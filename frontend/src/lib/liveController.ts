/** The Live panel's single active engine (v1: one armed strategy at a time in
 *  the panel). Owns the LiveState signal, the warmup-on-arm fetch, and the
 *  arm/disarm gestures. The panel subscribes to `liveStateSignal` and calls
 *  these; the headless loop (liveEngine) does the per-bar work. */
import { Signal } from "./signals";
import { fetchRecent } from "./feed";
import { fetchStrategies } from "../api";
import {
  armLiveEngine, saveArmed, loadArmed, saveArmedAccount, loadArmedAccount,
  type LiveEngineHandle,
} from "./liveEngine";
import {
  initialLiveState, armSnapshot, disarm as disarmState, editDraft,
  type LiveState, appendLog,
} from "./liveState";
import { defaultBacktestConfig, type BacktestConfig } from "./backtestConfig";
import { loadCodedCfg, resolveParamValues } from "./codedConfig";
import type { KLineData } from "klinecharts";
import { collectExprInstances, referencedInstanceIds, type LiveInstance } from "./exprInstances";

type KBar = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

const WARMUP_BARS = 500; // enough to warm any reasonable indicator on the base TF.

export const liveStateSignal = new Signal<LiveState>(
  initialLiveState(defaultBacktestConfig(), "capital:demo", 1),
);

let engine: LiveEngineHandle | null = null;
// The epic/resolution/broker the panel is currently pointed at.
let target = { epic: "", resolution: "MINUTE", brokerId: "capital" };
// The (epic, account) the RUNNING engine was armed on. Distinct from `target`,
// which follows the panel — using this for disarm/persistence means re-pointing
// the panel can't clear the wrong epic's saved snapshot.
let armedFor: { epic: string; account: string } | null = null;

function get(): LiveState {
  return liveStateSignal.value;
}
function set(s: LiveState): void {
  liveStateSignal.set(s);
}

/** Point the panel at a cell (epic/resolution/broker) and account, seeding the
 *  draft. If a snapshot for this epic+account was persisted (armed before a
 *  reload), restore it as the draft so the user sees what was running. Full
 *  broker-position reconcile + auto-re-arm is handled by `resume`. */
export function initLive(params: {
  epic: string;
  resolution: string;
  brokerId: string;
  account: string;
  seedDraft?: BacktestConfig;
  quantity?: number;
}): void {
  // While an engine is armed, never repoint/reset: the panel shows the one running
  // strategy (v1: one at a time), and the headless engine + panel share a single
  // signal. Repointing here would clear the wrong epic's snapshot and let a later
  // cycle overwrite the panel with the old epic's state. Resume/arm own the target.
  const cur = get();
  if (cur.status === "armed") return;
  target = { epic: params.epic, resolution: params.resolution, brokerId: params.brokerId };
  // Prefer the account this epic was last armed on (so a reload seeds the panel on
  // the running strategy's account, and resume() finds its snapshot).
  const account = loadArmedAccount(params.epic) ?? params.account;
  const persisted = loadArmed(params.epic, account);
  const draft = params.seedDraft ?? persisted?.cfg ?? get().draft;
  set(initialLiveState(draft, account, params.quantity ?? cur.quantity ?? 1));
}

export function setDraft(cfg: BacktestConfig): void {
  set(editDraft(get(), cfg));
}
export function setAccount(account: string): void {
  set({ ...get(), account });
}
export function setQuantity(quantity: number): void {
  set({ ...get(), quantity });
}

/** Warm indicators from history, freeze the snapshot, and start the loop. The
 *  strategyId is deterministic (`epic|account`) so the derived idempotency key
 *  survives a reload — a replay collapses to one order at the broker. */
