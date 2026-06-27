// Multi-timeframe coordinator for the TV-style EMA/MA. klinecharts' indicator
// `calc` is synchronous and only sees the chart's bars, so the higher-timeframe
// (HTF) series is fetched + computed here and stashed on the indicator's
// extendData; the alignment onto chart bars happens inside calc (see
// customIndicators.computeMa), which keeps scroll-back correct.
//
// Backend note: /api/candles serves any resolution, so this needs no new
// endpoint (see [[capital-com-api]] / charting-stack memory).

import type { Chart, KLineData } from "klinecharts";
import { fetchRecent, RESOLUTION_SECONDS } from "./feed";
import { maSeries } from "./mtf";
import { indTypeOf, type MaExtend } from "./customIndicators";

const HTF_BARS = 500; // HTF history to pull; ~enough to cover the chart's range

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
  // active broker. Defaults to "capital" via fetchRecent when omitted.
  brokerId?: string,
): Promise<void> {
  const ind = chart.getIndicatorByPaneId(paneId, name) as { extendData?: MaExtend } | null;
  const ext: MaExtend = { ...(ind?.extendData ?? {}), ...config.options };

  if (!timeframe || timeframe === "chart") {
    ext.mtf = { timeframe: null };
    chart.overrideIndicator({ name, calcParams: [config.length], extendData: ext }, paneId);
    return;
  }

  const htfMs = (RESOLUTION_SECONDS[timeframe] ?? 0) * 1000;
  // Best-effort: a failed HTF fetch (broker down) shouldn't reject and break the
  // base indicator — just skip the MTF overlay this round.
  let htf: KLineData[] = [];
  try {
    htf = await fetchRecent(epic, timeframe, HTF_BARS, "mid", brokerId);
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
 */
export async function refreshMtfIndicators(
  chart: Chart,
  epic: string,
  brokerId?: string,
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
      jobs.push(
        applyMaTimeframe(
          chart,
          epic,
          id,
          paneId,
          {
            kind: type === "EMA" ? "ema" : "sma",
            length: Number(ind.calcParams?.[0]) || (type === "EMA" ? 9 : 20),
            options: { source: ext.source, offset: ext.offset, smoothing: ext.smoothing },
          },
          tf,
          brokerId,
        ),
      );
    });
  });
  await Promise.all(jobs);
}
