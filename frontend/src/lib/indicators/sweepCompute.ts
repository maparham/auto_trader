// SWEEP (stop hunt) compute: pivot and previous-day levels, same-bar sweep,
// score and confirmation. Node-safe (type-only klinecharts import) so the
// golden generator and expr layer can run it without a window.
//
// Ported operation-for-operation to backend indicators/sweep.py: keep the
// arithmetic order identical, per the parity contract in indicators/core.py.
// The rules themselves are documented there, once.
import type { KLineData } from "klinecharts";
import { atrSeries } from "../atr";
import { getIndicatorTimezone } from "../indicatorTimezone";
import type { SweepConfig } from "./sweepOutputs";

export interface SweepPoint {
  bearSweep: number;
  bullSweep: number;
  bearConfirmed: number;
  bullConfirmed: number;
  score?: number;
  sweptLevel?: number;
  barsSince?: number;
  // 1 on a previous-candle reversal bar (0 while usePrevBar is off). A
  // reversal always flags its side, so each implies the matching sweep.
  bearReversal: number;
  bullReversal: number;
  // Flag bars only, for the draw: where the swept level's dashed segment
  // starts, and what kind of level it was. Not rule operands.
  levelFrom?: number;
  src?: "pivot" | "day" | "bar";
}

interface Level {
  price: number;
  born: number;
  start: number;
  src: "pivot" | "day" | "bar";
}

const DAY_MS = 86_400_000;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayKey(ts: number, zone: string): number {
  let fmt = dayFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(zone, fmt);
  }
  let y = 0;
  let m = 0;
  let d = 0;
  for (const p of fmt.formatToParts(ts)) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") m = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
  }
  return y * 10000 + m * 100 + d;
}

// "", "chart", absent or invalid means the chart zone (PREV_HL's rule). The
// backend gets a stamped zone from withChartTimezone, so both sides agree.
function resolveZone(tz: string | undefined): string {
  if (!tz || tz === "chart") return getIndicatorTimezone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return getIndicatorTimezone();
  }
}

