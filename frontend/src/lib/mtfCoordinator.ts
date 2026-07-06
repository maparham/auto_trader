// Multi-timeframe coordinator for the TV-style EMA/MA. klinecharts' indicator
// `calc` is synchronous and only sees the chart's bars, so the higher-timeframe
// (HTF) series is fetched + computed here and stashed on the indicator's
// extendData; the alignment onto chart bars happens inside calc (see
// customIndicators.computeMa), which keeps scroll-back correct.
//
// Backend note: /api/candles serves any resolution, so this needs no new
// endpoint (see [[capital-com-api]] / charting-stack memory).

import type { Chart, KLineData } from "klinecharts";
import { fetchRange, RESOLUTION_SECONDS } from "./feed";
import { maSeries, htfCoverageStartMs, type MtfSeriesBase } from "./mtf";
import { pageHistoryBack } from "./historyPaging";
import { indTypeOf, type MaExtend } from "./customIndicators";
import {
  computePivotBands,
  type PivotBandsExtend,
  type PivotBandsMode,
} from "./indicators/pivotBands";

// Bars per HTF page. The backend caps a single /api/candles fetch (bars le=1000),
// so a wide loaded span needs several pages walked back — kept under the cap.
const HTF_PAGE_BARS = 900;
// Bound the walk-back so a pathological span can't spin forever; 40 pages of 900
// bars (36k HTF bars) covers any realistic loaded chart range.
const HTF_MAX_PAGES = 40;
const HTF_MAX_EMPTY = 3; // consecutive empty windows before declaring exhausted

interface MaConfig {
  kind: "ema" | "sma";
  length: number;
  options: MaExtend; // source / offset / smoothing
}

/**
 * Fetch (and page back over) the higher-timeframe candles an MTF indicator needs
 * to cover the chart's whole loaded span. Shared by every MTF indicator — only
 * the per-indicator series computation differs afterwards.
 *
 * `warmupBars` is how many HTF bars of history the indicator needs *before* the
 * oldest visible bar so its left edge is populated (MA warmup for EMA/MA; enough
 * pivot history for Pivot Bands). A failed fetch (broker down) resolves to an
 * empty list rather than throwing, so the base indicator keeps working.
 */
async function fetchHtfBars(
  chart: Chart,
  epic: string,
  timeframe: string,
  warmupBars: number,
  brokerId: string | undefined,
  oldestChartMs: number | undefined,
): Promise<{ htf: KLineData[]; htfMs: number }> {
  const htfSec = RESOLUTION_SECONDS[timeframe] ?? 0;
  const htfMs = htfSec * 1000;
  // Cover the chart's whole loaded span, not just recent bars: reach back to the
  // oldest loaded bar (or the explicit scroll-back page's first bar) plus warmup.
  const data = chart.getDataList();
  const newestMs = data.length ? data[data.length - 1].timestamp : Date.now();
  const loadedOldest = data.length ? data[0].timestamp : newestMs;
  const oldest = Math.min(oldestChartMs ?? loadedOldest, loadedOldest);
  const fromMs = htfCoverageStartMs(oldest, htfMs, warmupBars);

  let htf: KLineData[] = [];
  try {
    await pageHistoryBack<KLineData>({
      fromTs: fromMs,
      toTs: newestMs,
      resSec: htfSec || 3600,
      pageBars: HTF_PAGE_BARS,
      maxPages: HTF_MAX_PAGES,
      maxEmpty: HTF_MAX_EMPTY,
      isStale: () => false,
      getData: () => htf,
      fetchOlder: (fSec, tSec) => fetchRange(epic, timeframe, fSec, tSec, "mid", brokerId),
      applyData: (merged) => {
        htf = merged;
      },
    });
  } catch {
    htf = [];
  }
  return { htf, htfMs };
}

/**
 * Point an EMA/MA at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, computes the MA on
 * them, and writes the result onto extendData; calc aligns it to the chart bars.
 * Returns once the override is applied (so callers can show pending state).
 */
export async function applyMaTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: MaConfig,
  timeframe: string | null,
  // HTF candles are broker-specific (epics aren't portable); fetch from the chart's
  // active broker. Defaults to "capital" via fetchRange when omitted.
  brokerId?: string,
  // Oldest chart bar (ms) the HTF series must reach back to. Passed explicitly by
  // the scroll-back loader (the just-fetched older page's first bar); otherwise
  // read from the chart's current dataList. Drives how far back the HTF series is
  // paged so the overlay spans the whole loaded range, not just recent bars.
  oldestChartMs?: number,
): Promise<void> {
  const ind = chart.getIndicatorByPaneId(paneId, name) as { extendData?: MaExtend } | null;
  const ext: MaExtend = { ...(ind?.extendData ?? {}), ...config.options };

  if (!timeframe || timeframe === "chart") {
    ext.mtf = { timeframe: null };
    chart.overrideIndicator({ name, calcParams: [config.length], extendData: ext }, paneId);
    return;
  }

  const { htf, htfMs } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    config.length,
    brokerId,
    oldestChartMs,
  );
  // MTF carries the base line only (smoothing is not shown under MTF — see
  // computeMa's MTF branch), so take the base series here.
  const { base } = maSeries(htf, config.kind, config.length, config.options);
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfSeries: base,
    htfMs,
  };
  chart.overrideIndicator({ name, calcParams: [config.length], extendData: ext }, paneId);
}

