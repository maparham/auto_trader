// Equal-width days: a display-only slot grid for intraday charts. Every UTC
// day that holds candles gets the same number of slots (one chart period
// each, from the earliest to the latest time of day seen in the loaded
// candles), and each candle sits in its own time slot, so a missing period
// shows as an empty gap. The candle list is never changed; klinecharts'
// patched store asks globalThis.__chartkarSlots(dataList) for each candle's
// display position and does its index/x math in positions. Without the
// provider every position equals the data index.

const DAY = 86_400_000;

export interface SlotGrid {
  readonly n: number;
  readonly perDay: number;
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

export function buildSlotGrid(times: readonly number[]): SlotGrid | null {
  const n = times.length;
  if (n < 2) return null;
  const step = periodOf(times);
  if (!(step > 0) || step >= DAY) return null;
  const off = new Array<number>(n);
  const dayOf = new Array<number>(n);
  let minOff = Infinity;
  let maxOff = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (!Number.isFinite(t)) return null;
    dayOf[i] = Math.floor(t / DAY);
    off[i] = Math.floor((t - dayOf[i] * DAY) / step);
    if (off[i] < minOff) minOff = off[i];
    if (off[i] > maxOff) maxOff = off[i];
  }
  const perDay = maxOff - minOff + 1;
  const pos = new Array<number>(n);
  let dayNum = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && dayOf[i] !== dayOf[i - 1]) dayNum++;
    pos[i] = dayNum * perDay + (off[i] - minOff);
    if (i > 0 && pos[i] <= pos[i - 1]) pos[i] = pos[i - 1] + 1;
  }
  const last = n - 1;
  return {
    n,
    perDay,
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
