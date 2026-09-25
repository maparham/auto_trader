# Auto Fib Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new overlay indicator, `AUTO_FIB`, that draws a fib retracement between the latest confirmed pivot high and pivot low, optionally shows the last N fibs dimmed, can be pinned to a higher timeframe, and exposes high/low/dir plus every enabled level as rule operands.

**Architecture:** A pure pair detector (`computeAutoFibPairs`) walks bars once, admitting strict fractal pivots at their confirm bar, and emits a pair list plus a per-bar pair index. Per-bar operands are derived from the active pair (`fibLevelPrice`). The chart template draws the last `pastCount + 1` pairs with the drawing tool's `fibLevelSegments`. MTF copies SR Levels: the coordinator runs the same detector on HTF bars and stashes the per-HTF-bar pair index, which `calc` aligns with `alignHtfToChart`. The backend port (`auto_fib.py`) mirrors the detector op for op and is pinned by the parity golden.

**Tech Stack:** TypeScript + klinecharts (vitest), React (Testing Library, jsdom), Python 3 (pytest).

**Spec:** `docs/superpowers/specs/2026-09-25-auto-fib-indicator-design.md`

## Global Constraints

- Type id `AUTO_FIB`, shortName `Auto Fib`, meta title `Auto Fib Retracement`.
- `calcParams = [pivotLen = 5, minSwingAtr = 0]`. `extendData`: `fib` (FibConfig), `pastCount` (0..10, default 0), `pastOpacity` (percent 5..100, default 35), `mtf` (`{timeframe, waitClose?}` persisted).
- No `fib` key means `{ ...defaultFibConfig(), extend: "right" }`.
- Outputs: `["high", "low", "dir", ...one per enabled level]`. Level name: `f`, `m` if value < 0, `|value|` rounded to 4 decimals with ties away from zero (TS `toFixed(4)`, Python `Decimal.quantize(..., ROUND_HALF_UP)`), trailing zeros and a trailing `.` dropped, `.` replaced by `_`. `|value| >= 1e6` or non-finite gets no output. Duplicate names keep the first.
- Pivots: `isPivotAt(vals, k, n, n, kind, true)` on highs/lows, processed at confirm bar `i = k + n`, kinds in order `high` then `low`. With `minSwingAtr = 0` no ATR is computed and pivots count from the first bar (deliberately unlike Trendlines). With `minSwingAtr > 0`, `atr[k] === null` rejects and `isSignificantSwing` against the RAW opposite turns decides.
- Tie (high and low pivot on the same bar k): `dir = close[k] >= open[k] ? 1 : -1`.
- Level price: `later = dir > 0 ? hi : lo`, `earlier = dir > 0 ? lo : hi`, `p0 = reverse ? earlier : later`, `p1 = reverse ? later : earlier`, `price = p0 + (p1 - p0) * r`. Identical op order in TS and Python.
- Pair index 0 is a real pair. Never test a pair index for truthiness; always `=== undefined` / `is None`.
- MTF calc snaps only the last `AUTO_FIB_MAX_PAST + 1` (11) mapped pairs; start/end come from one forward pass.
- No em dashes (`—`) or `--` in any UI text, tooltip or comment you add. Tooltips: short lines, `string[]` for more than one rule.
- Shared worktree: never `git stash`, `git clean`, `git restore`, `git checkout -- <file>`. Stage explicit paths only. Commit on the current branch (`main`); never create a branch; never push.
- CPU: per task, run ONLY the single test file the task names (use `-t` where given). Never the whole frontend suite. `tsc -b`, multi-file vitest and the backend pytest set run once, in Task 10, after asking the user.
- The golden fixture is one-line JSON: after regenerating it, run ALL of `backend/tests/test_indicator_parity.py`, not just the new test, to prove existing keys did not move.
- Commit trailer, every commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. Only one pair on screen and it is pair 0: must draw and emit operands, chart-TF and MTF. Tests in Task 2 (`pairOf[10] === 0`) and Task 5 (MTF waitClose case).
2. A pane with no `fib` key: extend reads `right`, default levels give outputs `f0 .. f1`, and `fm0_236` is not an output. Tests in Task 1 and the corpus case in Task 7.
3. Level-name parity on awkward values: `0.03125 → f0_0313`, `1.005 → f1_005`, `-0.00001 → fm0`, `1e6 → none`, `0.6180` then `0.618` → one output. Same table in Task 1 (TS) and Task 3 (Python).
4. MTF calc cost on a deep pin: with 29 mapped pairs only the last 11 are snapped. Test in Task 5.
5. A pinned pane after reload: `refreshMtfIndicators` must refetch it by its `indType`. Test in Task 6.

---

### Task 1: Config, names and level price (leaf module)

**Files:**
- Create: `frontend/src/lib/indicators/autoFibOutputs.ts`
- Test: `frontend/src/lib/indicators/autoFibOutputs.test.ts`

**Interfaces:**
- Consumes: `asFibConfig`, `defaultFibConfig`, `FibConfig` from `frontend/src/lib/fibConfig.ts`.
- Produces: `AUTO_FIB_ATR_LEN = 14`, `AUTO_FIB_MAX_PAST = 10`, `AUTO_FIB_BASE_OUTPUTS`, `interface AutoFibConfig { pivotLen: number; minSwingAtr: number }`, `AUTO_FIB_DEFAULTS`, `parseAutoFibConfig(calcParams: unknown): AutoFibConfig`, `autoFibFibConfig(extendData: unknown): FibConfig`, `fibOutputName(value: number): string | null`, `interface AutoFibLevelOutput { name: string; value: number }`, `autoFibLevelOutputs(fib: FibConfig): AutoFibLevelOutput[]`, `autoFibOutputs(extendData: unknown): string[]`, `autoFibWarmup(cfg: AutoFibConfig): number`, `fibLevelPrice(hi, lo, dir, reverse, r): number`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/indicators/autoFibOutputs.test.ts
import { describe, it, expect } from "vitest";
import {
  autoFibFibConfig,
  autoFibOutputs,
  autoFibWarmup,
  fibLevelPrice,
  fibOutputName,
  parseAutoFibConfig,
} from "./autoFibOutputs";
import { defaultFibConfig } from "../fibConfig";

describe("parseAutoFibConfig", () => {
  it("takes the defaults for missing or garbage slots", () => {
    expect(parseAutoFibConfig(undefined)).toEqual({ pivotLen: 5, minSwingAtr: 0 });
    expect(parseAutoFibConfig([0, -1])).toEqual({ pivotLen: 5, minSwingAtr: 0 });
    expect(parseAutoFibConfig(["x", NaN])).toEqual({ pivotLen: 5, minSwingAtr: 0 });
  });
  it("floors the pivot length and keeps a zero swing filter", () => {
    expect(parseAutoFibConfig([7.9, 0])).toEqual({ pivotLen: 7, minSwingAtr: 0 });
    expect(parseAutoFibConfig([3, 1.5])).toEqual({ pivotLen: 3, minSwingAtr: 1.5 });
  });
});

describe("fibOutputName", () => {
  // Same table as backend tests/test_auto_fib.py::test_fib_output_name.
  it.each([
    [0, "f0"],
    [0.236, "f0_236"],
    [0.5, "f0_5"],
    [0.618, "f0_618"],
    [1, "f1"],
    [1.618, "f1_618"],
    [-0.236, "fm0_236"],
    [10, "f10"],
    [0.03125, "f0_0313"],
    [1.005, "f1_005"],
    [-0.00001, "fm0"],
  ])("%s -> %s", (v, name) => {
    expect(fibOutputName(v)).toBe(name);
  });
  it("gives no name to huge or non-finite ratios", () => {
    expect(fibOutputName(1e6)).toBeNull();
    expect(fibOutputName(Infinity)).toBeNull();
    expect(fibOutputName(NaN)).toBeNull();
  });
});

describe("autoFibOutputs", () => {
  it("reads a pane with no fib key as the default levels, extended right", () => {
    expect(autoFibFibConfig({}).extend).toBe("right");
    expect(autoFibOutputs({})).toEqual([
      "high", "low", "dir", "f0", "f0_236", "f0_382", "f0_5", "f0_618", "f0_786", "f1",
    ]);
    expect(autoFibOutputs(undefined)).not.toContain("fm0_236");
  });
  it("lists enabled levels only, in level order, first duplicate wins", () => {
    const fib = defaultFibConfig();
    fib.levels = [
      { value: 0.618, enabled: true, color: "#000" },
      { value: 0.618, enabled: true, color: "#111" },
      { value: 0.5, enabled: false, color: "#222" },
      { value: -0.236, enabled: true, color: "#333" },
    ];
    expect(autoFibOutputs({ fib })).toEqual(["high", "low", "dir", "f0_618", "fm0_236"]);
  });
});

describe("fibLevelPrice", () => {
  it("puts level 0 on the later anchor and level 1 on the earlier one", () => {
    // dir +1: the high is later (an up-leg), so 0 = high, 1 = low.
    expect(fibLevelPrice(110, 90, 1, false, 0)).toBe(110);
    expect(fibLevelPrice(110, 90, 1, false, 1)).toBe(90);
    expect(fibLevelPrice(110, 90, 1, false, 0.5)).toBe(100);
    // dir -1: the low is later.
    expect(fibLevelPrice(110, 90, -1, false, 0)).toBe(90);
    // reverse swaps the ends.
    expect(fibLevelPrice(110, 90, 1, true, 0)).toBe(90);
  });
});