/** Fetch the warmup window, retrying a cold-cache timeout a few times. */
async function warmup(): Promise<KBar[]> {
  const { epic, resolution, brokerId } = target;
  set(appendLog(get(), Math.floor(Date.now() / 1000), `warming up (${WARMUP_BARS} bars)…`));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bars = (await fetchRecent(epic, resolution, WARMUP_BARS, "mid", brokerId)) as KLineData[];
      return bars.map((b) => ({
        timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set(appendLog(get(), Math.floor(Date.now() / 1000),
        attempt < 3 ? `warmup retry ${attempt}/3 (${msg})` : `warmup failed: ${msg}`));
    }
  }
  return [];
}

function startLoop(seedBars: KBar[]): void {
  const { epic, resolution, brokerId } = target;
  engine = armLiveEngine({ epic, resolution, brokerId, getState: get, setState: set, seedBars });
}

/** The rule rows a run actually EXECUTES, as expression strings.
 *
 *  Coded mode's rows are the coded set's panel exits (loadCodedCfg), NOT the
 *  draft's rule-mode groups, which lie dormant — the same "effective cfg"
 *  substitution runOneCycle makes when it builds exprLongExit/exprShortExit, and
 *  the one BacktestButton makes with effCfg. Deciding it in ONE place means the
 *  indicators map can't be collected from a different row set than the one that
 *  gets sent. Disabled rows are skipped: they never reach the backend. */
function effectiveExprRows(cfg: BacktestConfig): string[] {
  const groups =
    cfg.mode === "coded" && cfg.codedStrategy
      ? (() => {
          const c = loadCodedCfg("live", cfg.codedStrategy);
          return [c.longExit, c.shortExit];
        })()
      : [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit];
  return groups.flatMap((g) => g.rules.filter((r) => r.enabled !== false).map((r) => r.expr ?? ""));
}

/** Arm the draft. `live` is the chart's panes, flattened — the panel reads them
 *  off the chart (which this module has no handle on) and hands them in. The
 *  ones the executed rows actually reference are frozen into the snapshot
 *  alongside the rules. Empty/omitted for a config with no references, or when
 *  no chart is focused. */
export async function arm(
  live: readonly LiveInstance[] = [],
): Promise<void> {
  // Fail safe: refuse to arm "coded" mode with no file picked, BEFORE tearing down
  // any currently-running engine below — a refused arm must never kill a
  // legitimately armed strategy. Without this guard the cycle gate elsewhere would
  // silently fall back to trading whatever stale rule groups sit in the draft.
  const draftCfg = get().draft;
  if (draftCfg.mode === "coded" && !draftCfg.codedStrategy) {
    set(appendLog(get(), Math.floor(Date.now() / 1000),
      "cannot arm: coded mode selected but no strategy file chosen"));
    return;
  }

  // Refuse to arm a hedged coded strategy up front — it opens both long and short
  // buckets at once, which the live route's netted single-position model can't
  // represent (the backend already refuses it per-cycle with a 422, surfaced via
  // the "evaluate failed" log, but arming should never even start the loop). Done
  // BEFORE tearing down any running engine below, same rationale as the guard
  // above. Also used below to resolve/clamp the frozen coded params (I3) —
  // fetched once and reused, rather than a second round-trip. If the strategy
  // list can't be fetched (backend down), REFUSE the arm: freezing raw
  // unresolved params would reintroduce I3 (a stale out-of-range value 422s
  // every evaluate cycle, silently halting a supposedly-armed strategy), and
  // an arm with the backend down can't warm up or evaluate anyway.
  let pickedStrategy: Awaited<ReturnType<typeof fetchStrategies>>[number] | undefined;
  if (draftCfg.mode === "coded" && draftCfg.codedStrategy) {
    try {
      const strategies = await fetchStrategies();
      pickedStrategy = strategies.find((s) => s.filename === draftCfg.codedStrategy);
    } catch {
      set(appendLog(get(), Math.floor(Date.now() / 1000),
        "cannot arm: strategy list unavailable — params can't be validated; retry"));
      return;
    }
    if (!pickedStrategy) {
      set(appendLog(get(), Math.floor(Date.now() / 1000),
        `cannot arm: '${draftCfg.codedStrategy}' not found in the strategy list`));
      return;
    }
    if (pickedStrategy.hedged) {
      set(appendLog(get(), Math.floor(Date.now() / 1000),
        "cannot arm: hedged strategies are backtest-only"));
      return;
    }
  }

  // Every chart-pane reference the EXECUTED rows make must be covered by a pane
  // on the chart. An uncovered one is not a degraded arm: the backend resolves
  // the reference against nothing, `validate` raises unknown_indicator_ref, and
  // the evaluate route 422s on EVERY bar — taking the EXIT rules down with it,
  // so an open position would have nothing able to close it. Refuse instead,
  // naming the pane, and do it BEFORE tearing down any running engine (same
  // rationale as the guards above).
  const rows = effectiveExprRows(draftCfg);
  const indicators = collectExprInstances(live, rows);
  const missing = [...referencedInstanceIds(rows)].filter((id) => !(id in indicators)).sort();
  if (missing.length) {
    set(appendLog(get(), Math.floor(Date.now() / 1000),
      `cannot arm: rule${missing.length > 1 ? "s reference" : " references"} ` +
      `${missing.join(", ")}, which ${missing.length > 1 ? "are" : "is"} not on the chart`));
    return;
  }

  // Same refusal, one step further in: a pane that IS on the chart but carries its
  // own timeframe pin (extendData.mtf.timeframe) can't be evaluated live at all.
  // `SLOPE.9` on a pinned pane denotes the HIGHER-timeframe series with no
  // `@tf` in the rule text, so nothing upstream catches it — the arm-time
  // presence check passes, and `validate` passes too (nested_tf only fires for an
  // `@tf` stacked ON TOP of a pin). But the live evaluate route builds its HTF set
  // solely from req.htfCandles (strategy.py), which EvaluateRequest has no field
  // for and liveEngine never sends: the lookup misses, the operand resolves to
  // all-None, and the rule simply never fires. That is worse than the 422 above —
  // an exit rule that can never close a position, with a clean "armed" label over
  // it. Refuse, naming the pane AND the timeframe so the fix is obvious (unpin the
  // pane, or express the higher timeframe some other way).
  //
  // Read off `indicators` — already narrowed to the REFERENCED panes by
  // effectiveExprRows — so a pinned pane the executed rows don't name (including
  // one named only by coded mode's dormant rule-mode groups) never blocks an arm,
  // and no second traversal of `live` is introduced.
  const pinned = Object.entries(indicators)
    .map(([id, p]) => [id, (p.extendData as { mtf?: { timeframe?: string | null } } | null)
      ?.mtf?.timeframe] as const)
    .filter((e): e is readonly [string, string] => !!e[1])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (pinned.length) {
    set(appendLog(get(), Math.floor(Date.now() / 1000),
      `cannot arm: rule${pinned.length > 1 ? "s reference" : " references"} ` +
      `${pinned.map(([id, tf]) => `${id}, which is pinned to ${tf}`).join("; ")}` +
      ` — the live engine cannot fetch higher-timeframe candles`));
    return;
  }

  // Stop any running engine first (e.g. "Re-arm to apply"): without this, startLoop
  // overwrites `engine` and leaks the old WS + lease, and the new lease self-
  // conflicts with the still-open old one and immediately marks itself lost.
  engine?.disarm();
  engine = null;

  const { epic } = target;
  const account = get().account;
  const seedBars = await warmup();

  const strategyId = `${epic}|${account}`;
  const armedAtSec = Math.floor(Date.now() / 1000);
  // Coded mode: freeze the LIVE coded set (params/risk/exits) into the snapshot
  // at the same moment the draft is frozen — every evaluate cycle reads this
  // frozen copy, never a live-reloaded value (drift shows in the panel instead).
  // Params are resolved against the strategy's CURRENT schema here (I3): a
  // raw stored value can go stale (out of range / mistyped, e.g. the file's
  // min/max changed since the value was saved) and the backend 422s on it
  // every cycle, silently halting a supposedly-armed strategy while the panel
  // still shows the resolved default. Resolving once at arm time means the
  // frozen snapshot always carries a value the backend will accept.
  const coded =
    draftCfg.mode === "coded" && draftCfg.codedStrategy
      ? (() => {
          // pickedStrategy is guaranteed here — a coded arm without a fetched
          // schema was refused above.
          const cfg = loadCodedCfg("live", draftCfg.codedStrategy!);
          return { ...cfg, params: resolveParamValues(pickedStrategy!.params, cfg.params) };
        })()
      : undefined;
  // Only ship a map when there is something in it, so a reference-free config
  // is byte-identical to what it was before this existed.
  const armed = armSnapshot(
    get(), strategyId, armedAtSec, coded,
    Object.keys(indicators).length ? indicators : undefined,
  );
  set(appendLog(armed, armedAtSec, `armed ${epic} on ${account}`));
  saveArmed(epic, account, armed.snapshot);
  saveArmedAccount(epic, account);
  armedFor = { epic, account };
  startLoop(seedBars);
}

/** On reload: if this epic+account was left armed, restore the ORIGINAL snapshot
 *  (preserving its rule vintage) and restart the loop. The per-cycle reconcile
 *  then adopts the broker's open position before evaluating. Spec: an armed
 *  strategy survives a reload and re-adopts its broker position on resume. */
export async function resume(): Promise<boolean> {
  const { epic } = target;
  if (get().status === "armed") return false;
  // Resolve the account the strategy was armed on (persisted pointer), NOT the
  // panel's current default — otherwise a strategy armed on a non-default account
  // is never found and its live position is left unmanaged after a reload.
  const account = loadArmedAccount(epic) ?? get().account;
  const snap = loadArmed(epic, account);
  if (!snap) return false;

  engine?.disarm();
  engine = null;

  const restored: LiveState = {
    ...initialLiveState(snap.cfg, snap.account, snap.quantity),
    status: "armed",
    snapshot: snap,
  };
  set(appendLog(restored, Math.floor(Date.now() / 1000), `resumed armed ${epic} on ${snap.account}`));
  armedFor = { epic, account: snap.account };
  const seedBars = await warmup();
  startLoop(seedBars);
  return true;
}

/** Stop the loop. Keeps any open position (and its broker bracket) — spec:
 *  disarm only stops the engine. */
export function disarm(): void {
  engine?.disarm();
  engine = null;
  // Clear persistence under the epic/account the ENGINE was armed on, not the
  // panel's current target (which may have moved), so we don't strand a snapshot.
  const armed = armedFor;
  armedFor = null;
  const next = disarmState(get());
  set(next);
  const epic = armed?.epic ?? target.epic;
  const account = armed?.account ?? next.account;
  saveArmed(epic, account, null);
  saveArmedAccount(epic, null);
}
