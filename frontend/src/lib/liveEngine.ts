import { openLive, fetchRecent } from "./feed";
import { buildSeries as realBuildSeries } from "./backtestSeries";
import { evaluateStrategy as realEvaluateStrategy } from "../api";
import { fetchOpenPositions as realFetchOpenPositions } from "./trading";
import { placeActions as realPlaceActions } from "./livePlacement";
import { acquireLease } from "./liveLease";
import { detectBarClose } from "./liveHelpers";
import { save, load, ns } from "./persist";
import {
  type LiveState, type ArmedSnapshot, activeRules, appendLog, setPositionVintage, markLost,
} from "./liveState";
import { activeGroup } from "./backtestConfig";
import { markStrategyDeal, forgetStrategyDeal } from "./liveTags";
import { recordClose } from "./liveJournal";
import type { EvaluateRequest } from "./liveTypes";

type KBar = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

export interface CycleDeps {
  buildSeries: typeof realBuildSeries;
  fetchOpenPositions: typeof realFetchOpenPositions;
  evaluateStrategy: typeof realEvaluateStrategy;
  placeActions: typeof realPlaceActions;
  /** Fetch the recent CLOSED bars for a higher timeframe (MTF operands). Injected
   *  by armLiveEngine (bound to the live epic + broker); base-only configs never
   *  call it. Absent ⇒ falls back to the base bars (base-only / unit tests). */
  fetchTimeframe?: (tf: string) => Promise<KBar[]>;
}

const realDeps: CycleDeps = {
  buildSeries: realBuildSeries,
  fetchOpenPositions: realFetchOpenPositions,
  evaluateStrategy: realEvaluateStrategy,
  placeActions: realPlaceActions,
};

/** One closed-bar cycle: reconcile -> evaluate -> place. Returns the next state.
 *  All I/O is injected so this is unit-testable without network or WS. */
export async function runOneCycle(
  state: LiveState,
  bars: KBar[],
  barTsSec: number,
  resolution: string,
  epic: string,
  deps: CycleDeps = realDeps,
): Promise<{ state: LiveState }> {
  if (state.status !== "armed") return { state };
  const base = activeRules(state);
  if (!base) return { state };

  const positions = await deps.fetchOpenPositions(base.account, epic);
  const open = positions[0] ?? null;

  // Reconcile: a recorded vintage with no live position means the position closed
  // OUTSIDE the engine — a broker-side SL/TP bracket fill, or a close from another
  // device/tab. Clear the stale vintage so the NEXT entry evaluates under the
  // current armed snapshot's rules, not the closed position's (spec re-arm
  // semantics). NOTE: journaling a broker-side exit needs the broker's realized
  // fill and is not attempted here — the metrics under-report such exits.
  let reconciled = state;
  if (!open && state.positionVintage) {
    reconciled = appendLog(
      setPositionVintage(state, null), barTsSec, "position closed externally (broker bracket)",
    );
  }
  const snap = activeRules(reconciled);
  if (!snap) return { state: reconciled };

  const position = open
    ? {
        side: open.side, quantity: open.quantity, open_level: open.priceLevel,
        // Epoch seconds, for counted exits. openedAt is created_at in ms; omit if
        // the broker didn't report an open time (counted exits then can't count).
        open_time: open.openedAt != null ? Math.floor(open.openedAt / 1000) : undefined,
      }
    : null;

  // buildSeries wants a fetchTimeframe fn for HTF operands. Use the injected
  // per-TF fetcher (real broker fetch of that TF's CLOSED bars) so a multi-
  // timeframe operand is computed on ITS OWN timeframe, matching the backtest;
  // alignHtfToChart(waitClose=true) gates each HTF bar until it has closed, so no
  // lookahead. Base-only configs never invoke it; the base-bar fallback keeps
  // unit tests (and any base-only path) working without a fetcher.
  const fetchTf = deps.fetchTimeframe ?? (async () => bars);
  const series = await deps.buildSeries(
    bars as never, snap.cfg, resolution, (async (tf: string) => await fetchTf(tf)) as never,
  );

  const cfg = snap.cfg;
  const req: EvaluateRequest = {
    epic, resolution,
    candles: bars.map((b) => ({
      time: Math.floor(b.timestamp / 1000),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })),
    series,
    longEntry: activeGroup(cfg.longEntry),
    longExit: activeGroup(cfg.longExit),
    shortEntry: activeGroup(cfg.shortEntry),
    shortExit: activeGroup(cfg.shortExit),
    longEnabled: cfg.longEnabled !== false,
    shortEnabled: cfg.shortEnabled !== false,
    longRisk: cfg.longRisk ?? null,
    shortRisk: cfg.shortRisk ?? null,
    position,
  };

  const { actions } = await deps.evaluateStrategy(req);
  let next = { ...reconciled, lastEvalSec: barTsSec };
  if (actions.length === 0) {
    return { state: appendLog(next, barTsSec, "no signal") };
  }

  const outcomes = await deps.placeActions(actions, {
    strategyId: snap.strategyId,
    barTsSec,
    epic,
    account: snap.account,
    quantity: snap.quantity,
    confirm: snap.account.endsWith(":live"),
    openPosition: open,
  });
  // Apply each placement outcome: only a SUCCESSFUL fill changes the book, so
  // vintage/tag/journal update on ok only; a reject is surfaced in the log (never
  // silently reported as an open). Vintage tracks "open position finishes on its
  // opening rules" (spec re-arm semantics).
  for (const o of outcomes) {
    const a = o.action;
    if (!o.ok) {
      next = appendLog(next, barTsSec, `${a.kind} ${a.leg} rejected: ${o.detail}`);
      continue;
    }
    if (a.kind === "open") {
      markStrategyDeal(o.dealId);
      next = setPositionVintage(next, reconciled.snapshot);
    } else {
      if (open && o.fillPrice != null) {
        const dir = a.leg === "long" ? 1 : -1;
        recordClose({
          ts: barTsSec, epic, leg: a.leg,
          entry: open.priceLevel, exit: o.fillPrice, quantity: open.quantity,
          pnl: (o.fillPrice - open.priceLevel) * dir * open.quantity,
        });
      }
      if (open) forgetStrategyDeal(open.id);
      next = setPositionVintage(next, null);
    }
    next = appendLog(next, barTsSec, `${a.kind} ${a.leg} ${a.side}`);
  }
  return { state: next };
}