describe("autoFibWarmup", () => {
  it("is ATR(14) plus one full pivot window", () => {
    expect(autoFibWarmup({ pivotLen: 5, minSwingAtr: 0 })).toBe(24);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/autoFibOutputs.test.ts`
Expected: FAIL, cannot resolve `./autoFibOutputs`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/indicators/autoFibOutputs.ts
// The AUTO_FIB pane's config parsing, output names, warm-up and level price,
// split out of autoFib.ts as a leaf with no RUNTIME klinecharts import.
//
// Same split, same reason, as ./srLevelsOutputs: exprInstances.ts reads these
// from a node context, and autoFib.ts imports them back so the chart and the
// expression layer share one parser.
//
// Mirrors Python indicators/auto_fib.py (parse_auto_fib_config /
// fib_output_name / auto_fib_outputs / auto_fib_warmup / fib_level_price).
import { asFibConfig, defaultFibConfig, type FibConfig } from "../fibConfig";

/** ATR length the swing filter is measured in (backend AUTO_FIB_ATR_LEN). */
export const AUTO_FIB_ATR_LEN = 14;
/** Most past fibs a pane draws. MTF calc snaps this many plus the current. */
export const AUTO_FIB_MAX_PAST = 10;

export const AUTO_FIB_BASE_OUTPUTS = ["high", "low", "dir"] as const;

export interface AutoFibConfig {
  pivotLen: number; // fractal lookback each side; a pivot confirms this many bars late
  minSwingAtr: number; // 0 = off; else the leg must be >= this x ATR(14)
}

export const AUTO_FIB_DEFAULTS: AutoFibConfig = { pivotLen: 5, minSwingAtr: 0 };

/** calcParams order: [pivotLen, minSwingAtr]. Mirrored by backend
 * auto_fib.parse_auto_fib_config; keep in sync. */
export function parseAutoFibConfig(calcParams: unknown): AutoFibConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const len = Number(p[0]);
  const swing = Number(p[1]);
  return {
    pivotLen:
      Number.isFinite(len) && len > 0 ? Math.max(1, Math.floor(len)) : AUTO_FIB_DEFAULTS.pivotLen,
    minSwingAtr: Number.isFinite(swing) && swing >= 0 ? swing : AUTO_FIB_DEFAULTS.minSwingAtr,
  };
}

/** The pane's fib config: extendData.fib when present, else the drawing
 * tool's defaults extended right, so a fresh pane reaches the last bar. */
export function autoFibFibConfig(extendData: unknown): FibConfig {
  const fib =
    extendData && typeof extendData === "object"
      ? (extendData as { fib?: unknown }).fib
      : undefined;
  return fib === undefined ? { ...defaultFibConfig(), extend: "right" } : asFibConfig(fib);
}

/** Rule-operand name for a level ratio, or null when it gets none.
 * toFixed rounds ties to the larger magnitude, which the backend matches with
 * ROUND_HALF_UP on the exact binary value. */
export function fibOutputName(value: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e6) return null;
  let digits = Math.abs(value).toFixed(4);
  if (digits.includes(".")) digits = digits.replace(/0+$/, "").replace(/\.$/, "");
  return `f${value < 0 ? "m" : ""}${digits.replace(".", "_")}`;
}

export interface AutoFibLevelOutput {
  name: string;
  value: number;
}

/** One operand per ENABLED level, in level order; a duplicate name keeps the
 * first level that produced it. */
export function autoFibLevelOutputs(fib: FibConfig): AutoFibLevelOutput[] {
  const out: AutoFibLevelOutput[] = [];
  const seen = new Set<string>();
  for (const l of fib.levels) {
    if (!l.enabled) continue;
    const name = fibOutputName(l.value);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: l.value });
  }
  return out;
}

/** Every operand the pane exposes with its CURRENT levels. */
export function autoFibOutputs(extendData: unknown): string[] {
  return [
    ...AUTO_FIB_BASE_OUTPUTS,
    ...autoFibLevelOutputs(autoFibFibConfig(extendData)).map((l) => l.name),
  ];
}

/** Bars before the first pair can exist: ATR(14) warm-up plus one full pivot
 * window. Mirrors backend auto_fib_warmup. */
export function autoFibWarmup(cfg: AutoFibConfig): number {
  return AUTO_FIB_ATR_LEN + 2 * cfg.pivotLen;
}

/** Price of ratio r on the pair. Level 0 sits on the LATER anchor (the high
 * when dir is +1), level 1 on the earlier one; reverse swaps them, the same
 * convention as the fib drawing tool. Mirrors auto_fib.fib_level_price. */
export function fibLevelPrice(
  hi: number,
  lo: number,
  dir: number,
  reverse: boolean,
  r: number,
): number {
  const later = dir > 0 ? hi : lo;
  const earlier = dir > 0 ? lo : hi;
  const p0 = reverse ? earlier : later;
  const p1 = reverse ? later : earlier;
  return p0 + (p1 - p0) * r;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/autoFibOutputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/autoFibOutputs.ts frontend/src/lib/indicators/autoFibOutputs.test.ts
git commit -m "feat(auto-fib): config, level names and level price

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pair detector (chart timeframe)

**Files:**
- Create: `frontend/src/lib/indicators/autoFib.ts` (compute part only; the template comes in Task 5)
- Test: `frontend/src/lib/indicators/autoFib.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `isPivotAt` (`./pivots`); `isSignificantSwing` (`./trendlines`); `atrSeries` (`../atr`).
- Produces:
  - `interface AutoFibPair { hiIdx: number; hiPrice: number; loIdx: number; loPrice: number; dir: 1 | -1; startIdx: number; endIdx: number | null }`
  - `computeAutoFibPairs(dataList: KLineData[], cfg: AutoFibConfig): { pairOf: Array<number | undefined>; pairs: AutoFibPair[] }`
  - `autoFibSeries(dataList: KLineData[], cfg: AutoFibConfig, fib: FibConfig, output: string): Array<number | undefined>`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/indicators/autoFib.test.ts
// Pins the causal pair detector: strict fractal pivots at their confirm bar,
// the latest high + latest low as one pair, dir by bar order, the outside-bar
// tie, and the optional ATR swing filter. Same fixtures as the backend suite
// (tests/test_auto_fib.py).
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { autoFibSeries, computeAutoFibPairs } from "./autoFib";
import { autoFibFibConfig } from "./autoFibOutputs";

/** high = close + 1, low = close - 1, open = close. */
function bar(close: number, i: number, open = close): KLineData {
  return { timestamp: 1700000000000 + i * 3600_000, open, high: close + 1, low: close - 1, close, volume: 1 };
}

/** Repeated cycles trough(100) -> peak -> trough, 8 bars per cycle. */
function triangle(peaks: number[]): KLineData[] {
  const closes: number[] = [];
  for (const p of peaks) {
    const up = (p - 100) / 4;
    closes.push(100, 100 + up, 100 + 2 * up, 100 + 3 * up, p, 100 + 3 * up, 100 + 2 * up, 100 + up);
  }
  closes.push(100);
  return closes.map((c, i) => bar(c, i));
}

const CFG = { pivotLen: 2, minSwingAtr: 0 };

describe("computeAutoFibPairs", () => {
  it("forms the first pair only when both a high and a low have confirmed", () => {
    // Peaks at 4, 12, 20, 28; troughs at 8, 16, 24 (bar 0 has no left window).
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    // High at 4 confirms at 6; low at 8 confirms at 10. Nothing before 10.
    expect(pairOf.slice(0, 10).every((p) => p === undefined)).toBe(true);
    // Pair index 0 is a real pair (Review Focus 1).
    expect(pairOf[10]).toBe(0);
    expect(pairs[0]).toEqual({ hiIdx: 4, hiPrice: 111, loIdx: 8, loPrice: 99, dir: -1, startIdx: 10, endIdx: 14 });
  });

  it("replaces the pair at each confirm bar and closes the old one there", () => {
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    // High at 12 confirms at 14: new pair, the high is now later (up-leg).
    expect(pairs[1]).toMatchObject({ hiIdx: 12, loIdx: 8, dir: 1, startIdx: 14, endIdx: 18 });
    expect(pairOf[13]).toBe(0);
    expect(pairOf[14]).toBe(1);
    // The last pair is still current.
    expect(pairs[pairs.length - 1].endIdx).toBeNull();
  });

  it("breaks an outside-bar tie by the bar's own colour", () => {
    // Bar 2 is both a strict pivot high and a strict pivot low.
    const flat = (i: number) => bar(100, i);
    const up = [flat(0), flat(1), { ...bar(100, 2), high: 105, low: 95, open: 96, close: 104 }, flat(3), flat(4)];
    const down = [flat(0), flat(1), { ...bar(100, 2), high: 105, low: 95, open: 104, close: 96 }, flat(3), flat(4)];
    const a = computeAutoFibPairs(up, CFG);
    const b = computeAutoFibPairs(down, CFG);
    // One pair, pushed once even though both kinds changed on the same bar.
    expect(a.pairs).toHaveLength(1);
    expect(a.pairs[0].dir).toBe(1); // green: low first, high later
    expect(b.pairs[0].dir).toBe(-1);
    expect(a.pairOf[4]).toBe(0);
  });

  it("filters small swings and waits for ATR when minSwingAtr is on", () => {
    // ATR(14) is first defined at bar 13, so pivots at 4, 8, 12 are rejected.
    // The low at 16 measures against the RAW high turn at 12 and counts; the
    // high at 20 counts against the low at 16. First pair at 20 + 2 = 22.
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), {
      pivotLen: 2,
      minSwingAtr: 0.01,
    });
    expect(pairOf[21]).toBeUndefined();
    expect(pairs[0]).toMatchObject({ hiIdx: 20, loIdx: 16, dir: 1, startIdx: 22 });
  });

  it("rejects everything when the filter is larger than any swing", () => {
    const { pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), { pivotLen: 2, minSwingAtr: 100 });
    expect(pairs).toEqual([]);
  });
});

describe("autoFibSeries", () => {
  it("emits the active pair's high, low, dir and level prices", () => {
    const bars = triangle([110, 110, 110, 110]);
    const fib = autoFibFibConfig({});
    expect(autoFibSeries(bars, CFG, fib, "high")[10]).toBe(111);
    expect(autoFibSeries(bars, CFG, fib, "low")[10]).toBe(99);
    expect(autoFibSeries(bars, CFG, fib, "dir")[10]).toBe(-1);
    // dir -1: level 0 on the later anchor (the low), level 1 on the high.
    expect(autoFibSeries(bars, CFG, fib, "f0")[10]).toBe(99);
    expect(autoFibSeries(bars, CFG, fib, "f0_5")[10]).toBe(105);
    expect(autoFibSeries(bars, CFG, fib, "f0_5")[9]).toBeUndefined();
    // Not an output of this pane: all undefined.
    expect(autoFibSeries(bars, CFG, fib, "fm0_236").every((v) => v === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/autoFib.test.ts`
Expected: FAIL, cannot resolve `./autoFib`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/autoFib.test.ts`
Expected: PASS. If the ATR-filter case disagrees, print `atrSeries(triangle(...), 14)` first: the expectation assumes ATR(14) is first non-null at bar 13.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/autoFib.ts frontend/src/lib/indicators/autoFib.test.ts
git commit -m "feat(auto-fib): causal pivot pair detector

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backend port and registry

**Files:**
- Create: `backend/auto_trader/indicators/auto_fib.py`
- Modify: `backend/auto_trader/indicators/registry.py` (imports at top; `SERIES_INDICATORS` dict)
- Test: `backend/tests/test_auto_fib.py`

**Interfaces:**
- Consumes: `atr_series` from `auto_trader.indicators.core`; `Candle` from `auto_trader.core.models`.
- Produces: `AutoFibConfig`, `parse_auto_fib_config(calc_params, extend_data) -> AutoFibConfig`, `fib_output_name(value) -> str | None`, `fib_level_price(hi, lo, direction, reverse, r) -> float`, `compute_pairs(cfg, candles) -> tuple[list[int | None], list[Pair]]`, `auto_fib_outputs(cfg) -> tuple[str, ...]`, `auto_fib_series(cfg, output, candles, bar_hours) -> list[float | None]`, `auto_fib_warmup(cfg, output) -> int`; registry key `"AUTO_FIB"`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_auto_fib.py
"""AUTO_FIB backend series. Mirrors the frontend suites
(frontend/src/lib/indicators/autoFib.test.ts, autoFibOutputs.test.ts): same
fixtures, same expectations, same name table. Exact cross-runtime parity is
separately pinned by test_indicator_parity.py."""

from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.auto_fib import (
    AutoFibConfig,
    auto_fib_outputs,
    auto_fib_series,
    auto_fib_warmup,
    compute_pairs,
    fib_level_price,
    fib_output_name,
    parse_auto_fib_config,
)
from auto_trader.indicators.registry import SERIES_INDICATORS


def bar(close: float, i: int, open_: float | None = None, high: float | None = None,
        low: float | None = None) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=close if open_ is None else open_,
        high=close + 1 if high is None else high,
        low=close - 1 if low is None else low,
        close=close,
        volume=1,
    )


def triangle(peaks: list[float]) -> list[Candle]:
    closes: list[float] = []
    for p in peaks:
        up = (p - 100) / 4
        closes.extend([100, 100 + up, 100 + 2 * up, 100 + 3 * up, p, 100 + 3 * up, 100 + 2 * up, 100 + up])
    closes.append(100)
    return [bar(c, i) for i, c in enumerate(closes)]


CFG = parse_auto_fib_config([2, 0], {})
TRI = triangle([110, 110, 110, 110])


@pytest.mark.parametrize("value,name", [
    (0, "f0"), (0.236, "f0_236"), (0.5, "f0_5"), (0.618, "f0_618"), (1, "f1"),
    (1.618, "f1_618"), (-0.236, "fm0_236"), (10, "f10"), (0.03125, "f0_0313"),
    (1.005, "f1_005"), (-0.00001, "fm0"),
])
def test_fib_output_name(value, name):
    # Same table as frontend autoFibOutputs.test.ts.
    assert fib_output_name(value) == name


def test_fib_output_name_rejects_huge_and_non_finite():
    assert fib_output_name(1e6) is None
    assert fib_output_name(float("inf")) is None
    assert fib_output_name(float("nan")) is None


def test_parse_defaults_and_garbage():
    assert parse_auto_fib_config(None, None) == parse_auto_fib_config([5, 0], {})
    cfg = parse_auto_fib_config([0, -1], "junk")
    assert (cfg.pivot_len, cfg.min_swing_atr, cfg.reverse, cfg.timeframe) == (5, 0.0, False, None)
    assert parse_auto_fib_config([7.9, 1.5], {}).pivot_len == 7


def test_outputs_default_levels_and_enabled_only():
    assert auto_fib_outputs(CFG) == (
        "high", "low", "dir", "f0", "f0_236", "f0_382", "f0_5", "f0_618", "f0_786", "f1",
    )
    cfg = parse_auto_fib_config([5, 0], {"fib": {"levels": [
        {"value": 0.618, "enabled": True, "color": "#000"},
        {"value": 0.618, "enabled": True, "color": "#111"},
        {"value": 0.5, "enabled": False, "color": "#222"},
        {"value": -0.236, "enabled": True, "color": "#333"},
        {"value": True, "enabled": True, "color": "#444"},  # a bool is not a number
    ], "reverse": True}})
    assert auto_fib_outputs(cfg) == ("high", "low", "dir", "f0_618", "fm0_236")
    assert cfg.reverse is True


def test_all_invalid_levels_fall_back_to_defaults():
    cfg = parse_auto_fib_config([5, 0], {"fib": {"levels": [{"value": "x"}]}})
    assert auto_fib_outputs(cfg) == auto_fib_outputs(CFG)


def test_first_pair_and_replacement():
    pair_of, pairs = compute_pairs(CFG, TRI)
    assert all(p is None for p in pair_of[:10])
    assert pair_of[10] == 0  # pair index 0 is a real pair
    p0 = pairs[0]
    assert (p0.hi_idx, p0.hi_price, p0.lo_idx, p0.lo_price, p0.direction) == (4, 111, 8, 99, -1)
    assert (pairs[1].hi_idx, pairs[1].lo_idx, pairs[1].direction) == (12, 8, 1)
    assert pair_of[13] == 0 and pair_of[14] == 1


def test_outside_bar_tie():
    def mk(open_, close):
        flat = [bar(100, i) for i in range(5)]
        flat[2] = bar(close, 2, open_=open_, high=105, low=95)
        return flat
    up_of, up = compute_pairs(CFG, mk(96, 104))
    _, down = compute_pairs(CFG, mk(104, 96))
    assert len(up) == 1 and up[0].direction == 1
    assert down[0].direction == -1
    assert up_of[4] == 0


def test_swing_filter_waits_for_atr_and_uses_raw_turns():
    pair_of, pairs = compute_pairs(parse_auto_fib_config([2, 0.01], {}), TRI)
    assert pair_of[21] is None
    assert (pairs[0].hi_idx, pairs[0].lo_idx, pairs[0].direction) == (20, 16, 1)
    assert compute_pairs(parse_auto_fib_config([2, 100], {}), TRI)[1] == []


def test_series_values():
    assert auto_fib_series(CFG, "high", TRI, 1.0)[10] == 111
    assert auto_fib_series(CFG, "dir", TRI, 1.0)[10] == -1.0
    assert auto_fib_series(CFG, "f0", TRI, 1.0)[10] == 99
    assert auto_fib_series(CFG, "f0_5", TRI, 1.0)[10] == 105
    assert auto_fib_series(CFG, "f0_5", TRI, 1.0)[9] is None
    assert all(v is None for v in auto_fib_series(CFG, "fm0_236", TRI, 1.0))


def test_level_price_and_warmup():
    assert fib_level_price(110, 90, 1, False, 0) == 110
    assert fib_level_price(110, 90, -1, False, 0) == 90
    assert fib_level_price(110, 90, 1, True, 0) == 90
    assert auto_fib_warmup(parse_auto_fib_config([5, 0], {}), "f0_618") == 24
    assert auto_fib_warmup(CFG, "bogus") == 0


def test_registry_entry_and_pin():
    spec = SERIES_INDICATORS["AUTO_FIB"]
    cfg = spec.parse_config([5, 0], {"mtf": {"timeframe": "HOUR_4"}})
    assert isinstance(cfg, AutoFibConfig)
    assert spec.timeframe(cfg) == "HOUR_4"
    assert spec.timeframe(spec.parse_config([5, 0], {"mtf": {"timeframe": "chart"}})) is None
    assert spec.outputs(cfg)[:3] == ("high", "low", "dir")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest -q tests/test_auto_fib.py`
Expected: FAIL, `ModuleNotFoundError: auto_trader.indicators.auto_fib`.

- [ ] **Step 3: Write the implementation**

```python
# backend/auto_trader/indicators/auto_fib.py
"""AUTO_FIB instances (`AUTO_FIB#id.high` / `.low` / `.dir` / `.f0_618` ...):
a fib retracement between the latest confirmed pivot high and pivot low.
Ported operation-for-operation from frontend lib/indicators/autoFib.ts
(computeAutoFibPairs / autoFibSeries) and autoFibOutputs.ts (parse, names,
warm-up, level price); keep the arithmetic order identical, per the parity
contract in indicators/core.py.

Causal: a strict fractal pivot at bar k confirms at k + pivot_len and the pair
only changes at confirm bars, so values at bar i depend only on bars [0..i].
With min_swing_atr at 0 no ATR is computed and pivots count from the first
bar (unlike trendlines, which waits for ATR)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

AUTO_FIB_ATR_LEN = 14
BASE_OUTPUTS = ("high", "low", "dir")
# frontend fibConfig.ts DEFAULT_LEVELS as (value, enabled); colours are
# draw-only and not needed here.
_DEFAULT_LEVELS: tuple[tuple[float, bool], ...] = (
    (0.0, True), (0.236, True), (0.382, True), (0.5, True), (0.618, True),
    (0.786, True), (1.0, True), (1.618, False), (2.618, False), (-0.236, False),
)


@dataclass(frozen=True, slots=True)
class AutoFibConfig:
    pivot_len: int = 5
    min_swing_atr: float = 0.0
    # Enabled levels as (output name, ratio), in level order, names unique.
    levels: tuple[tuple[str, float], ...] = ()
    reverse: bool = False
    # Settings-pinned timeframe (extendData.mtf.timeframe, like SR_LEVELS).
    timeframe: str | None = None


@dataclass(slots=True)
class Pair:
    hi_idx: int
    hi_price: float
    lo_idx: int
    lo_price: float
    direction: int  # +1: the high is the later anchor


def fib_output_name(value: float) -> str | None:
    """fibOutputName: `f`, `m` when negative, |value| rounded to 4 decimals
    (JS toFixed picks the larger n on a tie, so ROUND_HALF_UP on the exact
    binary value), trailing zeros dropped, `.` -> `_`."""
    if not math.isfinite(value) or abs(value) >= 1e6:
        return None
    digits = format(Decimal(abs(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP), "f")
    if "." in digits:
        digits = digits.rstrip("0").rstrip(".")
    return f"f{'m' if value < 0 else ''}{digits.replace('.', '_')}"


def _raw_levels(ext: dict) -> tuple[list[tuple[float, bool]], bool]:
    """asFibConfig's level filter: keep entries with a finite number value, a
    bool enabled and a str color; nothing kept (or no fib object) falls back to
    the default levels. Returns (levels, reverse)."""
    fib = ext.get("fib")
    if not isinstance(fib, dict):
        return list(_DEFAULT_LEVELS), False
    kept: list[tuple[float, bool]] = []
    raw = fib.get("levels")
    if isinstance(raw, list):
        for lv in raw:
            if not isinstance(lv, dict):
                continue
            v = lv.get("value")
            enabled = lv.get("enabled")
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                continue
            if not isinstance(enabled, bool) or not isinstance(lv.get("color"), str):
                continue
            kept.append((float(v), enabled))
    return (kept or list(_DEFAULT_LEVELS)), fib.get("reverse") is True


def parse_auto_fib_config(calc_params: object, extend_data: object) -> AutoFibConfig:
    """Mirrors frontend parseAutoFibConfig + autoFibLevelOutputs. calcParams
    order: [pivotLen, minSwingAtr]. Never raises on chart state."""
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def num_at(i: int) -> float:
        try:
            return float(p[i])
        except (IndexError, TypeError, ValueError):
            return math.nan

    length = num_at(0)
    swing = num_at(1)
    ext = extend_data if isinstance(extend_data, dict) else {}
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    raw, reverse = _raw_levels(ext)
    levels: list[tuple[str, float]] = []
    seen: set[str] = set()
    for value, enabled in raw:
        if not enabled:
            continue
        name = fib_output_name(value)
        if name is None or name in seen:
            continue
        seen.add(name)
        levels.append((name, value))
    return AutoFibConfig(
        pivot_len=max(1, math.floor(length)) if math.isfinite(length) and length > 0 else 5,
        min_swing_atr=swing if math.isfinite(swing) and swing >= 0 else 0.0,
        levels=tuple(levels),
        reverse=reverse,
        timeframe=tf if isinstance(tf, str) and tf and tf != "chart" else None,
    )


def fib_level_price(hi: float, lo: float, direction: int, reverse: bool, r: float) -> float:
    """fibLevelPrice: level 0 on the later anchor, level 1 on the earlier."""
    later = hi if direction > 0 else lo
    earlier = lo if direction > 0 else hi
    p0 = earlier if reverse else later
    p1 = later if reverse else earlier
    return p0 + (p1 - p0) * r


def _is_pivot_at(values: Sequence[float], i: int, n: int, want_high: bool) -> bool:
    """pivots.ts isPivotAt with strict=True, lbL = lbR = n."""
    if i - n < 0 or i + n >= len(values):
        return False
    v = values[i]
    for j in range(i - n, i + n + 1):
        if j == i:
            continue
        w = values[j]
        if want_high:
            if w >= v:
                return False
        elif w <= v:
            return False
    return True


def _is_significant_swing(
    highs: Sequence[float], lows: Sequence[float], opposite_turns: Sequence[int],
    k: int, kind: str, atr_k: float, mult: float,
) -> bool:
    """trendlines.ts isSignificantSwing: the leg to the most recent opposite
    turn strictly before k; no opposite turn yet rejects."""
    if mult <= 0:
        return True
    h = -1
    for q in range(len(opposite_turns) - 1, -1, -1):
        if opposite_turns[q] < k:
            h = opposite_turns[q]
            break
    if h < 0:
        return False
    leg = highs[k] - lows[h] if kind == "high" else highs[h] - lows[k]
    return leg >= mult * atr_k


def compute_pairs(cfg: AutoFibConfig, candles: Sequence[Candle]) -> tuple[list[int | None], list[Pair]]:
    """computeAutoFibPairs: pair_of[i] is the pair current at bar i."""
    n = cfg.pivot_len
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    atr = atr_series(candles, AUTO_FIB_ATR_LEN) if cfg.min_swing_atr > 0 else None
    turns: dict[str, list[int]] = {"high": [], "low": []}
    hi: tuple[int, float] | None = None
    lo: tuple[int, float] | None = None
    pairs: list[Pair] = []
    pair_of: list[int | None] = []
    for i in range(len(candles)):
        k = i - n
        if k >= 0:
            changed = False
            for kind in ("high", "low"):
                vals = highs if kind == "high" else lows
                if not _is_pivot_at(vals, k, n, kind == "high"):
                    continue
                turns[kind].append(k)
                if atr is not None:
                    atr_k = atr[k]
                    if atr_k is None:
                        continue
                    opposite = turns["low" if kind == "high" else "high"]
                    if not _is_significant_swing(highs, lows, opposite, k, kind, atr_k, cfg.min_swing_atr):
                        continue
                if kind == "high":
                    hi = (k, highs[k])
                else:
                    lo = (k, lows[k])
                changed = True
            if changed and hi is not None and lo is not None:
                if hi[0] > lo[0]:
                    direction = 1
                elif hi[0] < lo[0]:
                    direction = -1
                else:
                    direction = 1 if candles[k].close >= candles[k].open else -1
                pairs.append(Pair(hi[0], hi[1], lo[0], lo[1], direction))
        pair_of.append(len(pairs) - 1 if pairs else None)
    return pair_of, pairs


def auto_fib_outputs(cfg: AutoFibConfig) -> tuple[str, ...]:
    """high/low/dir first (the chart click-to-insert token emits outputs[0]),
    then one name per enabled level."""
    return BASE_OUTPUTS + tuple(name for name, _ in cfg.levels)


def auto_fib_series(
    cfg: AutoFibConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    # Dispatch on the NAME; an unknown one is the validation layer's error, so
    # it yields an all-None series here.
    pair_of, pairs = compute_pairs(cfg, candles)
    ratio = dict(cfg.levels).get(output)
    out: list[float | None] = []
    for p in pair_of:
        if p is None:
            out.append(None)
            continue
        q = pairs[p]
        if output == "high":
            out.append(q.hi_price)
        elif output == "low":
            out.append(q.lo_price)
        elif output == "dir":
            out.append(float(q.direction))
        elif ratio is not None:
            out.append(fib_level_price(q.hi_price, q.lo_price, q.direction, cfg.reverse, ratio))
        else:
            out.append(None)
    return out


def auto_fib_warmup(cfg: AutoFibConfig, output: str) -> int:
    """ATR(14) warm-up plus one full pivot window; 0 for an output this config
    does not expose."""
    return AUTO_FIB_ATR_LEN + 2 * cfg.pivot_len if output in auto_fib_outputs(cfg) else 0
```

Registry (`backend/auto_trader/indicators/registry.py`): add `from auto_trader.indicators import auto_fib as _af` beside the other imports (alphabetical, first), and this entry at the top of `SERIES_INDICATORS`:

```python
    "AUTO_FIB": IndicatorSeriesSpec(
        parse_config=_af.parse_auto_fib_config,
        outputs=_af.auto_fib_outputs,
        series=_af.auto_fib_series,
        warmup=_af.auto_fib_warmup,
        timeframe=lambda cfg: cfg.timeframe,
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest -q tests/test_auto_fib.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/auto_fib.py backend/auto_trader/indicators/registry.py backend/tests/test_auto_fib.py
git commit -m "feat(auto-fib): backend series and registry entry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Parity golden

**Files:**
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts` (imports; the `series` object literal)
- Modify (regenerated): `backend/tests/fixtures/indicator_golden.json`
- Modify: `backend/tests/test_indicator_parity.py` (new test after `test_sr_levels`)

**Interfaces:**
- Consumes: `autoFibSeries` (Task 2), `defaultFibConfig`, `alignHtfToChart`; Python `parse_auto_fib_config`, `auto_fib_series` (Task 3), `align_htf_to_base`.
- Produces: golden keys `AUTO_FIB_HIGH`, `AUTO_FIB_LOW`, `AUTO_FIB_DIR`, `AUTO_FIB_F0_618`, `AUTO_FIB_F1`, `AUTO_FIB_ATR_F0_5`, `AUTO_FIB_F0_618@HOUR_4`.

- [ ] **Step 1: Write the failing Python test**

Append to `backend/tests/test_indicator_parity.py` after `test_sr_levels`:

```python
def test_auto_fib(golden, golden_raw):
    from auto_trader.indicators.auto_fib import auto_fib_series, parse_auto_fib_config
    from auto_trader.indicators.mtf import align_htf_to_base

    candles, _, series = golden
    # Configs mirrored by indicatorParityGolden.test.ts VALUE FOR VALUE.
    base = parse_auto_fib_config([3, 0], {})
    swing = parse_auto_fib_config([3, 1.5], {})
    for cfg, output, key in (
        (base, "high", "AUTO_FIB_HIGH"),
        (base, "low", "AUTO_FIB_LOW"),
        (base, "dir", "AUTO_FIB_DIR"),
        (base, "f0_618", "AUTO_FIB_F0_618"),
        (base, "f1", "AUTO_FIB_F1"),
        (swing, "f0_5", "AUTO_FIB_ATR_F0_5"),
    ):
        expected = series[key]
        assert any(v is not None for v in expected), f"{key}: golden is all-None"
        assert_series_equal(auto_fib_series(cfg, output, candles, 1.0), expected, key)
    # Both directions occur, so the ordering branches are exercised.
    assert {1, -1} <= {v for v in series["AUTO_FIB_DIR"] if v is not None}

    htf = [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"], volume=c["volume"],
        )
        for c in golden_raw["htfCandles"]
    ]
    base_ms = [c["time"] * 1000 for c in golden_raw["candles"]]
    aligned = align_htf_to_base(base_ms, htf, auto_fib_series(base, "f0_618", htf, 4.0), 4 * 3600 * 1000)
    assert_series_equal(aligned, series["AUTO_FIB_F0_618@HOUR_4"], "AUTO_FIB_F0_618@HOUR_4")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/pytest -q tests/test_indicator_parity.py -k auto_fib`
Expected: FAIL with `KeyError: 'AUTO_FIB_HIGH'`.

- [ ] **Step 3: Add the TS side and regenerate**

In `frontend/src/lib/indicatorParityGolden.test.ts`, add imports beside `computeTrendlines`:

```ts
import { autoFibSeries } from "./indicators/autoFib";
import { defaultFibConfig } from "./fibConfig";
```

Before `const series` add:

```ts
    // AUTO_FIB: configs mirrored by test_indicator_parity.test_auto_fib.
    const AF_FIB = { ...defaultFibConfig(), extend: "right" as const };
    const AF_BASE = { pivotLen: 3, minSwingAtr: 0 };
    const AF_SWING = { pivotLen: 3, minSwingAtr: 1.5 };
    const af = (cfg: typeof AF_BASE, output: string) => toNull(autoFibSeries(candles, cfg, AF_FIB, output));
```

Inside the `series` object literal, after the `SR_RESISTANCE` entry:

```ts
      AUTO_FIB_HIGH: af(AF_BASE, "high"),
      AUTO_FIB_LOW: af(AF_BASE, "low"),
      AUTO_FIB_DIR: af(AF_BASE, "dir"),
      AUTO_FIB_F0_618: af(AF_BASE, "f0_618"),
      AUTO_FIB_F1: af(AF_BASE, "f1"),
      AUTO_FIB_ATR_F0_5: af(AF_SWING, "f0_5"),
      "AUTO_FIB_F0_618@HOUR_4": toNull(
        alignHtfToChart(baseTimestamps, htfCandles, autoFibSeries(htfCandles, AF_BASE, AF_FIB, "f0_618"), htfMs, true),
      ),
```

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS, fixture rewritten.

- [ ] **Step 4: Verify the whole parity file (existing keys unchanged)**

Run: `cd backend && .venv/bin/pytest -q tests/test_indicator_parity.py`
Expected: all PASS. If `AUTO_FIB_ATR_F0_5` is all-None, lower `1.5` to `1.0` in BOTH files and regenerate.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorParityGolden.test.ts backend/tests/fixtures/indicator_golden.json backend/tests/test_indicator_parity.py
git commit -m "test(auto-fib): parity golden for series, swing filter and MTF

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Chart template (calc with MTF mapping, draw) and registration

**Files:**
- Modify: `frontend/src/lib/indicators/autoFib.ts` (append)
- Modify: `frontend/src/lib/customIndicators.ts` (barrel export, import, `CustomIndicatorType`, `BASE_TEMPLATES`, `OVERLAY_INDICATORS`)
- Modify: `frontend/src/lib/indicatorMeta.ts` (new `AUTO_FIB` entry, next to `SR_LEVELS`)
- Test: `frontend/src/lib/indicators/autoFib.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `alignHtfToChart`, `MtfSeriesBase` (`../mtf`); `htfBarEndMs` (`../mtfForming`); `fibLevelSegments` (`../fibConfig`); `clipSegmentToRect`, `DRAW_CLIP_PAD` (`./shared`).
- Produces:
  - `interface AutoFibMtfPair { hiTs: number; hiPrice: number; loTs: number; loPrice: number; dir: 1 | -1 }`
  - `interface AutoFibExtend { fib?: FibConfig; pastCount?: number; pastOpacity?: number; mtf?: MtfSeriesBase & { htfStarts?: number[]; htfMs?: number; htfFibPairIdx?: Array<number | undefined>; htfFibPairs?: AutoFibMtfPair[] }; hideLegendValue?: boolean }`
  - `interface AutoFibPoint { high?: number; low?: number; dir?: number }`, `interface AutoFibRow extends AutoFibPoint { pairs?: AutoFibPair[] }`
  - `computeAutoFib(dataList, cfg, ext?): { points: AutoFibPoint[]; pairs: AutoFibPair[] }`
  - `AUTO_FIB_TEMPLATE`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicators/autoFib.test.ts` (extend the import from `./autoFib` with `computeAutoFib`):

```ts
describe("computeAutoFib MTF branch", () => {
  const H = 3600_000;
  const t0 = 1700000000000;
  const flat = Array.from({ length: 12 }, (_, i) => bar(100, i)); // high 101, low 99
  const pairs = [
    { hiTs: t0, hiPrice: 110, loTs: t0 + 4 * H, loPrice: 90, dir: -1 as const },
    { hiTs: t0 + 8 * H, hiPrice: 120, loTs: t0 + 4 * H, loPrice: 90, dir: 1 as const },
  ];
  const mtf = {
    timeframe: "HOUR_4",
    chartMs: H,
    htfMs: 4 * H,
    htfStarts: [t0, t0 + 4 * H, t0 + 8 * H],
    htfFibPairIdx: [0, 0, 1] as Array<number | undefined>,
    htfFibPairs: pairs,
  };

  it("shows pair 0 when it is the only pair on screen (closed bars only)", () => {
    const { points, pairs: out } = computeAutoFib(flat, CFG, { mtf });
    expect(points[3]).toEqual({});
    expect(points[4]).toEqual({ high: 110, low: 90, dir: -1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startIdx: 4, endIdx: null, hiPrice: 110 });
  });

  it("admits the forming bar from its open and closes the previous pair there", () => {
    const { pairs: out } = computeAutoFib(flat, CFG, { mtf: { ...mtf, formingIdx: 2 } });
    expect(out.map((p) => [p.startIdx, p.endIdx])).toEqual([[4, 8], [8, null]]);
  });

  it("snaps an anchor to the chart candle holding the HTF extreme", () => {
    const bars = flat.slice();
    bars[2] = bar(109, 2); // high 110, inside HTF bar 0 (chart bars 0..3)
    const { pairs: out } = computeAutoFib(bars, CFG, { mtf });
    expect(out[0].hiIdx).toBe(2);
    expect(out[0].loIdx).toBe(4); // flat span: ties keep the first bar
  });

  it("snaps only the last 11 mapped pairs (calc runs every tick)", () => {
    // 30 HTF bars, pair p active on HTF bar p; each pair's high trades on the
    // third chart bar of its HTF bar. Pair 29 closes past the loaded bars, so
    // 29 pairs map (0..28) and only 18..28 are snapped.
    const bars = Array.from({ length: 120 }, (_, i) => bar(i % 4 === 2 ? 109 : 100, i));
    const deep = {
      timeframe: "HOUR_4",
      chartMs: H,
      htfMs: 4 * H,
      htfStarts: Array.from({ length: 30 }, (_, p) => t0 + p * 4 * H),
      htfFibPairIdx: Array.from({ length: 30 }, (_, p) => p) as Array<number | undefined>,
      htfFibPairs: Array.from({ length: 30 }, (_, p) => ({
        hiTs: t0 + p * 4 * H, hiPrice: 110, loTs: t0 + p * 4 * H, loPrice: 99, dir: 1 as const,
      })),
    };
    const { pairs: out } = computeAutoFib(bars, CFG, { mtf: deep });
    expect(out).toHaveLength(29);
    expect(out[17].hiIdx).toBe(17 * 4); // unsnapped: first bar of its HTF bar
    expect(out[18].hiIdx).toBe(18 * 4 + 2); // snapped onto the wick
    expect(out[28].hiIdx).toBe(28 * 4 + 2);
  });
});

describe("AUTO_FIB_TEMPLATE draw", () => {
  function fakeCtx() {
    const calls: string[] = [];
    const ctx: Record<string, unknown> = {
      strokeStyle: "", fillStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "", globalAlpha: 1,
      save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
      setLineDash: () => {},
      stroke: () => calls.push(`stroke:${ctx.globalAlpha}`),
      fillText: (t: string) => calls.push(`text:${t}`),
    };
    return { ctx, calls };
  }

  async function paint(pastCount: number) {
    const { AUTO_FIB_TEMPLATE } = await import("./autoFib");
    const { ctx, calls } = fakeCtx();
    const mk = (s: number, e: number | null) => ({ hiIdx: s - 2, hiPrice: 110, loIdx: s - 4, loPrice: 90, dir: 1, startIdx: s, endIdx: e });
    const result = [{}, { pairs: [mk(10, 20), mk(20, 30), mk(30, null)] }];
    (AUTO_FIB_TEMPLATE as { draw: (p: unknown) => boolean }).draw({
      ctx,
      chart: { getDataList: () => new Array(40), getSize: () => ({ width: 40 }) },
      indicator: {
        result,
        calcParams: [5, 0],
        extendData: { pastCount, fib: { levels: [{ value: 0, enabled: true, color: "#111" }, { value: 1, enabled: true, color: "#222" }], extend: "none", reverse: false, trendLine: false, labels: true } },
        paneId: "candle_pane",
        precision: 2,
      },
      bounding: { width: 500, height: 400 },
      xAxis: { convertToPixel: (i: number) => i * 10 },
      yAxis: { convertToPixel: (p: number) => 300 - p },
    });
    return calls;
  }

  it("draws only the current fib by default, with labels", async () => {
    const calls = await paint(0);
    expect(calls.filter((c) => c.startsWith("stroke:"))).toEqual(["stroke:1", "stroke:1"]);
    expect(calls).toContain("text:0 (110.00)");
  });

  it("adds pastCount earlier fibs, dimmed and unlabelled", async () => {
    const calls = await paint(1);
    expect(calls.filter((c) => c === "stroke:0.35")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(2); // current only
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/autoFib.test.ts`
Expected: FAIL, `computeAutoFib` / `AUTO_FIB_TEMPLATE` not exported.

- [ ] **Step 3: Implement**

Change the imports at the top of `autoFib.ts` to:

```ts
import type { Indicator, IndicatorDrawParams, IndicatorTemplate, KLineData } from "klinecharts";
import { fibLevelSegments, type FibConfig } from "../fibConfig";
import { isPivotAt } from "./pivots";
import { isSignificantSwing } from "./trendlines";
import { atrSeries } from "../atr";
import { alignHtfToChart, type MtfSeriesBase } from "../mtf";
import { htfBarEndMs } from "../mtfForming";
import { clipSegmentToRect, DRAW_CLIP_PAD } from "./shared";
import {
  AUTO_FIB_ATR_LEN,
  AUTO_FIB_DEFAULTS,
  AUTO_FIB_MAX_PAST,
  autoFibFibConfig,
  autoFibLevelOutputs,
  fibLevelPrice,
  parseAutoFibConfig,
  type AutoFibConfig,
} from "./autoFibOutputs";
```

Append:

```ts
// ---------------------------------------------------------------------------
// MTF mapping + chart template
// ---------------------------------------------------------------------------

/** One pair computed on HTF bars, stashed with TIMESTAMPS so calc can map it
 * onto whatever chart bars are loaded. */
export interface AutoFibMtfPair {
  hiTs: number; // open of the HTF bar holding the high anchor
  hiPrice: number;
  loTs: number;
  loPrice: number;
  dir: 1 | -1;
}

export interface AutoFibExtend {
  fib?: FibConfig; // levels, colours, extend, reverse, trend line, labels
  pastCount?: number; // earlier fibs to draw dimmed, 0..AUTO_FIB_MAX_PAST
  pastOpacity?: number; // percent
  // Set by the MTF coordinator (applyAutoFibTimeframe); calc re-aligns it.
  mtf?: MtfSeriesBase & {
    htfStarts?: number[];
    htfMs?: number;
    htfFibPairIdx?: Array<number | undefined>; // pair current on each HTF bar
    htfFibPairs?: AutoFibMtfPair[];
  };
  hideLegendValue?: boolean;
}

export interface AutoFibPoint {
  high?: number;
  low?: number;
  dir?: number;
}

/** calc row. The pair list rides on the LAST row only; draw reads it there. */
export interface AutoFibRow extends AutoFibPoint {
  pairs?: AutoFibPair[];
}

const pointOf = (q: { hiPrice: number; loPrice: number; dir: number } | undefined): AutoFibPoint =>
  q ? { high: q.hiPrice, low: q.loPrice, dir: q.dir } : {};

/** First index with ts[i] >= t (ts ascending); ts.length when none. */
function lowerBound(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mapMtf(
  dataList: KLineData[],
  mtf: NonNullable<AutoFibExtend["mtf"]>,
  htfStarts: number[],
  htfMs: number,
  pairIdx: Array<number | undefined>,
  src: AutoFibMtfPair[],
): { points: AutoFibPoint[]; pairs: AutoFibPair[] } {
  const ts = dataList.map((k) => k.timestamp);
  const htfBars = htfStarts.map((t) => ({ timestamp: t }) as KLineData);
  // The same closed-bar rule as every MTF series: a chart bar never sees a
  // pair whose HTF confirm bar closes in its future.
  const aligned = alignHtfToChart(ts, htfBars, pairIdx, htfMs, true, mtf.formingIdx, mtf.chartMs, mtf.timeframe);
  const points = aligned.map((p) => pointOf(p === undefined ? undefined : src[p]));
  // One forward pass: the aligned index never decreases, so each pair is one run.
  const runs: Array<{ p: number; start: number }> = [];
  for (let i = 0; i < aligned.length; i++) {
    const p = aligned[i];
    if (p === undefined) continue;
    if (!runs.length || runs[runs.length - 1].p !== p) runs.push({ p, start: i });
  }
  const chartMs = mtf.chartMs ?? (ts.length > 1 ? ts[1] - ts[0] : htfMs);
  const barEnd = (open: number) => htfBarEndMs(open, htfMs, mtf.timeframe ?? undefined);
  // An anchor older than the loaded bars gets a negative index, so its x
  // lands off-pane left instead of on the first loaded bar.
  const idxAt = (t: number): number =>
    ts.length && t < ts[0] ? Math.floor((t - ts[0]) / chartMs) : lowerBound(ts, t);
  // The anchor moves from the HTF bar's open to the chart candle whose high
  // (or low) traded nearest the anchor price, SR's snapFirst rule. Skipped
  // when the pin is not coarser than the chart or the span is not fully loaded.
  const snap = (openTs: number, price: number, side: "high" | "low", fallback: number): number => {
    if (!(htfMs > chartMs) || fallback < 0 || !ts.length) return fallback;
    const spanEnd = barEnd(openTs);
    if (ts[0] > openTs || ts[ts.length - 1] < spanEnd - chartMs) return fallback;
    let best = fallback;
    let bestD = Infinity;
    for (let i = fallback; i < ts.length && ts[i] < spanEnd; i++) {
      const d = Math.abs((side === "high" ? dataList[i].high : dataList[i].low) - price);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  // Calc runs on every tick; snapping scans a whole HTF bar of chart candles,
  // so only the pairs draw can ever show are snapped.
  const firstSnapped = Math.max(0, runs.length - (AUTO_FIB_MAX_PAST + 1));
  const pairs = runs.map((r, j): AutoFibPair => {
    const q = src[r.p];
    const hiAt = idxAt(q.hiTs);
    const loAt = idxAt(q.loTs);
    const snapIt = j >= firstSnapped;
    return {
      hiIdx: snapIt ? snap(q.hiTs, q.hiPrice, "high", hiAt) : hiAt,
      hiPrice: q.hiPrice,
      loIdx: snapIt ? snap(q.loTs, q.loPrice, "low", loAt) : loAt,
      loPrice: q.loPrice,
      dir: q.dir,
      startIdx: r.start,
      endIdx: j + 1 < runs.length ? runs[j + 1].start : null,
    };
  });
  return { points, pairs };
}

export function computeAutoFib(
  dataList: KLineData[],
  cfg: AutoFibConfig,
  ext?: Pick<AutoFibExtend, "mtf">,
): { points: AutoFibPoint[]; pairs: AutoFibPair[] } {
  const mtf = ext?.mtf;
  if (mtf?.timeframe && mtf.htfStarts && mtf.htfMs && mtf.htfFibPairIdx && mtf.htfFibPairs) {
    return mapMtf(dataList, mtf, mtf.htfStarts, mtf.htfMs, mtf.htfFibPairIdx, mtf.htfFibPairs);
  }
  const { pairOf, pairs } = computeAutoFibPairs(dataList, cfg);
  return { points: pairOf.map((p) => pointOf(p === undefined ? undefined : pairs[p])), pairs };
}

const TREND_COLOR = "#787b86"; // the fib drawing's anchor connector
const LABEL_FONT = "12px -apple-system, system-ui, sans-serif";

function drawAutoFib(params: IndicatorDrawParams<AutoFibRow, unknown, unknown>): boolean {
  const { ctx, chart, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as AutoFibRow[];
  const pairs = result[result.length - 1]?.pairs;
  if (!pairs?.length) return true;
  const ext = (indicator.extendData ?? {}) as AutoFibExtend;
  const fib = autoFibFibConfig(ext);
  const pastCount = Math.min(AUTO_FIB_MAX_PAST, Math.max(0, Math.floor(Number(ext.pastCount) || 0)));
  const pastAlpha = Math.min(1, Math.max(0.05, (Number(ext.pastOpacity) || 35) / 100));
  const lastIdx = chart.getDataList().length - 1;
  const precision =
    (chart as { getSymbol?: () => { pricePrecision?: number } | null }).getSymbol?.()?.pricePrecision ??
    indicator.precision ??
    2;
  // bounding.width runs under the y-axis strip; labels must stop short of it.
  const axisWidth = chart.getSize(indicator.paneId, "yAxis")?.width ?? 0;
  const W = bounding.width;
  const H = bounding.height;
  const clampX = (x: number) => Math.min(W + DRAW_CLIP_PAD, Math.max(-DRAW_CLIP_PAD, x));

  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "bottom";
  for (let p = Math.max(0, pairs.length - 1 - pastCount); p < pairs.length; p++) {
    const pair = pairs[p];
    const current = pair.endIdx === null;
    const up = pair.dir > 0;
    const ePrice = up ? pair.loPrice : pair.hiPrice;
    const lPrice = up ? pair.hiPrice : pair.loPrice;
    const e = { x: xAxis.convertToPixel(up ? pair.loIdx : pair.hiIdx), y: yAxis.convertToPixel(ePrice) };
    const l = { x: xAxis.convertToPixel(up ? pair.hiIdx : pair.loIdx), y: yAxis.convertToPixel(lPrice) };
    const extL = current && (fib.extend === "left" || fib.extend === "both");
    const extR = current && (fib.extend === "right" || fib.extend === "both");
    const rawX1 = extL ? 0 : e.x;
    const rawX2 = extR ? W : xAxis.convertToPixel(pair.endIdx ?? lastIdx);
    if (rawX2 < 0 || rawX1 > W) continue; // off-pane: cull
    const x1 = clampX(rawX1);
    const x2 = clampX(rawX2);
    ctx.globalAlpha = current ? 1 : pastAlpha;
    if (current && fib.trendLine) {
      const seg = clipSegmentToRect(e.x, e.y, l.x, l.y, -DRAW_CLIP_PAD, -DRAW_CLIP_PAD, W + DRAW_CLIP_PAD, H + DRAW_CLIP_PAD);
      if (seg) {
        ctx.strokeStyle = TREND_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
      }
    }
    // fibLevelSegments supplies each level's y, colour, width/dash and label;
    // the x-span is this pane's own (anchor to replacement bar, or extended).
    const segs = fibLevelSegments({ cfg: fib, coordinates: [e, l], values: [ePrice, lPrice], boundingWidth: W, precision });
    for (const s of segs) {
      // The canvas is shared with the panes above and below.
      if (s.y < 0 || s.y > H) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size ?? 1;
      ctx.setLineDash(s.style === "dashed" ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x1, s.y);
      ctx.lineTo(x2, s.y);
      ctx.stroke();
      if (current && fib.labels) {
        const atEdge = x2 >= W - axisWidth - 1;
        ctx.fillStyle = s.color;
        ctx.textAlign = atEdge ? "right" : "left";
        ctx.fillText(s.label, atEdge ? W - axisWidth - 4 : x2 + 4, s.y - 2);
      }
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
  return true; // the fibs replace any default figure drawing
}

// Auto Fib: calcParams = [pivotLen, minSwingAtr].
export const AUTO_FIB_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Auto Fib",
  series: "price",
  precision: 2,
  calcParams: [AUTO_FIB_DEFAULTS.pivotLen, AUTO_FIB_DEFAULTS.minSwingAtr],
  // Figure-less like Trendlines: draw paints everything, so there are no line
  // figures to hang selection handles on (no ZONE_ONLY_TYPES entry needed).
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) => {
    const { points, pairs } = computeAutoFib(
      dataList,
      parseAutoFibConfig(ind.calcParams),
      (ind.extendData ?? {}) as AutoFibExtend,
    );
    const out = points as AutoFibRow[];
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], pairs };
    return out;
  },
  draw: (params) => drawAutoFib(params as IndicatorDrawParams<AutoFibRow, unknown, unknown>),
};
```

(`AUTO_FIB_ATR_LEN`, `autoFibLevelOutputs` and `fibLevelPrice` stay used by Task 2's code.)

`customIndicators.ts`:
- after `export * from "./indicators/srLevels";` add `export * from "./indicators/autoFib";`
- after the `SR_LEVELS_TEMPLATE` import add `import { AUTO_FIB_TEMPLATE } from "./indicators/autoFib";`
- add `| "AUTO_FIB"` to `CustomIndicatorType` (after `"SR_LEVELS"`), `AUTO_FIB: AUTO_FIB_TEMPLATE,` to `BASE_TEMPLATES` (after `SR_LEVELS`), and `"AUTO_FIB",` to `OVERLAY_INDICATORS` (after `"SR_LEVELS"`).

If the barrel `export *` reports a duplicate export name, drop that name from `autoFib.ts`'s re-export list rather than renaming it.

`indicatorMeta.ts`, new entry after `SR_LEVELS`:

```ts
  AUTO_FIB: {
    inputs: [
      {
        ...num(0, "Pivot Length"),
        tip: ["Bars required on each side of a swing high or low.", "Higher finds bigger swings and confirms them later."],
      },
      {
        ...num(1, "Min Swing (×ATR)", { min: 0, step: 0.1 }),
        tip: ["A pivot counts only if its leg from the last opposite pivot is at least this many ATR(14).", "0 = off."],
      },
      {
        key: "pastCount",
        label: "Past fibs",
        type: "number",
        source: "extend",
        field: "pastCount",
        section: "History",
        default: 0,
        min: 0,
        max: 10,
        step: 1,
        tip: ["Also draw this many earlier fibs, dimmed.", "0 = only the current fib."],
      },
      {
        key: "pastOpacity",
        label: "Past fib opacity",
        type: "number",
        source: "extend",
        field: "pastOpacity",
        tab: "style",
        default: 35,
        min: 5,
        max: 100,
        step: 5,
        suffix: "%",
        tip: "How faded the past fibs paint.",
      },
    ],
    title: "Auto Fib Retracement",
    desc: "Draws a fib retracement between the latest confirmed swing high and swing low and redraws it as new swings confirm. Level 0 sits on the later swing. Pivots confirm Pivot Length bars late (no repaint). High, low, direction and every enabled level are available as rule operands.",
  },
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/autoFib.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/autoFib.ts frontend/src/lib/indicators/autoFib.test.ts frontend/src/lib/customIndicators.ts frontend/src/lib/indicatorMeta.ts
git commit -m "feat(auto-fib): chart template, MTF mapping and registration

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: MTF coordinator and runtime keys

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts` (imports; new `applyAutoFibTimeframe` + `buildAutoFibMtf` after `buildSrMtf`; `refreshFormingBar` dispatch after the `SR_LEVELS` branch near line 1648; `refreshMtfIndicatorsUncoalesced` after the `SR_LEVELS` branch near line 1919)
- Modify: `frontend/src/lib/mtfRuntime.ts` (`MTF_RUNTIME_KEYS`)
- Test: `frontend/src/lib/mtfCoordinator.test.ts` (new describe), `frontend/src/lib/mtfRuntime.test.ts` (create)

**Interfaces:**
- Consumes: `computeAutoFibPairs`, `AutoFibExtend` (Task 2/5); `parseAutoFibConfig`, `autoFibWarmup`, `AutoFibConfig` (Task 1).
- Produces: `applyAutoFibTimeframe(chart: Chart, epic: string, name: string, paneId: string, config: AutoFibConfig, timeframe: string | null, brokerId?: string, needed?: NeededInterval): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `mtfCoordinator.test.ts`, add `applyAutoFibTimeframe` to the destructured dynamic import, then append:

```ts
describe("applyAutoFibTimeframe", () => {
  const apply = (chart: Chart, timeframe: string | null) =>
    applyAutoFibTimeframe(chart, "EPIC", "af1", "candle_pane", { pivotLen: 5, minSwingAtr: 0 }, timeframe);

  it("clears the stash and writes the params when the pin is released", async () => {
    const { chart, overrides } = fakeChart({ mtf: { timeframe: "MINUTE_15", htfStarts: [1] } });
    await apply(chart, null);
    expect(overrides[0].patch.extendData?.mtf).toEqual({ timeframe: null });
    expect(overrides[0].patch.calcParams).toEqual([5, 0]);
    expect(fetchRangeStrict).not.toHaveBeenCalled();
  });

  it("stashes one pair index per HTF bar", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    await apply(chart, "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      timeframe: string;
      htfStarts: number[];
      htfFibPairIdx: unknown[];
      htfFibPairs: unknown[];
    };
    expect(mtf.timeframe).toBe("MINUTE_15");
    expect(mtf.htfFibPairIdx).toHaveLength(mtf.htfStarts.length);
    // Flat fixture bars: no pivots, so no pairs. The shape is what is pinned.
    expect(mtf.htfFibPairs).toEqual([]);
  });

  it("is restored by the refresh pass, so the pin survives a reload", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const ind = {
      paneId: "candle_pane",
      name: "AUTO_FIB",
      calcParams: [5, 0],
      extendData: { indType: "AUTO_FIB", mtf: { timeframe: "MINUTE_15" } },
    };
    const chart = {
      getDataList: () => [bar(10_000_000_000), bar(10_000_300_000)],
      getIndicators: () => [ind],
      overrideIndicator: () => true,
    } as unknown as Chart;
    await refreshMtfIndicators(chart, "EPIC");
    expect(fetchRangeStrict).toHaveBeenCalled();
  });
});
```

Create `frontend/src/lib/mtfRuntime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { stripMtfRuntime } from "./mtfRuntime";

describe("stripMtfRuntime", () => {
  it("drops the Auto Fib stash and keeps the pin", () => {
    const out = stripMtfRuntime({
      fib: { levels: [] },
      mtf: { timeframe: "HOUR_4", waitClose: false, htfStarts: [1], htfFibPairIdx: [0], htfFibPairs: [{}] },
    });
    expect(out.mtf).toEqual({ timeframe: "HOUR_4", waitClose: false });
    expect(out.fib).toEqual({ levels: [] });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/mtfCoordinator.test.ts -t "applyAutoFibTimeframe"` then `cd frontend && npx vitest run src/lib/mtfRuntime.test.ts`
Expected: FAIL (`applyAutoFibTimeframe` is not a function; `htfFibPairIdx` still present).

- [ ] **Step 3: Implement**

Imports in `mtfCoordinator.ts`, after the srLevels import block:

```ts
import { computeAutoFibPairs, type AutoFibExtend } from "./indicators/autoFib";
import {
  autoFibWarmup,
  parseAutoFibConfig,
  type AutoFibConfig,
} from "./indicators/autoFibOutputs";
```

After `buildSrMtf`:

```ts
/**
 * Point Auto Fib at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Same shape as applySrLevelsTimeframe: fetch
 * the HTF candles, run the chart-TF pair detector on them, and stash the pair
 * current on each HTF bar plus the pairs (anchors keyed by TIMESTAMP); calc
 * aligns the index with waitClose semantics (no lookahead). The fetch reach is
 * the operand warm-up only: past fibs older than the fetched span are simply
 * not drawn, never fetched for (the Trendlines freeze lesson).
 */
export async function applyAutoFibTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: AutoFibConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: AutoFibExtend } | null;
  const waitClose = readWaitClose(ind);
  const ext: AutoFibExtend = { ...(ind?.extendData ?? {}) };
  const calcParams = [config.pivotLen, config.minSwingAtr];

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, calcParams);
    return;
  }

  const need = needed ?? neededOf(chart);
  const { htf, htfMs, failed, askFromMs, askToMs } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    autoFibWarmup(config),
    brokerId,
    need,
    ind?.extendData?.mtf,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    calcParams,
    () => applyAutoFibTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, needed),
  );
  if (!proceed) return;
  const fp =
    waitClose || !dockedAt(chart, askToMs, htfMs)
      ? null
      : prepFormingBars(chart, htf, htfMs, timeframe);
  ext.mtf = {
    chartMs: chartIntervalOf(chart),
    epic,
    ...buildAutoFibMtf(fp ? fp.bars : htf, config, timeframe, htfMs),
    ...(fp?.extra ?? (waitClose ? {} : { waitClose: false })),
    ...(!failed ? { coveredFromMs: askFromMs, coveredToMs: askToMs } : {}),
  };
  overrideExtend(chart, paneId, name, ext, calcParams);
}

function buildAutoFibMtf(
  bars: KLineData[],
  config: AutoFibConfig,
  timeframe: string,
  htfMs: number,
): AutoFibExtend["mtf"] {
  const { pairOf, pairs } = computeAutoFibPairs(bars, config);
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfMs,
    htfFibPairIdx: pairOf,
    htfFibPairs: pairs.map((p) => ({
      hiTs: bars[p.hiIdx].timestamp,
      hiPrice: p.hiPrice,
      loTs: bars[p.loIdx].timestamp,
      loPrice: p.loPrice,
      dir: p.dir,
    })),
  };
}
```

`refreshFormingBar` dispatch, after the `SR_LEVELS` branch:

```ts
      } else if (type === "AUTO_FIB") {
        built = buildAutoFibMtf(bars, parseAutoFibConfig(ind.calcParams), timeframe, htfMs);
```

`refreshMtfIndicatorsUncoalesced`, after the `SR_LEVELS` branch:

```ts
      } else if (type === "AUTO_FIB") {
        const cfg = parseAutoFibConfig(ind.calcParams);
        if (covered(autoFibWarmup(cfg))) return;
        jobs.push(applyAutoFibTimeframe(chart, epic, id, paneId, cfg, tf, brokerId, need));
```

`mtfRuntime.ts`, inside `MTF_RUNTIME_KEYS` after `"htfResistance",`:

```ts
  // Auto Fib: the pair current on each HTF bar and the pair list.
  "htfFibPairIdx",
  "htfFibPairs",
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/lib/mtfCoordinator.test.ts -t "applyAutoFibTimeframe"` then `cd frontend && npx vitest run src/lib/mtfRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/mtfCoordinator.ts frontend/src/lib/mtfCoordinator.test.ts frontend/src/lib/mtfRuntime.ts frontend/src/lib/mtfRuntime.test.ts
git commit -m "feat(auto-fib): higher-timeframe pin through the MTF coordinator

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Rule operands in the expression bridge

**Files:**
- Modify: `frontend/src/lib/exprInstances.ts` (imports; `EXPR_INSTANCE_TYPES`; `synthesizeExprInstances` fixed-name list; `exprWarmupByRef`; `exprInstancesFor`)
- Modify: `frontend/src/lib/exprChartToken.ts` (import; new `case "AUTO_FIB"`; header comment list)
- Modify: `frontend/src/lib/expr/corpus.json` (three cases, before the closing `]`)
- Test: `frontend/src/lib/exprInstances.test.ts`, `frontend/src/lib/exprChartToken.test.ts` (append)

**Interfaces:**
- Consumes: `autoFibOutputs`, `autoFibWarmup`, `parseAutoFibConfig` (Task 1); type `AutoFibExtend` (Task 5).
- Produces: `AUTO_FIB` in `EXPR_INSTANCE_TYPES`; chart token `"<id>.<output>"`.

- [ ] **Step 1: Write the failing tests**

Append to `exprInstances.test.ts`:

```ts
describe("AUTO_FIB instances", () => {
  const live = [
    { id: "AUTO_FIB", type: "AUTO_FIB", calcParams: [5, 0], extendData: {} },
    { id: "AUTO_FIB2", type: "AUTO_FIB", calcParams: [8, 1.5], extendData: { mtf: { timeframe: "HOUR_4" } } },
  ];

  it("lists the base outputs plus every enabled level, and the pin", () => {
    const [a, b] = exprInstancesFor(live);
    expect(a.outputs).toEqual(["high", "low", "dir", "f0", "f0_236", "f0_382", "f0_5", "f0_618", "f0_786", "f1"]);
    expect([a.timeframe, a.detail]).toEqual([null, "pivot 5"]);
    expect([b.timeframe, b.detail]).toEqual(["HOUR_4", "pivot 8 · swing 1.5x ATR"]);
  });

  it("costs an exposed output the pane's floor and anything else 0", () => {
    const warm = exprWarmupByRef(live);
    expect(warm("AUTO_FIB", "f0_618")).toBe(14 + 2 * 5);
    expect(warm("AUTO_FIB2", "high")).toBe(14 + 2 * 8);
    expect(warm("AUTO_FIB", "fm0_236")).toBe(0);
  });

  it("synthesizes a default pane for a ref with no stored snapshot", () => {
    expect(synthesizeExprInstances(["candle.close > AUTO_FIB.f0_618"], new Set())).toEqual({
      AUTO_FIB: { type: "AUTO_FIB", calcParams: [], extendData: {} },
    });
  });
});
```

Append to `exprChartToken.test.ts`:

```ts
describe("AUTO_FIB panes", () => {
  it("emits an instance ref, honouring a live figure key", () => {
    expect(chartIndicatorToExprToken("AUTO_FIB", [5, 0], {}, { instanceId: "AUTO_FIB" })).toBe("AUTO_FIB.high");
    expect(
      chartIndicatorToExprToken("AUTO_FIB", [5, 0], {}, { instanceId: "AUTO_FIB2", figureKey: "f0_618" }),
    ).toBe("AUTO_FIB2.f0_618");
    expect(
      chartIndicatorToExprToken("AUTO_FIB", [5, 0], {}, { instanceId: "AUTO_FIB", figureKey: "fm0_236" }),
    ).toBe("AUTO_FIB.high");
    expect(chartIndicatorToExprToken("AUTO_FIB", [5, 0], {}, {})).toBeNull();
  });
});
```

Append to `corpus.json` (inside the array, after the last `SR_LEVELS` case; keep valid JSON):

```json
  { "expr": "candle.close > AUTO_FIB.f0_618", "isExit": false, "error": null,
    "instances": {"AUTO_FIB": {"type":"AUTO_FIB","calcParams":[5,0],"extendData":{}}},
    "literals": [] },
  { "expr": "AUTO_FIB.bogus > 0", "isExit": false, "error": {"code":"unknown_indicator_output","from":0,"to":14},
    "instances": {"AUTO_FIB": {"type":"AUTO_FIB","calcParams":[5,0],"extendData":{}}},
    "literals": [] },
  { "expr": "AUTO_FIB.fm0_236 > 0", "isExit": false, "error": {"code":"unknown_indicator_output","from":0,"to":16},
    "instances": {"AUTO_FIB": {"type":"AUTO_FIB","calcParams":[5,0],"extendData":{}}},
    "literals": [] }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/exprInstances.test.ts -t "AUTO_FIB"`
Expected: FAIL (no outputs listed for AUTO_FIB).

- [ ] **Step 3: Implement**

`exprInstances.ts` imports, after the SR imports:

```ts
import { autoFibOutputs, autoFibWarmup, parseAutoFibConfig } from "./indicators/autoFibOutputs";
import type { AutoFibExtend } from "./indicators/autoFib"; // erased at build; no runtime edge
```

- Add `"AUTO_FIB",` to `EXPR_INSTANCE_TYPES`.
- In `synthesizeExprInstances`, add `type === "AUTO_FIB" ||` to the fixed-name list and `AUTO_FIB` to the comment above it ("FVG, TRENDLINES, ... RSI and AUTO_FIB outputs are fixed names or level names, not lengths").
- In `exprWarmupByRef`, before the `SPIKE` branch:

```ts
    // Every AUTO_FIB output shares one floor (ATR(14) warm-up plus a full
    // pivot window); an output the pane's current levels do not expose costs 0.
    if (inst.type === "AUTO_FIB")
      return autoFibOutputs(inst.extendData).includes(output)
        ? autoFibWarmup(parseAutoFibConfig(inst.calcParams))
        : 0;
```

- In `exprInstancesFor`, after the `SR_LEVELS` branch:

```ts
    if (inst.type === "AUTO_FIB") {
      const ext = (inst.extendData ?? {}) as AutoFibExtend;
      const cfg = parseAutoFibConfig(inst.calcParams);
      out.push({
        id: inst.id,
        // Level outputs follow the pane's ENABLED levels, so editing a level
        // is what makes a rule that read it fail loudly.
        outputs: autoFibOutputs(inst.extendData),
        timeframe: ext.mtf?.timeframe ?? null,
        detail: cfg.minSwingAtr > 0 ? `pivot ${cfg.pivotLen} · swing ${cfg.minSwingAtr}x ATR` : `pivot ${cfg.pivotLen}`,
      });
      continue;
    }
```

`exprChartToken.ts`: import `import { autoFibOutputs } from "./indicators/autoFibOutputs";`, add `AUTO_FIB` to the header list of instance-ref types, and before `default:`:

```ts
    // AUTO_FIB is figure-less like TRENDLINES, so a click arrives without a
    // figureKey and takes outputs[0], high. A key is honoured only while it is
    // one of the pane's live outputs (its enabled levels).
    case "AUTO_FIB": {
      const id = opts?.instanceId;
      if (!id) return null;
      const outs = autoFibOutputs(extendData);
      const key = opts?.figureKey;
      return `${id}.${key && outs.includes(key) ? key : outs[0]}`;
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/lib/exprInstances.test.ts -t "AUTO_FIB"` then `cd frontend && npx vitest run src/lib/exprChartToken.test.ts -t "AUTO_FIB"`
Expected: PASS. (Both corpus suites run in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/exprInstances.ts frontend/src/lib/exprInstances.test.ts frontend/src/lib/exprChartToken.ts frontend/src/lib/exprChartToken.test.ts frontend/src/lib/expr/corpus.json
git commit -m "feat(auto-fib): rule operands in the expression bridge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Shared fib levels editor

**Files:**
- Create: `frontend/src/components/FibLevelsEditor.tsx`
- Modify: `frontend/src/DrawingSettings.tsx` (replace the block from the `<div className="ind-row">` holding the Extend select, ~line 711, through the "Levels" checkbox `</label>`, ~line 813; add the import)
- Test: `frontend/src/components/FibLevelsEditor.test.tsx`

**Interfaces:**
- Consumes: `ColorLineStylePicker`, `LineStyleOpt` (`../ColorLineStylePicker`); `FibConfig` (`../lib/fibConfig`).
- Produces: `default function FibLevelsEditor(props: { fib: FibConfig; onChange: (next: FibConfig) => void; sharedSize: number; sharedStyle: "solid" | "dashed"; trendLabel: string })`.

The `.fib-levels` / `.fib-level` rules in `App.css` (3111-3113) are global, not scoped under `.ind-settings-fib`, so the editor styles correctly inside IndicatorSettings too. Only the modal width (`.ind-settings-fib { width: 400px }`) is drawing-specific; Task 9 reuses that class.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/FibLevelsEditor.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FibLevelsEditor from "./FibLevelsEditor";
import { defaultFibConfig } from "../lib/fibConfig";

afterEach(cleanup);

function setup() {
  const onChange = vi.fn();
  render(
    <FibLevelsEditor fib={defaultFibConfig()} onChange={onChange} sharedSize={1} sharedStyle="solid" trendLabel="Width line" />,
  );
  return onChange;
}

describe("FibLevelsEditor", () => {
  it("toggles one level without touching the others", () => {
    const onChange = setup();
    fireEvent.click(screen.getByLabelText("Level 0.236"));
    const next = onChange.mock.calls[0][0];
    expect(next.levels[1].enabled).toBe(false);
    expect(next.levels[0].enabled).toBe(true);
  });

  it("flips reverse and shows the caller's trend label", () => {
    const onChange = setup();
    expect(screen.getByText("Width line")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Reverse"));
    expect(onChange.mock.calls[0][0].reverse).toBe(true);
  });

  it("changes the extend mode", () => {
    const onChange = setup();
    fireEvent.change(screen.getByLabelText("Extend"), { target: { value: "right" } });
    expect(onChange.mock.calls[0][0].extend).toBe("right");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/FibLevelsEditor.test.tsx`
Expected: FAIL, cannot resolve `./FibLevelsEditor`.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/components/FibLevelsEditor.tsx
// The fib levels editor: extend, one row per level (on/off, ratio, colour and
// per-level width/dash) and the trend line / reverse / labels switches. Shared
// by the fib drawing tools (DrawingSettings) and the Auto Fib indicator
// (IndicatorSettings); both keep their config as a FibConfig.
import ColorLineStylePicker, { type LineStyleOpt } from "../ColorLineStylePicker";
import type { FibConfig, FibLevel } from "../lib/fibConfig";

interface Props {
  fib: FibConfig;
  onChange: (next: FibConfig) => void;
  /** Width/dash a level shows while it has no override of its own. */
  sharedSize: number;
  sharedStyle: "solid" | "dashed";
  /** The trendLine switch's label: the retracement's anchor connector, or a
   * fib channel's width leg. Same flag, different line. */
  trendLabel: string;
}

const LINE_STYLES = ["solid", "dashed"] as LineStyleOpt[];

export default function FibLevelsEditor({ fib, onChange, sharedSize, sharedStyle, trendLabel }: Props) {
  const setLevel = (i: number, patch: Partial<FibLevel>) =>
    onChange({ ...fib, levels: fib.levels.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      <div className="ind-row">
        <label htmlFor="fib-extend">Extend</label>
        <select
          id="fib-extend"
          value={fib.extend}
          onChange={(e) => onChange({ ...fib, extend: e.target.value as FibConfig["extend"] })}
        >
          <option value="none">Don't extend</option>
          <option value="left">Extend left</option>
          <option value="right">Extend right</option>
          <option value="both">Extend both</option>
        </select>
      </div>
      <div className="fib-levels">
        {fib.levels.map((l, i) => (
          <div className="fib-level" key={i}>
            <input
              type="checkbox"
              aria-label={`Level ${l.value}`}
              checked={l.enabled}
              onChange={(e) => setLevel(i, { enabled: e.target.checked })}
            />
            <input
              type="number"
              step="any"
              aria-label={`Level ${i + 1} ratio`}
              value={l.value}
              onChange={(e) => setLevel(i, { value: Number(e.target.value) })}
            />
            {/* Everything here is THIS level's: colour, and width/dash stored
                as per-level overrides that win over the shared line style.
                Unset overrides display the shared values. */}
            <ColorLineStylePicker
              color={l.color}
              onColor={(c) => setLevel(i, { color: c })}
              size={l.size ?? sharedSize}
              onSize={(s) => setLevel(i, { size: s })}
              lineStyle={l.style ?? sharedStyle}
              onLineStyle={(s) => setLevel(i, { style: s === "dashed" ? "dashed" : "solid" })}
              lineStyleOptions={LINE_STYLES}
            />
          </div>
        ))}
      </div>
      <label className="ind-check">
        <input type="checkbox" checked={fib.trendLine} onChange={(e) => onChange({ ...fib, trendLine: e.target.checked })} />
        <span>{trendLabel}</span>
      </label>
      <label className="ind-check">
        <input type="checkbox" checked={fib.reverse} onChange={(e) => onChange({ ...fib, reverse: e.target.checked })} />
        <span>Reverse</span>
      </label>
      <label className="ind-check">
        <input type="checkbox" checked={fib.labels} onChange={(e) => onChange({ ...fib, labels: e.target.checked })} />
        <span>Levels</span>
      </label>
    </>
  );
}
```

In `DrawingSettings.tsx`, add `import FibLevelsEditor from "./components/FibLevelsEditor";` and replace the Extend row, the `fib-levels` grid and the three `ind-check` labels (keep the "Lines" row above them) with:

```tsx
                  <FibLevelsEditor
                    fib={fib}
                    onChange={applyFib}
                    sharedSize={size}
                    sharedStyle={style === "dashed" ? "dashed" : "solid"}
                    trendLabel={name === "fibChannel" ? "Width line" : "Trend line"}
                  />
```

If `FibLevel` is not exported from `fibConfig.ts`, it is (`export interface FibLevel`); do not re-declare it.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/FibLevelsEditor.test.tsx`
Expected: PASS. (`DrawingSettings.*.test.tsx` run in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FibLevelsEditor.tsx frontend/src/components/FibLevelsEditor.test.tsx frontend/src/DrawingSettings.tsx
git commit -m "refactor(fib): share the levels editor between drawing and indicator

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Indicator settings wiring

**Files:**
- Modify: `frontend/src/IndicatorSettings.tsx`
- Test: `frontend/src/IndicatorSettings.autoFib.test.tsx` (create)

**Interfaces:**
- Consumes: `applyAutoFibTimeframe` (Task 6); `parseAutoFibConfig`, `autoFibFibConfig` (Task 1, via `./lib/indicators/autoFibOutputs`); `FibLevelsEditor` (Task 8); `FibConfig` type.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/IndicatorSettings.autoFib.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";

afterEach(cleanup);

function open(extendData: object = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const ind = {
    paneId: "candle_pane",
    name: "AUTO_FIB",
    calcParams: [5, 0],
    extendData: { indType: "AUTO_FIB", ...extendData },
    figures: [],
    styles: {},
  };
  const chart = {
    getIndicators: () => [ind],
    overrideIndicator: (o: { extendData?: Record<string, unknown> }) => {
      if (o.extendData) writes.push(o.extendData);
      return true;
    },
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  };
  render(
    <IndicatorSettings
      chart={chart as never}
      scope="tab.test"
      epic="US100"
      brokerId="capital"
      chartResolution="DAY"
      paneId="candle_pane"
      name="AUTO_FIB"
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
  return writes;
}

describe("Auto Fib settings", () => {
  it("offers Past fibs and a timeframe pin on the Inputs tab", () => {
    open();
    // The value is not asserted: a 0 in a number box can render empty (the
    // off-sentinel draft rule), which is not what this pins.
    expect(screen.getByLabelText("Past fibs")).toBeTruthy();
    // Only pinnable types render this checkbox; the fallback shows a disabled select.
    expect(screen.getAllByText("Wait for timeframe closes").length).toBeGreaterThan(0);
  });

  it("edits the levels from the Style tab as a plain extendData write", () => {
    const writes = open();
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Level 0.236"));
    const fib = writes.at(-1)?.fib as { levels: Array<{ enabled: boolean }>; extend: string };
    expect(fib.levels[1].enabled).toBe(false);
    // A pane with no saved fib starts extended right.
    expect(fib.extend).toBe("right");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/IndicatorSettings.autoFib.test.tsx`
Expected: FAIL (no Wait-for-closes control for this type; no `Level 0.236`).

- [ ] **Step 3: Implement** (all in `IndicatorSettings.tsx`, each next to its SR Levels counterpart)

1. Imports: add `applyAutoFibTimeframe` to the `./lib/mtfCoordinator` import (line 31); add
   ```tsx
   import { autoFibFibConfig, parseAutoFibConfig } from "./lib/indicators/autoFibOutputs";
   import type { FibConfig } from "./lib/fibConfig";
   import FibLevelsEditor from "./components/FibLevelsEditor";
   ```
2. Type flag, after `const isTrendlines = ...` (~line 329):
   ```tsx
   // Auto Fib: same MTF shape as S/R Levels (pin on the Inputs tab), and its
   // levels are the fib drawing tool's editor on the Style tab.
   const isAutoFib = type === "AUTO_FIB";
   ```
3. State, after the SR zone state (~line 577):
   ```tsx
   // --- AUTO_FIB: fib levels/extend/reverse/labels (draw + operand names, on extendData.fib) ---
   const [autoFib, setAutoFib] = useState<FibConfig>(() => autoFibFibConfig(ind?.extendData));
   ```
4. Writer, after `patchSrZone`:
   ```tsx
   // AUTO_FIB levels: no recompute (the pairs do not depend on them), so a
   // plain extendData override is the whole live-update path.
   function patchAutoFib(next: FibConfig): void {
     setAutoFib(next);
     const live = getIndicator(chart, paneId, name) as Indicator | null;
     chart.overrideIndicator({
       paneId,
       name,
       extendData: { ...((live?.extendData as object) ?? {}), fib: next },
     });
   }
   ```
5. Apply, after `applySrLevels`:
   ```tsx
   // Push an Auto Fib config (chart-TF or MTF) through the coordinator, which
   // re-detects the pairs on the pinned timeframe's own bars (mirrors
   // applySrLevels above).
   function applyAutoFib(next: Partial<{ timeframe: string }> = {}, nextCp?: number[]) {
     const tf = next.timeframe ?? timeframe;
     void applyAutoFibTimeframe(
       chart,
       epic,
       name,
       paneId,
       parseAutoFibConfig(nextCp ?? calcParams),
       tf === "chart" ? null : tf,
       brokerId,
     );
   }
   ```
6. `currentConfig()`, after the Trendlines `mtf` line:
   ```tsx
       // Auto Fib: same MTF persistence contract as S/R Levels.
       if (isAutoFib && timeframe !== "chart") extendData.mtf = { timeframe, ...(waitClose ? {} : { waitClose: false }) };
   ```
   and after the FVG `zoneStyle` block:
   ```tsx
       if (isAutoFib && JSON.stringify(autoFib) !== JSON.stringify(autoFibFibConfig({}))) {
         // Persist only a customized fib, so a plain pane carries no `fib` key.
         extendData.fib = autoFib;
       }
   ```
7. `setParam`, before the `isTrendlines && timeframe !== "chart"` branch:
   ```tsx
       } else if (isAutoFib && timeframe !== "chart") {
         // Pivot Length / Min Swing feed the detector, so under a pin the HTF
         // pairs must be found again, not re-aligned.
         apply({ calcParams: nextCp });
         applyAutoFib({}, nextCp);
   ```
8. Inputs tab timeframe block: add a branch `) : isAutoFib ? (` beside `isSrLevels ? (` that is a copy of the SR block with `applySrLevels` replaced by `applyAutoFib` and this Timeframe tip:
   ```tsx
                        text={["Find the swings on this timeframe instead of the chart's.", "A higher timeframe draws the bigger swing, e.g. the daily fib on a 5m chart."]}
   ```
9. The fallback Timeframe InfoTip (~line 2902): change its text to `"Higher-timeframe mode is only on EMA, MA, Pivot Bands, Slope, S/R Levels, FVG, Trendlines and Auto Fib."`
10. Style tab, after the `{isSrLevels && (...)}` block:
    ```tsx
              {isAutoFib && (
                <>
                  <div className="ind-group">Levels</div>
                  <FibLevelsEditor
                    fib={autoFib}
                    onChange={patchAutoFib}
                    sharedSize={1}
                    sharedStyle="solid"
                    trendLabel="Trend line"
                  />
                </>
              )}
    ```
11. Root class (~line 1929): give the Auto Fib modal the fib drawing's width:
    ```tsx
      className={`ind-settings${type === "PREV_HL" ? " ind-settings-wide" : type === "TRENDLINES" ? " ind-settings-tl" : type === "AUTO_FIB" ? " ind-settings-fib" : ""}`}
    ```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/IndicatorSettings.autoFib.test.tsx`
Expected: PASS. If `getByLabelText("Past fibs")` finds nothing, check `visibleInput` and `controlFor` render extend-number inputs on the Inputs tab with `aria-label={inp.label}` (they do for Trendlines' "Merge lines within").

- [ ] **Step 5: Commit**

```bash
git add frontend/src/IndicatorSettings.tsx frontend/src/IndicatorSettings.autoFib.test.tsx
git commit -m "feat(auto-fib): settings panel (pin, history, levels editor)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Batched verification and live check

**Files:** none new (fixes only, if a check fails).

- [ ] **Step 1: Ask the user once before running the heavy checks** (per the CPU constraint). Proposed batch:

```bash
cd frontend && npx vitest run \
  src/lib/indicators/autoFibOutputs.test.ts src/lib/indicators/autoFib.test.ts \
  src/lib/mtfCoordinator.test.ts src/lib/mtfRuntime.test.ts \
  src/lib/exprInstances.test.ts src/lib/exprChartToken.test.ts src/lib/expr/corpus.test.ts \
  src/lib/trendlines.register.test.ts src/lib/slope.register.test.ts src/lib/indicators/inset.test.ts \
  src/lib/indicators/srLevels.test.ts src/lib/fibConfig.test.ts \
  src/components/FibLevelsEditor.test.tsx src/DrawingSettings.masked.test.tsx src/DrawingSettings.trade.test.tsx \
  src/IndicatorSettings.autoFib.test.tsx src/IndicatorSettings.inputs.test.tsx
cd backend && .venv/bin/pytest -q tests/test_auto_fib.py tests/test_indicator_parity.py \
  tests/test_expr_parser_corpus.py tests/test_indicator_registry.py tests/test_indicator_series_api.py tests/test_sr_levels.py
cd frontend && npx tsc -b 2>&1 | grep -E "autoFib|FibLevelsEditor|IndicatorSettings|DrawingSettings|mtfCoordinator|mtfRuntime|exprInstances|exprChartToken|customIndicators|indicatorMeta|indicatorParityGolden"
```

Expected: all tests PASS. For `tsc -b`: zero errors in the new files; in pre-existing files (`mtfCoordinator.ts` has a known backlog), every error must point at a line this plan did not change (check with `git diff -U0 <Task 1 commit>^ -- <file>`).

- [ ] **Step 2: Live check through the agent bridge** (backend on :8000, frontend on :5173)

1. `ui_sessions`; `ui_set_title("US100 Auto Fib check")`; `ui_invoke("market.select", {"epic": "US100"})`; `ui_invoke("chart.timeframe.set", {"resolution": "HOUR"})`.
2. `ui_invoke("indicator.add", {"type": "AUTO_FIB"})`, then `ui_screenshot`: one fib, labels at the right edge, level 0 on the later swing.
3. `indicator.set` cannot pin a timeframe for this type (Trendlines only, out of scope). Ask the user to open the Auto Fib settings, pin `HOUR_4`, set Past fibs to 3, then take another screenshot: the fib should snap to the 4H swing candles, with 3 dimmed fibs behind it.
4. Report what the screenshots show. Do not claim success without them.

- [ ] **Step 3: Commit any fixes**

Commit each fix with its own message and the trailer, staging explicit paths only.
