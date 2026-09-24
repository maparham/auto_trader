// Stock split history for the chart's split markers (SplitMarkers.tsx). The
// backend answers from Yahoo for equities only (GET /api/market/{epic}/splits)
// and [] for everything else, so a chart never has to know an instrument's type.
// Splits never change after the fact: one fetch per broker+epic per session.

import { API_BASE as BASE, apiFetch } from "./http";
import { isSynthetic } from "./syntheticRegistry";
import { tfSecondsOf } from "./timeframe";

type Bar = { timestamp: number };

export interface Split {
  timeMs: number;
  /** New shares per old share: 25 for 25:1, 0.1 for a 1:10 reverse split. */
  ratio: number;
}

const cache = new Map<string, Promise<Split[]>>();

export function _resetSplitsCache(): void {
  cache.clear();
}

/** Splits for an epic, oldest first. [] on any failure, and a failure is not
 * cached, so the next chart load asks again. */
export function fetchSplits(epic: string, brokerId: string): Promise<Split[]> {
  if (isSynthetic(epic)) return Promise.resolve([]);
  const key = `${brokerId}|${epic}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<Split[]> => {
    const url = `${BASE}/api/market/${encodeURIComponent(epic)}/splits?broker=${encodeURIComponent(brokerId)}`;
    const res = await apiFetch(url);
    if (!res.ok) throw new Error(`splits ${res.status}`);
    const d = (await res.json()) as { splits?: { time: number; ratio: number }[] };
    return (d.splits ?? [])
      .filter((s) => Number.isFinite(s.time) && s.ratio > 0)
      .map((s) => ({ timeMs: s.time * 1000, ratio: s.ratio }));
  })().catch(() => {
    cache.delete(key);
    return [] as Split[];
  });
  cache.set(key, p);
  return p;
}

/** "25:1", "1:6", "3:2": the smallest whole-number pair for the ratio. */
export function splitLabel(ratio: number): string {
  for (let den = 1; den <= 50; den++) {
    const num = Math.round(ratio * den);
    if (num >= 1 && Math.abs(num / den - ratio) < 1e-3 * Math.max(1, ratio)) {
      return `${num}:${den}`;
    }
  }
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6 Apr 2026" (UTC; the split is a date, not a moment). */
export function splitDateText(timeMs: number): string {
  const d = new Date(timeMs);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Index of the bar that carries the split: the bar whose span holds it, or
 * the next bar when it falls in a gap (overnight, weekend). -1 when it lies
 * outside the loaded bars. `bars` ascending by timestamp (ms): the chart's
 * own data list, read in place (the paint loop calls this every frame). */
export function splitBarIndex(bars: readonly Bar[], splitMs: number, barMs: number): number {
  const n = bars.length;
  if (n === 0 || splitMs < bars[0].timestamp || splitMs >= bars[n - 1].timestamp + barMs) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].timestamp <= splitMs) lo = mid;
    else hi = mid - 1;
  }
  return splitMs < bars[lo].timestamp + barMs ? lo : Math.min(lo + 1, n - 1);
}

/** The longest one bar of `resolution` can span, for splitBarIndex: the
 * timeframe table counts a month as 30 days and a year as 365, so calendar
 * units are stretched to 31/30 of that (a split on the 31st stays in its month). */
export function maxBarMs(resolution: string): number {
  const sec = tfSecondsOf(resolution) ?? 60;
  return (sec >= 30 * 86_400 ? (sec * 31) / 30 : sec) * 1000;
}

export interface SplitMarker {
  key: string;
  x: number;
  label: string;
  date: string;
}

/** Pixel markers for the splits on visible bars. `toX` projects a bar
 * timestamp (null when klinecharts cannot); off-pane markers are dropped. */
export function projectSplitMarkers(
  splits: readonly Split[],
  bars: readonly Bar[],
  barMs: number,
  visible: { from: number; to: number },
  toX: (timestamp: number) => number | null,
  paneW: number,
): SplitMarker[] {
  const out: SplitMarker[] = [];
  for (const s of splits) {
    const i = splitBarIndex(bars, s.timeMs, barMs);
    if (i < 0 || i < visible.from || i > visible.to) continue;
    const x = toX(bars[i].timestamp);
    if (x == null || x < 0 || x > paneW) continue;
    out.push({ key: `split:${s.timeMs}`, x, label: splitLabel(s.ratio), date: splitDateText(s.timeMs) });
  }
  return out;
}
