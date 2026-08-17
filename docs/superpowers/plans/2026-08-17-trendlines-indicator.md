# TRENDLINES Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `TRENDLINES` custom indicator that finds major sloping support and resistance lines automatically, draws them, and exposes the nearest one per side as a rule operand with a bit-identical Python twin.

**Architecture:** Confirmed fractal pivots (shared `isPivotAt`) are paired into candidate lines; a candidate survives only if no bar pierces it beyond an ATR-scaled tolerance. Survivors are ranked by touches and span, capped per side, and projected forward to feed four price operands. All state mutates at pivot-confirm bars except break detection, which runs every bar. Every boolean gate is evaluated as a cross-product against the exact integer bar span, never by computing a slope.

**Tech Stack:** TypeScript + klinecharts (frontend, vitest), Python 3 (backend, pytest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-trendlines-indicator-design.md`

## Global Constraints

- **Causality:** the value at bar `i` depends only on bars `[0..i]`. No exceptions, including in the draw path.
- **Parity:** the Python port is operation-for-operation identical to the TS. Per `backend/auto_trader/indicators/core.py`, do NOT "improve" arithmetic or reorder operations.
- **No division in boolean gates.** Pierce and touch tests use the cross-product form. Division appears only when emitting a projected price.
- **Determinism:** ranking never relies on sort stability. Full tiebreak chain: touches desc, span desc, `lastTouchIdx` desc, `i1` asc, `p1` asc.
- **No em dashes in user-facing copy** (labels, tips, descriptions). Parentheses or colons instead. Code and commit messages are exempt.
- **Defaults, verbatim:** `pivotLen 5`, `violMult 0.25`, `touchMult 0.75`, `minTouches 2`, `minSpanBars 20`, `maxProjBars 250`, `breakHoldBars 30`, `maxLines 3`. Internal constants: `TL_ATR_LEN 14`, `MAX_PAIR_PIVOTS 20`, `MAX_LIVE_MULT 4`.
- **Working directories:** frontend commands run from `frontend/`, backend commands from `backend/`.
- **Shared checkout:** other sessions commit into this repo. Always `git add` explicit paths, never `git add -A` or `git add .`.

---

### Task 1: Config leaf module

The leaf exists so `exprInstances.ts` can import output names and warm-up without pulling klinecharts into a node context that has no `window`. Same split, same reason, as `fvgOutputs.ts` and `slopeOutputs.ts`.

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesOutputs.ts`
- Test: `frontend/src/lib/indicators/trendlinesOutputs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TL_ATR_LEN`, `MAX_PAIR_PIVOTS`, `MAX_LIVE_MULT`, `TRENDLINES_OUTPUTS`, `TrendlinesOutput`, `TrendlinesConfig`, `TRENDLINES_DEFAULTS`, `parseTrendlinesConfig(calcParams: unknown): TrendlinesConfig`, `trendlinesWarmup(cfg: TrendlinesConfig): number`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/indicators/trendlinesOutputs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  TRENDLINES_DEFAULTS,
  TRENDLINES_OUTPUTS,
  parseTrendlinesConfig,
  trendlinesWarmup,
} from "./trendlinesOutputs";

describe("parseTrendlinesConfig", () => {
  it("takes every default from an empty params list", () => {
    expect(parseTrendlinesConfig([])).toEqual(TRENDLINES_DEFAULTS);
  });

  it("reads params positionally", () => {
    const cfg = parseTrendlinesConfig([9, 0.5, 1.5, 3, 40, 100, 10, 2]);
    expect(cfg).toEqual({
      pivotLen: 9,
      violMult: 0.5,
      touchMult: 1.5,
      minTouches: 3,
      minSpanBars: 40,
      maxProjBars: 100,
      breakHoldBars: 10,
      maxLines: 2,
    });
  });

  // violMult zero is the STRICTEST setting (exact containment, no pierce
  // allowed), not a "filter off" switch. Coercing it back to the default would
  // silently swap strict containment for tolerant containment with no error.
  it("keeps a zero violMult", () => {
    expect(parseTrendlinesConfig([5, 0]).violMult).toBe(0);
  });

  it("rejects a zero or negative touchMult back to the default", () => {
    expect(parseTrendlinesConfig([5, 0.25, 0]).touchMult).toBe(0.75);
    expect(parseTrendlinesConfig([5, 0.25, -1]).touchMult).toBe(0.75);
  });

  it("floors the integer params and rejects junk", () => {
    const cfg = parseTrendlinesConfig([5.9, 0.25, 0.75, 2.7, "x", null, 30, 3]);
    expect(cfg.pivotLen).toBe(5);
    expect(cfg.minTouches).toBe(2);
    expect(cfg.minSpanBars).toBe(TRENDLINES_DEFAULTS.minSpanBars);
    expect(cfg.maxProjBars).toBe(TRENDLINES_DEFAULTS.maxProjBars);
  });

  it("survives a non-array", () => {
    expect(parseTrendlinesConfig(undefined)).toEqual(TRENDLINES_DEFAULTS);
  });
});

