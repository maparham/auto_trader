// Data-load + live-stream effect for a ChartCore cell, extracted verbatim from
// ChartCore. On a symbol/period/side/broker change it: reloads recent history,
// rehydrates the epic's overlays/backtest/AVWAP anchors, kicks the coverage
// walks (through handle bridge refs), and opens the live stream that applies
// per-tick candles + drives the pills. Behavior is identical to the in-component
// effect — every value the original read from ChartCore's closure is supplied
// here via `handle.*`, a module import, or an explicit `deps` field.
import { useEffect, useRef } from "react";
import { type KLineData } from "klinecharts";
import {
  fetchRecent,
  openLive,
  type Instrument,
  type Period,
} from "../lib/feed";
import type { PriceSide } from "../theme";
import { synthPrecision } from "./chartPainters";
import { periodFromTf } from "./chartDataFacade";
import {
  teardownArtifacts,
  rehydrateBacktest,
  selectedTradeForChart,
  restoreTradeSelection,
} from "../lib/backtest";
import { toast } from "../lib/notify";
import { loadAvwapAnchor } from "../lib/persist";
import { loadSnapshotMeta, saveSnapshotMeta, type SnapshotMeta } from "../lib/persist";
import { renderSnapshotMarker } from "../lib/snapshotMarker";
import { applyIndicatorVisibility, forceCollapseSubPanes, getIndicatorsByPane } from "../lib/indicators";
import { maybeAutoApplyTemplate } from "../lib/templates";
import { indTypeOf } from "../lib/customIndicators";
import { applyVisibleRange } from "../lib/chartSync";
import { refreshMtfIndicators } from "../lib/mtfCoordinator";
import { setLivePrice } from "../lib/trading";
import { isSynthetic, setSyntheticPrecision } from "../lib/syntheticRegistry";
import type { LiveStatus } from "../lib/feed";
import type { ChartHandle } from "./chartHandle";

export interface LiveMarketDataDeps {
  symbol: Instrument;
  brokerId: string;
  priceSide: PriceSide;
  period: Period;
  scope: string;
  effPrecision: number;
  // State setters (identity-stable across renders).
  setStatus: (s: LiveStatus) => void;
  setLastPrice: (p: number | null) => void;
  setHasData: (v: boolean) => void;
  setLoadError: (v: string | null) => void;
  setErrorOpen: (v: boolean) => void;
  setFetchedPrecision: (p: number | null) => void;
  setSnapView: (m: SnapshotMeta | null) => void;
  setActiveRange: (k: import("../lib/rangeWindow").RangeKey | null) => void;
  setMarketClosed: (v: boolean) => void;
  // Refs shared with paint/status code that stays in ChartCore (not on the handle).
  sepCacheRef: React.MutableRefObject<{ ts: number; tz: string; theme: string; label: string; accent: string } | null>;
  lastCandleAtRef: React.MutableRefObject<number>;
  marketClosedRef: React.MutableRefObject<boolean>;
  // Callbacks that stay in ChartCore (called across the extraction boundary).
  unlockSnapshotView: () => void;
  coverBacktestTradeTo: (fromTs: number) => Promise<boolean>;
}

