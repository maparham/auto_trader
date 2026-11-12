// Equal-width days ("Time gaps"): a display-only slot grid for intraday
// charts. Every broker day gets the same number of slots (one chart period
// each, from the earliest to the latest time into the day seen in the loaded
// candles), and each candle sits in its own time slot, so a missing period
// shows as an empty gap. Days come from pinned 1D bars when given, else from
// the daily pause in the candles. The chart is laid out by weeks: every week
// has a column for each weekday that ever trades, so a holiday is an empty
// column and every week is the same width. The candle list is never changed; klinecharts'
// patched store asks globalThis.__chartkarSlots(dataList) for each candle's
// display position and does its index/x math in positions. Without the
// provider every position equals the data index.

const DAY = 86_400_000;

export interface SlotGrid {
  readonly n: number;
  readonly perDay: number;
  /** Day columns per week times perDay: every week is this wide. */
  readonly perWeek: number;
  /** Display position of each candle, strictly increasing. */
  readonly pos: readonly number[];
  /** Position of a fractional index: linear between neighbours, 1:1 past either end. */
  posOf(i: number): number;
  /** Inverse of posOf. */
  idxOf(p: number): number;
  /** Number of positions up to and including the last candle. */
  count(): number;
}

// The chart period: the most common gap among the last 200 candles (ties go
// to the smaller gap). A median would land on an overnight gap for a short
// list, and a minimum on one stray irregular stamp.
function periodOf(times: readonly number[]): number {
  const counts = new Map<number, number>();
  for (let i = Math.max(1, times.length - 200); i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [g, c] of counts) if (c > bestCount || (c === bestCount && g < best)) [best, bestCount] = [g, c];
  return best;
}

/** Bar starts the grid should follow, from pinned panes' 1D and 1W bars. */
export interface SlotAnchors {
  dayStarts?: readonly number[];
  weekStarts?: readonly number[];
}

const mod = (a: number, m: number) => ((a % m) + m) % m;

/**
 * Where the broker's day starts, in ms after 00:00 UTC: the start of the
 * time-of-day bin (one period wide, in step with the candles) holding the
 * fewest candles. Near-ties (within a tenth of the busiest bin, so a partial
 * first or last day does not decide) go to the bin closest to 00:00 round
 * the clock, the one before midnight on an exact tie.
 */
export function inferDayStartOffset(times: readonly number[], step: number): number {
  if (!(step > 0) || step >= DAY || times.length === 0) return 0;
  const bins = Math.max(1, Math.round(DAY / step));
  const phase = mod(times[0], step);
  const counts = new Array<number>(bins).fill(0);
  for (const t of times) counts[Math.min(bins - 1, Math.floor(mod(t - phase, DAY) / step))]++;
  const min = Math.min(...counts);
  const tol = Math.floor(Math.max(...counts) / 10);
  let best = 0;
  let bestDist = Infinity;
  for (let b = 0; b < bins; b++) {
    if (counts[b] > min + tol) continue;
    const start = mod(phase + b * step, DAY);
    const dist = Math.min(start, DAY - start);
    // Strictly closer wins; an exact tie goes to the start before midnight.
    if (dist < bestDist || (dist === bestDist && start > DAY / 2)) [best, bestDist] = [start, dist];
  }
  return best;
}

/** Index of the last value at or before x in a sorted list, or -1. */
function lastAtOrBefore(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= x) [ans, lo] = [m, m + 1];
    else hi = m - 1;
  }
  return ans;
}

const calOf = (dayStart: number) => Math.floor((dayStart + DAY / 2) / DAY);
const weekdayOf = (cal: number) => mod(cal + 3, 7); // 0 = Monday

