// Win/loss contrast analytics: for each recorded entry-context field (plus a
// few derived ones), split the trades by outcome and measure how strongly the
// field separates winners from losers. Fields are RANKED by a proper effect
// size — Cramér's V for categorical fields, |rank-biserial| for numeric ones,
// both on a 0..1 scale — but DISPLAYED as plain per-bucket win rates, which is
// what a person can read. Pure functions over the stored trade shape; computed
// client-side so it works on stored runs without a backend rerun.
//
// Guards: a field needs MIN_FIELD_N valued trades to appear at all; buckets
// under LOW_SAMPLE_N trades are flagged low_sample (same threshold as the
// backend's analysis tables). A run that is all wins or all losses has no
// contrast to measure and yields [].

import type { StoredBacktestResult } from "./persist";

export type ContrastTrade = StoredBacktestResult["trades"][number];
type Trade = ContrastTrade;

export const MIN_FIELD_N = 20;
export const LOW_SAMPLE_N = 5; // mirrors backend analysis.LOW_SAMPLE_N

export interface ContrastBucket {
  bucket: string;
  n: number;
  win_rate: number;
  delta: number; // win_rate minus the field's overall win rate
  low_sample: boolean;
  indices: number[]; // positions in the input trades array, entry order
  legs: { long: LegCount; short: LegCount }; // the bucket split by direction
}

export interface LegCount {
  n: number;
  wins: number;
}

export interface FieldContrast {
  field: string;
  label: string;
  effect: number; // 0..1: Cramér's V (categorical) or |rank-biserial| (numeric)
  n: number; // trades with a value for this field
  conjecture: string;
  buckets: ContrastBucket[];
}

/** Cramér's V for a buckets x (wins, losses) table. With two outcome columns
 * this is sqrt(chi2 / n). Degenerate tables (fewer than two non-empty rows or
 * columns) carry no contrast and return 0. */
export function cramersV(rows: Array<[number, number]>): number {
  const live = rows.filter(([w, l]) => w + l > 0);
  const colW = live.reduce((s, [w]) => s + w, 0);
  const colL = live.reduce((s, [, l]) => s + l, 0);
  const n = colW + colL;
  if (live.length < 2 || colW === 0 || colL === 0 || n === 0) return 0;
  let chi2 = 0;
  for (const [w, l] of live) {
    const rowN = w + l;
    const eW = (rowN * colW) / n;
    const eL = (rowN * colL) / n;
    chi2 += (w - eW) ** 2 / eW + (l - eL) ** 2 / eL;
  }
  return Math.sqrt(chi2 / n);
}

/** Signed rank-biserial correlation from the Mann-Whitney U statistic, with
 * midranks for ties: +1 when every winner value exceeds every loser value,
 * -1 for the reverse, 0 for identical distributions. */
export function rankBiserial(winVals: number[], lossVals: number[]): number {
  const n1 = winVals.length;
  const n2 = lossVals.length;
  if (n1 === 0 || n2 === 0) return 0;
  const all = [
    ...winVals.map((v) => ({ v, win: true })),
    ...lossVals.map((v) => ({ v, win: false })),
  ].sort((a, b) => a.v - b.v);
  // Midranks: every member of a tie group gets the group's average rank.
  let rankSumWins = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const midrank = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) if (all[k].win) rankSumWins += midrank;
    i = j + 1;
  }
  const u1 = rankSumWins - (n1 * (n1 + 1)) / 2;
  return (2 * u1) / (n1 * n2) - 1;
}

/** The three interior quartile edges of `values` (linear interpolation between
 * order statistics). Duplicate edges from heavy ties are deduplicated, so the
 * result can be shorter than 3. */