interface PivotBandsConfig {
  n: number; // strength (calcParams[0])
  k: number; // avg window (calcParams[1])
  mode: PivotBandsMode;
}

// Pivot Bands need enough HTF history *before* the oldest visible bar to have a
// confirmed pivot to show. Unlike EMA/MA convergence this is best-effort (pivots
// are sparse — no fixed window guarantees one), so a blank left edge is possible
// and correct; 2·N (pivot + confirmation lag) plus K (avg window) is a sensible
// reach-back margin.
const pivotWarmup = (n: number, k: number) => 2 * n + k;

/**
 * Point Pivot Bands at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, computes the two
 * step-lines on them, and writes BOTH series onto extendData; calc aligns them
 * onto the live chart bars (no lookahead). Mode/strength come from `config`, not
 * from re-reading live extendData, so a param change can't race the write.
 */
export async function applyPivotBandsTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: PivotBandsConfig,
  timeframe: string | null,
  brokerId?: string,
  oldestChartMs?: number,
): Promise<void> {
  const ind = chart.getIndicatorByPaneId(paneId, name) as { extendData?: PivotBandsExtend } | null;
  const ext: PivotBandsExtend = { ...(ind?.extendData ?? {}), mode: config.mode };
  const calcParams = [config.n, config.k];

  if (!timeframe || timeframe === "chart") {
    ext.mtf = { timeframe: null };
    chart.overrideIndicator({ name, calcParams, extendData: ext }, paneId);
    return;
  }

  const { htf, htfMs } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    pivotWarmup(config.n, config.k),
    brokerId,
    oldestChartMs,
  );
  // Reuse the exact chart-TF math on the HTF bars: computePivotBands already
  // carries each side's value forward (dense after the first pivot) and bakes in
  // the N-bar confirmation lag, so the aligned series stays gap-free and honest.
  const pts = computePivotBands(htf, config.n, config.k, { mode: config.mode });
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfHigh: pts.map((p) => p.pivotHigh),
    htfLow: pts.map((p) => p.pivotLow),
    htfMs,
  };
  chart.overrideIndicator({ name, calcParams, extendData: ext }, paneId);
}

/**
 * Re-fetch HTF data for every MTF indicator (EMA/MA and Pivot Bands) already
 * configured for a timeframe — call after the symbol or chart timeframe changes,
 * since the stashed HTF series belongs to the previous epic/range. Also the
 * reload path: persistence saves only `mtf:{timeframe}` (no series), so a
 * reloaded MTF indicator renders on the chart timeframe until this refetches.
 * No-op for chart-timeframe indicators.
 *
 * Also called from the scroll-back loader, which passes `oldestChartMs` (the
 * just-loaded older page's first bar). In that mode the epic/config are
 * unchanged, so an indicator whose stashed series already reaches back past the
 * new oldest bar (plus its warmup) is skipped — no redundant refetch per page.
 */
export async function refreshMtfIndicators(
  chart: Chart,
  epic: string,
  brokerId?: string,
  oldestChartMs?: number,
): Promise<void> {
  const byPane = chart.getIndicatorByPaneId() as Map<string, Map<string, unknown>> | null;
  if (!byPane) return;
  const jobs: Promise<void>[] = [];
  byPane.forEach((nameMap, paneId) => {
    nameMap.forEach((indUnknown, id) => {
      // `id` is the instance id (klinecharts name); branch on the real TYPE.
      const ind = indUnknown as {
        name?: string;
        calcParams?: unknown[];
        extendData?: MaExtend & PivotBandsExtend;
      };
      const type = indTypeOf({ name: id, extendData: ind.extendData });
      const tf = (ind.extendData?.mtf as MtfSeriesBase | undefined)?.timeframe;
      if (!tf) return;

      // Scroll-back guard shared by every MTF type: skip the refetch if the
      // stashed series already reaches the coverage start for the new oldest bar.
      // `warmup` is the type's reach-back margin (MA length; pivot 2N+K).
      const stashed = ind.extendData?.mtf as MtfSeriesBase | undefined;
      const covered = (warmup: number): boolean => {
        if (oldestChartMs == null) return false;
        if (!stashed?.htfStarts?.length || !stashed.htfMs) return false;
        return stashed.htfStarts[0] <= htfCoverageStartMs(oldestChartMs, stashed.htfMs, warmup);
      };

      if (type === "EMA" || type === "MA") {
        const ext = ind.extendData ?? {};
        const length = Number(ind.calcParams?.[0]) || (type === "EMA" ? 9 : 20);
        if (covered(length)) return;
        jobs.push(
          applyMaTimeframe(
            chart,
            epic,
            id,
            paneId,
            {
              kind: type === "EMA" ? "ema" : "sma",
              length,
              options: { source: ext.source, offset: ext.offset, smoothing: ext.smoothing },
            },
            tf,
            brokerId,
            oldestChartMs,
          ),
        );
      } else if (type === "PIVOT_BANDS") {
        const n = Number(ind.calcParams?.[0]) || 5;
        const k = Number(ind.calcParams?.[1]) || 3;
        if (covered(pivotWarmup(n, k))) return;
        const mode: PivotBandsMode = ind.extendData?.mode === "avg" ? "avg" : "last";
        jobs.push(
          applyPivotBandsTimeframe(chart, epic, id, paneId, { n, k, mode }, tf, brokerId, oldestChartMs),
        );
      }
    });
  });
  await Promise.all(jobs);
}
