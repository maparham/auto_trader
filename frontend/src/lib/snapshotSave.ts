// One-call "save a snapshot of this chart" used by both the toolbar camera
// button and the gallery's "Save current chart" button. Lives apart from
// lib/snapshots.ts so the pure capture/write module stays free of chartSync
// (and its klinecharts runtime imports) for node-env unit tests.
import type { Chart } from "klinecharts";
import { readVisibleRange } from "./chartSync";
import { captureSnapshot, makeChartThumbnail } from "./snapshots";
import { saveSnapshot, type ChartSnapshot } from "./persist";
import { isChartReplaying } from "./backtest";
import type { Instrument, Period } from "./feed";

/** Capture + persist a snapshot of the given chart. Returns the saved record,
 *  or null when the chart has no visible data yet, or when the chart is running
 *  a replay session.
 *
 *  The replay refusal is a blindness gate, not tidiness. A snapshot stores
 *  `readVisibleRange(chart)` — the REAL epoch milliseconds of the bars on
 *  screen, which during a session is the replayed slice. Restoring it opens a
 *  new cell that is NOT replaying (`mode === "off"`), so its axis uses the
 *  unmasked formatter and prints the exact dates the session is hiding, while
 *  the original session is still sitting there resumable. Both entry points (the
 *  toolbar camera and the gallery's "Save current chart") come through here, so
 *  this one guard covers them, and neither can be talked into a partial save:
 *  there is no version of this record that is safe to write, because the range
 *  IS the leak. */
export async function saveSnapshotOfChart(
  chart: Chart,
  scope: string,
  symbol: Instrument,
  period: Period,
): Promise<ChartSnapshot | null> {
  if (isChartReplaying(chart)) return null;
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