describe("outputs and warm-up", () => {
  it("names the four operands in pane order", () => {
    expect(TRENDLINES_OUTPUTS).toEqual([
      "tl_support",
      "tl_resistance",
      "tl_broken_support",
      "tl_broken_resistance",
    ]);
  });

  // ATR must be warm, two pivots must confirm, and they must span the minimum.
  it("floors warm-up at ATR + two confirms + the minimum span", () => {
    expect(trendlinesWarmup(TRENDLINES_DEFAULTS)).toBe(14 + 2 * 5 + 20);
    expect(trendlinesWarmup({ ...TRENDLINES_DEFAULTS, pivotLen: 9 })).toBe(14 + 18 + 20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesOutputs.test.ts`
Expected: FAIL, cannot resolve `./trendlinesOutputs`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/indicators/trendlinesOutputs.ts`:

```ts
// The TRENDLINES pane's OUTPUT SHAPE and config parsing — split out of
// trendlines.ts as a leaf with no RUNTIME imports, so exprInstances.ts can
// import it without dragging klinecharts into a node context that has no
// `window`. Same split, same reason, as ./fvgOutputs and ./slopeOutputs.
//
// Mirrors Python indicators/trendlines.py (`parse_trendlines_config` /
// `trendlines_outputs` / `trendlines_warmup`), which is what the backend
// validates a rule reference against.

export const TL_ATR_LEN = 14;

/** How many earlier same-side pivots a new pivot pairs with. Bounds the run at
 * O(P * 20) instead of O(P^2) — and bounds how far back a line can reach, so a
 * long line needs a proportionally large pivotLen. */
export const MAX_PAIR_PIVOTS = 20;

/** Live state keeps this multiple of maxLines per side, so a line that is
 * temporarily outranked is not destroyed and can return when it gains a touch.
 * maxLines itself governs only what draws and what feeds the operands. */
export const MAX_LIVE_MULT = 4;

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * trendlines_outputs and the chart figure keys, so an operand a user inserts
 * from the legend and the series the backend computes cannot drift apart. */
export const TRENDLINES_OUTPUTS = [
  "tl_support",
  "tl_resistance",
  "tl_broken_support",
  "tl_broken_resistance",
] as const;

export type TrendlinesOutput = (typeof TRENDLINES_OUTPUTS)[number];

export interface TrendlinesConfig {
  pivotLen: number; // fractal lookback each side; confirm lag = this many bars
  violMult: number; // pierce tolerance as a multiple of ATR(14)
  touchMult: number; // touch tolerance as a multiple of ATR(14)
  minTouches: number; // touches before a line is major (2 = anchors only)
  minSpanBars: number; // minimum span before a line is major
  maxProjBars: number; // how far past its last touch a line stays live
  breakHoldBars: number; // how long a broken line keeps drawing and emitting
  maxLines: number; // strongest lines kept live, per side
}

export const TRENDLINES_DEFAULTS: TrendlinesConfig = {
  pivotLen: 5,
  violMult: 0.25,
  touchMult: 0.75,
  minTouches: 2,
  minSpanBars: 20,
  maxProjBars: 250,
  breakHoldBars: 30,
  maxLines: 3,
};

/** calcParams order: [pivotLen, violMult, touchMult, minTouches, minSpanBars,
 * maxProjBars, breakHoldBars, maxLines]. Mirrored by backend
 * trendlines.parse_trendlines_config — keep in sync.
 *
 * violMult takes ZERO (exact containment, the strictest setting), so it
 * validates on `>= 0` while every other param keeps the usual `> 0` rule.
 * Getting this wrong silently restores tolerant containment, so both runtimes
 * test it. */
export function parseTrendlinesConfig(calcParams: unknown): TrendlinesConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = TRENDLINES_DEFAULTS;
  const numAt = (i: number, def: number, allowZero: boolean): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : def;
  };
  const intAt = (i: number, def: number): number => Math.max(1, Math.floor(numAt(i, def, false)));
  return {
    pivotLen: intAt(0, d.pivotLen),
    violMult: numAt(1, d.violMult, true),
    touchMult: numAt(2, d.touchMult, false),
    minTouches: Math.max(2, Math.floor(numAt(3, d.minTouches, false))),
    minSpanBars: intAt(4, d.minSpanBars),
    maxProjBars: intAt(5, d.maxProjBars),
    breakHoldBars: intAt(6, d.breakHoldBars),
    maxLines: intAt(7, d.maxLines),
  };
}

/** Bars before the first line can possibly exist: ATR(14) warm-up, plus the two
 * pivots that must confirm (pivotLen each), plus the span they must cover.
 * Lines keep forming after that, so this is the floor — the same convention as
 * the other specs. Every output shares it.
 *
 * Unlike fvgWarmup(), this depends on the parsed config. */
export function trendlinesWarmup(cfg: TrendlinesConfig): number {
  return TL_ATR_LEN + 2 * cfg.pivotLen + cfg.minSpanBars;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesOutputs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesOutputs.ts frontend/src/lib/indicators/trendlinesOutputs.test.ts
git commit -m "feat(trendlines): config leaf, output names and warm-up"
```

---

### Task 2: Cross-product geometry

The whole parity argument lives here. A pierce test is a **boolean that gates set membership**: a 1-ULP disagreement between TS and Python does not drift a number, it deletes a line and changes every output from that bar forward. Multiplying through by the exact positive integer `(i2 - i1)` preserves the inequality and removes a rounding source.

**Files:**
- Create: `frontend/src/lib/indicators/trendlines.ts`
- Test: `frontend/src/lib/indicators/trendlines.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces: `TrendSide` (`"support" | "resistance"`), `TrendLine`, `pierces(line, j, price, violTol): boolean`, `inTouchBand(line, j, price, violTol, touchTol): boolean`, `projectAt(line, j): number`, `rankLines(a, b): number`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/indicators/trendlines.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inTouchBand, pierces, projectAt, rankLines, type TrendLine } from "./trendlines";

// A resistance line falling 1.0 per bar from 100 at bar 0 to 90 at bar 10.
const res: TrendLine = {
  side: "resistance",
  i1: 0,
  p1: 100,
  i2: 10,
  p2: 90,
  touches: 2,
  lastTouchIdx: 10,
  brokenIdx: null,
};

// A support line rising 1.0 per bar from 50 at bar 0 to 60 at bar 10.
const sup: TrendLine = { ...res, side: "support", p1: 50, p2: 60 };

describe("projectAt", () => {
  it("interpolates between the anchors", () => {
    expect(projectAt(res, 5)).toBeCloseTo(95, 10);
    expect(projectAt(sup, 5)).toBeCloseTo(55, 10);
  });

  it("extrapolates past the second anchor", () => {
    expect(projectAt(res, 20)).toBeCloseTo(80, 10);
  });
});

describe("pierces", () => {
  it("a high above a resistance line by more than the tolerance pierces it", () => {
    expect(pierces(res, 5, 96.5, 1)).toBe(true);
    expect(pierces(res, 5, 95.5, 1)).toBe(false);
  });

  it("a low below a support line by more than the tolerance pierces it", () => {
    expect(pierces(sup, 5, 53.5, 1)).toBe(true);
    expect(pierces(sup, 5, 54.5, 1)).toBe(false);
  });

  it("does not pierce on the wrong side", () => {
    expect(pierces(res, 5, 10, 1)).toBe(false);
    expect(pierces(sup, 5, 900, 1)).toBe(false);
  });

  // THE parity test. A bar exactly at line + violTol must not pierce, and one
  // ULP beyond must. This is precisely where a slope-and-project implementation
  // diverges between runtimes, so it is what earns the cross-product form.
  it("is exact at the tolerance boundary", () => {
    const atBoundary = 95 + 1;
    expect(pierces(res, 5, atBoundary, 1)).toBe(false);
    expect(pierces(res, 5, Math.nextUp(atBoundary), 1)).toBe(true);
  });

  it("treats a zero tolerance as exact containment", () => {
    expect(pierces(res, 5, 95, 0)).toBe(false);
    expect(pierces(res, 5, Math.nextUp(95), 0)).toBe(true);
  });
});

describe("inTouchBand", () => {
  // Asymmetric on purpose. For resistance the band is
  // [line - touchTol, line + violTol]: a symmetric band with touchTol > violTol
  // would put the far edge of the "touch" zone inside the pierce zone.
  it("accepts a pivot below a resistance line by up to touchTol", () => {
    expect(inTouchBand(res, 5, 93, 1, 2)).toBe(true);
    expect(inTouchBand(res, 5, 92.9, 1, 2)).toBe(false);
  });

  it("accepts a pivot above a resistance line by up to violTol only", () => {
    expect(inTouchBand(res, 5, 96, 1, 2)).toBe(true);
    expect(inTouchBand(res, 5, 96.1, 1, 2)).toBe(false);
  });

  it("mirrors the asymmetry for support", () => {
    expect(inTouchBand(sup, 5, 57, 1, 2)).toBe(true);
    expect(inTouchBand(sup, 5, 57.1, 1, 2)).toBe(false);
    expect(inTouchBand(sup, 5, 54, 1, 2)).toBe(true);
    expect(inTouchBand(sup, 5, 53.9, 1, 2)).toBe(false);
  });
});

describe("rankLines", () => {
  const base: TrendLine = { ...res };
  it("prefers more touches, then longer span", () => {
    expect(rankLines({ ...base, touches: 3 }, { ...base, touches: 2 })).toBeLessThan(0);
    expect(
      rankLines({ ...base, i1: 0, lastTouchIdx: 50 }, { ...base, i1: 10, lastTouchIdx: 50 }),
    ).toBeLessThan(0);
  });

  it("breaks every remaining tie deterministically", () => {
    const a = { ...base, lastTouchIdx: 20 };
    const b = { ...base, lastTouchIdx: 10, i1: -10 };
    // same touches, same span (20-0 vs 10-(-10)) -> newer lastTouchIdx wins
    expect(rankLines(a, b)).toBeLessThan(0);
    // fully identical -> 0, so no reliance on sort stability
    expect(rankLines({ ...base }, { ...base })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: FAIL, cannot resolve `./trendlines`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/indicators/trendlines.ts` with the header and geometry only (Task 3 appends the detector, Task 5 the template):

```ts
// TRENDLINES: major sloping support/resistance lines from confirmed fractal
// pivots.
//
// Causal by construction (backtest-safe): a strict fractal pivot at bar i only
// exists at its confirm bar i+N, every line is seeded at a confirm bar, and
// break detection at bar i only ever tests a line whose anchors precede i. So
// values at bar i depend only on bars [0..i].
//
// PARITY, and why there is no division below. core.py's contract is that
// identical operation order is what makes the parity suite exact. Here validity
// is a BOOLEAN THAT GATES SET MEMBERSHIP: a 1-ULP disagreement does not drift a
// number, it deletes a line and changes the whole output set from that bar
// forward. So every side test multiplies through by the exact positive integer
// (i2 - i1) instead of computing a slope. Division survives only in projectAt,
// whose output is a price that can drift harmlessly.
//
// Ported operation-for-operation to
// backend/auto_trader/indicators/trendlines.py; keep the arithmetic order
// identical (see core.py's parity contract).

export type TrendSide = "support" | "resistance";

/** A line is defined by two anchor pivots and NEVER rotates once defined.
 * Later touches move lastTouchIdx, which extends the line's coverage; they do
 * not move i2/p2, so the geometry a line was born with is the one it dies
 * with. */
export interface TrendLine {
  side: TrendSide;
  i1: number; // first anchor bar index
  p1: number; // first anchor price (high for resistance, low for support)
  i2: number; // second anchor bar index (i2 > i1)
  p2: number;
  touches: number;
  lastTouchIdx: number; // seeded to i2, only ever moves forward
  brokenIdx: number | null; // bar that pierced it, once one has
}

/** The line's price at bar j. The ONLY division in this module: its output is
 * a price that drifts harmlessly, not a gate. */
export function projectAt(line: TrendLine, j: number): number {
  return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1);
}

/** True when bar j's extreme goes beyond the line by more than violTol.
 *
 * Cross-multiplied: with span = i2 - i1 an exact positive integer,
 *   (price - p1) * span  vs  (p2 - p1) * (j - i1) +/- violTol * span
 * is the same inequality as comparing price against the projected value, with
 * one rounding source removed. Multiplying by a positive integer preserves the
 * direction of the inequality. */
export function pierces(line: TrendLine, j: number, price: number, violTol: number): boolean {
  const span = line.i2 - line.i1;
  const lhs = (price - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  const tol = violTol * span;
  return line.side === "resistance" ? lhs > rhs + tol : lhs < rhs - tol;
}

/** True when bar j's extreme counts as a touch.
 *
 * The band is ASYMMETRIC on purpose. For resistance it is
 * [line - touchTol, line + violTol]: the far edge of the touch zone must not
 * reach into the pierce zone, which is exactly what a symmetric band with
 * touchTol > violTol would do. */
export function inTouchBand(
  line: TrendLine,
  j: number,
  price: number,
  violTol: number,
  touchTol: number,
): boolean {
  const span = line.i2 - line.i1;
  const lhs = (price - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  const out = violTol * span;
  const inn = touchTol * span;
  return line.side === "resistance" ? lhs >= rhs - inn && lhs <= rhs + out : lhs >= rhs - out && lhs <= rhs + inn;
}

/** Full deterministic ordering (no stability reliance — Python sorts
 * identically): strongest first, then longest, then most recent, then oldest
 * origin, then lowest anchor price. The last key is a STORED price, never a
 * projected one, so ranking cannot depend on which bar it runs at. */
export function rankLines(a: TrendLine, b: TrendLine): number {
  if (a.touches !== b.touches) return b.touches - a.touches;
  const spanA = a.lastTouchIdx - a.i1;
  const spanB = b.lastTouchIdx - b.i1;
  if (spanA !== spanB) return spanB - spanA;
  if (a.lastTouchIdx !== b.lastTouchIdx) return b.lastTouchIdx - a.lastTouchIdx;
  if (a.i1 !== b.i1) return a.i1 - b.i1;
  return a.p1 - b.p1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts
git commit -m "feat(trendlines): cross-product pierce/touch geometry"
```

---

### Task 3: The incremental detector

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (append)
- Modify: `frontend/src/lib/indicators/trendlines.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `TrendlinesConfig`, `TL_ATR_LEN`, `MAX_PAIR_PIVOTS`, `MAX_LIVE_MULT`; Task 2's `TrendLine`, `pierces`, `inTouchBand`, `projectAt`, `rankLines`; existing `isPivotAt` from `./pivots` and `atrSeries` from `../atr`.
- Produces: `TrendlinesPoint`, `computeTrendlines(dataList: KLineData[], cfg: TrendlinesConfig): { points: TrendlinesPoint[]; lines: TrendLine[] }`.

**Note on validation range.** A candidate seeded at confirm bar `c` is validated over `(i1, c]`, not `(i1, i2)`. Bars between the second anchor and the confirm bar are real bars that could already have pierced the line; leaving them unchecked would let a line be born already broken. The design doc says `(i1, c]`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicators/trendlines.test.ts`. **Extend the existing
`./trendlines` import** from Task 2 with `computeTrendlines` rather than adding a
second import statement for the same module, and add the two new imports:

```ts
import type { KLineData } from "klinecharts";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
// ./trendlines import becomes:
// import { computeTrendlines, inTouchBand, pierces, projectAt, rankLines, type TrendLine } from "./trendlines";

/** Bars with a flat 1.0 true range so ATR(14) settles at exactly 1.0, which
 * makes every tolerance in these tests a round number. */
function bar(i: number, low: number, high: number): KLineData {
  const mid = (low + high) / 2;
  return { timestamp: i * 60_000, open: mid, high, low, close: mid, volume: 1 };
}

/** A flat corridor of `n` bars around price 100, each with range 1.0. */
function flat(n: number, from = 0): KLineData[] {
  return Array.from({ length: n }, (_, k) => bar(from + k, 99.5, 100.5));
}

const cfg = (over: Partial<TrendlinesConfig> = {}): TrendlinesConfig => ({
  ...TRENDLINES_DEFAULTS,
  pivotLen: 2,
  minSpanBars: 5,
  ...over,
});

describe("computeTrendlines", () => {
  it("returns one point per bar and emits nothing before warm-up", () => {
    const bars = flat(30);
    const { points } = computeTrendlines(bars, cfg());
    expect(points).toHaveLength(30);
    expect(points[0]).toEqual({});
  });

  it("finds a rising support line through two swing lows", () => {
    // Two dips 20 bars apart, the second higher, inside a flat corridor.
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const sup = lines.filter((l) => l.side === "support");
    expect(sup.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(true);
  });

  it("rejects a candidate that a bar between the anchors pierces", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    // A dip well under the 20->40 line, but not itself a pivot low extreme
    // enough to reseed a better pair at this pivotLen.
    bars[30] = bar(30, 80, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    expect(lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(false);
  });

  // The hole that per-pivot break detection leaves: a line is almost always
  // broken by an ordinary bar, not by a pivot.
  it("marks a line broken on an ordinary bar, not only at a confirm bar", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    // Bar 60 closes far below the projected support line; it is NOT a pivot.
    bars[60] = bar(60, 80, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const line = lines.find((l) => l.i1 === 20 && l.i2 === 40);
    expect(line?.brokenIdx).toBe(60);
  });

  it("moves a broken line from tl_support to tl_broken_support", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 80, 100.5);
    const { points } = computeTrendlines(bars, cfg({ breakHoldBars: 10 }));
    expect(points[59].tl_support).toBeDefined();
    expect(points[61].tl_support).toBeUndefined();
    expect(points[61].tl_broken_support).toBeDefined();
    // Past the hold window it is gone from both.
    expect(points[75].tl_broken_support).toBeUndefined();
  });

  it("stops projecting past maxProjBars", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const { points } = computeTrendlines(bars, cfg({ maxProjBars: 20 }));
    expect(points[55].tl_support).toBeDefined();
    expect(points[100].tl_support).toBeUndefined();
  });

  // The property that actually protects backtests. If this fails, the
  // indicator is repainting and every backtest that reads it is wrong.
  it("is causal: a prefix computes the same values as the full series", () => {
    const bars = flat(90);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[62] = bar(62, 96, 100.5);
    bars[70] = bar(70, 88, 100.5);
    const full = computeTrendlines(bars, cfg()).points;
    for (let i = 0; i < bars.length; i++) {
      const prefix = computeTrendlines(bars.slice(0, i + 1), cfg()).points;
      expect({ bar: i, ...prefix[i] }).toEqual({ bar: i, ...full[i] });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: FAIL, `computeTrendlines is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add these imports at the top of `frontend/src/lib/indicators/trendlines.ts`:

```ts
import type { KLineData } from "klinecharts";
import { isPivotAt } from "./pivots";
import { atrSeries } from "../atr";
import {
  MAX_LIVE_MULT,
  MAX_PAIR_PIVOTS,
  TL_ATR_LEN,
  type TrendlinesConfig,
} from "./trendlinesOutputs";
```

Append to the same file:

```ts
export interface TrendlinesPoint {
  tl_support?: number;
  tl_resistance?: number;
  tl_broken_support?: number;
  tl_broken_resistance?: number;
}

const SIDES: readonly TrendSide[] = ["resistance", "support"];

/** Live means: not aged out past its projection horizon, and if broken, still
 * inside the hold window. */
function isLive(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.brokenIdx !== null) return i - line.brokenIdx <= cfg.breakHoldBars;
  return i - line.lastTouchIdx <= cfg.maxProjBars;
}

/** Major means: enough touches, enough span, and covering this bar. The
 * top-maxLines cap is applied by the caller, which is what actually suppresses
 * noise — see the design doc. */
function isMajor(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.touches < cfg.minTouches) return false;
  if (line.lastTouchIdx - line.i1 < cfg.minSpanBars) return false;
  return i >= line.i1 && i <= line.lastTouchIdx + cfg.maxProjBars;
}

export function computeTrendlines(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
): { points: TrendlinesPoint[]; lines: TrendLine[] } {
  const n = dataList.length;
  const points: TrendlinesPoint[] = Array.from({ length: n }, () => ({}));
  if (n === 0) return { points, lines: [] };

  const atr = atrSeries(dataList, TL_ATR_LEN);
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  const pools: Record<TrendSide, number[]> = { resistance: [], support: [] };
  let lines: TrendLine[] = [];

  const extremeOf = (side: TrendSide, j: number): number =>
    side === "resistance" ? highs[j] : lows[j];

  for (let i = 0; i < n; i++) {
    const a = atr[i];

    // 1. PER-BAR break test. Runs every bar, not only at confirm bars: a line
    //    is almost always broken by an ordinary bar. Still causal — every
    //    anchor of every line tested here precedes i.
    if (a !== null) {
      for (const line of lines) {
        if (line.brokenIdx !== null) continue;
        if (i <= line.i2) continue; // (i1, c] was validated at seed time
        if (pierces(line, i, extremeOf(line.side, i), cfg.violMult * a)) line.brokenIdx = i;
      }
    }

    // 2. CONFIRM-BAR work for the pivot at bar k = i - pivotLen.
    const k = i - cfg.pivotLen;
    if (k >= 0 && a !== null) {
      for (const side of SIDES) {
        const vals = side === "resistance" ? highs : lows;
        const want = side === "resistance" ? "high" : "low";
        if (!isPivotAt(vals, k, cfg.pivotLen, cfg.pivotLen, want, true)) continue;
        const pool = pools[side];
        const price = vals[k];

        // 2a. Test the new pivot against every existing line on this side.
        for (const line of lines) {
          if (line.side !== side) continue;
          if (k <= line.i2) continue;
          if (line.brokenIdx !== null) continue;
          const tolA = atr[k];
          if (tolA === null) continue;
          if (inTouchBand(line, k, price, cfg.violMult * tolA, cfg.touchMult * tolA)) {
            line.touches += 1;
            line.lastTouchIdx = k;
          }
        }

        // 2b. Seed candidates against the previous MAX_PAIR_PIVOTS pivots.
        const from = Math.max(0, pool.length - MAX_PAIR_PIVOTS);
        for (let q = from; q < pool.length; q++) {
          const i1 = pool[q];
          if (lines.some((l) => l.side === side && l.i1 === i1 && l.i2 === k)) continue;
          const cand: TrendLine = {
            side,
            i1,
            p1: vals[i1],
            i2: k,
            p2: price,
            touches: 2,
            lastTouchIdx: k,
            brokenIdx: null,
          };
          // Validate over (i1, c]: bars between the anchors AND the bars since
          // the second anchor, which are real bars that could already have
          // pierced it. Anchor bars themselves are excluded.
          let ok = true;
          for (let j = i1 + 1; j <= i; j++) {
            if (j === k) continue;
            const tolJ = atr[j];
            if (tolJ === null) continue;
            if (pierces(cand, j, extremeOf(side, j), cfg.violMult * tolJ)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          // Retro-count touches from pivots already in the pool between the
          // anchors. Not lookahead: every one of them confirmed before i.
          for (const pj of pool) {
            if (pj <= i1 || pj >= k) continue;
            const tolP = atr[pj];
            if (tolP === null) continue;
            if (inTouchBand(cand, pj, vals[pj], cfg.violMult * tolP, cfg.touchMult * tolP)) {
              cand.touches += 1;
            }
          }
          lines.push(cand);
        }
        pool.push(k);
      }

      // 3. Prune the dead, then cap live state by rank.
      lines = lines.filter((l) => isLive(l, i, cfg));
      for (const side of SIDES) {
        const mine = lines.filter((l) => l.side === side).sort(rankLines);
        const keep = new Set(mine.slice(0, MAX_LIVE_MULT * cfg.maxLines));
        lines = lines.filter((l) => l.side !== side || keep.has(l));
      }
    }

    // 4. Emit. Membership is gated (major + top maxLines by rank); selection is
    //    nearest to the close, the same reading as SR_LEVELS.
    const close = dataList[i].close;
    const point: TrendlinesPoint = {};
    for (const side of SIDES) {
      const majors = lines
        .filter((l) => l.side === side && isLive(l, i, cfg) && isMajor(l, i, cfg))
        .sort(rankLines)
        .slice(0, cfg.maxLines);
      // An UNBROKEN support line sits at or below the close and an unbroken
      // resistance above it. A BROKEN line is on the far side by definition:
      // price fell through the support, so it now sits ABOVE the close. That
      // inversion is why the side test cannot be shared between the two.
      const pick = (want: "unbroken" | "broken"): number | undefined => {
        let best: number | undefined;
        for (const line of majors) {
          if (want === "unbroken" ? line.brokenIdx !== null : line.brokenIdx === null) continue;
          const v = projectAt(line, i);
          const below = v <= close;
          const wantBelow = want === "unbroken" ? side === "support" : side === "resistance";
          if (below !== wantBelow) continue;
          if (best === undefined || Math.abs(v - close) < Math.abs(best - close)) best = v;
        }
        return best;
      };
      const unbroken = pick("unbroken");
      const broken = pick("broken");
      if (side === "support") {
        if (unbroken !== undefined) point.tl_support = unbroken;
        if (broken !== undefined) point.tl_broken_support = broken;
      } else {
        if (unbroken !== undefined) point.tl_resistance = unbroken;
        if (broken !== undefined) point.tl_broken_resistance = broken;
      }
    }
    points[i] = point;
  }

  return { points, lines };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: PASS, all tests including the causality prefix test.

If the causality test fails, the bug is state that survives a bar it should not, or an emit that reads `lines` mutated later in the same iteration. Do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts
git commit -m "feat(trendlines): incremental detector with per-bar break detection"
```

---

### Task 4: DXY acceptance fixture

This is what turns "reliably" into something that can fail a build. Without it, every later refactor is guesswork.

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesDxy.fixture.json`
- Create: `frontend/src/lib/indicators/trendlinesDxy.test.ts`

**Interfaces:**
- Consumes: Task 3's `computeTrendlines`; Task 1's `TRENDLINES_DEFAULTS`.
- Produces: nothing.

- [ ] **Step 1: Capture the fixture**

The 470 DXY monthly bars are in the running app. With the app open at `http://localhost:5173` on a DXY 1M chart, run in the browser console and save the output to `frontend/src/lib/indicators/trendlinesDxy.fixture.json`:

```js
copy(JSON.stringify(window.__chart.getDataList().map(b => ({
  timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0,
}))))
```

If the app is not running, any DXY monthly OHLC series covering 1987-07 to 2026-08 works, but the expected anchors below are tied to this data and must be re-derived if the source differs.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/indicators/trendlinesDxy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines } from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import fixture from "./trendlinesDxy.fixture.json";

// The three lines a human draws on DXY monthly. Anchors are the bar's own
// high/low, so they are exact, not eyeballed.
const EXPECTED = [
  { side: "resistance", from: "2002-03", fromPrice: 119.61, to: "2007-08", toPrice: 82.132 },
  { side: "support", from: "2011-05", fromPrice: 72.696, to: "2021-01", toPrice: 89.203 },
  { side: "resistance", from: "2022-09", fromPrice: 114.687, to: "2025-01", toPrice: 109.879 },
] as const;

const bars = fixture as unknown as KLineData[];
const month = (t: number): string => new Date(t).toISOString().slice(0, 7);

describe("TRENDLINES on DXY monthly", () => {
  it("has the fixture it expects", () => {
    expect(bars.length).toBeGreaterThan(400);
    expect(month(bars[bars.length - 1].timestamp)).toBe("2026-08");
  });

  it.each(EXPECTED)("surfaces the $from to $to $side line", (want) => {
    const { lines } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const found = lines.find(
      (l) =>
        l.side === want.side &&
        month(bars[l.i1].timestamp) === want.from &&
        month(bars[l.i2].timestamp) === want.to,
    );
    expect(found, `no ${want.side} line ${want.from} -> ${want.to}`).toBeDefined();
    expect(found!.p1).toBeCloseTo(want.fromPrice, 3);
    expect(found!.p2).toBeCloseTo(want.toPrice, 3);
  });

  // The 2011 support line projects to ~98.7 against a ~99.2 spot, i.e. under
  // test. If this stops holding, the projection or the ranking has drifted.
  it("puts the secular support line within a point of spot", () => {
    const { points } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const last = points[points.length - 1];
    expect(last.tl_support).toBeGreaterThan(96);
    expect(last.tl_support).toBeLessThan(100);
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDxy.test.ts`

- [ ] **Step 4: Reconcile, do not loosen silently**

If a line is missing, diagnose before changing anything, and check these in order:

1. **Pairing window.** Verified at `pivotLen = 5`: 7 low pivots separate the 2011-05 and 2021-01 anchors, 2 high pivots separate line A's. Both are inside `MAX_PAIR_PIVOTS = 20`. If a line is missing for this reason, the fixture or `pivotLen` changed.
2. **Line C has exactly two touches.** Its only intervening pivot (2023-10, high 106.952) sits 5.503 from a projected 112.455 against a touch tolerance of 2.589. It passes only because `minTouches` defaults to 2. Do not raise the default to make some other test pass.
3. **Validation range.** Line B is seeded when 2021-01 confirms, so bars from 2021-01 to that confirm bar are validated too. A near-miss there is the likeliest genuine failure.
4. **Rank vs presence.** The design doc records this: if the anchors are right but the line is not top-ranked, relax the assertion to "present among the top N majors" and say so in the test comment. Relaxing anchors or prices is not an option.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesDxy.fixture.json frontend/src/lib/indicators/trendlinesDxy.test.ts
git commit -m "test(trendlines): DXY monthly acceptance fixture"
```

---

### Task 5: klinecharts template and drawing

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (append)

**Interfaces:**
- Consumes: Task 3's `computeTrendlines`, `TrendlinesPoint`, `TrendLine`, `projectAt`; Task 1's `parseTrendlinesConfig`, `TRENDLINES_DEFAULTS`.
- Produces: `TrendlinesExtend`, `TrendlinesCalcPoint`, `TRENDLINES_TEMPLATE`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicators/trendlines.test.ts`:

```ts
import { TRENDLINES_TEMPLATE } from "./trendlines";

describe("TRENDLINES_TEMPLATE", () => {
  it("declares the eight calcParams in spec order", () => {
    expect(TRENDLINES_TEMPLATE.calcParams).toEqual([5, 0.25, 0.75, 2, 20, 250, 30, 3]);
  });

  it("is a price-series overlay on the candle pane", () => {
    expect(TRENDLINES_TEMPLATE.series).toBe("price");
    expect(TRENDLINES_TEMPLATE.figures).toEqual([]);
  });

  it("rides the full line list on the last calc row only", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const rows = TRENDLINES_TEMPLATE.calc!(bars, {
      calcParams: [2, 0.25, 0.75, 2, 5, 250, 30, 3],
      extendData: {},
    } as never) as TrendlinesCalcPoint[];
    expect(rows).toHaveLength(60);
    expect(rows[rows.length - 1].lines).toBeDefined();
    expect(rows[0].lines).toBeUndefined();
  });
});
```

Add `TrendlinesCalcPoint` to the existing import from `./trendlines`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t "TRENDLINES_TEMPLATE"`
Expected: FAIL, `TRENDLINES_TEMPLATE` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the imports in `frontend/src/lib/indicators/trendlines.ts`:

```ts
import type { Indicator, IndicatorDrawParams, IndicatorTemplate } from "klinecharts";
import { parseTrendlinesConfig, TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
```

Append:

```ts
/** Render-only options, on extendData rather than calcParams — the same seam
 * SR_LEVELS uses for showMidline. Because none of this changes a value, it
 * needs no Python port and no parity test. */
export interface TrendlinesExtend {
  /** "ray" keeps going right (default), "segment" stops at the last touch,
   * "extended" also draws back before the first anchor. Backward extension is
   * never readable by an operand: a line emitting values before its first
   * anchor existed would be lookahead. */
  extend?: "ray" | "segment" | "extended";
}

/** calc result row. The full line list rides on the LAST row only (draw reads
 * it there), exactly as SR_LEVELS carries its levels. */
export type TrendlinesCalcPoint = TrendlinesPoint & { lines?: TrendLine[] };

function drawTrendlines(
  params: IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>,
): boolean {
  const { ctx, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as TrendlinesCalcPoint[];
  const last = result[result.length - 1];
  if (!last?.lines?.length) return true;
  const cfg = parseTrendlinesConfig(indicator.calcParams);
  const ext = indicator.extendData as TrendlinesExtend | undefined;
  const mode = ext?.extend ?? "ray";

  ctx.save();
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  for (const line of last.lines) {
    const broken = line.brokenIdx !== null;
    // Left edge: the first anchor, or off-screen left when extended.
    const jLeft = mode === "extended" ? line.i1 - cfg.maxProjBars : line.i1;
    // Right edge: the last touch, or the projection horizon.
    const jRight = mode === "segment" ? line.lastTouchIdx : line.lastTouchIdx + cfg.maxProjBars;
    const x0 = xAxis.convertToPixel(jLeft);
    const x1 = xAxis.convertToPixel(jRight);
    if (x1 <= 0 || x0 >= bounding.width) continue;
    const y0 = yAxis.convertToPixel(projectAt(line, jLeft));
    const y1 = yAxis.convertToPixel(projectAt(line, jRight));
    ctx.strokeStyle = line.side === "support" ? "#26a69a" : "#ef5350";
    ctx.globalAlpha = broken ? 0.45 : 1;
    ctx.lineWidth = 1;
    ctx.setLineDash(broken ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    // Touch count at the right end, so the reason a line outranked another is
    // visible at a glance.
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`x${line.touches}`, Math.min(x1 + 4, bounding.width - 20), y1);
  }
  ctx.restore();
  return true;
}

export const TRENDLINES_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Trendlines",
  series: "price",
  precision: 2,
  calcParams: [
    TRENDLINES_DEFAULTS.pivotLen,
    TRENDLINES_DEFAULTS.violMult,
    TRENDLINES_DEFAULTS.touchMult,
    TRENDLINES_DEFAULTS.minTouches,
    TRENDLINES_DEFAULTS.minSpanBars,
    TRENDLINES_DEFAULTS.maxProjBars,
    TRENDLINES_DEFAULTS.breakHoldBars,
    TRENDLINES_DEFAULTS.maxLines,
  ],
  // Empty figures + a draw that returns true (isCover) is the established way
  // to run calc but paint nothing of klinecharts' own — the mechanism
  // sessions.ts and proximityHeatmap.ts already use.
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) => {
    const { points, lines } = computeTrendlines(dataList, parseTrendlinesConfig(ind.calcParams));
    const out = points.map((p) => ({ ...p })) as TrendlinesCalcPoint[];
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], lines };
    return out;
  },
  draw: (params) => drawTrendlines(params as IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts
git commit -m "feat(trendlines): klinecharts template, draw and the extend option"
```

---

### Task 6: Register in the frontend

**Files:**
- Modify: `frontend/src/lib/customIndicators.ts`
- Modify: `frontend/src/lib/indicatorMeta.ts`
- Modify: `frontend/src/lib/exprInstances.ts`

**Interfaces:**
- Consumes: Task 5's `TRENDLINES_TEMPLATE`; Task 1's `TRENDLINES_OUTPUTS`, `parseTrendlinesConfig`, `trendlinesWarmup`.
- Produces: `"TRENDLINES"` as a `CustomIndicatorType` and an `EXPR_INSTANCE_TYPES` member.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/trendlines.register.test.ts` (mirrors `slope.register.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { BASE_TEMPLATES } from "./customIndicators";
// INDICATOR_META is module-local; indicatorInfo and resolveInputs are the
// exported surface.
import { indicatorInfo, resolveInputs } from "./indicatorMeta";
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef } from "./exprInstances";
import { TRENDLINES_OUTPUTS } from "./indicators/trendlinesOutputs";

describe("TRENDLINES registration", () => {
  it("has a base template", () => {
    expect(BASE_TEMPLATES.TRENDLINES).toBeDefined();
  });

  it("has settings metadata for all eight params plus the extend select", () => {
    const inputs = resolveInputs("TRENDLINES", undefined);
    expect(inputs.filter((i) => i.type === "number")).toHaveLength(8);
    expect(inputs.find((i) => i.key === "extend")?.type).toBe("select");
    // resolveInputs falls back to synthesized generic inputs when a name has no
    // metadata, so assert the named title too or this test passes on a miss.
    expect(indicatorInfo("TRENDLINES").title).toBe("Trendlines");
  });

  it("is a referenceable expression instance exposing four outputs", () => {
    expect(EXPR_INSTANCE_TYPES.has("TRENDLINES")).toBe(true);
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const [inst] = exprInstancesFor(live as never);
    expect(inst.outputs).toEqual([...TRENDLINES_OUTPUTS]);
    expect(inst.timeframe).toBeNull();
  });

  it("gives every output the same warm-up floor and unknown outputs zero", () => {
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const warmup = exprWarmupByRef(live as never);
    expect(warmup("tl1", "tl_support")).toBe(14 + 10 + 20);
    expect(warmup("tl1", "not_an_output")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/trendlines.register.test.ts`
Expected: FAIL, `BASE_TEMPLATES.TRENDLINES` is undefined.

- [ ] **Step 3: Wire the three files**

In `frontend/src/lib/customIndicators.ts`: add `export * from "./indicators/trendlines";` beside the other barrel exports, add `import { TRENDLINES_TEMPLATE } from "./indicators/trendlines";` beside the other template imports, add `| "TRENDLINES"` to `CustomIndicatorType`, and add `TRENDLINES: TRENDLINES_TEMPLATE,` to `BASE_TEMPLATES`.

In `frontend/src/lib/indicatorMeta.ts`, add to `INDICATOR_META` (no em dashes in any label, tip or desc):

```ts
  TRENDLINES: {
    inputs: [
      {
        ...num(0, "Pivot Length"),
        tip: "Bars required each side of a swing before it counts as a pivot. Higher value uses only the more prominent swings (and confirms them later). It also sets how far back a line can reach, so long lines need a large value.",
      },
      {
        ...num(1, "Pierce Tolerance (xATR)", { min: 0, step: 0.05 }),
        tip: "How far a wick may go beyond a line before the line is dead, as a multiple of ATR(14). Zero means exact containment: no pierce allowed at all.",
      },
      {
        ...num(2, "Touch Tolerance (xATR)", { min: 0.05, step: 0.05 }),
        tip: "How close a swing must sit to a line to count as a touch, as a multiple of ATR(14).",
      },
      {
        ...num(3, "Min Touches", { min: 2 }),
        tip: "Touches a line needs before it is drawn. Two means the anchors alone, which is what lets a freshly formed line show up.",
      },
      {
        ...num(4, "Min Span (bars)"),
        tip: "Bars a line must cover before it is drawn. This is what keeps short scraps out.",
      },
      {
        ...num(5, "Projection (bars)"),
        tip: "How far past its last touch a line is projected forward. Past that it retires, however healthy it looks.",
      },
      {
        ...num(6, "Break Hold (bars)"),
        tip: "How long a broken line stays on the chart (dashed) so a retest is visible.",
      },
      {
        ...num(7, "Max Lines"),
        tip: "Keep only this many of the strongest (most-touched, longest, most recent) lines per side.",
      },
      {
        key: "extend",
        label: "Extend",
        type: "select",
        source: "extend",
        field: "extend",
        default: "ray",
        options: [
          { value: "ray", label: "Ray (forward)" },
          { value: "segment", label: "Segment (stop at last touch)" },
          { value: "extended", label: "Extended (both ways)" },
        ],
        tip: "Drawing only. The rule operands always project forward by the Projection setting, so changing this cannot alter a strategy.",
      },
    ],
    title: "Trendlines",
    desc: "Finds major sloping support and resistance lines from confirmed fractal swings. A line survives only where no bar pierced it, so lines anchor where price actually held rather than at the highest or lowest bar. Nearest trendline support and resistance, and their broken counterparts during the hold window, are available as rule operands. Swings confirm Pivot Length bars late (no repaint).",
  },
```

In `frontend/src/lib/exprInstances.ts`:
- Add the import: `import { TRENDLINES_OUTPUTS, parseTrendlinesConfig, trendlinesWarmup } from "./indicators/trendlinesOutputs";`
- Add `"TRENDLINES"` to the `EXPR_INSTANCE_TYPES` set.
- In the `calcParams` recovery ternary (around line 141), treat `TRENDLINES` like `FVG` — its outputs are fixed names, not lengths, so nothing about the pane's params is recoverable from a ref and an empty list takes every default. Change the `FVG` arm's condition to `type === "FVG" || type === "TRENDLINES"`.
- In `exprWarmupByRef`, before the `SLOPE` branch:

```ts
    // Every TRENDLINES output shares one floor (ATR warm-up + two confirms +
    // the minimum span); an output this pane does not expose costs 0.
    if (inst.type === "TRENDLINES")
      return (TRENDLINES_OUTPUTS as readonly string[]).includes(output)
        ? trendlinesWarmup(parseTrendlinesConfig(inst.calcParams))
        : 0;
```

- In `exprInstancesFor`, before the `SLOPE` branch:

```ts
    if (inst.type === "TRENDLINES") {
      const cfg = parseTrendlinesConfig(inst.calcParams);
      out.push({
        id: inst.id,
        outputs: [...TRENDLINES_OUTPUTS],
        timeframe: null, // no MTF in v1 (see the design doc's non-goals)
        // The output names say which side; what they cannot say is how
        // selective the pane is — the SLOPE/ATR detail convention.
        detail: `pivot ${cfg.pivotLen} · top ${cfg.maxLines}/side`,
      });
      continue;
    }
```

- [ ] **Step 4: Run the test and the full frontend suite**

Run: `cd frontend && npx vitest run src/lib/trendlines.register.test.ts`
Expected: PASS.

Run: `cd frontend && npm run test:unit`
Expected: the suite's known baseline failures only. **The baseline on `main` is not green** (a handful of pre-existing failures, several order-sensitive). Compare against a baseline captured on a clean checkout before this task; do not "fix" failures unrelated to TRENDLINES.

Run: `cd frontend && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/customIndicators.ts frontend/src/lib/indicatorMeta.ts frontend/src/lib/exprInstances.ts frontend/src/lib/trendlines.register.test.ts
git commit -m "feat(trendlines): register the pane, its settings and its rule operands"
```

---

### Task 7: Python port

**Files:**
- Create: `backend/auto_trader/indicators/trendlines.py`
- Modify: `backend/auto_trader/indicators/registry.py`
- Test: `backend/tests/test_trendlines_indicator.py`

**Interfaces:**
- Consumes: `auto_trader.indicators.core.atr_series` (the same one `sr_levels.py` uses, not the one in `indicators/atr.py`), `auto_trader.core.models.Candle`.
- Produces: `TrendlinesConfig` (frozen dataclass), `parse_trendlines_config(calc_params, extend_data)`, `trendlines_outputs(cfg)`, `trendlines_series(cfg, output, candles, bar_hours)`, `trendlines_warmup(cfg, output)`.

Signatures follow `registry.IndicatorSeriesSpec`, so `parse_config` takes two arguments and `warmup` takes `(cfg, output)`, even though `extend_data` is unused here (v1 has no MTF, so `timeframe` is `lambda cfg: None`, as ATR's is).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_trendlines_indicator.py`:

```python
"""TRENDLINES config parsing, outputs and the geometry gates.

The cross-product form of the pierce test is the parity contract: validity is a
boolean that gates set membership, so a 1-ULP disagreement with the TS deletes a
line rather than nudging a number.
"""

import math

import pytest

from auto_trader.indicators.trendlines import (
    TREND_LINES_OUTPUTS,
    TrendLine,
    parse_trendlines_config,
    pierces,
    project_at,
    trendlines_outputs,
    trendlines_warmup,
)


def _res() -> TrendLine:
    return TrendLine(side="resistance", i1=0, p1=100.0, i2=10, p2=90.0,
                     touches=2, last_touch_idx=10, broken_idx=None)


def test_defaults_from_empty_params():
    cfg = parse_trendlines_config([], {})
    assert (cfg.pivot_len, cfg.viol_mult, cfg.touch_mult) == (5, 0.25, 0.75)
    assert (cfg.min_touches, cfg.min_span_bars) == (2, 20)
    assert (cfg.max_proj_bars, cfg.break_hold_bars, cfg.max_lines) == (250, 30, 3)


def test_zero_viol_mult_survives():
    # The STRICTEST setting (exact containment), not a "filter off" switch.
    assert parse_trendlines_config([5, 0], {}).viol_mult == 0.0


def test_zero_touch_mult_falls_back():
    assert parse_trendlines_config([5, 0.25, 0], {}).touch_mult == 0.75


def test_outputs_in_pane_order():
    cfg = parse_trendlines_config([], {})
    assert trendlines_outputs(cfg) == (
        "tl_support", "tl_resistance", "tl_broken_support", "tl_broken_resistance",
    )
    assert TREND_LINES_OUTPUTS == trendlines_outputs(cfg)


def test_warmup_floor():
    cfg = parse_trendlines_config([], {})
    assert trendlines_warmup(cfg, "tl_support") == 14 + 10 + 20
    assert trendlines_warmup(cfg, "not_an_output") == 0


def test_project_at():
    assert project_at(_res(), 5) == pytest.approx(95.0)
    assert project_at(_res(), 20) == pytest.approx(80.0)


def test_pierce_is_exact_at_the_boundary():
    line = _res()
    assert pierces(line, 5, 96.0, 1.0) is False
    assert pierces(line, 5, math.nextafter(96.0, math.inf), 1.0) is True


def test_pierce_ignores_the_wrong_side():
    assert pierces(_res(), 5, 10.0, 1.0) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_trendlines_indicator.py -v`
Expected: FAIL, `ModuleNotFoundError: auto_trader.indicators.trendlines`.

- [ ] **Step 3: Write the port**

Create `backend/auto_trader/indicators/trendlines.py`. Everything except
`compute_trendlines` is given below in full. `compute_trendlines` is a
**line-by-line transliteration** of `computeTrendlines` from Task 3, which is
shown in full there: same loop order, same branch order, same arithmetic order.
Do not restructure the loops, do not replace the cross-product tests with a
slope, and do not reorder any expression. Read the TS beside the Python.

```python
"""TRENDLINES: major sloping support/resistance lines from confirmed fractal
pivots. Ported operation-for-operation from
frontend/src/lib/indicators/trendlines.ts.

Validity here is a BOOLEAN THAT GATES SET MEMBERSHIP, not a number: a 1-ULP
disagreement with the TS deletes a line and changes the whole output set from
that bar forward. That is why every side test multiplies through by the exact
positive integer (i2 - i1) instead of computing a slope. Division survives only
in project_at, whose output is a price that can drift harmlessly.

Do NOT "improve" the arithmetic (see core.py's parity contract). Values at index
i depend only on inputs [0..i] — no lookahead by construction."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series  # NOT .atr — sr_levels.py uses this one

TL_ATR_LEN = 14
MAX_PAIR_PIVOTS = 20
MAX_LIVE_MULT = 4

TREND_LINES_OUTPUTS: tuple[str, ...] = (
    "tl_support",
    "tl_resistance",
    "tl_broken_support",
    "tl_broken_resistance",
)

_DEFAULTS = (5, 0.25, 0.75, 2, 20, 250, 30, 3)

Side = Literal["support", "resistance"]


@dataclass(frozen=True, slots=True)
class TrendlinesConfig:
    pivot_len: int
    viol_mult: float
    touch_mult: float
    min_touches: int
    min_span_bars: int
    max_proj_bars: int
    break_hold_bars: int
    max_lines: int


@dataclass(slots=True)
class TrendLine:
    side: Side
    i1: int
    p1: float
    i2: int
    p2: float
    touches: int
    last_touch_idx: int
    broken_idx: int | None


def parse_trendlines_config(calc_params: object, extend_data: object) -> TrendlinesConfig:
    """Mirrors TS parseTrendlinesConfig. extend_data is unused: the only
    extendData field is the render-only `extend` option, and v1 has no MTF."""
    p: list[Any] = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    d = _DEFAULTS

    def num_at(i: int, default: float, allow_zero: bool) -> float:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            return default
        if v != v or v in (float("inf"), float("-inf")):  # NaN / inf
            return default
        return v if (v >= 0 if allow_zero else v > 0) else default

    def int_at(i: int, default: float) -> int:
        return max(1, int(num_at(i, default, False) // 1))

    return TrendlinesConfig(
        pivot_len=int_at(0, d[0]),
        # viol_mult takes ZERO (exact containment, the strictest setting), so it
        # alone validates on >= 0.
        viol_mult=num_at(1, d[1], True),
        touch_mult=num_at(2, d[2], False),
        min_touches=max(2, int(num_at(3, d[3], False) // 1)),
        min_span_bars=int_at(4, d[4]),
        max_proj_bars=int_at(5, d[5]),
        break_hold_bars=int_at(6, d[6]),
        max_lines=int_at(7, d[7]),
    )


def project_at(line: TrendLine, j: int) -> float:
    """The line's price at bar j. The ONLY division in this module."""
    return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1)


def pierces(line: TrendLine, j: int, price: float, viol_tol: float) -> bool:
    span = line.i2 - line.i1
    lhs = (price - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    tol = viol_tol * span
    if line.side == "resistance":
        return lhs > rhs + tol
    return lhs < rhs - tol


def in_touch_band(
    line: TrendLine, j: int, price: float, viol_tol: float, touch_tol: float
) -> bool:
    """Asymmetric on purpose: for resistance the band is
    [line - touch_tol, line + viol_tol], so the far edge of the touch zone
    cannot reach into the pierce zone."""
    span = line.i2 - line.i1
    lhs = (price - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    out = viol_tol * span
    inn = touch_tol * span
    if line.side == "resistance":
        return rhs - inn <= lhs <= rhs + out
    return rhs - out <= lhs <= rhs + inn


def rank_key(line: TrendLine) -> tuple[int, int, int, int, float]:
    """Reproduces TS rankLines as a sort key: strongest, then longest, then most
    recent, then oldest origin, then lowest anchor price. p1 is a STORED price,
    never a projected one, so ranking cannot depend on which bar it runs at."""
    return (
        -line.touches,
        -(line.last_touch_idx - line.i1),
        -line.last_touch_idx,
        line.i1,
        line.p1,
    )


def _is_pivot_at(
    values: Sequence[float], i: int, lb_l: int, lb_r: int, want: str
) -> bool:
    """Mirrors TS isPivotAt with strict=True: the pivot must be strictly beyond
    every neighbour, so a flat top or bottom does not register."""
    if i - lb_l < 0 or i + lb_r >= len(values):
        return False
    v = values[i]
    for j in range(i - lb_l, i + lb_r + 1):
        if j == i:
            continue
        w = values[j]
        if want == "low":
            if w <= v:
                return False
        else:
            if w >= v:
                return False
    return True


def trendlines_outputs(cfg: TrendlinesConfig) -> tuple[str, ...]:
    return TREND_LINES_OUTPUTS


def trendlines_warmup(cfg: TrendlinesConfig, output: str) -> int:
    """Every output shares one floor; an output this pane does not expose costs
    0, like fvg_warmup."""
    if output not in TREND_LINES_OUTPUTS:
        return 0
    return TL_ATR_LEN + 2 * cfg.pivot_len + cfg.min_span_bars


def trendlines_series(
    cfg: TrendlinesConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    """bar_hours is unused (nothing here is time-scaled); it is in the signature
    because IndicatorSeriesSpec.series requires it."""
    if output not in TREND_LINES_OUTPUTS:
        return [None] * len(candles)
    points, _lines = compute_trendlines(candles, cfg)
    return [p.get(output) for p in points]
```

Then write `compute_trendlines(candles, cfg) -> tuple[list[dict[str, float]], list[TrendLine]]`
as the transliteration described above. Two Python-specific notes:

- `atr_series(candles, TL_ATR_LEN)` returns `None` where the TS returns `null`; keep the same `is None` guards in the same places.
- Where the TS does `.sort(rankLines)`, use `sorted(..., key=rank_key)`. `rank_key` is a total order, so Python's stable sort and the TS comparator cannot disagree.

Then add to `backend/auto_trader/indicators/registry.py`: the import
`from auto_trader.indicators import trendlines as _tl` beside the others, and

```python
    "TRENDLINES": IndicatorSeriesSpec(
        parse_config=_tl.parse_trendlines_config,
        outputs=_tl.trendlines_outputs,
        series=_tl.trendlines_series,
        warmup=_tl.trendlines_warmup,
        timeframe=lambda cfg: None,
    ),
```

Then add to `backend/auto_trader/indicators/registry.py`: the import
`from auto_trader.indicators import trendlines as _tl` beside the others, and

```python
    "TRENDLINES": IndicatorSeriesSpec(
        parse_config=_tl.parse_trendlines_config,
        outputs=_tl.trendlines_outputs,
        series=_tl.trendlines_series,
        warmup=_tl.trendlines_warmup,
        timeframe=lambda cfg: None,
    ),
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_trendlines_indicator.py tests/test_indicator_registry.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/trendlines.py backend/auto_trader/indicators/registry.py backend/tests/test_trendlines_indicator.py
git commit -m "feat(trendlines): Python port and registry entry"
```

---

### Task 8: Parity golden

The two runtimes must agree on every bar. Because a boolean gate decides set membership here, a near-miss shows up as a whole line appearing in one runtime and not the other, which is exactly what this test catches.

**Files:**
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts`
- Modify: `backend/tests/test_indicator_parity.py`
- Regenerates: `backend/tests/fixtures/indicator_golden.json`

**Interfaces:**
- Consumes: Task 3's `computeTrendlines`, Task 7's `trendlines_series` and `TrendlinesConfig`.
- Produces: four new keys in the golden fixture's `series` map.

This repo's parity seam is a **golden-master generator**, not a shared cases file: the TS test runs the real functions over a deterministic synthetic walk and *writes* `backend/tests/fixtures/indicator_golden.json`, which the Python side must reproduce exactly. `SR_LEVELS` and `FVG` already ride this seam. Add to it rather than building a parallel one.

- [ ] **Step 1: Emit the four series from the TS generator**

In `frontend/src/lib/indicatorParityGolden.test.ts`:

Add the import beside `computeFvg`:

```ts
import { computeTrendlines } from "./indicators/trendlines";
```

Add beside the `computeFvg` call, above the `series` object:

```ts
    // TRENDLINES: config mirrored by test_indicator_parity.test_trendlines.
    // pivotLen 3 and minSpanBars 10 keep the synthetic walk producing lines on
    // both sides rather than a handful, so the pierce gate, the touch band, the
    // per-bar break path and the break-hold window all get exercised.
    const tlPoints = computeTrendlines(candles, {
      pivotLen: 3, violMult: 0.25, touchMult: 0.75, minTouches: 2,
      minSpanBars: 10, maxProjBars: 250, breakHoldBars: 30, maxLines: 3,
    }).points;
```

Add these four entries to the `series` object:

```ts
      TL_SUPPORT: toNull(tlPoints.map((p) => p.tl_support ?? null)),
      TL_RESISTANCE: toNull(tlPoints.map((p) => p.tl_resistance ?? null)),
      TL_BROKEN_SUPPORT: toNull(tlPoints.map((p) => p.tl_broken_support ?? null)),
      TL_BROKEN_RESISTANCE: toNull(tlPoints.map((p) => p.tl_broken_resistance ?? null)),
```

- [ ] **Step 2: Regenerate the fixture and check it is not vacuous**

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS, and `backend/tests/fixtures/indicator_golden.json` is rewritten with the four `TL_*` keys.

Inspect it before going on:

```bash
cd backend && python3 -c "
import json; s=json.load(open('tests/fixtures/indicator_golden.json'))['series']
for k in ('TL_SUPPORT','TL_RESISTANCE','TL_BROKEN_SUPPORT','TL_BROKEN_RESISTANCE'):
    v=[x for x in s[k] if x is not None]; print(k, len(v), 'non-null of', len(s[k]))
"
```

Every key must have a healthy count of non-null values. An all-null series makes the Python assertion vacuous — it would pass against a port that returns nothing. If a series is empty, loosen `minSpanBars` or `pivotLen` in the generator config until it is not, and mirror the change in Step 3.

- [ ] **Step 3: Add the Python side**

Add to `backend/tests/test_indicator_parity.py`, following `test_fvg` exactly:

```python
def test_trendlines(golden):
    from auto_trader.indicators.trendlines import TrendlinesConfig, trendlines_series

    candles, _, series = golden
    cfg = TrendlinesConfig(
        pivot_len=3, viol_mult=0.25, touch_mult=0.75, min_touches=2,
        min_span_bars=10, max_proj_bars=250, break_hold_bars=30, max_lines=3,
    )
    for output, key in (
        ("tl_support", "TL_SUPPORT"),
        ("tl_resistance", "TL_RESISTANCE"),
        ("tl_broken_support", "TL_BROKEN_SUPPORT"),
        ("tl_broken_resistance", "TL_BROKEN_RESISTANCE"),
    ):
        expected = series[key]
        # Guard against a vacuous golden: the synthetic walk must form lines.
        assert any(v is not None for v in expected), f"{key}: golden is all-None"
        assert_series_equal(trendlines_series(cfg, output, candles, 1.0), expected, key)
```

The config here must match the generator's in Step 1 value for value. If they drift, the test compares two different indicators and passes or fails for the wrong reason.

- [ ] **Step 4: Run both sides**

Run: `cd backend && python3 -m pytest tests/test_indicator_parity.py -v`
Expected: PASS, including `test_trendlines`.

A mismatch here is a real bug, not a tolerance to widen. The usual causes, in order of likelihood: a division that crept into a gate, a reordered arithmetic expression, a sort that relies on stability in one runtime, or an iteration order difference over the line list.

- [ ] **Step 5: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint`
Run: `cd backend && python3 -m pytest tests/ -q`
Expected: frontend at its known baseline, backend green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicatorParityGolden.test.ts backend/tests/test_indicator_parity.py backend/tests/fixtures/indicator_golden.json
git commit -m "test(trendlines): TS/Python parity via the golden-master seam"
```

---

## Verification

After Task 8, confirm the indicator works in the real app, not only in tests:

1. Start the frontend, open a DXY 1M chart.
2. Indicators menu, add **Trendlines**. Expect roughly three lines per side, the support line arriving near spot.
3. Open its settings. Change **Extend** to Segment, confirm the lines stop at their last touch. Change to Extended, confirm they run both ways.
4. Confirm the drawn support line agrees with the manually drawn ray anchored 2011-05 to 2021-01 already saved on that chart.
5. In a strategy rule, type `tl_` and confirm all four operands appear in the completion popup.
