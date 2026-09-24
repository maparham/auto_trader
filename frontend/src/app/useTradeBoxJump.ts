// Trade-list row -> chart: jump to (or open) the trade's chart, then sketch the
// trade as a tradeBox drawing once the target cell has mounted and
// rehydrated, optionally dropping to a timeframe that makes the box readable,
// and scroll it into view.
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { applyVisibleRange } from "../lib/chartSync";
import { beginHistoryJump } from "../lib/historyJump";
import { coverBacktestHistory } from "../lib/backtest";
import { alertsChanged } from "../lib/signals";
import { minPositiveGap } from "../lib/barInterval";
import type { jumpToEpic as runEpicJump, ReuseSlot } from "../lib/epicJump";
import { PERIODS, fetchRangeWithStatus, RESOLUTION_SECONDS } from "../lib/feed";
import { loadDrawings, saveDrawings, type ChartTab } from "../lib/persist";
import { autoTfResolution, loadAutoTf, loadSameTab, tradeBoxSpec, type TradeRow } from "../lib/tradeList";
import type { KLineData } from "klinecharts";
import type { ReadyCells, Ref } from "./types";

// Bar duration per resolution, for the trade-box scroll padding. A direct
// RESOLUTION_SECONDS read (its Proxy covers custom timeframes), never a
// snapshot of its entries, which list the built-ins only.
const resolutionMs = (r: string): number | null => {
  const secs = RESOLUTION_SECONDS[r];
  return secs != null ? secs * 1000 : null;
};

// Pointer to the ONE trade box the trade-list panel has sketched (one box at a
// time by design: clicking a row replaces the previous one, wherever it lives).
// localStorage so a leftover box from the last session is still found and
// replaced, not orphaned.
const TRADE_LIST_BOX_KEY = "auto-trader.tradeListBox";

