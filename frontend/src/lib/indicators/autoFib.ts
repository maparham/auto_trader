// frontend/src/lib/indicators/autoFib.ts
// AUTO_FIB: a fib retracement between the latest confirmed pivot high and the
// latest confirmed pivot low, redrawn as pivots confirm, optionally with the
// last N fibs dimmed.
//
// Causal (backtest-safe): strict fractal pivots (shared isPivotAt, called the
// way Trendlines calls it) exist only at their confirm bar k + pivotLen, and a
// pair changes only at confirm bars, so the pair active at bar i depends on
// bars [0..i] alone. Per-bar outputs are the rule operands: high, low, dir and
// one price per enabled level (autoFibOutputs).
//
// Ported operation-for-operation to backend/auto_trader/indicators/auto_fib.py;
// keep the arithmetic order identical (see core.py's parity contract).
import type { KLineData } from "klinecharts";
import type { FibConfig } from "../fibConfig";
import { isPivotAt } from "./pivots";
import { isSignificantSwing } from "./trendlines";
import { atrSeries } from "../atr";
import {
  AUTO_FIB_ATR_LEN,
  autoFibLevelOutputs,
  fibLevelPrice,
  type AutoFibConfig,
} from "./autoFibOutputs";

export {
  AUTO_FIB_ATR_LEN,
  AUTO_FIB_DEFAULTS,
  AUTO_FIB_MAX_PAST,
  autoFibFibConfig,
  autoFibOutputs,
  autoFibWarmup,
  fibLevelPrice,
  fibOutputName,
  parseAutoFibConfig,
  type AutoFibConfig,
} from "./autoFibOutputs";

export interface AutoFibPair {
  hiIdx: number;
  hiPrice: number;
  loIdx: number;
  loPrice: number;
  // +1: the high is the later anchor (an up-leg, retracing down). -1: the low.
  dir: 1 | -1;
  startIdx: number; // confirm bar that made this pair current
  endIdx: number | null; // confirm bar that replaced it; null while current
}

interface Anchor {
  idx: number;
  price: number;
}

/** Walk the bars once. `pairOf[i]` is the index of the pair current at bar i
 * (undefined before the first pair). Index 0 is a real pair: compare with
 * `=== undefined`, never by truthiness. */
export function computeAutoFibPairs(
  dataList: KLineData[],
  cfg: AutoFibConfig,
): { pairOf: Array<number | undefined>; pairs: AutoFibPair[] } {
  const len = dataList.length;
  const n = cfg.pivotLen;
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  // No ATR at all with the filter off: pivots count from the first bar, unlike
  // Trendlines, which waits for ATR even then.
  const atr = cfg.minSwingAtr > 0 ? atrSeries(dataList, AUTO_FIB_ATR_LEN) : null;
  // RAW fractal turns per kind, counted or not: the pool isSignificantSwing
  // measures the leg against, exactly as Trendlines keeps it.
  const turns: Record<"high" | "low", number[]> = { high: [], low: [] };
  let hi: Anchor | null = null;
  let lo: Anchor | null = null;
  const pairs: AutoFibPair[] = [];
  const pairOf: Array<number | undefined> = new Array(len).fill(undefined);

  for (let i = 0; i < len; i++) {
    const k = i - n;
    if (k >= 0) {
      let changed = false;
      for (const kind of ["high", "low"] as const) {
        const vals = kind === "high" ? highs : lows;
        if (!isPivotAt(vals, k, n, n, kind, true)) continue;
        turns[kind].push(k);
        if (atr) {
          const atrK = atr[k];
          if (atrK === null) continue;
          const opposite = turns[kind === "high" ? "low" : "high"];
          if (!isSignificantSwing(highs, lows, opposite, k, kind, atrK, cfg.minSwingAtr)) continue;
        }
        if (kind === "high") hi = { idx: k, price: highs[k] };
        else lo = { idx: k, price: lows[k] };
        changed = true;
      }
      if (changed && hi !== null && lo !== null) {
        if (pairs.length) pairs[pairs.length - 1].endIdx = i;
        // Equal indices mean one outside bar is both pivots: its colour picks
        // which extreme came first (green: the low).
        const dir: 1 | -1 =
          hi.idx > lo.idx
            ? 1
            : hi.idx < lo.idx
              ? -1
              : dataList[k].close >= dataList[k].open
                ? 1
                : -1;
        pairs.push({
          hiIdx: hi.idx,
          hiPrice: hi.price,
          loIdx: lo.idx,
          loPrice: lo.price,
          dir,
          startIdx: i,
          endIdx: null,
        });
      }
    }
    if (pairs.length) pairOf[i] = pairs.length - 1;
  }
  return { pairOf, pairs };
}

/** One operand series (`high`, `low`, `dir` or a level name) over the bars.
 * An output the pane does not expose is all undefined. The parity golden
 * reads this. */
export function autoFibSeries(
  dataList: KLineData[],
  cfg: AutoFibConfig,
  fib: FibConfig,
  output: string,
): Array<number | undefined> {
  const { pairOf, pairs } = computeAutoFibPairs(dataList, cfg);
  const level = autoFibLevelOutputs(fib).find((l) => l.name === output);
  return pairOf.map((p) => {
    if (p === undefined) return undefined;
    const q = pairs[p];
    if (output === "high") return q.hiPrice;
    if (output === "low") return q.loPrice;
    if (output === "dir") return q.dir;
    return level ? fibLevelPrice(q.hiPrice, q.loPrice, q.dir, fib.reverse, level.value) : undefined;
  });
}
