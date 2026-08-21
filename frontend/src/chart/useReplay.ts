// Chart replay for ONE cell: TradingView-style bar replay over locally held
// bars. The hook owns the session (cursor, high-water, masking, playback) and
// the bar store; every pure decision lives in lib/replayBars.ts.
//
// Painting is deliberately split between two places:
//   - a SERIES load (session start, timeframe switch, exit) goes through
//     useLiveMarketData's normal effect, which we re-trigger by bumping
//     `replayEpoch`. That reuses the whole load path (drawings rehydrate,
//     indicator visibility, MTF refresh, template apply) instead of forking it.
//   - a STEP repaints here, directly through the data facade, so play/step feel
//     instant and never re-run the load effect.
//
// Per-cell state pattern: chart/useProximityHeatmap.ts. No React context.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { fetchRangeWithStatus, RESOLUTION_SECONDS, type CandlesResult } from "../lib/feed";
import type { PriceSide } from "../theme";
import {
  bufferWindowSec,
  cursorForStartTs,
  hasLoadedSuccessor,
  mergeForward,
  mergeOlder,
  needsBuffer,
  nextCursorMs,
  nominalMsFor,
  prevCursorMs,
  revealedBars,
  revealedCount,
} from "../lib/replayBars";
import {
  advanceBar,
  canPlaceAt,
  cancelOrder,
  closeAt,
  editLevels,
  emptyLedger,
  placeLimit,
  placeMarket,
  shouldAdvanceAt,
  summarize,
  toTradeViews,
  type ReplayLedgerState,
  type ReplaySummary,
} from "../lib/replayLedger";
import { refreshTrades } from "../lib/trading";
import {
  clearReplaySession,
  loadReplaySession,
  MAX_JUMP_ATTEMPTS,
  pickJumpTarget,
  saveReplaySession,
} from "../lib/replaySession";
import { mtfBucketMs, refreshMtfIndicators, setHtfCursorClamp } from "../lib/mtfCoordinator";
import {
  backtestRenderFlags,
  ownsBacktestPanel,
  registerReplayingChart,
  rehydrateBacktest,
  renderArtifacts,
  teardownArtifacts,
  updateShownResult,
} from "../lib/backtest";
import { filterResultToCursor } from "../lib/replayReveal";
import { loadBacktestResult } from "../lib/persist";
import { backtestResultSignal } from "../lib/signals";
import { toast } from "../lib/notify";
import type { ChartHandle, ReplayHandle } from "./chartHandle";

// Bars fetched left of the start (screen context the user can scroll into) and
// right of the cursor (the forward buffer that keeps stepping local).
/** Halvings a jump skips when a read comes back degraded, on top of the one the
 * next attempt makes anyway. A timeout is evidence about the DEPTH asked for, so
 * the search collapses rather than creeping: this bounds the whole jump to two
 * slow reads, which is what a genuine outage costs before it is reported. */
const DEGRADED_SKIP = 3;
/** How long one jump read may take before the search moves on. Generous next to
 * a cached page (milliseconds) and to a live broker round trip (a second or two),
 * so it only ever fires on a read that was not going to arrive. */
const JUMP_READ_TIMEOUT_MS = 10_000;
const TIMEOUT_MSG = "Timed out reading that far back. Try a shorter window or a higher timeframe.";
const CONTEXT_BARS = 300;
const FORWARD_BARS = 200;
// Refill when the cursor comes within this many unrevealed bars of the store's end.
const REFILL_MARGIN = 50;

// Longest the session record may go unwritten while something keeps changing.
// One second is ten steps at 10x: enough for the debounce to still coalesce a
// burst, short enough that a tab closed mid-playback loses about a second of
// replay rather than the entire run. See the persistence effect.
const SAVE_MAX_GAP_MS = 1000;

// A degraded read means the broker/backend path is unreachable and the backend
// served whatever short cached page it had. Replay REFUSES such a page rather
// than painting it: a hole in the middle of the window makes barCloseMs compute
// the wrong close across the gap, which silently breaks the blindness guarantee
// the whole feature rests on. (fetchRangeWithStatus's `degraded` string also
// carries the backend's own actionable detail, e.g. the WAF block message; a
// later polish pass may want to surface it instead of this fixed copy.)
const OUTAGE_MSG = "Couldn't reach the broker. Try again in a moment.";

export const REPLAY_SPEEDS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "1x", ms: 1000 },
  { label: "2x", ms: 500 },
  { label: "5x", ms: 200 },
  { label: "10x", ms: 100 },
];

export interface ReplayUiState {
  mode: "off" | "picking" | "active";
  startMs: number;
  cursorMs: number;
  highWaterMs: number;
  masked: boolean;
  playing: boolean;
  speedMs: number;
  /** True once playback has reached the last closed bar before now. */
  atEnd: boolean;
  loading: boolean;
  error: string | null;
  /** Bumped every time a SERIES load establishes the bar store (barsFor). The
   * one dependency that reliably says "the chart has just been repainted from
   * scratch and anything drawn on top of it is gone".
   *
   * `loading` cannot do that job: it is a true→false pair, and when both land in
   * the same React batch (a cached or same-tick read) no effect ever observes the
   * `true`, so nothing keyed on it re-runs. That is exactly how the strategy
   * reveal came to publish once at session start and then stay dead — the load
   * effect tore its artifacts down and cleared the panel underneath it, and no
   * dependency changed to tell it. A monotonic counter cannot be missed. */
  storeSeq: number;
}

export interface ReplayApi {
  state: ReplayUiState;
  enterPicking(): void;
  cancelPicking(): void;
  startAt(startTs: number, opts: { masked: boolean }): void;
  randomJump(windowMs: number, masked: boolean): void;
  stepForward(): void;
  stepBack(): void;
  togglePlay(): void;
  setSpeed(ms: number): void;
  exit(): void;
  /** Bumped whenever the SERIES must be reloaded (start / exit). Passed into
   * useLiveMarketData's deps so its effect re-runs. */
  replayEpoch: number;

  // --- ending a session: the report card (ReplayReportCard.tsx) --------------
  /** The UI's exit path (the pill's ✕). Opens the report card instead of tearing
   * the session down outright; `dismissReport` is what actually exits. */
  requestExit(): void;
  /** The UI's "pick new start" path (the pill's ⟲). Same card, but dismissing it
   * lands in `picking` rather than `off`. */
  requestNewStart(): void;
  /** Non-null while the card is up. The session is still technically ACTIVE at
   * that point, so every control that could advance it is gated on this — see
   * `reportOpenRef` in the hook. */
  pendingReport: {
    summary: ReplaySummary;
    startMs: number;
    cursorMs: number;
    masked: boolean;
  } | null;
  /** Close the card and perform the real teardown (exit, or re-enter picking
   * when the card was opened by ⟲). The card's Done button AND its Escape key
   * both come here: there is no path from the card back into the session. */
  dismissReport(): void;

  // --- the session's trading book (lib/replayLedger) ------------------------
  /** The book itself, for the report card and any read-only chrome. */
  ledger: ReplayLedgerState;
  /** False while the cursor is rewound behind the high-water mark. The ticket
   * disables its Buy/Sell on it, and the two actions that transact a PRICE
   * (`place`, `closeTrade`) re-check the same condition at call time and no-op.
   * `cancel` and `edit` deliberately do not: see `tradingOpen` in the hook. */
  canTrade: boolean;
  place(a: {
    side: "buy" | "sell";
    quantity: number;
    type: "market" | "limit";
    price: number | null;
    stop: number | null;
    takeProfit: number | null;
  }): void;
  closeTrade(id: string): void;
  cancel(id: string): void;
  edit(id: string, e: { price?: number | null; stop?: number | null; takeProfit?: number | null }): void;
  /** Close of the newest revealed bar: what a market order fills at. Null before
   * any bar is revealed (a resumed session before its store loads). */
  markPrice: number | null;

