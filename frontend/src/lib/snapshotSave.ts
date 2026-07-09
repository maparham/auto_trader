// One-call "save a snapshot of this chart" used by both the toolbar camera
// button and the gallery's "Save current chart" button. Lives apart from
// lib/snapshots.ts so the pure capture/write module stays free of chartSync
// (and its klinecharts runtime imports) for node-env unit tests.
import type { Chart } from "klinecharts";
import { readVisibleRange } from "./chartSync";
import { captureSnapshot, makeChartThumbnail } from "./snapshots";
import { saveSnapshot, type ChartSnapshot } from "./persist";
import type { Instrument, Period } from "./feed";

/** Capture + persist a snapshot of the given chart. Returns the saved record,
 *  or null when the chart has no visible data yet. */
export async function saveSnapshotOfChart(
  chart: Chart,
  scope: string,
  symbol: Instrument,
  period: Period,
): Promise<ChartSnapshot | null> {
  const range = readVisibleRange(chart);
  if (!range) return null;
  const thumb = await makeChartThumbnail(chart);
  const snap = captureSnapshot({
    scope,
    symbol,
    period,
    range: { from: range.fromTs, to: range.toTs },
    thumb,
  });
  saveSnapshot(snap);
  return snap;
}
