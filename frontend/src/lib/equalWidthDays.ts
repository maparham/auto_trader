// Equal-width days ("Time gaps"): a display-only slot grid for intraday
// charts. Every broker day gets the same number of slots (one chart period
// each, from the earliest to the latest time into the day seen in the loaded
// candles), and each candle sits in its own time slot, so a missing period
// shows as an empty gap. The days and weeks are the broker's own: the open
// times of the symbol's daily and weekly bars, loaded per chart through
// setSlotSource. Without them there is no grid (the chart is drawn normally);
// nothing is guessed. The chart is laid out by weeks: every week has a column
// for each weekday the broker has daily bars on, so a holiday is an empty
// column and every week is the same width. The candle list is never changed;
// klinecharts' patched store asks globalThis.__chartkarSlots(dataList, chart)
// for each candle's display position and does its index/x math in positions.
// Without the provider every position equals the data index.

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

/** The broker's own bar starts: its daily bars' and weekly bars' open times. */
export interface SlotAnchors {
  dayStarts?: readonly number[];
  weekStarts?: readonly number[];
}

const mod = (a: number, m: number) => ((a % m) + m) % m;

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

/** The start of the period holding x: the last known start at or before it,
 * stepping on (or back, before the first) in whole periods where the known
 * starts run out. */
function periodStart(starts: readonly number[], x: number, len: number): number {
  const k = lastAtOrBefore(starts, x);
  if (k >= 0) return starts[k] + Math.floor((x - starts[k]) / len) * len;
  return starts[0] - Math.ceil((starts[0] - x) / len) * len;
}

// A day's calendar date: its start plus half a day, so a day the broker opens
// the evening before (FX at 22:00 Sunday) is Monday's.
const calOf = (start: number) => Math.floor((start + DAY / 2) / DAY);
const weekdayOf = (cal: number) => mod(cal + 3, 7); // 0 = Monday

const sortedFinite = (xs: readonly number[] | undefined) =>
  [...new Set((xs ?? []).filter(Number.isFinite))].sort((a, b) => a - b);

/**
 * The slot grid for these candles, laid out on the broker's own days and
 * weeks. Null without both day and week starts: Time gaps never guesses.
 */