// prevHl.ts estimateBarMs without its cache: the median positive gap.
function medianBarMs(dataList: KLineData[]): number {
  if (dataList.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < dataList.length; i++) {
    const d = dataList[i].timestamp - dataList[i - 1].timestamp;
    if (d > 0) deltas.push(d);
  }
  return deltas.length ? deltas.sort((a, b) => a - b)[deltas.length >> 1] : 0;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Weighted mean of the clamped components, times 100. Range 0 scores 0; a
 * missing ATR or volume reading gives that component 0. */
export function sweepScore(
  cfg: SweepConfig,
  bear: boolean,
  o: number,
  h: number,
  l: number,
  c: number,
  atrPrev: number | null,
  volZ: number | null,
): number {
  const rng = h - l;
  if (rng <= 0) return 0;
  let wick: number;
  let closeD: number;
  if (bear) {
    wick = (h - Math.max(o, c)) / rng;
    closeD = (h - c) / rng;
  } else {
    wick = (Math.min(o, c) - l) / rng;
    closeD = (c - l) / rng;
  }
  const w = clamp01(wick / (cfg.minWickPct / 100));
  const cl = clamp01(closeD / (2 / 3));
  const r = atrPrev !== null && atrPrev > 0 ? clamp01(rng / (cfg.minRangeAtr * atrPrev)) : 0;
  if (cfg.useVolume) {
    const v = volZ !== null ? clamp01(volZ / cfg.volZ) : 0;
    return (w * 0.3 + cl * 0.15 + r * 0.3 + v * 0.25) * 100;
  }
  return (w * 0.4 + cl * 0.2 + r * 0.4) * 100;
}

function volZAt(vols: number[], i: number, n: number): number | null {
  if (i < n) return null;
  let s = 0;
  for (let j = i - n; j < i; j++) s += vols[j];
  const mean = s / n;
  let ss = 0;
  for (let j = i - n; j < i; j++) {
    const d = vols[j] - mean;
    ss += d * d;
  }
  const sd = Math.sqrt(ss / n);
  if (sd === 0) return null;
  return (vols[i] - mean) / sd;
}

function isPivot(vals: number[], p: number, left: number, right: number, wantHigh: boolean): boolean {
  const v = vals[p];
  for (let j = p - left; j <= p + right; j++) {
    if (j === p) continue;
    const w = vals[j];
    if (wantHigh) {
      if (w >= v) return false;
    } else if (w <= v) {
      return false;
    }
  }
  return true;
}

export function computeSweep(dataList: KLineData[], cfg: SweepConfig): SweepPoint[] {
  const n = dataList.length;
  const opens = dataList.map((d) => d.open);
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  const closes = dataList.map((d) => d.close);
  const vols = dataList.map((d) => d.volume ?? 0);
  const atr = atrSeries(dataList, cfg.atrLen);
  // reversalsOnly: no level is ever born, so skip the previous-day
  // birth/tracking too (pivot births are skipped per-bar below).
  const zone = cfg.usePrevDay && !cfg.reversalsOnly && medianBarMs(dataList) <= DAY_MS ? resolveZone(cfg.tz) : null;

  let hiLevels: Level[] = [];
  let loLevels: Level[] = [];
  let curDay: number | null = null;
  let dayHi = -Infinity;
  let dayLo = Infinity;
  let pendDir = 0;
  let pendLevel = 0;
  let pendBar = 0;
  let lastScore: number | undefined;
  let lastLevel: number | undefined;
  let lastBar = -1;

  const out: SweepPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Births: the pivot at p confirms on this bar. reversalsOnly skips this
    // entirely, so no level is ever born (the brief's "no stored levels at
    // all").
    if (!cfg.reversalsOnly) {
      const p = i - cfg.pivotRight;
      if (p - cfg.pivotLeft >= 0) {
        if (isPivot(highs, p, cfg.pivotLeft, cfg.pivotRight, true)) hiLevels.push({ price: highs[p], born: i, start: p, src: "pivot" });
        if (isPivot(lows, p, cfg.pivotLeft, cfg.pivotRight, false)) loLevels.push({ price: lows[p], born: i, start: p, src: "pivot" });
      }
    }
    if (zone !== null) {
      const key = dayKey(dataList[i].timestamp, zone);
      if (curDay === null) {
        curDay = key;
      } else if (key !== curDay) {
        hiLevels.push({ price: dayHi, born: i, start: i, src: "day" });
        loLevels.push({ price: dayLo, born: i, start: i, src: "day" });
        curDay = key;
        dayHi = -Infinity;
        dayLo = Infinity;
      }
    }

    // Expiry.
    hiLevels = hiLevels.filter((lv) => i - lv.born <= cfg.levelMaxAge);
    loLevels = loLevels.filter((lv) => i - lv.born <= cfg.levelMaxAge);

    // Crossings: every crossed level dies; the most extreme is the candidate.
    let bearLv: Level | null = null;
    let kept: Level[] = [];
    for (const lv of hiLevels) {
      if (highs[i] > lv.price) {
        if (bearLv === null || lv.price > bearLv.price) bearLv = lv;
      } else {
        kept.push(lv);
      }
    }
    hiLevels = kept;
    let bullLv: Level | null = null;
    kept = [];
    for (const lv of loLevels) {
      if (lows[i] < lv.price) {
        if (bullLv === null || lv.price < bullLv.price) bullLv = lv;
      } else {
        kept.push(lv);
      }
    }
    loLevels = kept;

    // Previous-candle outside-bar reversal: a one-bar crossing candidate,
    // never stored, that joins the "most extreme crossed level" contest.
    let bullReversal = false;
    let bearReversal = false;
    let prevBullLv: Level | null = null;
    let prevBearLv: Level | null = null;
    // reversalsOnly evaluates this as if usePrevBar were on, whatever
    // usePrevBar says.
    if ((cfg.usePrevBar || cfg.reversalsOnly) && i >= 1) {
      if (closes[i - 1] < opens[i - 1] && lows[i] < lows[i - 1] && closes[i] > highs[i - 1]) {
        bullReversal = true;
        prevBullLv = { price: lows[i - 1], born: i, start: i - 1, src: "bar" };
      } else if (closes[i - 1] > opens[i - 1] && highs[i] > highs[i - 1] && closes[i] < lows[i - 1]) {
        bearReversal = true;
        prevBearLv = { price: highs[i - 1], born: i, start: i - 1, src: "bar" };
      }
    }

    const atrPrev = i >= 1 ? atr[i - 1] : null;
    const vz = cfg.useVolume && (bearLv || bullLv || bearReversal || bullReversal) ? volZAt(vols, i, cfg.volLen) : null;
    let bearS: number | null = null;
    let bullS: number | null = null;
    let bearWin: Level | null = null;
    let bullWin: Level | null = null;
    if (bearReversal) {
      bearWin = bearLv !== null && closes[i] < bearLv.price && bearLv.price > prevBearLv!.price ? bearLv : prevBearLv;
      bearS = sweepScore(cfg, true, opens[i], highs[i], lows[i], closes[i], atrPrev, vz);
    } else if (bearLv !== null && closes[i] < bearLv.price) {
      const s = sweepScore(cfg, true, opens[i], highs[i], lows[i], closes[i], atrPrev, vz);
      if (s >= cfg.minScore) {
        bearS = s;
        bearWin = bearLv;
      }
    }
    if (bullReversal) {
      bullWin = bullLv !== null && closes[i] > bullLv.price && bullLv.price < prevBullLv!.price ? bullLv : prevBullLv;
      bullS = sweepScore(cfg, false, opens[i], highs[i], lows[i], closes[i], atrPrev, vz);
    } else if (bullLv !== null && closes[i] > bullLv.price) {
      const s = sweepScore(cfg, false, opens[i], highs[i], lows[i], closes[i], atrPrev, vz);
      if (s >= cfg.minScore) {
        bullS = s;
        bullWin = bullLv;
      }
    }
    let flag = 0;
    if (bearS !== null && bullS !== null) {
      if (bearReversal && !bullReversal) flag = -1;
      else if (bullReversal && !bearReversal) flag = 1;
      else flag = bearS > bullS ? -1 : bullS > bearS ? 1 : 0;
    } else if (bearS !== null) flag = -1;
    else if (bullS !== null) flag = 1;

    // Confirm check of the sweep pending from an earlier bar.
    let bearConf = 0;
    let bullConf = 0;
    if (pendDir !== 0) {
      if (pendDir < 0 && closes[i] > pendLevel) {
        pendDir = 0;
      } else if (pendDir > 0 && closes[i] < pendLevel) {
        pendDir = 0;
      } else if (i - pendBar >= cfg.confirmBars) {
        if (pendDir < 0) bearConf = 1;
        else bullConf = 1;
        pendDir = 0;
      }
    }

    // This bar's flag: it replaces any pending sweep.
    let flagLv: Level | null = null;
    if (flag !== 0) {
      flagLv = flag < 0 ? bearWin : bullWin;
      pendDir = flag;
      pendLevel = flagLv!.price;
      pendBar = i;
      lastScore = (flag < 0 ? bearS : bullS)!;
      lastLevel = flagLv!.price;
      lastBar = i;
    }

    if (zone !== null) {
      dayHi = Math.max(dayHi, highs[i]);
      dayLo = Math.min(dayLo, lows[i]);
    }

    const pt: SweepPoint = {
      bearSweep: flag < 0 ? 1 : 0,
      bullSweep: flag > 0 ? 1 : 0,
      bearConfirmed: bearConf,
      bullConfirmed: bullConf,
      bearReversal: bearReversal ? 1 : 0,
      bullReversal: bullReversal ? 1 : 0,
    };
    if (lastBar >= 0) {
      pt.score = lastScore;
      pt.sweptLevel = lastLevel;
      pt.barsSince = i - lastBar;
    }
    if (flagLv) {
      pt.levelFrom = flagLv.start;
      pt.src = flagLv.src;
    }
    out[i] = pt;
  }
  return out;
}