export function useTradeBoxJump({
  readyRef,
  readyTick,
  tabsRef,
  brokerIdRef,
  setTabs,
  jumpToEpic,
}: {
  readyRef: Ref<ReadyCells>;
  readyTick: number;
  tabsRef: Ref<ChartTab[]>;
  brokerIdRef: Ref<string>;
  setTabs: Dispatch<SetStateAction<ChartTab[]>>;
  jumpToEpic: (epic: string, precisionGuess: number, reuse?: ReuseSlot) => ReturnType<typeof runEpicJump>;
}) {
  // A clicked row jumps to the trade's chart (jumpToEpic: reuse an open cell,
  // else a fresh tab) and sketches the trade as a tradeBox drawing. Same
  // deferred idiom as pendingSelectRef: a brand-new tab's chart hasn't mounted
  // or rehydrated yet, so the request parks here and resolves once the target
  // cell reports the right hydrated epic.
  const pendingTradeBoxRef = useRef<{ cellId: string; epic: string; trade: TradeRow } | null>(null);
  // Guards the async placement against rapid row clicks: each click bumps the
  // epoch, and a placement that comes back from its candle fetch to find a
  // newer epoch drops out instead of deleting the newer click's box.
  const tradeBoxEpochRef = useRef(0);
  const removePreviousTradeListBox = useCallback(() => {
    let ptr: { scope: string; epic: string; cellId: string; id: string } | null = null;
    try {
      ptr = JSON.parse(localStorage.getItem(TRADE_LIST_BOX_KEY) ?? "null");
    } catch {
      /* corrupt pointer: nothing to remove */
    }
    if (!ptr) return;
    localStorage.removeItem(TRADE_LIST_BOX_KEY);
    const entry = readyRef.current.get(ptr.cellId);
    if (entry && entry.controller.overlays.getHydratedEpic() === ptr.epic) {
      entry.controller.overlays.remove(ptr.id); // mounted: onRemoved persists
      return;
    }
    // Unmounted (another tab, or the cell is gone): edit the saved drawings
    // directly — the next mount rehydrates without the old box.
    saveDrawings(ptr.scope, ptr.epic, loadDrawings(ptr.scope, ptr.epic).filter((d) => d.id !== ptr.id));
    // App's refs and setTabs are stable for the component's life, so the deps stay as they were in App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const resolvePendingTradeBox = useCallback(() => {
    const p = pendingTradeBoxRef.current;
    if (!p) return;
    const entry = readyRef.current.get(p.cellId);
    if (!entry) return; // cell not mounted yet (retries on ready / alertsChanged)
    if (entry.controller.overlays.getHydratedEpic() !== p.epic) return; // pre-rehydrate
    pendingTradeBoxRef.current = null; // clear BEFORE the async work: no double-place
    const epoch = tradeBoxEpochRef.current;
    const t = p.trade;
    const DAY_S = 86_400;
    // Passive "Loading history…" pill on the target cell for the whole jump —
    // the daily-bar fetch, the auto-TF settle poll AND the history cover can
    // add up to many silent seconds. The cover walk begins its own (superseding)
    // notice via the chart's pager wrapper, so ending here after the cover is a
    // no-op in the common case; the explicit ends cover the pre-cover bailouts.
    const jump = beginHistoryJump(p.cellId);
    void (async () => {
      // Daily bars over the trade's life (± a few days of context): they shape
      // the sketched stop (just past the extreme the price actually reached)
      // and snap the box edges onto real candles. A fetch failure still draws
      // the box — the stop falls back to the entry/exit extreme.
      let bars: KLineData[] = [];
      try {
        bars = (
          await fetchRangeWithStatus(
            p.epic, "DAY",
            t.entryTs / 1000 - 5 * DAY_S, t.exitTs / 1000 + 5 * DAY_S,
            "mid", brokerIdRef.current,
          )
        ).bars;
      } catch {
        /* stop falls back to the entry/exit extreme */
      }
      if (epoch !== tradeBoxEpochRef.current) return jump.end(); // a newer click superseded this one
      // Re-check the cell still shows OUR symbol: a symbol switch during the
      // fetch doesn't bump the epoch (only trade-list clicks do), and placing
      // now would persist the box into the new symbol's drawings — orphaned
      // there forever, since the pointer below records the OLD epic.
      const liveEntry = readyRef.current.get(p.cellId);
      if (!liveEntry || liveEntry.controller.overlays.getHydratedEpic() !== p.epic) return jump.end();
      const spec = tradeBoxSpec(t, bars);
      // Auto TF (panel toggle, default on): a box under 5 bars at the cell's
      // current interval reads as a sliver — drop to the coarsest interval that
      // still gives it 5+. Trading days come from the daily fetch; wall-clock
      // scaled ~5/7 stands in when that fetch failed.
      const cellNow = tabsRef.current.flatMap((tt) => tt.cells).find((c) => c.id === p.cellId);
      // When a TF switch is issued below, the scroll poll must not fire on the
      // OLD interval's still-loaded series (the reload right after would reset
      // the view): it waits until the chart's bar spacing matches this.
      let switchedResMs: number | null = null;
      if (loadAutoTf() && cellNow) {
        // Date-only stamps (no time of day in the import) pin the chart to
        // DAILY — the anchors are day-granular, so intraday bars would place
        // the box edges at fictional times. Timed stamps are exact and may
        // drop to whatever interval gives the box 5+ bars.
        let target: string | null;
        if (!t.hasTime) {
          target = cellNow.period.resolution === "DAY" ? null : "DAY";
        } else {
          const lo = Math.min(spec.points[0].timestamp, spec.points[1].timestamp);
          const hi = Math.max(spec.points[0].timestamp, spec.points[1].timestamp);
          const spanDays =
            bars.filter((b) => b.timestamp >= lo && b.timestamp <= hi).length ||
            Math.max(1, Math.round(((t.exitTs - t.entryTs) / 86_400_000) * (5 / 7)));
          target = autoTfResolution(cellNow.period.resolution, spanDays);
        }
        const targetPeriod = target ? PERIODS.find((x) => x.resolution === target) : undefined;
        if (targetPeriod) {
          switchedResMs = resolutionMs(targetPeriod.resolution);
          // This cell only — deliberately narrower than setCellPeriod's
          // interval-sync broadcast: the jump is about reading ONE trade.
          setTabs((ts) =>
            ts.map((tt) =>
              tt.cells.some((c) => c.id === p.cellId)
                ? {
                    ...tt,
                    cells: tt.cells.map((c) =>
                      c.id === p.cellId ? { ...c, period: targetPeriod } : c,
                    ),
                  }
                : tt,
            ),
          );
        }
      }
      removePreviousTradeListBox();
      const id = liveEntry.controller.overlays.placeDrawing({
        name: "tradeBox",
        points: spec.points,
        extendData: { text: spec.text, priceLabels: true },
      });
      const cell = tabsRef.current.flatMap((tt) => tt.cells).find((c) => c.id === p.cellId);
      if (id && cell) {
        try {
          localStorage.setItem(
            TRADE_LIST_BOX_KEY,
            JSON.stringify({ scope: cell.scope, epic: p.epic, cellId: p.cellId, id }),
          );
        } catch {
          /* pointer lost: worst case the old box lingers until deleted by hand */
        }
      }
      // Bring the trade's span into view with breathing room either side —
      // but only once the chart holds bars reaching the box (a fresh tab is
      // still loading, and an auto-TF switch reloads the series). Poll briefly,
      // then scroll anyway: applyVisibleRange clamps to whatever is loaded.
      const from = Math.min(spec.points[0].timestamp, spec.points[1].timestamp);
      const to = Math.max(spec.points[0].timestamp, spec.points[1].timestamp);
      // Breathing room scales with the interval the chart ends on: a fixed
      // 10-day floor would dwarf an intraday box right after Auto TF dropped
      // the chart to keep it readable. ~10 bars each side.
      const finalResMs =
        switchedResMs ??
        (cellNow ? resolutionMs(cellNow.period.resolution) : null) ??
        DAY_S * 1000;
      const pad = Math.max((to - from) * 0.6, 10 * finalResMs);
      const tryScroll = (attempt: number) => {
        if (epoch !== tradeBoxEpochRef.current) return jump.end(); // superseded
        const live = readyRef.current.get(p.cellId);
        if (!live) return jump.end(); // cell closed while we waited
        const data = live.chart.getDataList();
        // Spacing check: after a TF switch the OLD interval's (finer, hence
        // closer-together) bars are still on the chart for a beat — scrolling
        // them would be undone by the reload. Wait for the new series.
        // Two-sided: the OLD series is stale whether it's finer (gap too
        // small) or coarser (gap too big — Auto TF lowered the interval).
        // The min positive gap is the real bar interval even when a pair of
        // bars straddles a weekend.
        const gap = minPositiveGap(data.map((b) => b.timestamp));
        const spacingOk =
          switchedResMs == null ||
          (gap != null && gap >= switchedResMs * 0.5 && gap <= switchedResMs * 1.5);
        if ((!spacingOk || data.length === 0) && attempt < 30) {
          window.setTimeout(() => tryScroll(attempt + 1), 250);
          return;
        }
        // A trade older than the loaded window first pages history back to it
        // through the chart's own bounded walk (the backtest pager); then the
        // scroll lands on real bars. A failed/absent walk still scrolls —
        // applyVisibleRange clamps to whatever is loaded.
        void coverBacktestHistory(live.chart, from - pad).then(() => {
          jump.end();
          if (epoch !== tradeBoxEpochRef.current) return;
          const cur = readyRef.current.get(p.cellId);
          if (cur) applyVisibleRange(cur.chart, from - pad, to + pad);
        });
      };
      tryScroll(0);
    })();
    // App's refs and setTabs are stable for the component's life, so the deps stay as they were in App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removePreviousTradeListBox]);
  useEffect(() => alertsChanged.subscribe(resolvePendingTradeBox), [resolvePendingTradeBox]);
  useEffect(() => resolvePendingTradeBox(), [readyTick, resolvePendingTradeBox]);
  // Same-tab mode reuses ONE tab for symbols not open anywhere; the ref tracks
  // which (session-only — a fresh session starts with the first click's tab).
  const tradeListTabRef = useRef<string | null>(null);
  const jumpToTrade = async (t: TradeRow) => {
    const epoch = ++tradeBoxEpochRef.current;
    // Remember only a tab WE opened (created or symbol-replaced) as the reuse
    // target — adopting a tab that merely already showed the symbol would let
    // the next click hijack a user tab. Recorded even when this click is
    // superseded below: the tab exists, and the newer click must reuse it.
    const { cellId } = await jumpToEpic(t.symbol, 2, {
      get: () => (loadSameTab() ? tradeListTabRef.current : null),
      opened: (tabId) => { tradeListTabRef.current = tabId; },
    });
    if (epoch !== tradeBoxEpochRef.current) return; // a newer click superseded this one
    pendingTradeBoxRef.current = { cellId, epic: t.symbol, trade: t };
    resolvePendingTradeBox();
  };
  return jumpToTrade;
}