export function buildSlotGrid(times: readonly number[], anchors?: SlotAnchors): SlotGrid | null {
  const n = times.length;
  if (n < 2) return null;
  for (let i = 0; i < n; i++) if (!Number.isFinite(times[i])) return null;
  const step = periodOf(times);
  if (!(step > 0) || step >= DAY) return null;
  const inferred = inferDayStartOffset(times, step);
  const dayStarts = anchors?.dayStarts?.filter(Number.isFinite) ?? [];
  // Each candle's day: the last given start at or before it (stepping on by
  // whole days when the starts run out), else the inferred daily offset.
  const slot = new Array<number>(n);
  const cal = new Array<number>(n);
  let minSlot = Infinity;
  let maxSlot = -Infinity;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const t = times[i];
    const k = lastAtOrBefore(dayStarts, t);
    let start: number;
    if (k >= 0) start = dayStarts[k] + Math.floor((t - dayStarts[k]) / DAY) * DAY;
    else start = Math.floor((t - inferred) / DAY) * DAY + inferred;
    slot[i] = Math.floor((t - start) / step);
    cal[i] = calOf(start);
    seen.add(weekdayOf(cal[i]));
    if (slot[i] < minSlot) minSlot = slot[i];
    if (slot[i] > maxSlot) maxSlot = slot[i];
  }
  const perDay = maxSlot - minSlot + 1;
  // A week starts on the weekly bars' weekday when given, else on the first
  // weekday that ever trades; its columns are the weekdays that ever trade.
  const weekStarts = anchors?.weekStarts?.filter(Number.isFinite) ?? [];
  const firstWd = weekStarts.length
    ? weekdayOf(calOf(weekStarts[weekStarts.length - 1]))
    : Math.min(...seen);
  const order = [...seen].sort((a, b) => mod(a - firstWd, 7) - mod(b - firstWd, 7));
  const colOf = new Map(order.map((wd, c) => [wd, c]));
  const perWeek = order.length * perDay;
  const own = new Array<number>(n);
  let weekIdx = -1;
  let lastWeek = NaN;
  let base = 0;
  for (let i = 0; i < n; i++) {
    const week = Math.floor((cal[i] + 3 - firstWd) / 7);
    if (week !== lastWeek) [weekIdx, lastWeek] = [weekIdx + 1, week];
    own[i] = weekIdx * perWeek + colOf.get(weekdayOf(cal[i]))! * perDay + (slot[i] - minSlot);
    if (i === 0) base = colOf.get(weekdayOf(cal[0]))! * perDay;
    own[i] -= base;
    // Mixed sources (given starts after inferred days) must never go back.
    if (i > 0 && own[i] < own[i - 1]) own[i] = own[i - 1];
  }
  // Candles sharing a slot (a DST fall-back, a stray stamp) split that slot
  // evenly, so positions stay strictly increasing without pushing any later
  // candle out of its own slot.
  const pos = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let k = i + 1;
    while (k < n && own[k] === own[i]) k++;
    for (let m = i; m < k; m++) pos[m] = own[i] + (m - i) / (k - i);
    i = k;
  }
  const last = n - 1;
  return {
    n,
    perDay,
    perWeek,
    pos,
    posOf(i: number): number {
      if (i <= 0) return pos[0] + i;
      if (i >= last) return pos[last] + (i - last);
      const k = Math.floor(i);
      const f = i - k;
      return f === 0 ? pos[k] : pos[k] + (pos[k + 1] - pos[k]) * f;
    },
    idxOf(p: number): number {
      if (p <= pos[0]) return p - pos[0];
      if (p >= pos[last]) return last + (p - pos[last]);
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (pos[m] <= p) lo = m;
        else hi = m;
      }
      return lo + (p - pos[lo]) / (pos[hi] - pos[lo]);
    },
    count(): number {
      return pos[last] + 1;
    },
  };
}

type Stamped = { timestamp: number };
type CacheEntry = { n: number; first: number; last: number; grid: SlotGrid | null };

const cache = new WeakMap<readonly Stamped[], CacheEntry>();
let on = false;

/** The cached grid for a candle list while the setting is on, else null. */
export function slotGridFor(list: readonly Stamped[]): SlotGrid | null {
  if (!on || !Array.isArray(list) || list.length < 2) return null;
  const n = list.length;
  const first = list[0]?.timestamp;
  const last = list[n - 1]?.timestamp;
  const hit = cache.get(list);
  if (hit && hit.n === n && hit.first === first && hit.last === last) return hit.grid;
  const times = new Array<number>(n);
  for (let i = 0; i < n; i++) times[i] = list[i]?.timestamp;
  const grid = buildSlotGrid(times);
  cache.set(list, { n, first, last, grid });
  return grid;
}

export function equalWidthDaysOn(): boolean {
  return on;
}

type SlotsGlobal = { __chartkarSlots?: (list: unknown) => SlotGrid | null };

export function setEqualWidthDays(next: boolean): void {
  on = next;
  const g = globalThis as SlotsGlobal;
  // klinecharts calls this from its layout path, where a throw would silently
  // stop every later layout: any failure means "no grid" (identity).
  if (next)
    g.__chartkarSlots = (list) => {
      try {
        return slotGridFor(list as readonly Stamped[]);
      } catch {
        return null;
      }
    };
  else delete g.__chartkarSlots;
}