  // --- the progressive strategy reveal (lib/replayReveal) -------------------
  /** True while the cell's saved backtest is being revealed at the cursor. */
  showStrategy: boolean;
  /** False when this cell has no saved backtest to reveal: the pill disables the
   * button and says to run one first. Re-read whenever the mode changes, so a
   * backtest run before the session starts is picked up. */
  hasStrategy: boolean;
  toggleStrategy(): void;
}

export interface ReplayDeps {
  epic: string;
  resolution: string;
  priceSide: PriceSide;
  brokerId: string;
  scope: string;
  /** Real (never masked) timestamp label, in the cell's timezone and clock. Used
   * only for the reveal a no-trade blind session gets INSTEAD of the report card
   * (see finishSession); the card itself is formatted by the caller. */
  formatReal?: (ms: number) => string;
}

const OFF: ReplayUiState = {
  mode: "off",
  startMs: 0,
  cursorMs: 0,
  highWaterMs: 0,
  masked: false,
  playing: false,
  speedMs: 1000,
  atEnd: false,
  loading: false,
  error: null,
  storeSeq: 0,
};

export function useReplay(handle: ChartHandle, deps: ReplayDeps): ReplayApi {
  const { epic, resolution, priceSide, brokerId, scope } = deps;

  // Resume a session parked by a reload — but only when it still addresses this
  // cell's instrument (a symbol change ends the session; the bars underneath a
  // cursor belong to one epic).
  const [state, setState] = useState<ReplayUiState>(() => {
    const saved = loadReplaySession(scope);
    if (!saved || saved.epic !== epic) return OFF;
    return {
      ...OFF,
      mode: "active",
      startMs: saved.startMs,
      cursorMs: saved.cursorMs,
      highWaterMs: saved.highWaterMs,
      masked: saved.masked,
    };
  });
  const [replayEpoch, setReplayEpoch] = useState(0);

  // The bar store for the CURRENT resolution (ascending, may extend past the
  // cursor — that's the forward buffer, which the chart never sees).
  const barsRef = useRef<KLineData[]>([]);
  const storeResRef = useRef<string>(resolution);
  // Latest state for imperative callbacks (playback timer, the handle) without
  // stale closures — same idiom as useProximityHeatmap's `latest`.
  const latest = useRef({ state, epic, resolution, priceSide, brokerId, scope, formatReal: deps.formatReal });
  latest.current = { state, epic, resolution, priceSide, brokerId, scope, formatReal: deps.formatReal };
  const refillingRef = useRef(false);
  // Monotonic request id: a resolved fetch applies only if it is still the newest
  // one issued (useProximityHeatmap's idiom). ONE counter for every path that
  // writes the store, because they all write the same store — a refill landing
  // after a jump must not resurrect the jumped-away-from window. The session
  // enders bump it too, which is what stops a slow startAt from re-activating a
  // session the user has already cancelled or exited.
  const reqSeq = useRef(0);

  const nominalMs = useCallback((res: string) => nominalMsFor(res), []);

  // --- the session's trading book -------------------------------------------
  //
  // Resumed on the same terms as the cursor above: only when the saved record
  // still addresses this cell's instrument, since a fill's price means nothing
  // against another symbol's bars.
  const [ledger, setLedger] = useState<ReplayLedgerState>(() => {
    const saved = loadReplaySession(scope);
    return (saved?.epic === epic && saved.ledger) || emptyLedger();
  });
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  // --- the progressive strategy reveal --------------------------------------
  //
  // The cell's SAVED backtest, redrawn at every cursor as the slice that has
  // already happened (lib/replayReveal). Deliberately narrower than "run the
  // strategy live": building a run request means reproducing several hundred
  // lines of BacktestButton's config-to-request logic, and the saved result is
  // the same artifact a rehydrate draws. The button is disabled with an
  // explanatory tooltip when the cell has none.
  //
  // Restored from the persisted record on the same terms as the cursor and the
  // book above (a record for another instrument is not this session's), so a
  // reload lands back on the toggle the user left it at — with the slice redrawn
  // at the restored cursor by the effect below.
  const [showStrategy, setShowStrategy] = useState<boolean>(() => {
    const saved = loadReplaySession(scope);
    return saved?.epic === epic ? !!saved.showStrategy : false;
  });
  // Read at CALL time by the toggle and by endSession, for the same stale-closure
  // reason `latest` exists — and because the restore below is a side effect that
  // must not live inside a setState updater (StrictMode invokes those twice).
  const showStrategyRef = useRef(showStrategy);
  showStrategyRef.current = showStrategy;
  const [hasStrategy, setHasStrategy] = useState<boolean>(() => loadBacktestResult(scope, epic) != null);
  // What the last reveal DREW — the overlay-bearing parts only, so a step that
  // merely grows the equity curve takes the cheap in-place path instead of a
  // teardown + rebuild (see the effect for why that distinction is the whole
  // point). Carries the display resolution as well as the counts: a timeframe
  // switch changes the marker mode (backtestRenderFlags) without changing any
  // count, and the load effect has torn the artifacts down by then.
  const revealSigRef = useRef("");

  /** Take the revealed slice back off the chart, leaving the cell exactly as a
   * session that never turned the reveal on: no markers, no equity pane, an
   * empty panel.
   *
   * This — NOT a rehydrate — is what switching the toggle off during a LIVE
   * session must do. Restoring the saved backtest there paints the whole run on
   * a blind chart: every marker of the run, including the fills in the session's
   * own future, plus its final net P&L on the panel. One click and the user has
   * seen the answer to the exercise they are sitting in the middle of. It is the
   * same publish already gated on the load path (backtestPanelActionForReplay)
   * and on the cross-tab push; this was the third way in.
   *
   * Ownership is read BEFORE the teardown, because teardownArtifacts nulls
   * `artifacts.result` and after that the question cannot be answered — and only
   * an owner may blank the shared panel, or a split-layout sibling's result goes
   * with it. */
  const clearRevealedBacktest = useCallback(() => {
    revealSigRef.current = "";
    const chart = handle.chartRef.current;
    if (!chart) return;
    const owned = ownsBacktestPanel(chart);
    teardownArtifacts(chart);
    if (owned) backtestResultSignal.set(null);
  }, [handle]);

  /** Put the cell's OWN saved backtest back on the chart and in the panel.
   *
   * Only ever on the way OUT of a session — the report card's Done, the pill's
   * ⟲, the symbol-change exit — which all funnel through `endSession`. Those end
   * the session, so the full run is no longer lookahead; without this the cell
   * would be stranded showing a slice frozen at the last cursor, a truncated
   * trade list and a partial P&L presented as the real backtest.
   *
   * Dropping the dedup signature is half the job, and it is the half that bites:
   * what is on the chart after this is the FULL result, so a reveal turned back
   * on at the same cursor would match the signature the last one recorded, skip
   * its redraw, and leave the whole run on the panel under a button reading ON.
   * Cleared ABOVE the chart guard, so a cell whose chart is not mounted yet still
   * forgets what it drew. */
  const restoreSavedBacktest = useCallback(() => {
    revealSigRef.current = "";
    const chart = handle.chartRef.current;
    if (!chart) return;
    const cur = latest.current;
    rehydrateBacktest(chart, cur.scope, cur.epic, cur.resolution);
  }, [handle]);

  /** The side effect lives OUT here rather than inside the setState updater:
   * React invokes updaters twice under StrictMode, and doing this twice would
   * tear the artifacts down and rebuild them for nothing. */
  const toggleStrategy = useCallback(() => {
    const next = !showStrategyRef.current;
    showStrategyRef.current = next;
    // Off: take the slice down now rather than waiting for the next load. NOT a
    // restore — the session is still running. See clearRevealedBacktest.
    if (!next) clearRevealedBacktest();
    setShowStrategy(next);
  }, [clearRevealedBacktest]);

  // --- the exit reveal ------------------------------------------------------
  //
  // The session report card, held here rather than in ChartCore because it has
  // to GATE the session as well as render it. `requestExit` opens the card while
  // the session is still `active` — the user is now looking at the real dates of
  // bars they traded blind, so from this moment the session must be a one-way
  // door: no stepping, no playback, no new fills. Every control below is gated
  // on the ref rather than the state value, for the same stale-closure reason
  // `latest` exists (a playback tick or a click handler captured before the card
  // opened would otherwise still fire).
  const [pendingReport, setPendingReport] = useState<{
    summary: ReplaySummary;
    startMs: number;
    cursorMs: number;
    masked: boolean;
  } | null>(null);
  const reportOpenRef = useRef(false);
  reportOpenRef.current = pendingReport !== null;
  // Which teardown the card's Done/Escape performs: `exit` (the ✕ path) or
  // `enterPicking` (the ⟲ path). A ref, not state, because nothing renders off
  // it — the card looks identical either way.
  const restartAfterReport = useRef(false);

  /** The price a replay trade transacts at: the close of the newest revealed bar.
   *
   * `atMs` defaults to the cursor, but every caller that has just SCHEDULED a
   * cursor move must pass the new one: `latest` is written during render, so
   * inside a click handler or the playback timer it still holds the pre-step
   * cursor and the mark would be one whole bar stale (permanently — nothing
   * re-marks afterwards). */
  const markPriceNow = useCallback(
    (atMs?: number): number | null => {
      const res = storeResRef.current;
      const cursorMs = atMs ?? latest.current.state.cursorMs;
      const n = revealedCount(barsRef.current, cursorMs, nominalMs(res));
      return n > 0 ? barsRef.current[n - 1].close : null;
    },
    [nominalMs],
  );

  // Publish the book into the cell's existing trade-line layer: the same
  // TradeView array the live feed writes, so lines, pills, bracket and drag all
  // work unchanged (ChartCore stops feeding it from the global feed while
  // replaying — see its subscribeTrades guard).
  const publishLedger = useCallback(
    (next: ReplayLedgerState, atMs?: number) => {
      setLedger(next);
      ledgerRef.current = next;
      handle.tradesRef.current = toTradeViews(next, latest.current.epic, markPriceNow(atMs));
      handle.posDrawRef.current();
      handle.redrawRef.current();
    },
    [handle, markPriceNow],
  );

  // --- bar store ------------------------------------------------------------

  const fetchWindow = useCallback(
    async (res: string, centerMs: number, signal?: AbortSignal): Promise<CandlesResult> => {
      const cur = latest.current;
      const { fromSec, toSec } = bufferWindowSec({
        centerMs,
        resSec: RESOLUTION_SECONDS[res] ?? 60,
        contextBars: CONTEXT_BARS,
        forwardBars: FORWARD_BARS,
        nowMs: Date.now(),
      });
      // WithStatus, not the forgiving fetchRange: that one flattens a 5xx to an
      // empty page, which replay would otherwise report to the user as "no
      // candles at that point" — blaming their pick for a broker outage.
      return fetchRangeWithStatus(
        cur.epic, res, fromSec, toSec, cur.priceSide, cur.brokerId, signal,
      );
    },
    [],
  );

  /** Bars to PAINT for a resolution at the current cursor. Called by the load
   * effect (session start, timeframe switch, resume) through handle.replayRef.
   *
   * Returns [] with `state.error` set when the read was degraded or failed. That
   * is NOT "the session is over" — the store is left alone and the next load or
   * step retries. */
  const barsFor = useCallback(
    async (res: string): Promise<KLineData[]> => {
      const seq = ++reqSeq.current;
      const cursorMs = latest.current.state.cursorMs;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const { bars, degraded } = await fetchWindow(res, cursorMs);
        if (seq !== reqSeq.current) return []; // superseded: leave the store alone
        if (degraded) {
          setState((s) => ({ ...s, loading: false, error: OUTAGE_MSG }));
          return [];
        }
        // The session may have ENDED while this read was in flight. The
        // symbol-change guard is the only path that flips `mode` from inside an
        // effect, so for one flush the load effect for the NEW epic still saw
        // `mode === "active"` and called this. `reqSeq` does not cover it:
        // endSession bumped the counter to N and this call then took N+1, so the
        // check above passes and nothing bumps afterwards.
        //
        // Publishing here would write the just-EMPTIED ledger into
        // handle.tradesRef, after endSession's refreshTrades() had already
        // refilled it from the account — and the user's REAL open positions would
        // silently lose their lines, pills and bracket until the next trade event,
        // possibly for the rest of the day. Returning [] also keeps a dead
        // session's slice off a chart that now belongs to another instrument.
        if (latest.current.state.mode !== "active") return [];
        barsRef.current = bars;
        storeResRef.current = res;
        // The store is now established at this cursor, so the book can be marked
        // against a real close. This is also the only publish a RESUMED session
        // gets before its first step: nothing else writes this cell's tradesRef
        // while replaying (the global feed is gated off), so without it a
        // reloaded session would show no position lines at all.
        publishLedger(ledgerRef.current, cursorMs);
        // storeSeq, not just `loading: false`: see its note on ReplayUiState. The
        // chart is about to be repainted from this store, so everything drawn on
        // top of it (the strategy reveal's markers and equity pane) has to know
        // to rebuild, and a true→false `loading` pair can be batched away.
        setState((s) => ({ ...s, loading: false, storeSeq: s.storeSeq + 1 }));
        return revealedBars(bars, cursorMs, nominalMs(res));
      } catch (err) {
        if (seq !== reqSeq.current) return [];
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        return [];
      }
    },
    [fetchWindow, nominalMs, publishLedger],
  );

  // Assigned during RENDER (not in an effect) so the load effect below in
  // ChartCore's hook order always reads a current handle — the same reason
  // ensureCoverageAndFitRef is assigned in render.
  const replayHandle = useMemo<ReplayHandle>(
    () => ({
      isActive: () => latest.current.state.mode === "active",
      masked: () => latest.current.state.masked && latest.current.state.mode === "active",
      cursorMs: () => (latest.current.state.mode === "active" ? latest.current.state.cursorMs : 0),
      startMs: () => (latest.current.state.mode === "active" ? latest.current.state.startMs : 0),
      barsFor,
    }),
    [barsFor],
  );
  handle.replayRef.current = replayHandle;

  // --- painting a step ------------------------------------------------------

  const applySlice = useCallback(
    (cursorMs: number, appended: boolean) => {
      const chart = handle.chartRef.current;
      const facade = handle.dataFacadeRef.current;
      if (!chart || !facade) return;
      const res = storeResRef.current;
      const revealed = revealedBars(barsRef.current, cursorMs, nominalMs(res));
      if (!revealed.length) return;
      if (appended) {
        // One new bar at the right edge: push it so the view is untouched (a
        // full setBars would resetData and re-park the view every step).
        facade.pushBar(revealed[revealed.length - 1]);
        return;
      }
      // Step back / jump / reveal-toggle: replace the dataset, keeping whatever
      // older history scroll-back paged in. resetData parks the view at the
      // right edge, which is where the cursor sits — acceptable by design.
      facade.setBars(mergeOlder(chart.getDataList() ?? [], revealed), true);
    },
    [handle, nominalMs],
  );

  // --- forward buffer -------------------------------------------------------

  const refillIfNeeded = useCallback(() => {
    const cur = latest.current;
    if (cur.state.mode !== "active" || refillingRef.current) return;
    // A refill EXTENDS a store; it cannot create one. Without this, a resumed
    // session (mode active, store still empty until the load effect calls
    // barsFor) would refill on the first step and supersede that very load.
    if (!barsRef.current.length) return;
    const res = storeResRef.current;
    if (!needsBuffer(barsRef.current, cur.state.cursorMs, nominalMs(res), REFILL_MARGIN)) return;
    refillingRef.current = true;
    // CAPTURED, not incremented — unlike the other three fetch paths. A refill is
    // background work for the store a load already established, so it must never
    // cancel a foreground barsFor/startAt/randomJump; it only has to be cancelled
    // BY them (and by exit/cancelPicking, which bump the counter too).
    const seq = reqSeq.current;
    void fetchWindow(res, cur.state.cursorMs)
      .then(({ bars, degraded }) => {
        // The seq check lives INSIDE .then so .finally still clears the in-flight
        // flag on a superseded refill; skipping it would wedge refills off for
        // the rest of the session.
        if (seq !== reqSeq.current) return;
        // The store may have been re-established at another timeframe while this
        // was in flight; merging bars across resolutions would corrupt it.
        if (storeResRef.current !== res) return;
        if (degraded) {
          setState((s) => ({ ...s, playing: false, error: OUTAGE_MSG }));
          return;
        }
        // NOT a length comparison: the refill window is the same width re-centred
        // on the advanced cursor, so on continuous data it carries the same bar
        // count and would never look "longer". See mergeForward.
        if (!bars.length) return; // a failed page reads as empty; keep what we have
        barsRef.current = mergeForward(barsRef.current, bars);
        // The end of the session is "the store can no longer offer a bar with a
        // LOADED successor" — the exact predicate stepForward steps by, so the
        // two cannot disagree about whether one more step exists.
        //
        // Derived BOTH ways, not just set: a refill that grew the store past the
        // cursor REOPENS the session. Without the clearing half, atEnd was a
        // one-way door — it is only ever set here, and here is only reachable
        // from stepForward, which the controls disable at atEnd. A user who
        // caught up with the live edge and waited for real bars to print could
        // never continue. Read the CURRENT cursor, not the one captured when the
        // refill was issued: playback may have advanced it since.
        const canAdvance = hasLoadedSuccessor(
          barsRef.current,
          latest.current.state.cursorMs,
          nominalMs(res),
        );
        setState((s) =>
          s.atEnd === !canAdvance
            ? s
            : // Reaching the end also stops playback; leaving it must not start it.
              { ...s, atEnd: !canAdvance, playing: canAdvance ? s.playing : false },
        );
      })
      .catch(() => {
        if (seq !== reqSeq.current) return;
        // A hard network fault (refused / DNS / offline) — HTTP failures come
        // back as `degraded` above. Transient either way: keep the loaded bars
        // and let the NEXT step retry (each step calls refillIfNeeded, so the
        // retry is user-paced rather than a timer with backoff — simpler, and it
        // cannot spin while the user is idle). Playback pauses with a notice
        // rather than ending the session.
        setState((s) => ({ ...s, playing: false, error: "Couldn't load more bars. Paused." }));
      })
      .finally(() => {
        refillingRef.current = false;
      });
  }, [fetchWindow, nominalMs]);

  // --- controls -------------------------------------------------------------

  const stepForward = useCallback(() => {
    const cur = latest.current;
    // The report card is a one-way door: once the reveal is on screen the user
    // has seen the real dates, so nothing may reveal another bar. Gated here
    // rather than in the pill so a caller the pill does not own (the playback
    // timer, a future keyboard shortcut) cannot route around it.
    if (cur.state.mode !== "active" || reportOpenRef.current) return;
    const res = storeResRef.current;
    const nominal = nominalMs(res);
    // Only step onto a bar that already has a LOADED successor (hasLoadedSuccessor
    // carries the why, and refillIfNeeded's end-of-session check reads the SAME
    // predicate so the two cannot drift apart).
    const next = hasLoadedSuccessor(barsRef.current, cur.state.cursorMs, nominal)
      ? nextCursorMs(barsRef.current, cur.state.cursorMs, nominal)
      : null;
    if (next == null) {
      setState((s) => ({ ...s, playing: false }));
      refillIfNeeded();
      return;
    }
    setState((s) => ({
      ...s,
      cursorMs: next,
      highWaterMs: Math.max(s.highWaterMs, next),
      // The guard above just proved another loaded bar follows, so a store that
      // had reached the live edge and has since grown is no longer at the end.
      atEnd: false,
      error: null,
    }));
    // Advance the book over the bar this step just revealed, BEFORE painting it,
    // so the fills and the candle land in the same frame.
    const idx = revealedCount(barsRef.current, next, nominal) - 1;
    const newBar = barsRef.current[idx];
    // Fills only ever happen when the cursor moves PAST the high-water mark: a
    // replayed-again bar must not re-trigger the orders it already filled.
    if (newBar && shouldAdvanceAt(next, cur.state.highWaterMs)) {
      publishLedger(advanceBar(ledgerRef.current, newBar, next), next);
    } else {
      publishLedger(ledgerRef.current, next); // re-mark P&L at the new cursor
    }
    applySlice(next, true);
    refillIfNeeded();
  }, [applySlice, nominalMs, publishLedger, refillIfNeeded]);

  const stepBack = useCallback(() => {
    const cur = latest.current;
    // Rewinding reveals nothing new, but it does REPAINT the series under a card
    // that is reporting on a cursor which would no longer be the session's. The
    // card is a terminal state; leave the chart where the reveal describes it.
    if (cur.state.mode !== "active" || reportOpenRef.current) return;
    const prev = prevCursorMs(barsRef.current, cur.state.cursorMs, nominalMs(storeResRef.current));
    if (prev == null) return;
    // High-water is NEVER lowered: rewind is a view-only move, so trades cannot
    // un-happen and no order may be placed until the cursor returns.
    setState((s) => ({ ...s, cursorMs: prev, playing: false, atEnd: false }));
    // Re-mark, never advance: the book is frozen while rewound, but its uPnL must
    // be the P&L AT the bar on screen. Leaving it marked at the high-water price
    // would print a number derived from bars the user has rewound past — the same
    // lookahead the rewind is supposed to undo.
    publishLedger(ledgerRef.current, prev);
    applySlice(prev, false);
  }, [applySlice, nominalMs, publishLedger]);

  const togglePlay = useCallback(() => {
    // Same one-way door as stepForward. The card also sets `playing: false` on
    // its way up, but that alone would leave Play as a way back INTO the session.
    setState((s) => (s.mode === "active" && !reportOpenRef.current ? { ...s, playing: !s.playing } : s));
  }, []);

  const setSpeed = useCallback((ms: number) => setState((s) => ({ ...s, speedMs: ms })), []);

  // --- trading --------------------------------------------------------------

  /** Trading is live only at the session's leading edge. While rewound the book
   * is frozen: trades cannot un-happen, so letting the user act on bars they have
   * already seen would be trading with hindsight. */
  const canTrade =
    state.mode === "active" && pendingReport === null && canPlaceAt(state.cursorMs, state.highWaterMs);

  /** The gate, re-read from `latest` at CALL time. The two actions that transact
   * a price (place, closeTrade) both go through this rather than trusting the
   * `canTrade` their button was rendered with: a playback tick can move the
   * cursor between the render and the click, and — the reason this is a function
   * and not just a flag — not every caller is a gated button. ChartCore hands the
   * trade pills their actions on `mode === "active"` alone, so the entry pill's ✕
   * stays live while the ticket's Buy/Sell are visibly disabled.
   *
   * `cancel` and `edit` are deliberately NOT gated. Cancelling transacts no
   * price, so hindsight buys nothing; and an edited level can only ever be tested
   * against bars past the high-water mark, because shouldAdvanceAt already stops
   * the book re-advancing over bars it has already played. That stays true with
   * the report card up: neither can move the P&L the card is reporting, and the
   * whole book is discarded a click later.
   *
   * A pending REPORT closes the gate for the same reason it stops playback: the
   * reveal has already shown the user the real dates, so a fill booked after it
   * would be a fill taken with hindsight. */
  const tradingOpen = useCallback((): boolean => {
    const { state: s } = latest.current;
    return s.mode === "active" && !reportOpenRef.current && canPlaceAt(s.cursorMs, s.highWaterMs);
  }, []);

  const place = useCallback(
    (a: {
      side: "buy" | "sell";
      quantity: number;
      type: "market" | "limit";
      price: number | null;
      stop: number | null;
      takeProfit: number | null;
    }) => {
      const cur = latest.current;
      if (!tradingOpen()) return;
      const mark = markPriceNow();
      if (mark == null) return;
      publishLedger(
        a.type === "market"
          ? placeMarket(ledgerRef.current, {
              side: a.side,
              quantity: a.quantity,
              price: mark,
              stop: a.stop,
              takeProfit: a.takeProfit,
              atMs: cur.state.cursorMs,
            })
          : placeLimit(ledgerRef.current, {
              side: a.side,
              quantity: a.quantity,
              limit: a.price ?? mark,
              stop: a.stop,
              takeProfit: a.takeProfit,
              atMs: cur.state.cursorMs,
            }),
      );
    },
    [markPriceNow, publishLedger, tradingOpen],
  );

  // Gated for the same reason `place` is, and it is the one that actually bites:
  // closing while rewound would book the exit at a bar the user has already
  // watched print (they step back precisely because they know what came next),
  // and it would stamp exitMs behind an earlier trade's, making closed[] no
  // longer monotonic in exit time for the report card.
  const closeTrade = useCallback(
    (id: string) => {
      if (!tradingOpen()) return;
      const mark = markPriceNow();
      if (mark == null) return;
      publishLedger(closeAt(ledgerRef.current, id, mark, latest.current.state.cursorMs));
    },
    [markPriceNow, publishLedger, tradingOpen],
  );

  const cancel = useCallback(
    (id: string) => publishLedger(cancelOrder(ledgerRef.current, id)),
    [publishLedger],
  );

  const edit = useCallback(
    (id: string, e: { price?: number | null; stop?: number | null; takeProfit?: number | null }) =>
      publishLedger(editLevels(ledgerRef.current, id, e)),
    [publishLedger],
  );

  /** Drop everything that belongs to the CURRENT session: the bar store, the
   * book, the persisted record, and any fetch still in flight for it. The caller
   * decides what mode to land in. */
  const endSession = useCallback(() => {
    reqSeq.current++;
    barsRef.current = [];
    clearReplaySession(latest.current.scope);
    // A report card describes a session; it cannot outlive one. dismissReport
    // has already cleared it on the normal path, but the symbol-change guard
    // calls `exit` OUTRIGHT — without this, changing instrument while the reveal
    // is up would leave the card floating over a live chart, its Done button the
    // only way to dismiss chrome for a session that no longer exists. Above the
    // early return, because this belongs to every teardown.
    setPendingReport(null);
    restartAfterReport.current = false;
    // Everything below is the handover of the TRADE LAYER, and only a session
    // that was actually RUNNING ever took it. enterPicking lands here from `off`
    // too (the toolbar's "start replay" button), and on a cell that never
    // replayed the layer still holds the account's own book: clearing it there
    // would blink every real position line out and back across a round-trip, and
    // fire a needless fetch, for a user who has merely opened the picker.
    if (latest.current.state.mode !== "active") return;
    // Hand the BACKTEST layer back before the trade layer. Every teardown lands
    // here — the report card's Done (via exit / enterPicking), the pill's ⟲, and
    // the symbol-change exit — so this is the one place that guarantees a session
    // ended with the reveal still ON leaves the cell showing its real saved
    // result rather than the slice frozen at the last cursor. Gated on the ref so
    // a cell that never revealed anything is untouched: its backtest is already
    // whatever the load effect drew, and a needless rehydrate would blink the
    // panel. The toggle itself stays as the user left it (like `speedMs`), so the
    // next session on this cell reveals again if they had it on.
    if (showStrategyRef.current) restoreSavedBacktest();
    // The book dies with the session — including on "pick new start", which
    // begins a fresh one and must not inherit the last one's positions. The ref
    // is cleared alongside the state because callers act synchronously after
    // this, long before the next render would have synced it.
    setLedger(emptyLedger());
    ledgerRef.current = emptyLedger();
    // Hand the layer back to the account. Refreshing is NOT optional: the global
    // trades feed is EVENT-driven (a fetch on subscribe, then only on actions and
    // backend pushes), so without it the cell would show no position lines at all
    // until the next trade event — possibly for the rest of the day.
    handle.tradesRef.current = [];
    refreshTrades();
  }, [handle, restoreSavedBacktest]);

  // Opening the picker from an ACTIVE session ENDS that session (Task 7 wires the
  // pill's "pick new start" here). Anything less would leave replay bars on the
  // chart under an `off` mode, and a reload would resurrect the stale record.
  // Bumping the epoch while the mode is no longer active sends the load effect
  // down its normal path, which restores the live bars the user picks on.
  const enterPicking = useCallback(() => {
    const wasActive = latest.current.state.mode === "active";
    endSession();
    setState((s) => ({ ...OFF, speedMs: s.speedMs, mode: "picking" }));
    if (wasActive) setReplayEpoch((n) => n + 1);
  }, [endSession]);

  const cancelPicking = useCallback(() => {
    // A startAt still in flight must not resurrect a session the user backed out of.
    reqSeq.current++;
    setState((s) => (s.mode === "picking" ? { ...OFF, speedMs: s.speedMs } : s));
  }, []);

  const startAt = useCallback(
    (startTs: number, opts: { masked: boolean }) => {
      const res = latest.current.resolution;
      const seq = ++reqSeq.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      void fetchWindow(res, startTs)
        .then(({ bars, degraded }) => {
          if (seq !== reqSeq.current) return; // cancelled / exited / superseded
          if (degraded) {
            setState((s) => ({ ...s, loading: false, error: OUTAGE_MSG }));
            return;
          }
          const cursor = cursorForStartTs(bars, startTs, nominalMs(res));
          if (cursor == null) {
            setState((s) => ({ ...s, loading: false, error: "No candles at that point. Pick another." }));
            return;
          }
          barsRef.current = bars;
          storeResRef.current = res;
          setState((s) => ({
            ...s,
            mode: "active",
            startMs: cursor,
            cursorMs: cursor,
            highWaterMs: cursor,
            masked: opts.masked,
            playing: false,
            atEnd: false,
            loading: false,
            error: null,
          }));
          // Re-run the load effect: it repaints through barsFor and skips the
          // websocket, and rehydrates drawings/indicators for the new window.
          setReplayEpoch((n) => n + 1);
        })
        // Without this the spinner would never clear on a network failure (and
        // the rejection would surface as an unhandled one).
        .catch(() => {
          if (seq !== reqSeq.current) return;
          setState((s) => ({ ...s, loading: false, error: "Couldn't load candles. Try again." }));
        });
    },
    [fetchWindow, nominalMs],
  );

  const randomJump = useCallback(
    (windowMs: number, masked: boolean) => {
      const res = latest.current.resolution;
      const seq = ++reqSeq.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      void (async () => {
        // A degraded read is usually a real outage, but not always: asking a
        // broker for minute candles from a year ago times out precisely because
        // that history does not exist, and reporting "broker unreachable" for it
        // sends the user looking at their connection. So one is spent asking
        // again much nearer to now, where the answer is cheap and often cached.
        let lastDegraded: string | null = null;
        // The backend bounds how long it spends filling history and says so
        // (X-Candles-Partial). An empty page under that marker does not mean the
        // history is absent, only that the download has not got there yet, so it
        // must not end up reported as "no candles at this timeframe".
        let sawPartial = false;
        for (let attempt = 0; attempt < MAX_JUMP_ATTEMPTS; attempt++) {
          if (seq !== reqSeq.current) return; // cancelled / exited / superseded
          const { targetMs } = pickJumpTarget({
            nowMs: Date.now(),
            windowMs,
            attempt,
            random: Math.random,
          });
          // Bounded, because a read this deep does not merely fail slowly: asking
          // a broker for year-old MINUTE candles can hang for minutes with no
          // answer at all, and the picker would sit on "Finding candles..."
          // forever. A jump is the one read that can afford a deadline, having
          // five other places it could land.
          const ctrl = new AbortController();
          const timer = window.setTimeout(() => ctrl.abort(), JUMP_READ_TIMEOUT_MS);
          const { bars, degraded, partial } = await fetchWindow(res, targetMs, ctrl.signal)
            .catch(() => ({
              bars: [] as KLineData[],
              degraded: ctrl.signal.aborted ? TIMEOUT_MSG : OUTAGE_MSG,
              partial: null,
            }))
            .finally(() => window.clearTimeout(timer));
          if (seq !== reqSeq.current) return;
          if (degraded) {
            lastDegraded = degraded;
            // Plus the loop's own step. This can skip past a depth that would
            // have worked, which is the trade: a read that did not arrive says
            // nothing about where the data starts, and creeping down one halving
            // at a time would cost another slow read to find out.
            attempt += DEGRADED_SKIP;
            continue;
          }
          // A read that ARRIVED, empty or not, is the better witness: it says the
          // history really does stop here rather than that the ask was too deep.
          // Without this, one deep timeout would keep speaking for the whole run
          // and report a broker problem where the answer is the timeframe.
          lastDegraded = null;
          if (partial) sawPartial = true;
          const cursor = cursorForStartTs(bars, targetMs, nominalMs(res));
          if (cursor == null) continue; // dead zone or history floor: halve and re-roll
          barsRef.current = bars;
          storeResRef.current = res;
          setState((s) => ({
            ...s,
            mode: "active",
            startMs: cursor,
            cursorMs: cursor,
            highWaterMs: cursor,
            masked,
            playing: false,
            atEnd: false,
            loading: false,
            error: null,
          }));
          setReplayEpoch((n) => n + 1);
          // Nothing on screen says the jump landed in a fraction of the window
          // that was asked for: a blind session shows no date at all, and a
          // dated one shows where it landed but never why. Two halvings (a
          // quarter of the window or less) is where that stops being a detail.
          if (attempt >= 2) toast("No candles that far back, so the jump stayed closer to now.");
          return;
        }
        setState((s) => ({
          ...s,
          loading: false,
          // The broker's own reason wins when there was one: a jump that only
          // ever saw timeouts has learned nothing about the timeframe.
          //
          // Otherwise NOT "try a wider one": by now the search has halved its
          // way down to roughly a hundredth of the window and still found
          // nothing, so more history is the one thing that cannot help. A
          // coarser timeframe is what the broker actually keeps further back.
          error:
            lastDegraded ??
            (sawPartial
              ? "Still loading history for that range. Try again in a moment."
              : "No candles at this timeframe. Try a higher one."),
        }));
      })();
    },
    [fetchWindow, nominalMs],
  );

  const exit = useCallback(() => {
    endSession();
    setState((s) => ({ ...OFF, speedMs: s.speedMs }));
    setReplayEpoch((n) => n + 1); // load effect restores live data + the stream
  }, [endSession]);

  /** Both UI ways OUT of a session (the pill's ✕ and its ⟲): show what happened
   * first. `exit` itself stays the immediate teardown, because the symbol-change
   * guard below has to end the session outright — a card asking the user to
   * acknowledge a reveal cannot stand between them and a chart they just
   * navigated away from.
   *
   * A session with no trades has no book to report on, so it skips the card
   * entirely and takes the teardown it was headed for. A modal that says nothing
   * happened is worse than no modal.
   *
   * A BLIND one still owes the user the reveal (the picker promised the real
   * dates on exit), so that goes out as a toast instead: the same fact, without
   * a dialog to dismiss. The card stays the moment there is a book to show,
   * where its numbers are the reason to stop and read. An open position counts
   * as a trade — it is the one that has not finished yet. */
  const finishSession = useCallback(
    (restart: boolean) => {
      const s = latest.current.state;
      const sum = summarize(ledgerRef.current);
      if (sum.trades === 0 && sum.openPositions === 0) {
        const fmt = latest.current.formatReal;
        // A session exited without stepping has one instant, not a range, and
        // "X to X" reads like a bug.
        if (s.masked && fmt) {
          const start = fmt(s.startMs);
          toast(s.cursorMs > s.startMs ? `Replay was ${start} to ${fmt(s.cursorMs)}` : `Replay was ${start}`);
        }
        if (restart) enterPicking();
        else exit();
        return;
      }
      restartAfterReport.current = restart;
      setPendingReport({ summary: sum, startMs: s.startMs, cursorMs: s.cursorMs, masked: s.masked });
      setState((st) => ({ ...st, playing: false }));
      // Drop the persisted record NOW, not at dismissal. The session stays
      // `active` behind the card, so without this a tab closed while the reveal
      // is on screen would resurrect a MASKED session on reload — one whose real
      // dates the user has already been shown. The debounced save effect is gated
      // on `pendingReport` for the same reason (and its cleanup cancels any write
      // a step queued in the last 400ms, which would otherwise re-write the
      // record right after this clear).
      clearReplaySession(latest.current.scope);
    },
    [enterPicking, exit],
  );

  const requestExit = useCallback(() => finishSession(false), [finishSession]);
  const requestNewStart = useCallback(() => finishSession(true), [finishSession]);

  /** The card's ONLY exit, reached from its Done button and from Escape alike.
   * Note that after a ⟲ this lands in the picker rather than at `off`: the user
   * asked for another session, and the card was only the reveal owed to them for
   * the one they are leaving. */
  const dismissReport = useCallback(() => {
    const restart = restartAfterReport.current;
    restartAfterReport.current = false;
    setPendingReport(null);
    // Both teardowns run endSession, which is what makes the next session a
    // genuinely fresh blind one: the store, the book (state AND ref) and the
    // persisted record all go, and the OFF spread resets startMs / cursorMs /
    // highWaterMs / masked so the new session arms its own anchor and its own
    // mask rather than inheriting this one's.
    if (restart) enterPicking();
    else exit();
  }, [enterPicking, exit]);

  // --- playback timer -------------------------------------------------------

  useEffect(() => {
    // `pendingReport` is belt-and-braces on top of stepForward's own gate and the
    // `playing: false` the card sets: it tears the interval DOWN rather than
    // leaving one ticking into a no-op ten times a second.
    if (state.mode !== "active" || !state.playing || pendingReport) return;
    const id = window.setInterval(stepForward, state.speedMs);
    return () => window.clearInterval(id);
  }, [state.mode, state.playing, state.speedMs, stepForward, pendingReport]);

  // --- the strategy reveal, redrawn at the cursor ---------------------------
  //
  // Is there anything to reveal? Re-read on every MODE change rather than once
  // per mount, so a backtest the user runs on this cell just before starting a
  // session enables the button (and one they clear disables it). Cheap: a single
  // localStorage read at a transition the user drove, and React bails out of the
  // re-render when the boolean is unchanged.
  useEffect(() => {
    setHasStrategy(loadBacktestResult(scope, epic) != null);
  }, [scope, epic, state.mode]);

  // Re-render the revealed slice whenever the cursor moves (coalesced to a frame:
  // 10x playback steps every 100ms and renderArtifacts rebuilds overlays).
  useEffect(() => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    if (state.mode !== "active" || !showStrategy) return;
    // A series (re)load is in flight — a session start, a timeframe switch, or a
    // resumed session's first store read. The load effect has already torn this
    // cell's artifacts down synchronously and is about to replace the bars under
    // them, possibly at another resolution. Drawing against the outgoing bars
    // would anchor markers to candles that are about to be discarded, so skip the
    // frame and DROP the signature: the redraw that follows the settled load must
    // not be dismissed as "unchanged".
    if (state.loading) {
      revealSigRef.current = "";
      return;
    }
    const saved = loadBacktestResult(scope, epic);
    if (!saved) return;
    const raf = requestAnimationFrame(() => {
      const cur = latest.current;
      // Re-read the gate at FIRE time rather than trusting the render this frame
      // was scheduled in — the same reason stepForward reads `reportOpenRef` and
      // `place` re-calls `tradingOpen` instead of the flag their button rendered
      // with. A SYMBOL CHANGE is where it bites: this effect is declared before
      // the symbol-change guard, so on the epic's commit it runs first (mode
      // still `active`) and schedules a frame; the guard then calls exit(), whose
      // endSession restores the real result synchronously. Nothing but React's
      // scheduling promises the cancel wins that race, and a frame that landed
      // late would republish a truncated slice on top of the restore — filtered
      // at the OLD cursor, for the NEW instrument.
      if (cur.state.mode !== "active" || !showStrategyRef.current) return;
      // No bars painted yet (a resumed session between mount and its first store
      // read): nothing for a marker to anchor to, and no signature recorded, so
      // the load that follows still draws.
      if (!(chart.getDataList()?.length ?? 0)) return;
      const shown = filterResultToCursor(saved, cur.state.cursorMs);
      // What actually needs DRAWING, as opposed to what merely changed. The
      // equity curve grows by a point on every single step (the engine emits one
      // point per bar), so a signature that included it would never dedup
      // anything — and the redraw it gated is the destructive one: a full
      // teardown + render rebuilds every marker overlay ten times a second at
      // 10x, and teardownArtifacts nulls selectedTradeSignal /
      // highlightTradeSignal, so a trade row the user clicked to study vanishes
      // within a tenth of a second, permanently, in the exact mode where they
      // are watching it play out.
      //
      // So the two are split. This signature covers only what a full render is
      // needed for: the overlays (markers, and the regions/period bands drawn
      // beside them) and the marker MODE, which follows the display resolution
      // even when no count moved. `regions` earns its place here rather than
      // riding along with equity: once downsampleEquity makes the curve sparse,
      // the equity length stops moving every step and a newly-closed region
      // would otherwise never get drawn.
      const sig = [
        cur.resolution,
        shown.markers.length,
        shown.trades.length,
        shown.regions?.length ?? 0,
      ].join(":");
      // Nothing new to draw: advance the curve and the panel's running numbers
      // in place, leaving the overlays and the user's selection alone.
      //
      // The `&&` is load-bearing, and its absence is what made the whole feature
      // inoperative in the browser while this file's unit tests were green.
      // updateShownResult refuses (returns false) whenever this chart no longer
      // backs the panel — which is routine, because the load effect tears these
      // artifacts down and clears the panel on every replayEpoch bump, AFTER the
      // reveal has already drawn. Discarding that `false` left the reveal
      // convinced its signature was still on screen when nothing was, and it
      // never drew again for the rest of the session. Falling through to the
      // full render makes the reveal self-healing: whoever wiped it, and
      // whenever, the next fire rebuilds.
      if (revealSigRef.current === sig && updateShownResult(chart, shown)) return;
      revealSigRef.current = sig;
      teardownArtifacts(chart);
      const flags = backtestRenderFlags(cur.resolution, saved.resolution);
      renderArtifacts(chart, shown, { markerMode: flags.markerMode, canEquity: flags.drawEquity });
      // Published with THIS exact object, the way rehydrateBacktest does: the
      // hover/selection sync renderArtifacts installs is identity-gated on it,
      // and teardownArtifacts' ownership check reads the same identity.
      backtestResultSignal.set(shown);
    });
    return () => cancelAnimationFrame(raf);
    // `state.storeSeq` is what re-runs this after a series load has repainted the
    // chart and taken the reveal's artifacts with it (see its note on
    // ReplayUiState). Without it the reveal draws once at session start and is
    // then dead for the rest of the session, because the load effect's teardown
    // and panel clear land afterwards and change none of the other deps.
  }, [
    state.mode,
    state.cursorMs,
    state.loading,
    state.storeSeq,
    showStrategy,
    scope,
    epic,
    resolution,
    handle,
  ]);

  // --- persistence ----------------------------------------------------------
  //
  // Debounced: play at 10x fires a step every 100ms, and each write serializes
  // the whole record. Device-local (saveReplaySession → saveLocal).
  //
  // Debounced, but with a CEILING on how long the debounce may starve the write.
  // A pure 400ms trailing debounce is silently broken at speed: this effect
  // re-runs on every step (both `state.cursorMs` and `ledger` change, the latter
  // a fresh object out of every publishLedger), and its cleanup clears the timer
  // — so at 5x (200ms) and 10x (100ms) the timer is re-armed before it can ever
  // fire and NOTHING is written for the whole run. Reload or close the tab
  // mid-playback and the session came back at the cursor from before you pressed
  // play, with every fill booked during the run gone. 1x and 2x are slower than
  // the debounce, which is why it looked fine.
  const lastSaveMsRef = useRef(0);
  useEffect(() => {
    // A session under the report card is over in every sense but its mode, and
    // finishSession has already cleared its record. Re-running the effect on
    // `pendingReport` is what cancels a write a recent step had queued.
    if (state.mode !== "active" || pendingReport) return;
    const write = () => {
      lastSaveMsRef.current = Date.now();
      saveReplaySession(scope, {
        epic,
        resolution,
        startMs: state.startMs,
        cursorMs: state.cursorMs,
        highWaterMs: state.highWaterMs,
        masked: state.masked,
        showStrategy,
        ledger: ledgerRef.current,
        savedAt: Date.now(),
      });
    };
    // Past the ceiling: write NOW rather than arming a timer this run's next step
    // would cancel. Bounds worst-case loss to one SAVE_MAX_GAP_MS window instead
    // of the whole playback run, while a burst still coalesces to one write.
    if (Date.now() - lastSaveMsRef.current >= SAVE_MAX_GAP_MS) {
      write();
      return;
    }
    const id = window.setTimeout(write, 400);
    return () => window.clearTimeout(id);
  }, [state.mode, state.startMs, state.cursorMs, state.highWaterMs, state.masked, showStrategy, ledger, epic, resolution, scope, pendingReport]);

  // Entering a session hands the trade-line layer over to the book. The
  // subscribeTrades guard in ChartCore only stops LATER account updates; whatever
  // the layer already held is still drawn, and in a masked session that is a leak
  // rather than merely a wrong book: a real position's openedAt is ~now, so the
  // pills format it against the hidden anchor and print "Day 1832" — the day
  // count from which the start date follows by subtraction. Same class of hole as
  // the stranded crosshair guide ChartCore clears on this transition.
  //
  // Keyed on the MODE alone. barsFor's publish covers the mark once the store
  // lands (and is the only one a session whose first load was degraded ever
  // gets); adding the cursor here would double-publish on every step, ten times a
  // second at 10x.
  useEffect(() => {
    if (state.mode !== "active") return;
    publishLedger(ledgerRef.current);
  }, [state.mode, publishLedger]);

  // --- higher-timeframe no-lookahead ---------------------------------------
  //
  // Publish this cell's cursor to the MTF coordinator, so every higher-timeframe
  // series it computes stops at the same closed-bar boundary the chart does (an
  // EMA pinned to 1H on a 15m replay must not read the hour the cursor is inside
  // — the backend serves that bucket fully aggregated).
  //
  // Registered ONCE and left in place: the reader reports 0 while the cell is
  // not replaying, so it is correct before the first session and after the last.
  // `handle` is a useMemo([]) holding one chart per mount, and the chart-init
  // effect runs earlier in ChartCore's hook order, so chartRef is already set.
  // Ordering is belt-and-braces anyway: fetchHtfBars reads the clamp AFTER its
  // awaits, so a fetch already in flight when a session starts is clamped on
  // resolution too.
  useEffect(() => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    setHtfCursorClamp(chart, () =>
      latest.current.state.mode === "active" ? latest.current.state.cursorMs : 0,
    );
    // Same registration, same lifetime, for the panel-publishing decisions in
    // lib/backtest: App's cross-tab push handler reaches a chart without its
    // ChartHandle, so it cannot ask `replayRef` and needs a chart-keyed answer.
    // Derived from the same `latest` the handle's isActive() reads, so the two
    // cannot disagree about whether this cell is replaying.
    registerReplayingChart(chart, () => latest.current.state.mode === "active");
    return () => {
      setHtfCursorClamp(chart, null);
      registerReplayingChart(chart, null);
    };
  }, [handle]);

  // The cursor crossing a higher-timeframe bar close makes previously-illegal HTF
  // data legal, so the pinned series must be re-fetched (and re-clamped) as the
  // cursor advances.
  //
  // Keyed on the BUCKET the cursor sits in, not on the cursor: the set of closed
  // HTF bars can only change when that index changes, so a 10x play refetches
  // once per released HTF bar instead of once per step. A debounce (the shape the
  // plan sketched) is wrong in both directions — at 10x the 100ms steps would
  // re-arm it forever so it never fires, and at 1x it would fire every second,
  // walking every MTF indicator's history pages to reveal one hourly bar.
  //
  // The index grids on the UNIX EPOCH, which is a refresh trigger and never a
  // correctness input (the clamp is applied at fetch time, whoever triggered the
  // fetch). Two things make it approximate, both erring stale rather than early,
  // both self-correcting at the next crossing: bucket PHASE (a WEEK pin's epoch
  // grid turns over on Thursday while the weekly bar closes Sunday/Monday, so a
  // release can lag by a few days of replay time) and, for the derived widths
  // (WEEK_2, the MONTH_N family, YEAR), bucket WIDTH.
  //
  // Session START and EXIT are NOT handled here: both bump replayEpoch, and the
  // load effect they re-run calls refreshMtfIndicators itself — clamped on the
  // way in (mode is already active), unclamped on the way out (the reader reports
  // 0), which is what stops a session's truncated series from outliving it. The
  // first run of a session therefore only RECORDS its bucket: refreshing here too
  // would double every pinned indicator's HTF paging at session entry.
  const mtfBucketRef = useRef<number | null>(null);
  const mtfRefreshingRef = useRef(false);
  useEffect(() => {
    if (state.mode !== "active") {
      mtfBucketRef.current = null;
      return;
    }
    const chart = handle.chartRef.current;
    if (!chart) return;
    const bucket = mtfBucketMs(chart);
    if (!bucket) return; // nothing pinned to a higher timeframe: nothing to refresh
    const idx = Math.floor(state.cursorMs / bucket);
    if (mtfBucketRef.current === idx) return;
    if (mtfBucketRef.current === null) {
      // Session entry: the load effect's own refresh covers this cursor.
      mtfBucketRef.current = idx;
      return;
    }
    // One refresh at a time. Skipping is safe rather than lossy: the in-flight
    // fetch reads the clamp at its END, so it already clamps to the newer cursor,
    // and the index is only recorded when a refresh actually starts — so a step
    // that arrives while one is running still triggers the next one.
    if (mtfRefreshingRef.current) return;
    mtfBucketRef.current = idx;
    mtfRefreshingRef.current = true;
    void refreshMtfIndicators(chart, latest.current.epic, latest.current.brokerId)
      .catch(() => {}) // a broker outage is the coordinator's own retry to handle
      .finally(() => {
        mtfRefreshingRef.current = false;
      });
  }, [state.mode, state.cursorMs, handle]);

  // A symbol change ends the session: the cursor addresses one instrument's bars.
  const prevEpicRef = useRef(epic);
  useEffect(() => {
    if (prevEpicRef.current === epic) return;
    prevEpicRef.current = epic;
    if (latest.current.state.mode === "off") return;
    toast("Replay ended: the symbol changed.");
    exit();
  }, [epic, exit]);

  return {
    state,
    enterPicking,
    cancelPicking,
    startAt,
    randomJump,
    stepForward,
    stepBack,
    togglePlay,
    setSpeed,
    exit,
    replayEpoch,
    requestExit,
    requestNewStart,
    pendingReport,
    dismissReport,
    ledger,
    canTrade,
    place,
    closeTrade,
    cancel,
    edit,
    // Computed during RENDER, where `latest` is fresh, so this is the mark for
    // the cursor currently on screen.
    markPrice: markPriceNow(),
    showStrategy,
    hasStrategy,
    toggleStrategy,
  };
}