export function buildSlotGrid(times: readonly number[], anchors?: SlotAnchors): SlotGrid | null {
  const n = times.length;
  if (n < 2) return null;
  const dayStarts = sortedFinite(anchors?.dayStarts);
  const weekStarts = sortedFinite(anchors?.weekStarts);
  if (!dayStarts.length || !weekStarts.length) return null;
  for (let i = 0; i < n; i++) if (!Number.isFinite(times[i])) return null;
  const step = periodOf(times);
  if (!(step > 0) || step >= DAY) return null;
  // Week starts as calendar dates: a day belongs to the last week whose date
  // is at or before its own (so a weekly bar stamped Monday 00:00 still holds
  // the Monday the broker opened Sunday evening).
  const weekCals = weekStarts.map(calOf);
  const slot = new Array<number>(n);
  const cal = new Array<number>(n);
  let minSlot = Infinity;
  let maxSlot = -Infinity;
  // Columns: the weekdays the broker has daily bars on (and any a stepped
  // day lands on).
  const seen = new Set<number>(dayStarts.map((d) => weekdayOf(calOf(d))));
  for (let i = 0; i < n; i++) {
    const start = periodStart(dayStarts, times[i], DAY);
    slot[i] = Math.floor((times[i] - start) / step);
    cal[i] = calOf(start);
    seen.add(weekdayOf(cal[i]));
    if (slot[i] < minSlot) minSlot = slot[i];
    if (slot[i] > maxSlot) maxSlot = slot[i];
  }
  const perDay = maxSlot - minSlot + 1;
  const firstWd = weekdayOf(weekCals[weekCals.length - 1]);
  const order = [...seen].sort((a, b) => mod(a - firstWd, 7) - mod(b - firstWd, 7));
  const colOf = new Map(order.map((wd, c) => [wd, c]));
  const perWeek = order.length * perDay;
  // Weeks start at multiples of perWeek and days at multiples of perDay (the
  // Trendlines step map relies on it), so a first week that opens mid-week
  // keeps its empty leading columns. Weeks with no candles take no room.
  const own = new Array<number>(n);
  let weekIdx = -1;
  let lastWeek = NaN;
  for (let i = 0; i < n; i++) {
    const week = periodStart(weekCals, cal[i], 7);
    if (week !== lastWeek) [weekIdx, lastWeek] = [weekIdx + 1, week];
    own[i] = weekIdx * perWeek + colOf.get(weekdayOf(cal[i]))! * perDay + (slot[i] - minSlot);
    // Never go back (a stray stamp across a boundary).
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
type CacheEntry = { n: number; first: number; last: number; v: number; grid: SlotGrid | null };

const cache = new WeakMap<readonly Stamped[], CacheEntry>();
let on = false;
// Bumped whenever anchors or the setting change, so cached grids (here and
// in the klinecharts store) are rebuilt.
let version = 0;

// Anchors per chart, per key, in registration order (the chart's own source
// writes one key). The store passes its chart with the data list;
// slotGridFor(list) callers without a chart find it through the list.
const anchorsByChart = new WeakMap<object, Map<string, SlotAnchors>>();
const chartOfList = new WeakMap<object, object>();

function mergedAnchors(chart: object | undefined): SlotAnchors | undefined {
  const m = chart ? anchorsByChart.get(chart) : undefined;
  if (!m || m.size === 0) return undefined;
  const out: SlotAnchors = {};
  // First registered wins per field.
  for (const a of m.values()) {
    if (!out.dayStarts && a.dayStarts?.length) out.dayStarts = a.dayStarts;
    if (!out.weekStarts && a.weekStarts?.length) out.weekStarts = a.weekStarts;
  }
  return out;
}

/** Loads the broker's own day and week starts covering [fromMs, toMs], or
 * null when it cannot (then the chart is drawn without Time gaps). */
export type SlotSource = (fromMs: number, toMs: number) => Promise<SlotAnchors | null>;

type SourceState = { load: SlotSource; inFlight: boolean; asked?: { from: number; to: number; at: number } };
const sources = new WeakMap<object, SourceState>();
const SOURCE_KEY = "broker";
/** A range already asked for is not asked again this soon (a failed or empty
 * answer would otherwise repeat on every layout). */
const ASK_AGAIN_MS = 60_000;

/**
 * Give a chart the loader for its symbol's daily and weekly bar starts (null
 * removes it). A new source means a new symbol or broker: the old starts go.
 */
export function setSlotSource(chart: object | null | undefined, load: SlotSource | null): void {
  if (!chart) return;
  const m = anchorsByChart.get(chart);
  if (m && m.size)
    relayoutSlots(chart, () => {
      m.clear();
      bump();
    });
  if (load) sources.set(chart, { load, inFlight: false });
  else sources.delete(chart);
}

/** Ask the chart's source for the starts its candles need, unless they are
 * already known, already being loaded, or were just asked for. */
function ensureStarts(chart: object, first: number, last: number): void {
  const st = sources.get(chart);
  if (!st || st.inFlight) return;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return;
  const a = mergedAnchors(chart);
  const ds = a?.dayStarts;
  const ws = a?.weekStarts;
  const covered =
    !!ds?.length &&
    !!ws?.length &&
    ds[0] <= first &&
    last < ds[ds.length - 1] + DAY &&
    ws[0] <= first + DAY &&
    last < ws[ws.length - 1] + 8 * DAY;
  if (covered) return;
  // From the candles only: the answer's own bars may reach further back, and
  // asking from those would walk back through history without end.
  const from = first - 8 * DAY;
  const to = last + DAY;
  const now = Date.now();
  if (st.asked && from >= st.asked.from && to <= st.asked.to && now - st.asked.at < ASK_AGAIN_MS) return;
  st.inFlight = true;
  st.asked = { from, to, at: now };
  let p: Promise<SlotAnchors | null>;
  try {
    p = st.load(from, to);
  } catch {
    st.inFlight = false;
    return;
  }
  void Promise.resolve(p)
    .then((res) => {
      st.inFlight = false;
      if (sources.get(chart) !== st || !res?.dayStarts?.length || !res.weekStarts?.length) return;
      const prev = mergedAnchors(chart);
      setSlotAnchors(chart, SOURCE_KEY, {
        dayStarts: sortedFinite([...(prev?.dayStarts ?? []), ...res.dayStarts]),
        weekStarts: sortedFinite([...(prev?.weekStarts ?? []), ...res.weekStarts]),
      });
    })
    .catch(() => {
      st.inFlight = false;
    });
}

/** The anchors a chart's grid uses now. */
export function slotAnchorsOf(chart: object): SlotAnchors | undefined {
  return mergedAnchors(chart);
}

/** The cached grid for a candle list while the setting is on, else null. */
export function slotGridFor(list: readonly Stamped[]): SlotGrid | null {
  if (!on || !Array.isArray(list) || list.length < 2) return null;
  const n = list.length;
  const first = list[0]?.timestamp;
  const last = list[n - 1]?.timestamp;
  const chart = chartOfList.get(list);
  if (chart) ensureStarts(chart, first, last);
  const hit = cache.get(list);
  if (hit && hit.n === n && hit.first === first && hit.last === last && hit.v === version) return hit.grid;
  const times = new Array<number>(n);
  for (let i = 0; i < n; i++) times[i] = list[i]?.timestamp;
  const grid = buildSlotGrid(times, mergedAnchors(chart));
  cache.set(list, { n, first, last, v: version, grid });
  return grid;
}

export function equalWidthDaysOn(): boolean {
  return on;
}

type Provider = ((list: unknown, chart?: unknown) => SlotGrid | null) & { version?: number };
type SlotsGlobal = { __chartkarSlots?: Provider };

function bump(): void {
  version++;
  const p = (globalThis as SlotsGlobal).__chartkarSlots;
  if (p) p.version = version;
}

export function setEqualWidthDays(next: boolean): void {
  on = next;
  const g = globalThis as SlotsGlobal;
  // klinecharts calls this from its layout path, where a throw would silently
  // stop every later layout: any failure means "no grid" (identity).
  if (next) {
    const p: Provider = (list, chart) => {
      try {
        if (chart && typeof chart === "object" && list && typeof list === "object") chartOfList.set(list, chart);
        return slotGridFor(list as readonly Stamped[]);
      } catch {
        return null;
      }
    };
    g.__chartkarSlots = p;
  } else delete g.__chartkarSlots;
  bump();
}

type RelayoutStore = { chartkarRelayoutSlots?: (change: () => void) => void };

/**
 * Run a change that moves the slot grid (the setting, anchors) and keep the
 * candle at the middle of the view where it was. Falls back to just running
 * the change on an unpatched chart.
 */
export function relayoutSlots(chart: object | null | undefined, change: () => void): void {
  const store = (chart as { _chartStore?: RelayoutStore } | null | undefined)?._chartStore;
  if (store && typeof store.chartkarRelayoutSlots === "function") store.chartkarRelayoutSlots(change);
  else change();
}

/**
 * Give (or with null, take back) a pinned pane's day or week starts for one
 * chart. Several panes merge, the first registered winning per field.
 */
export function setSlotAnchors(chart: object | null | undefined, key: string, anchors: SlotAnchors | null): void {
  if (!chart) return;
  const m = anchorsByChart.get(chart) ?? new Map<string, SlotAnchors>();
  const prev = m.get(key);
  if (!anchors && !prev) return;
  if (anchors && prev && sameAnchors(prev, anchors)) return;
  relayoutSlots(chart, () => {
    if (anchors) m.set(key, anchors);
    else m.delete(key);
    anchorsByChart.set(chart, m);
    bump();
  });
}

function sameList(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameAnchors(a: SlotAnchors, b: SlotAnchors): boolean {
  return sameList(a.dayStarts, b.dayStarts) && sameList(a.weekStarts, b.weekStarts);
}
