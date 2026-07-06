/** The Live panel's single active engine (v1: one armed strategy at a time in
 *  the panel). Owns the LiveState signal, the warmup-on-arm fetch, and the
 *  arm/disarm gestures. The panel subscribes to `liveStateSignal` and calls
 *  these; the headless loop (liveEngine) does the per-bar work. */
import { Signal } from "./signals";
import { fetchRecent } from "./feed";
import {
  armLiveEngine, saveArmed, loadArmed, saveArmedAccount, loadArmedAccount,
  type LiveEngineHandle,
} from "./liveEngine";
import {
  initialLiveState, armSnapshot, disarm as disarmState, editDraft,
  type LiveState, appendLog,
} from "./liveState";
import { defaultBacktestConfig, type BacktestConfig } from "./backtestConfig";
import type { KLineData } from "klinecharts";

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

export async function arm(): Promise<void> {
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
  const armed = armSnapshot(get(), strategyId, armedAtSec);
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
