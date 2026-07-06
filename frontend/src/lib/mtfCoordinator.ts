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
import { maSeries, htfCoverageStartMs } from "./mtf";
import { pageHistoryBack } from "./historyPaging";
import { indTypeOf, type MaExtend } from "./customIndicators";

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

  const htfSec = RESOLUTION_SECONDS[timeframe] ?? 0;
  const htfMs = htfSec * 1000;
  // Cover the chart's whole loaded span, not just recent bars: reach back to the
  // oldest loaded bar (or the explicit scroll-back page's first bar) plus the MA
  // warmup ahead of it. The backend caps one fetch, so page the range walking
  // back until coverage reaches that start.
  const data = chart.getDataList();
  const newestMs = data.length ? data[data.length - 1].timestamp : Date.now();
  const loadedOldest = data.length ? data[0].timestamp : newestMs;
  const oldest = Math.min(oldestChartMs ?? loadedOldest, loadedOldest);
  const fromMs = htfCoverageStartMs(oldest, htfMs, config.length);

  // Best-effort: a failed HTF fetch (broker down) shouldn't reject and break the
  // base indicator — just skip the MTF overlay this round. pageHistoryBack seeds
  // its cursor from getData()[0] (empty here) or toTs, then prepends older pages.
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

/**
 * Re-fetch HTF data for every EMA/MA already configured for a timeframe — call
 * after the symbol or chart timeframe changes, since the stashed HTF series
 * belongs to the previous epic/range. No-op for chart-timeframe indicators.
 *
 * Also called from the scroll-back loader, which passes `oldestChartMs` (the
 * just-loaded older page's first bar). In that mode the epic/config are
 * unchanged, so an indicator whose stashed series already reaches back past the
 * new oldest bar (plus its MA warmup) is skipped — no redundant refetch per page.
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
        extendData?: MaExtend;
      };
      const type = indTypeOf({ name: id, extendData: ind.extendData });
      if (type !== "EMA" && type !== "MA") return;
      const tf = ind.extendData?.mtf?.timeframe;
      if (!tf) return;
      const ext = ind.extendData ?? {};
      const length = Number(ind.calcParams?.[0]) || (type === "EMA" ? 9 : 20);
      // Scroll-back guard: same epic/config, so skip the refetch if the stashed
      // series already reaches the coverage start for the new oldest bar.
      if (oldestChartMs != null) {
        const mtf = ext.mtf;
        if (mtf?.htfStarts?.length && mtf.htfMs) {
          const need = htfCoverageStartMs(oldestChartMs, mtf.htfMs, length);
          if (mtf.htfStarts[0] <= need) return;
        }
      }
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
    });
  });
  await Promise.all(jobs);
}