export function armedKey(epic: string, account: string): string {
  return ns(`live.${account}`, `armed.${epic}`);
}
export function saveArmed(epic: string, account: string, snap: ArmedSnapshot | null): void {
  save(armedKey(epic, account), snap);
}
export function loadArmed(epic: string, account: string): ArmedSnapshot | null {
  return load<ArmedSnapshot | null>(armedKey(epic, account), null);
}

export interface LiveEngineHandle {
  disarm(): void;
}

/** Wire the real loop: lease + live WS + per-closed-bar runOneCycle. `getState`/
 *  `setState` let Plan 2's panel subscribe. Kept thin — the logic is runOneCycle
 *  + the reducer, both already tested. */
export function armLiveEngine(params: {
  epic: string;
  resolution: string;
  brokerId: string;
  getState: () => LiveState;
  setState: (s: LiveState) => void;
  /** Warmup: historical CLOSED bars preloaded so indicators are warm on the
   *  first live tick and the engine can act on the latest closed bar at arm.
   *  Seeding prevTs to the last of these makes the first live tick (a new bar)
   *  detect a close and run one cycle immediately (spec §4: act on the latest
   *  closed bar). */
  seedBars?: KBar[];
}): LiveEngineHandle {
  const { epic, resolution, brokerId, getState, setState, seedBars = [] } = params;
  const account = getState().snapshot!.account;

  const lease = acquireLease(`${epic}|${account}`);
  if (!lease.held) {
    setState(markLost(getState()));
    return { disarm() {} };
  }

  // `cancelled` is the single source of truth for "this engine is stopped": set by
  // disarm() and by a lost lease. It gates BOTH starting a new cycle and applying a
  // cycle's result, so a stop mid-cycle can't resurrect an armed UI (or trade on).
  let cancelled = false;
  let handle: { close: () => void } = { close() {} };
  const stop = () => {
    cancelled = true;
    lease.release();
    handle.close();
  };

  lease.onLost(() => {
    // Losing the lease must tear the engine down — not just flip the label — or the
    // WS stream and the lease claim leak for the life of the tab.
    stop();
    setState(markLost(getState()));
  });

  // MTF operands read their own timeframe's CLOSED bars, fetched from the same
  // broker the live stream uses.
  const deps: CycleDeps = { ...realDeps, fetchTimeframe: (tf) => fetchRecent(epic, tf, 1500, "mid", brokerId) as Promise<KBar[]> };

  const bars: KBar[] = [...seedBars];
  let prevTs: number | null = seedBars.length ? seedBars[seedBars.length - 1].timestamp : null;
  let running = false;

  handle = openLive(epic, resolution, (k) => {
    const { closed } = detectBarClose(prevTs, k as KBar);
    // Maintain the rolling bar array: replace the in-progress bar or append a new one.
    if (bars.length && bars[bars.length - 1].timestamp === k.timestamp) {
      bars[bars.length - 1] = k as KBar;
    } else {
      bars.push(k as KBar);
      if (bars.length > 1500) bars.shift(); // bound memory; warmup-sized window
    }
    prevTs = k.timestamp;
    if (cancelled || !closed || running) return; // stopped, no close, or already running
    // Act on the just-CLOSED bars = everything up to (not including) the in-progress bar.
    const closedBars = bars.slice(0, -1);
    if (closedBars.length < 2) return;
    running = true;
    const barTsSec = Math.floor(closedBars[closedBars.length - 1].timestamp / 1000);
    void runOneCycle(getState(), closedBars, barTsSec, resolution, epic, deps)
      .then(({ state }) => { if (!cancelled) setState(state); })
      .finally(() => { running = false; });
  }, undefined, "mid", brokerId);

  return { disarm: stop };
}

// --- persisted "which account is this epic armed on" pointer ------------------
// resume() on reload knows the epic (from the cell) but not which account the
// strategy was armed on — the armed snapshot is keyed per (epic, account). This
// pointer records it so resume can find the snapshot without guessing the account.
function armedAccountKey(epic: string): string {
  return ns("live", `armedAccount.${epic}`);
}
export function saveArmedAccount(epic: string, account: string | null): void {
  save(armedAccountKey(epic), account);
}
export function loadArmedAccount(epic: string): string | null {
  return load<string | null>(armedAccountKey(epic), null);
}