export function useLiveMarketData(handle: ChartHandle, deps: LiveMarketDataDeps) {
  const {
    symbol,
    brokerId,
    priceSide,
    period,
    scope,
    effPrecision,
    setStatus,
    setLastPrice,
    setHasData,
    setLoadError,
    setErrorOpen,
    setFetchedPrecision,
    setSnapView,
    setActiveRange,
    setMarketClosed,
    sepCacheRef,
    lastCandleAtRef,
    marketClosedRef,
    unlockSnapshotView,
    coverBacktestTradeTo,
  } = deps;

  const { controller, overlays } = handle;
  const { measureArmed, slopeArmed, rangePickArmed } = controller;

  // Effect-local state (only this effect reads/writes these), previously
  // ChartCore locals. Not shared → private refs here.
  const prevEpicRef = useRef(symbol.epic);
  const prevResRef = useRef(period.resolution);

  // Symbol / period changes -> reload history, (re)subscribe live, set scroll-back.
  useEffect(() => {
    const chart = handle.chartRef.current;
    const dataFacade = handle.dataFacadeRef.current;
    if (!chart || !dataFacade) return;
    let cancelled = false;

    // Declare the instrument (carries precision) + timeframe to v10. Both must be
    // set before the async setBars below, since v10 fires getBars(init) once
    // symbol+period+loader are all present; the facade serves stored bars, so the
    // extra init fire before setBars is harmless (empty until setBars runs).
    dataFacade.setSymbol(symbol.epic, effPrecision, 0);
    dataFacade.setPeriod(periodFromTf(period.label));
    overlays.setPricePrecision(effPrecision); // keep alert-level rounding in lockstep
    overlays.setEpic(symbol.epic);
    // Alerts are stored per broker; address them with THIS cell's broker (not the
    // ambient persistBroker the toolbar may flip mid-switch). In lockstep with setEpic.
    overlays.setBroker(brokerId);
    // Backtest markers/equity belong to the previous series — drop the live
    // artifacts immediately (keep the persisted result; rehydrateBacktest below
    // redraws it for the new series once its bars are loaded). Capture the
    // selected trade FIRST: teardown nulls the shared selection, so we grab it
    // here (while this chart still owns the panel) to re-center on it after the
    // switch. Fall back to a restore a superseded run never got to attempt, so
    // rapid TF switches don't drop the selection.
    const capturedSelectedTrade = selectedTradeForChart(chart) ?? handle.pendingTradeRestoreRef.current;
    teardownArtifacts(chart);
    // Reset scroll-back state for the new series.
    handle.loadingRef.current = false;
    handle.exhaustedRef.current = false;
    handle.emptyStreakRef.current = 0;

    // Drop a stale quick-range when this re-run isn't the range pick itself.
    // - Epic change: the boundary belongs to the OLD instrument's timeline — clear
    //   the separator, the pill, and any in-flight fit (it targeted the old series).
    // - Manual interval change (toolbar, no pending pick): the view no longer
    //   matches the preset, so drop the pill; the separator stays (a "start of
    //   today" marker is still valid at any interval).
    const epicChanged = prevEpicRef.current !== symbol.epic;
    const resChanged = prevResRef.current !== period.resolution;
    // Park the captured trade for the post-walk restore below. An epic change
    // loads a DIFFERENT backtest whose trade array the old index wouldn't map
    // onto — drop it instead.
    handle.pendingTradeRestoreRef.current = epicChanged ? null : capturedSelectedTrade;
    prevEpicRef.current = symbol.epic;
    prevResRef.current = period.resolution;
    // A symbol or interval change invalidates any live measurement (its anchors map
    // onto the old timescale) — discard it and disarm the ruler.
    if (epicChanged || resChanged) {
      measureArmed.set(false);
      overlays.clearMeasure();
      // A live slope line maps onto the old timescale too — discard it and disarm.
      slopeArmed.set(false);
      overlays.clearSlope();
      // A live Pick Range band is anchored to the old timescale too — disarm it.
      rangePickArmed.set(false);
      overlays.clearRangePick();
    }
    if (epicChanged) {
      handle.separatorTsRef.current = null;
      sepCacheRef.current = null;
      handle.pendingRangeRef.current = null;
      setActiveRange(null);
    } else if (resChanged) {
      // A pending pick whose target interval doesn't match the one that just
      // loaded was OVERRIDDEN (the user changed interval again before its walk
      // ran) — it can never be consumed (consumption requires resolution
      // equality below), and leaving it parked would permanently gate the
      // drawing-anchor coverage walk. Drop it along with the pill.
      if (handle.pendingRangeRef.current && handle.pendingRangeRef.current.resolution !== period.resolution) {
        handle.pendingRangeRef.current = null;
      }
      if (!handle.pendingRangeRef.current) setActiveRange(null);
    }
    // No data for the new series until history loads or a live tick arrives. The
    // banner is grace-gated, so this can't flash during a normal load — only when
    // the broker is genuinely unreachable.
    setHasData(false);
    setLoadError(null);
    setErrorOpen(false);

    (async () => {
      // Tolerate a failed initial load (offline/DNS/refused/CORS make fetchRecent
      // REJECT, not return []): fall back to no history and carry on. Crucially this
      // still reaches rehydrate() below, which advances overlays.hydratedEpic — skip
      // it and persist() stays gated on the stale epic forever, silently dropping
      // every alert/drawing the user adds until they switch symbol again.
      let bars: KLineData[];
      try {
        bars = await fetchRecent(symbol.epic, period.resolution, 500, priceSide, brokerId);
      } catch (err) {
        console.warn(`[chart] initial load failed for ${symbol.epic}; continuing with no history`, err);
        bars = [];
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled || !handle.chartRef.current) return;
      // Cursor starts at the oldest loaded bar; scroll-back requests older windows.
      handle.cursorSecRef.current = bars.length
        ? Math.floor(bars[0].timestamp / 1000)
        : Math.floor(Date.now() / 1000);
      // canLoadOlder arms left-edge scroll-back paging (the facade owns the v10
      // flag translation; onLoadRequest answers the loads). Live-only (seconds)
      // intervals have no history, so disable scroll-back there to avoid firing
      // empty fetchRange windows that walk back for nothing.
      dataFacade.setBars(bars, !period.liveOnly);
      if (isSynthetic(symbol.epic) && bars.length > 0) {
        const p = synthPrecision(bars[bars.length - 1].close);
        setFetchedPrecision(p);
        setSyntheticPrecision(symbol.epic, p);
      }
      // Live-only (seconds) intervals legitimately start empty and fill from the
      // stream, so don't badge them no-data on the empty history; the first tick
      // below flips hasData true. Native intervals with no history are genuinely
      // empty until proven otherwise.
      setHasData(bars.length > 0);
      // Anchor to the latest bars so the live/forming candle is on-screen.
      handle.chartRef.current.scrollToRealTime();
      // Rehydrate this symbol's saved drawings + alerts now that the data (and
      // therefore the timescale their points map onto) is loaded. Passing the
      // resolution makes rehydrate adopt it BEFORE points materialize — a
      // future-anchored point decodes its timestamp with the bar width, and a
      // trailing setResolution() call left it decoding with the PREVIOUS
      // timeframe's width on every switch (trendline slope changed, and the
      // next persist baked the drift in). This also re-derives each drawing's
      // per-interval visibility, so no separate setResolution call remains.
      // Read-only snapshot view must be set BEFORE rehydrate: it decides whether
      // drawings materialize locked and whether the epic's live alert lines
      // materialize at all. This is the one storage read; it re-asserts
      // controller.readOnly (whose subscription mirrors it into snapViewRef) and
      // refreshes the banner state (effect re-runs on TF switches; meta only
      // actually changes via Unlock).
      const markerMeta = loadSnapshotMeta(scope);
      controller.readOnly.set(markerMeta != null);
      setSnapView(markerMeta);
      overlays.setReadOnly(markerMeta != null);
      overlays.rehydrate(period.resolution);
      // Snapshot-moment marker: dashed vertical line + time-axis chip at the
      // taken-at timestamp of a restored snapshot tab, independent of the
      // pendingRange walk below. Remove the previous marker first — this effect
      // re-runs on every symbol/TF switch, and the old overlay id no longer
      // matches the freshly loaded series. Clicking the chip = Unlock (same flow
      // as the banner button).
      if (handle.snapMarkerIdRef.current) {
        handle.chartRef.current.removeOverlay({ id: handle.snapMarkerIdRef.current });
        handle.snapMarkerIdRef.current = null;
      }
      if (markerMeta) {
        handle.snapMarkerIdRef.current = renderSnapshotMarker(handle.chartRef.current, markerMeta, () => {
          unlockSnapshotView();
        });
      }
      // Restore this cell's saved backtest (markers/equity/trades) for the new
      // series — the backtest counterpart to overlays.rehydrate. Markers show on
      // the backtest's native timeframe and any finer one where fills align to
      // bars; equity only on the native one; a coarser timeframe draws nothing
      // but keeps the result saved. Republishes backtestResultSignal so the
      // trades panel + summary chip come back.
      // (Re-selecting the previously-studied trade waits until the coverage
      // walks below settle — see the anchor-coverage chain.)
      rehydrateBacktest(handle.chartRef.current, scope, symbol.epic, period.resolution);
      // Redraw position lines for the (possibly new) epic at the current precision.
      handle.posLinesRef.current?.setPrecision(effPrecision);
      handle.posDrawRef.current();
      // Same for the live trade markers — the epic's entry/exit arrows against the
      // freshly loaded bars (reconcile drops the old epic's markers).
      handle.tradeMarkersDrawRef.current();
      // Re-evaluate the selected-trade pill against the now-current epic: selecting a
      // dock row for an OFF-chart symbol switches the epic here, and the pill only
      // shows for a trade on this epic — so refresh once the rehydrate lands rather
      // than waiting for the next live tick.
      handle.redrawRef.current();
      // Mirror the drawings' interval filter for indicators: re-derive each
      // indicator's effective visibility (user intent AND interval match) against
      // the now-current resolution. Runs here so both a fresh rehydrate (above)
      // and a plain period switch (this effect re-runs on period.resolution) land
      // on the right on-chart state — a view reaction only, nothing persisted.
      // Guard: the sidebar "Hide indicators" master switch overrides this re-derive —
      // while it's on, re-assert all-hidden instead of un-hiding.
      applyIndicatorVisibility(handle.chartRef.current, period.resolution, controller.indicatorsHidden.value);
      // A symbol switch recreates the sub-panes at their default height, so re-assert
      // the double-click "hide bottom sub-panes" collapse if it's on. forceCollapse
      // (not collapseSubPanes) so it doesn't overwrite the captured heights with the
      // freshly-recreated defaults — the map from the original toggle is the source of
      // truth for restore (recreated panes have new ids and fall back to the default).
      if (controller.subPanesHidden.value) forceCollapseSubPanes(handle.chartRef.current);
      // A quick-range pick that switched interval parked its window here; the
      // initial new-resolution bars are loaded, so page back to the period start
      // (if needed) and fit. ensureCoverageAndFit clears pendingRangeRef when done.
      const pend = handle.pendingRangeRef.current;
      const rangeWalk =
        pend && pend.resolution === period.resolution && handle.chartRef.current
          ? handle.ensureCoverageAndFitRef.current(pend)
          : null;
      // Re-apply each AVWAP instance's anchor for this epic (anchors are per-epic,
      // per-instance; no-op if no AVWAP is active).
      const candlePane = getIndicatorsByPane(handle.chartRef.current).get("candle_pane");
      for (const [id, ind] of candlePane ?? []) {
        if (indTypeOf(ind) !== "AVWAP") continue;
        handle.chartRef.current.overrideIndicator({
          name: id,
          calcParams: [loadAvwapAnchor(scope, symbol.epic, id)],
        });
      }
      // Re-fetch HTF data for any EMA/MA pinned to a higher timeframe — the
      // stashed series belonged to the previous epic/range (no-op otherwise).
      void refreshMtfIndicators(handle.chartRef.current, symbol.epic, brokerId);

      // Auto-apply this symbol's default template onto a FRESH cell (no saved
      // indicators or drawings yet). Runs after rehydrate so the empty-cell gate
      // sees the final state; a populated/customized cell is left untouched.
      // Skip entirely for a restored snapshot tab (markerMeta non-null — written
      // unconditionally by writeSnapshotToScope): an empty snapshot has
      // no saved indicators/drawings either, so the auto-apply gate can't tell
      // it apart from a fresh cell, and would silently graft the symbol's default
      // template onto it, contradicting "restore reproduces the saved state exactly".
      if (!markerMeta) {
        maybeAutoApplyTemplate(handle.chartRef.current, controller, scope, symbol.epic);
      }

      // A restored snapshot tab parks a one-shot pendingRange on this scope's
      // snapshotMeta (see writeSnapshotToScope) — page history back to cover it.
      // Reuses coverBacktestTradeTo directly — it has no backtest-only guards,
      // just a generic bounded page-back-to-a-target walk that no-ops the
      // backtest-marker redraw when there's no rendered result. Both this walk
      // and the anchor walk below are already running by the time either
      // .then() fires — the chaining doesn't sequence their execution. What
      // actually prevents the two pagers from contending for loadingRef is
      // coverBacktestTradeTo's own pendingRangeRef bail (each walk gates the
      // others) plus the bounded loadingRef wait; the .then() chain only
      // controls when positionSnapshotRange/ensureAnchorCoverage run relative
      // to the pagers' settling. The snapshot range usually already covers the
      // restored drawings' anchors (captured inside that same window), so
      // ensureAnchorCoverage typically finds nothing left to do.
      const snapMeta = markerMeta;
      const pendingRange = snapMeta?.pendingRange ?? null;
      const snapshotWalk = pendingRange ? coverBacktestTradeTo(pendingRange.from) : null;
      // Position the window on the saved snapshot range and clear pendingRange
      // (one-shot — a later reload of this same tab must not re-scroll). Called
      // only once the walk(s) ahead of it have fully settled: paging via the
      // facade's setBars resets the view to realtime on every page it applies, so
      // positioning any earlier risks being clobbered by a later page (e.g. a
      // drawing anchor older than the snapshot's own saved range).
      const positionSnapshotRange = (reached: boolean) => {
        if (cancelled || !pendingRange) return;
        // A quick-range pick made right after restore preempts this walk (see
        // coverBacktestTradeTo's own pendingRangeRef bail, which is why `reached`
        // can be false here without history actually being exhausted). Bail
        // before touching the view or meta so the user's pick stands, and leave
        // pendingRange unconsumed on snapMeta — a later effect run (e.g. the next
        // symbol/TF switch) retries the snapshot positioning then.
        if (handle.pendingRangeRef.current !== null) return;
        const c = handle.chartRef.current;
        if (!c) return;
        const data = c.getDataList() ?? [];
        if (data.length === 0) return;
        const oldest = data[0].timestamp;
        applyVisibleRange(c, Math.max(pendingRange.from, oldest), pendingRange.to);
        // The marker chip's dismiss confirm (above) may have deleted this scope's
        // snapshotMeta while this walk was still in flight — re-check before
        // writing it back, otherwise this unconditionally resurrects the record
        // the user just removed. The positioning itself still applies: dismissing
        // the marker is a decision about the meta/marker, not the scroll.
        if (loadSnapshotMeta(scope)) {
          saveSnapshotMeta(scope, {
            snapshotId: snapMeta!.snapshotId,
            name: snapMeta!.name,
            takenAt: snapMeta!.takenAt,
          });
        }
        if (!reached && oldest > pendingRange.from) {
          toast("History doesn't reach the snapshot range — showing oldest available");
        }
      };

      // Page back (no fit) until every saved drawing anchor maps onto a loaded bar —
      // otherwise klinecharts clamps older anchors to the first loaded bar and the
      // drawing renders with the wrong slope on this interval. Runs AFTER the
      // template auto-apply so template-added drawings count. It's chained after
      // the quick-range walk and the snapshot walk above, but that chaining is
      // just ordering of the .then() callbacks — the walks themselves are already
      // running concurrently by then, and mutual exclusion for the loading mutex
      // comes from pendingRangeRef/loadingRef (each walk bails if another already
      // owns it), not from this chain. Live-only intervals have no history to
      // page, so the snapshot walk (which also no-ops without history) settles on
      // its own and positions directly.
      if (!period.liveOnly) {
        const baseWalk = snapshotWalk
          ? rangeWalk
            ? snapshotWalk.then(() => rangeWalk)
            : snapshotWalk
          : rangeWalk;
        const anchorWalk = baseWalk
          ? baseWalk.then(() => handle.ensureAnchorCoverageRef.current())
          : handle.ensureAnchorCoverageRef.current();
        if (snapshotWalk) {
          void anchorWalk.then(() => snapshotWalk.then(positionSnapshotRange)).catch(() => {});
        }
        // Re-select the trade the user was studying before the switch — only NOW,
        // once the switch-time coverage walks have settled. The walks prepend
        // pages via the facade's setBars, which resets the view to realtime each page; a
        // re-center issued while one is still running lands on the trade and then
        // snaps back to the live edge. Re-emitting the selection fires the
        // subscription renderArtifacts installed: redraw the R/R zone, page the
        // trade's own bars in if still off-window (coverBacktestTradeTo), scroll.
        // A superseded run (cancelled) leaves the ref parked for its successor.
        void anchorWalk.then(() => {
          if (cancelled || !handle.chartRef.current) return;
          const restore = handle.pendingTradeRestoreRef.current;
          if (restore == null) return;
          handle.pendingTradeRestoreRef.current = null;
          restoreTradeSelection(handle.chartRef.current, restore);
        });
      } else if (snapshotWalk) {
        void snapshotWalk.then(positionSnapshotRange).catch(() => {});
      }

      // Live updates for the current bar.
      handle.wsRef.current?.close();
      setStatus("connecting");
      setLastPrice(null);
      handle.wsRef.current = openLive(
        symbol.epic,
        period.resolution,
        (k: KLineData, bid: number | null, ask: number | null) => {
          const chart = handle.chartRef.current;
          if (!chart) return;
          // Latest raw spread sides for the bid/ask lines (redraw reads the refs).
          handle.bidRef.current = bid;
          handle.askRef.current = ask;
          // pushBar updates the last bar (==ts) or appends (>ts); an older ts
          // is silently ignored by klinecharts. Log regressions so a frozen chart
          // is diagnosable rather than mysterious.
          const list = chart.getDataList();
          const lastTs = list.length ? list[list.length - 1].timestamp : 0;
          if (k.timestamp < lastTs) {
            console.warn(
              `[live] stale candle ${k.timestamp} < last ${lastTs} for ${symbol.epic}; ignoring`,
            );
            return;
          }
          handle.dataFacadeRef.current?.pushBar(k);
          setHasData(true); // a flowing stream clears the no-data banner (React no-ops if unchanged)
          setLastPrice(k.close);
          // Publish the price so the positions dock can mark P&L to market without
          // polling the server (see trading.setLivePrice / PositionsPanel).
          setLivePrice(symbol.epic, k.close);
          // A live candle proves the market is open: record it (so the status check
          // stays event-driven) and flip the badge open instantly if it was closed.
          lastCandleAtRef.current = Date.now();
          if (marketClosedRef.current) setMarketClosed(false);
          handle.redrawRef.current(); // keep the price/alert pills glued as the bar moves
          // NOTE: alert FIRING is owned by the background alertEngine (the single
          // authority across all tabs, active included) — not here. This chart feed
          // only drives the visible candles/pills. The engine persists fired/removed
          // alerts and bumps the alerts signal; overlays reconciles its lines off it.
        },
        setStatus,
        priceSide,
        brokerId,
      );
    })();

    return () => {
      cancelled = true;
      handle.wsRef.current?.close();
      handle.wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol.epic, period.resolution, priceSide, brokerId]);
}