export function quartileEdges(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  const edges = [at(0.25), at(0.5), at(0.75)];
  return edges.filter((e, k) => k === 0 || e > edges[k - 1]);
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_BUCKET_WIDTH = 4;
const pad2 = (n: number) => String(n).padStart(2, "0");

const hourBucketLabel = (hourUtc: number, offsetHours: number): string => {
  const local = (((hourUtc + offsetHours) % 24) + 24) % 24;
  const start = Math.floor(local / HOUR_BUCKET_WIDTH) * HOUR_BUCKET_WIDTH;
  return `${pad2(start)}:00-${pad2(start + HOUR_BUCKET_WIDTH)}:00`;
};

// Compact duration for the derived holding-time field's bucket labels.
function fmtDur(seconds: number): string {
  const sec = Math.round(seconds);
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Signed percentage-point delta for display. A delta that rounds to zero
 * prints unsigned: "−0%" reads as a defect rather than a near-average bucket. */
export function fmtDeltaPct(delta: number): string {
  const pp = Math.round(delta * 100);
  if (pp === 0) return "0%";
  return `${pp > 0 ? "+" : "−"}${Math.abs(pp)}%`;
}

const fmtVal = (v: number): string => String(Number(v.toFixed(2)));
const pct = (v: number): string => `${Math.round(v * 100)}%`;

interface CatField {
  field: string;
  label: string;
  // Bucket label for one trade, or null when the trade carries no value.
  value(t: Trade, offsetHours: number): string | null;
  // Display order for the bucket labels; default is descending trade count.
  ord?(bucket: string): number;
}

const ctx = (t: Trade, key: string): unknown => (t.context as Record<string, unknown> | null)?.[key];

const catStr = (key: string) => (t: Trade) => {
  const v = ctx(t, key);
  return typeof v === "string" ? v : null;
};

const CATEGORICAL: CatField[] = [
  { field: "trend", label: "trend", value: catStr("trend") },
  { field: "vol_regime", label: "volatility regime", value: catStr("vol_regime") },
  { field: "session", label: "session", value: catStr("session") },
  { field: "candle_pattern", label: "candle pattern", value: catStr("candle_pattern") },
  {
    field: "day_of_week",
    label: "day of week",
    value: (t) => {
      const v = ctx(t, "day_of_week");
      return typeof v === "number" ? DAY_NAMES[v] ?? null : null;
    },
    ord: (b) => DAY_NAMES.indexOf(b),
  },
  {
    field: "hour_utc",
    label: "time of day",
    value: (t, offsetHours) => {
      const v = ctx(t, "hour_utc");
      return typeof v === "number" ? hourBucketLabel(v, offsetHours) : null;
    },
    ord: (b) => parseInt(b, 10),
  },
];

interface NumField {
  field: string;
  label: string;
  value(t: Trade): number | null;
  fmt(v: number): string;
}

const numCtx = (key: string) => (t: Trade) => {
  const v = ctx(t, key);
  return typeof v === "number" ? v : null;
};

const NUMERIC: NumField[] = [
  { field: "dist_swing_high", label: "distance to swing high", value: numCtx("dist_swing_high"), fmt: fmtVal },
  { field: "dist_swing_low", label: "distance to swing low", value: numCtx("dist_swing_low"), fmt: fmtVal },
  {
    field: "held",
    label: "holding time",
    value: (t) => (t.exit_time_exact ?? t.exit_time) - t.entry_time,
    fmt: fmtDur,
  },
];

function conjectureFor(label: string, overall: number, buckets: ContrastBucket[]): string {
  const eligible = buckets.filter((b) => !b.low_sample);
  const pool = eligible.length > 0 ? eligible : buckets;
  // Equal-magnitude deltas tie-break toward the loss-heavy bucket: the whole
  // exercise is about understanding losses.
  const EPS = 1e-9; // float noise (0.8-0.5 vs |0.2-0.5|) must not decide a tie
  const extreme = pool.reduce((a, b) =>
    Math.abs(b.delta) - Math.abs(a.delta) > EPS ||
    (Math.abs(Math.abs(b.delta) - Math.abs(a.delta)) <= EPS && b.delta < a.delta)
      ? b
      : a,
  );
  const side = extreme.delta < 0 ? "Losses" : "Wins";
  return `${side} concentrate where ${label} is ${extreme.bucket}: ${pct(extreme.win_rate)} win rate vs ${pct(overall)} overall.`;
}

interface Group {
  n: number;
  wins: number;
  indices: number[];
  legs: { long: LegCount; short: LegCount };
}

const emptyGroup = (): Group => ({
  n: 0,
  wins: 0,
  indices: [],
  legs: { long: { n: 0, wins: 0 }, short: { n: 0, wins: 0 } },
});

// One trade into its bucket's tallies (overall, direction split, membership).
function addToGroup(g: Group, t: Trade, i: number): void {
  const win = t.pnl > 0;
  g.n++;
  if (win) g.wins++;
  g.indices.push(i);
  const leg = t.leg === "short" ? g.legs.short : g.legs.long;
  leg.n++;
  if (win) leg.wins++;
}

function bucketsFromGroups(
  groups: Map<string, Group>,
  overall: number,
  ord?: (bucket: string) => number,
): ContrastBucket[] {
  const rows = [...groups.entries()].map(([bucket, g]) => ({
    bucket,
    n: g.n,
    win_rate: g.wins / g.n,
    delta: g.wins / g.n - overall,
    low_sample: g.n < LOW_SAMPLE_N,
    indices: g.indices,
    legs: g.legs,
  }));
  rows.sort(ord ? (a, b) => ord(a.bucket) - ord(b.bucket) : (a, b) => b.n - a.n);
  return rows;
}

/** All qualifying fields' contrasts, strongest separation first. `offsetHours`
 * localizes the time-of-day buckets; it defaults to the viewer's timezone and
 * is a parameter so tests need not mock Date. */
export function winLossContrast(
  trades: Trade[],
  offsetHours = -new Date().getTimezoneOffset() / 60,
): FieldContrast[] {
  const anyWin = trades.some((t) => t.pnl > 0);
  const anyLoss = trades.some((t) => t.pnl <= 0);
  if (!anyWin || !anyLoss) return [];

  const out: FieldContrast[] = [];

  for (const f of CATEGORICAL) {
    const groups = new Map<string, Group>();
    let n = 0;
    let wins = 0;
    for (const [i, t] of trades.entries()) {
      const bucket = f.value(t, offsetHours);
      if (bucket == null) continue;
      const g = groups.get(bucket) ?? emptyGroup();
      addToGroup(g, t, i);
      groups.set(bucket, g);
      n++;
      if (t.pnl > 0) wins++;
    }
    if (n < MIN_FIELD_N) continue;
    const overall = wins / n;
    const effect = cramersV([...groups.values()].map((g) => [g.wins, g.n - g.wins]));
    const buckets = bucketsFromGroups(groups, overall, f.ord);
    out.push({
      field: f.field,
      label: f.label,
      effect,
      n,
      conjecture: conjectureFor(f.label, overall, buckets),
      buckets,
    });
  }

  for (const f of NUMERIC) {
    const winVals: number[] = [];
    const lossVals: number[] = [];
    for (const t of trades) {
      const v = f.value(t);
      if (v == null) continue;
      (t.pnl > 0 ? winVals : lossVals).push(v);
    }
    const n = winVals.length + lossVals.length;
    if (n < MIN_FIELD_N || winVals.length === 0 || lossVals.length === 0) continue;
    const overall = winVals.length / n;
    const effect = Math.abs(rankBiserial(winVals, lossVals));
    const edges = quartileEdges([...winVals, ...lossVals]);
    const labelFor = (v: number): string => {
      const idx = edges.findIndex((e) => v <= e);
      if (idx === 0) return `≤${f.fmt(edges[0])}`;
      if (idx === -1) return `>${f.fmt(edges[edges.length - 1])}`;
      return `${f.fmt(edges[idx - 1])}-${f.fmt(edges[idx])}`;
    };
    // Value-ascending display order: one label per edge interval.
    const orderedLabels = [
      `≤${f.fmt(edges[0])}`,
      ...edges.slice(1).map((e, k) => `${f.fmt(edges[k])}-${f.fmt(e)}`),
      `>${f.fmt(edges[edges.length - 1])}`,
    ];
    const groups = new Map<string, Group>();
    for (const [i, t] of trades.entries()) {
      const v = f.value(t);
      if (v == null) continue;
      const bucket = labelFor(v);
      const g = groups.get(bucket) ?? emptyGroup();
      addToGroup(g, t, i);
      groups.set(bucket, g);
    }
    const buckets = bucketsFromGroups(groups, overall, (b) => orderedLabels.indexOf(b));
    out.push({
      field: f.field,
      label: f.label,
      effect,
      n,
      conjecture: conjectureFor(f.label, overall, buckets),
      buckets,
    });
  }

  return out.sort((a, b) => b.effect - a.effect);
}
