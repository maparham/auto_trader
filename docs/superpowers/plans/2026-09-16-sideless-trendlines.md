# Sideless Trendlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the TRENDLINES indicator so a line connects any two significant swings (high or low) with no side, no pierce rule and no broken state, counts price crossings, and exposes ranked `tl_1..tl_N` plus `tl_nearest` outputs, in both the TS detector and its Python parity port.

**Architecture:** One shared pivot pool (highs and lows in confirm order) feeds a seeding pass that pairs any two pivots; validity is touches within one symmetric ATR tolerance; crossings of the close are counted per line as detector state; ranking picks the emitted set. The Python module is rewritten operation for operation from the TS and the parity golden is regenerated. Draw, MTF and settings code collapse their per-side branches to the single case.

**Tech Stack:** TypeScript (vitest, klinecharts), Python 3 (pytest, dataclasses).

**Spec:** `docs/superpowers/specs/2026-09-16-sideless-trendlines-design.md`

## Global Constraints

- **Parity contract:** every boolean gate multiplies through by the exact positive integer span `i2 - i1`; the only division is `projectAt` / `project_at`. No new quotient anywhere in the detector.
- **Causality:** a value at bar `i` depends only on bars `[0..i]`. Pivots confirm at `k + pivotLen`; every line is seeded at a confirm bar; the crossing counter only reads closes at or before `i`.
- **No migration:** saved instances, presets and rules are not migrated (owner's decision). The calcParams layout is re-cut; old instances parse with defaults.
- **Deterministic pool order:** within one confirm bar the high pivot enters the pool before the low pivot. A candidate needs `i1 < k` strictly (a same-bar high/low pair has span 0 and is skipped).
- **Ranking is a total order** (`rankLines` / `rank_key`): touches desc, span desc, crossings asc, lastTouchIdx desc, i1 asc, p1 asc.
- **Output names:** `tl_1 .. tl_<maxLines>` then `tl_nearest`, from `trendlinesOutputs(cfg)` / `trendlines_outputs(cfg)`. `TL_NEAREST = "tl_nearest"`.
- **Copy rules:** no em dashes in UI text or tips; tips are short scannable lines (`string[]`).
- **Frontend tests:** run ONLY the touched files with `cd frontend && npx vitest run <path>`; NEVER the whole suite. Typecheck with `cd frontend && npx tsc -b` and judge by per-file parity (`tsc --noEmit` is a no-op here).
- **Backend tests:** `cd backend && python3 -m pytest <path> -x -q`.
- **Shared worktree:** never stash/clean/restore; `git add` by explicit path only. Pre-flight before Task 1: `git status --porcelain`; if any file this plan touches is already modified, STOP and ask the user.
- **Commits:** on the current branch (`main`), never create a branch, never suggest push. Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KJkpgc1sXBkbNBjtFgtQFw
  ```

## File Structure

| File | Responsibility after this plan |
|---|---|
| `frontend/src/lib/indicators/trendlinesOutputs.ts` | Config type, defaults, parser, output-name list, warm-up. Leaf, no klinecharts import. |
| `frontend/src/lib/indicators/trendlines.ts` | Detector (types, geometry gates, step loop, session), emission, draw path, MTF alignment, template. |
| `frontend/src/lib/indicatorMeta.ts` | TRENDLINES settings rows, presets, description. |
| `frontend/src/lib/exprInstances.ts`, `frontend/src/lib/exprChartToken.ts` | Output list per instance from cfg. |
| `frontend/src/lib/mtfCoordinator.ts` | `buildTrendlinesMtf` stashes per-HTF-bar points. |
| `backend/auto_trader/indicators/trendlines.py` | Python twin of the detector and outputs. |
| `frontend/src/lib/indicatorParityGolden.test.ts` + `backend/tests/fixtures/indicator_golden.json` + `backend/tests/test_indicator_parity.py` | Parity golden generator, fixture, verifier. |
| `frontend/src/lib/indicators/trendlinesEurusd.fixture.json` + `trendlinesEurusd.test.ts` | Acceptance: the 2021 high to Nov-2025 low weekly line. |

---

### Task 1: TS config leaf (`trendlinesOutputs.ts`)

**Files:**
- Modify: `frontend/src/lib/indicators/trendlinesOutputs.ts`
- Test: `frontend/src/lib/indicators/trendlinesOutputs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TrendlinesConfig {
    pivotLen: number; touchMult: number; minTouches: number; minSpanBars: number;
    maxProjBars: number; maxLines: number; minSwingAtr: number; minSwingReach: number;
    pairPivots: number; maxTouches: number; maxSpanBars: number; maxSlopeAtr: number;
    minSlopeAtr: number; maxTouchSpacing: number; minTouchSpacing: number;
    minCrossings: number; maxCrossings: number;
  }
  export const MAX_PAIR_PIVOTS = 40;
  export const TL_NEAREST = "tl_nearest";
  export function tlOutputName(rank: number): string;           // "tl_1" for rank 1
  export function trendlinesOutputs(cfg: TrendlinesConfig): string[];
  export function parseTrendlinesConfig(calcParams: unknown): TrendlinesConfig;
  export function trendlinesWarmup(cfg: TrendlinesConfig): number;
  ```
  Key ORDER of `TRENDLINES_DEFAULTS` IS the calcParams order (slots 0..16 as in the spec table).

- [ ] **Step 1: Replace the tests**

Overwrite `trendlinesOutputs.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_PAIR_PIVOTS,
  parseTrendlinesConfig,
  TL_ATR_LEN,
  TL_NEAREST,
  tlOutputName,
  TRENDLINES_DEFAULTS,
  trendlinesOutputs,
  trendlinesWarmup,
} from "./trendlinesOutputs";

describe("TRENDLINES_DEFAULTS", () => {
  it("pins the calcParams slot order", () => {
    expect(Object.keys(TRENDLINES_DEFAULTS)).toEqual([
      "pivotLen", "touchMult", "minTouches", "minSpanBars", "maxProjBars", "maxLines",
      "minSwingAtr", "minSwingReach", "pairPivots", "maxTouches", "maxSpanBars",
      "maxSlopeAtr", "minSlopeAtr", "maxTouchSpacing", "minTouchSpacing",
      "minCrossings", "maxCrossings",
    ]);
  });
  it("shares one pool, so pairing reaches 40 pivots back", () => {
    expect(MAX_PAIR_PIVOTS).toBe(40);
    expect(TRENDLINES_DEFAULTS.pairPivots).toBe(40);
  });
});

describe("parseTrendlinesConfig", () => {
  it("returns the defaults for an empty or non-array input", () => {
    expect(parseTrendlinesConfig([])).toEqual(TRENDLINES_DEFAULTS);
    expect(parseTrendlinesConfig(undefined)).toEqual(TRENDLINES_DEFAULTS);
    expect(parseTrendlinesConfig("junk")).toEqual(TRENDLINES_DEFAULTS);
  });
  it("reads every slot in order", () => {
    const p = [4, 0.5, 3, 30, 100, 9, 3, 6, 25, 7, 300, 0.2, 0.01, 60, 3, 1, 4];
    expect(parseTrendlinesConfig(p)).toEqual({
      pivotLen: 4, touchMult: 0.5, minTouches: 3, minSpanBars: 30, maxProjBars: 100,
      maxLines: 9, minSwingAtr: 3, minSwingReach: 6, pairPivots: 25, maxTouches: 7,
      maxSpanBars: 300, maxSlopeAtr: 0.2, minSlopeAtr: 0.01, maxTouchSpacing: 60,
      minTouchSpacing: 3, minCrossings: 1, maxCrossings: 4,
    });
  });
  it("keeps zero on the >= 0 params and floors the integers", () => {
    const c = parseTrendlinesConfig([2.9, 0, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(c.pivotLen).toBe(2);
    expect(c.touchMult).toBe(0);
    expect(c.minTouches).toBe(2); // clamped to the two anchors
    expect(c.minSpanBars).toBe(TRENDLINES_DEFAULTS.minSpanBars); // 0 fails > 0
    expect(c.maxLines).toBe(TRENDLINES_DEFAULTS.maxLines);
    expect(c.minSwingAtr).toBe(0);
    expect(c.maxTouches).toBe(0);
    expect(c.minCrossings).toBe(0);
    expect(c.maxCrossings).toBe(0);
  });
  it("sends negatives and junk to the default", () => {
    const c = parseTrendlinesConfig([-1, -1, "x", null, [], {}, NaN]);
    expect(c).toEqual(TRENDLINES_DEFAULTS);
  });
});

describe("trendlinesOutputs", () => {
  it("names one ranked output per Max Trendlines slot, then the nearest", () => {
    const cfg = { ...TRENDLINES_DEFAULTS, maxLines: 3 };
    expect(trendlinesOutputs(cfg)).toEqual(["tl_1", "tl_2", "tl_3", TL_NEAREST]);
    expect(tlOutputName(7)).toBe("tl_7");
    expect(TL_NEAREST).toBe("tl_nearest");
  });
  it("grows with the setting", () => {
    expect(trendlinesOutputs({ ...TRENDLINES_DEFAULTS, maxLines: 1 })).toEqual(["tl_1", TL_NEAREST]);
    expect(trendlinesOutputs({ ...TRENDLINES_DEFAULTS, maxLines: 9 })).toHaveLength(10);
  });
});

describe("trendlinesWarmup", () => {
  it("is ATR warm-up plus two pivot confirms plus the minimum span", () => {
    expect(trendlinesWarmup(TRENDLINES_DEFAULTS)).toBe(TL_ATR_LEN + 2 * 5 + 20);
    expect(trendlinesWarmup({ ...TRENDLINES_DEFAULTS, pivotLen: 3, minSpanBars: 10 })).toBe(TL_ATR_LEN + 6 + 10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesOutputs.test.ts`
Expected: FAIL (missing exports `TL_NEAREST`, `tlOutputName`, `trendlinesOutputs`; key order mismatch).

- [ ] **Step 3: Rewrite the leaf**

Replace the whole of `trendlinesOutputs.ts` with:

```ts
// The TRENDLINES pane's OUTPUT SHAPE and config parsing, split out of
// trendlines.ts as a leaf with no RUNTIME imports so exprInstances.ts can
// import it in a node context. Same split, same reason, as ./fvgOutputs.
//
// Mirrors Python indicators/trendlines.py (parse_trendlines_config,
// trendlines_outputs, trendlines_warmup), which is what the backend validates
// a rule reference against.

export const TL_ATR_LEN = 14;

/** DEFAULT for how many earlier pivots a new pivot pairs with; the live value
 * is cfg.pairPivots (calcParams[8]). ONE POOL holds highs and lows together,
 * so this reaches about half as far back in time as the old per-side 20 did,
 * which is why the default doubled. Counted in pivots, not bars: filtering
 * pivots out lets the same slots reach further back. */
export const MAX_PAIR_PIVOTS = 40;

/** Live state keeps this multiple of maxLines lines IN TOTAL, so a line that is
 * temporarily outranked is not destroyed and can return when it gains a touch.
 * Raising maxLines therefore also widens the candidate set a rule can see. */
export const MAX_LIVE_MULT = 4;

/** The nearest-to-price operand, the one output whose name does not carry a
 * rank. */
export const TL_NEAREST = "tl_nearest";

/** The ranked operand names: rank 1 is the strongest live line on that bar. */
export function tlOutputName(rank: number): string {
  return `tl_${rank}`;
}

/** The rule-operand names, in pane order. Config-driven: one per Max
 * Trendlines slot, then the nearest. The SAME strings as the backend's
 * trendlines_outputs. */
export function trendlinesOutputs(cfg: TrendlinesConfig): string[] {
  const out: string[] = [];
  for (let r = 1; r <= cfg.maxLines; r++) out.push(tlOutputName(r));
  out.push(TL_NEAREST);
  return out;
}

export interface TrendlinesConfig {
  pivotLen: number; // fractal lookback each side; confirm lag = this many bars
  // Touch tolerance as a multiple of ATR(14), on EITHER side of the line. 0 is
  // the strictest setting (a pivot must sit exactly on the line), not an off
  // switch.
  touchMult: number;
  minTouches: number; // touches before a line is major (2 = anchors only)
  minSpanBars: number; // minimum span before a line is major
  maxProjBars: number; // how far past its last touch a line stays live
  // Sizes live state (x MAX_LIVE_MULT) and is the number of ranked outputs
  // (tl_1 .. tl_maxLines) and the drawn budget.
  maxLines: number;
  // How far a pivot must stand out from the last pivot of the other kind, in
  // ATR(14), before it counts as a swing at all. 0 = off.
  minSwingAtr: number;
  // Bars a pivot must dominate to its LEFT, on top of the fractal window. 0 =
  // off, and so is anything <= pivotLen.
  minSwingReach: number;
  pairPivots: number; // earlier pivots (either kind) a new pivot pairs with
  maxTouches: number; // upper bound on touches; 0 = no limit
  maxSpanBars: number; // upper bound on span; 0 = no limit
  maxSlopeAtr: number; // ceiling on steepness, ATR(14) per bar; 0 = no limit
  minSlopeAtr: number; // floor on steepness, same units; 0 = no floor
  maxTouchSpacing: number; // widest gap between consecutive touches; 0 = no limit
  minTouchSpacing: number; // narrowest such gap; 0 = off
  // How many times the close must have changed side of the line, at least
  // (a floor a line can grow into) and at most (0 = no limit; a ceiling that
  // silences, like Max Touches).
  minCrossings: number;
  maxCrossings: number;
}

/** KEY ORDER IS THE calcParams ORDER (mtfCoordinator builds HTF params from
 * Object.values, the template's calcParams are Object.values, indicatorMeta
 * indexes by slot). Append, never insert. */
export const TRENDLINES_DEFAULTS: TrendlinesConfig = {
  pivotLen: 5,
  touchMult: 0.75,
  minTouches: 2,
  minSpanBars: 20,
  maxProjBars: 250,
  maxLines: 3,
  minSwingAtr: 0,
  minSwingReach: 0,
  pairPivots: MAX_PAIR_PIVOTS,
  maxTouches: 0,
  maxSpanBars: 0,
  maxSlopeAtr: 0,
  minSlopeAtr: 0,
  maxTouchSpacing: 0,
  minTouchSpacing: 0,
  minCrossings: 0,
  maxCrossings: 0,
};

/** Defaults for the render-only extendData flags. ONE source for the draw
 * path and indicatorMeta's `default`. */
export const TRENDLINES_EXTEND_DEFAULTS = {
  showPivots: false,
  showLinePivots: true,
} as const;

/** calcParams order: [pivotLen, touchMult, minTouches, minSpanBars,
 * maxProjBars, maxLines, minSwingAtr, minSwingReach, pairPivots, maxTouches,
 * maxSpanBars, maxSlopeAtr, minSlopeAtr, maxTouchSpacing, minTouchSpacing,
 * minCrossings, maxCrossings]. Mirrored by backend parse_trendlines_config.
 *
 * touchMult and minSwingAtr take ZERO (strictest touch rule; swing gate off),
 * so they validate on `>= 0`; every param with an off state at 0 (the
 * ceilings, the floors, the crossings range) does too. pivotLen, minSpanBars,
 * maxProjBars, maxLines, pairPivots keep the usual `> 0` rule and are floored
 * to at least 1. minTouches is floored to at least 2 (a line has two anchors).
 *
 * Number coercion: null, "" and [] coerce via Number() to 0, which passes the
 * `>= 0` rule; Python's float() raises for all three and returns the default.
 * That divergence is deliberate and tested on both sides. */
export function parseTrendlinesConfig(calcParams: unknown): TrendlinesConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = TRENDLINES_DEFAULTS;
  const numAt = (i: number, def: number, allowZero: boolean): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : def;
  };
  const intAt = (i: number, def: number): number => Math.max(1, Math.floor(numAt(i, def, false)));
  const zeroInt = (i: number, def: number): number => Math.max(0, Math.floor(numAt(i, def, true)));
  return {
    pivotLen: intAt(0, d.pivotLen),
    touchMult: numAt(1, d.touchMult, true),
    minTouches: Math.max(2, Math.floor(numAt(2, d.minTouches, false))),
    minSpanBars: intAt(3, d.minSpanBars),
    maxProjBars: intAt(4, d.maxProjBars),
    maxLines: intAt(5, d.maxLines),
    minSwingAtr: numAt(6, d.minSwingAtr, true),
    minSwingReach: zeroInt(7, d.minSwingReach),
    pairPivots: intAt(8, d.pairPivots),
    maxTouches: zeroInt(9, d.maxTouches),
    maxSpanBars: zeroInt(10, d.maxSpanBars),
    maxSlopeAtr: numAt(11, d.maxSlopeAtr, true),
    minSlopeAtr: numAt(12, d.minSlopeAtr, true),
    maxTouchSpacing: zeroInt(13, d.maxTouchSpacing),
    minTouchSpacing: zeroInt(14, d.minTouchSpacing),
    minCrossings: zeroInt(15, d.minCrossings),
    maxCrossings: zeroInt(16, d.maxCrossings),
  };
}

/** Bars before the first line can possibly exist: ATR(14) warm-up, plus the
 * two pivots that must confirm (pivotLen each), plus the span they must
 * cover. Every output shares it. minSwingReach is a left-window gate and is
 * deliberately left out (the floor is about the shape of the spec, not the
 * strictest reachable config). */
export function trendlinesWarmup(cfg: TrendlinesConfig): number {
  return TL_ATR_LEN + 2 * cfg.pivotLen + cfg.minSpanBars;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesOutputs.test.ts`
Expected: PASS. (`trendlines.ts` will not compile yet; that is Task 2 and 3. Do not run other test files.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesOutputs.ts frontend/src/lib/indicators/trendlinesOutputs.test.ts
git commit -m "feat(trendlines): sideless config leaf and ranked output names"
```

---

### Task 2: TS detector types and geometry gates

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (lines 1-540: header, types, helpers)
- Test: `frontend/src/lib/indicators/trendlines.test.ts` (top of file: fixtures; `describe` blocks `projectAt`, `pierces`, `inTouchBand`, `rankLines`, `isSignificantSwing`, `hasSwingReach`, `hasBackClearance`, `withinSlope`, `aboveSlope`)

**Interfaces:**
- Produces (all exported from `trendlines.ts`):
  ```ts
  export type PivotKind = "high" | "low";
  export interface TrendPivots { idxs: number[]; kinds: PivotKind[]; highs: number[]; lows: number[] }
  export function pivotPriceAt(pivots: TrendPivots, q: number): number;
  export interface TrendLine {
    i1: number; p1: number; k1: PivotKind;
    i2: number; p2: number; k2: PivotKind;
    touches: number; touchIdxs: number[]; touchKinds: PivotKind[];
    lastTouchIdx: number;
    crossings: number; lastSign: number;
    maxTouchGap: number; minTouchGap: number; maxTouchIdx: number;
  }
  export function projectAt(line: TrendLine, j: number): number;
  export function inTouchBand(line: TrendLine, j: number, price: number, tol: number): boolean;
  export function sideSign(line: TrendLine, j: number, close: number): -1 | 0 | 1;
  export function stepCrossing(line: TrendLine, j: number, close: number): void;
  export function rankLines(a: TrendLine, b: TrendLine): number;
  export function overCeilings(line: TrendLine, cfg: TrendlinesConfig): boolean;
  export function isMajor(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean;
  export function isSignificantSwing(highs, lows, oppositeTurns: readonly number[], k, kind: PivotKind, atrK, mult): boolean;
  export function hasSwingReach(vals, k, kind: PivotKind, bars): boolean;
  export function withinSlope / aboveSlope (unchanged);
  export function touchGaps (unchanged);
  export interface TrendlinesPoint { tl_nearest?: number; [rank: `tl_${number}`]: number | undefined }
  ```
  Removed: `TrendSide`, `pivotPrice`, `pierces`, `hasBackClearance`, `SIDES`, `brokenIdx`, `firstTouchIdx`.

- [ ] **Step 1: Write the failing tests**

In `trendlines.test.ts`, replace the fixture block at the top (the `res` / `sup` constants, ~lines 12-40) and the `describe` blocks `projectAt`, `pierces`, `inTouchBand`, `rankLines`, `hasBackClearance` with:

```ts
// A descending line through a high at bar 0 (100) and a LOW at bar 10 (90):
// the sideless shape this detector exists for. Its two kinds differ.
const mixed: TrendLine = {
  i1: 0, p1: 100, k1: "high",
  i2: 10, p2: 90, k2: "low",
  touches: 2, touchIdxs: [0, 10], touchKinds: ["high", "low"],
  lastTouchIdx: 10, crossings: 0, lastSign: 0,
  maxTouchGap: 10, minTouchGap: 10, maxTouchIdx: 10,
};

describe("projectAt", () => {
  it("interpolates between the anchors and extrapolates past them", () => {
    expect(projectAt(mixed, 0)).toBe(100);
    expect(projectAt(mixed, 10)).toBe(90);
    expect(projectAt(mixed, 5)).toBe(95);
    expect(projectAt(mixed, 20)).toBe(80);
  });
});

describe("inTouchBand", () => {
  it("is symmetric: the same distance above and below the line counts", () => {
    expect(inTouchBand(mixed, 5, 95.5, 0.5)).toBe(true);
    expect(inTouchBand(mixed, 5, 94.5, 0.5)).toBe(true);
    expect(inTouchBand(mixed, 5, 95.6, 0.5)).toBe(false);
    expect(inTouchBand(mixed, 5, 94.4, 0.5)).toBe(false);
  });
  it("at zero tolerance only a pivot on the line counts", () => {
    expect(inTouchBand(mixed, 5, 95, 0)).toBe(true);
    expect(inTouchBand(mixed, 5, 95.0001, 0)).toBe(false);
  });
});

describe("sideSign / stepCrossing", () => {
  it("reports which side of the line a close sits on, 0 exactly on it", () => {
    expect(sideSign(mixed, 5, 96)).toBe(1);
    expect(sideSign(mixed, 5, 94)).toBe(-1);
    expect(sideSign(mixed, 5, 95)).toBe(0);
  });
  it("counts a crossing only when the non-zero sign changes", () => {
    const l = { ...mixed, touchIdxs: [...mixed.touchIdxs], touchKinds: [...mixed.touchKinds] };
    stepCrossing(l, 1, 98); // below: baseline, no count
    expect([l.crossings, l.lastSign]).toEqual([0, -1]);
    stepCrossing(l, 2, 98.5); // still below
    expect(l.crossings).toBe(0);
    stepCrossing(l, 3, 97); // line is 97 here: on it, keeps the previous sign
    expect([l.crossings, l.lastSign]).toEqual([0, -1]);
    stepCrossing(l, 4, 99); // above: one crossing
    expect([l.crossings, l.lastSign]).toEqual([1, 1]);
    stepCrossing(l, 5, 90); // back below: two
    expect(l.crossings).toBe(2);
  });
});

describe("rankLines", () => {
  const base = mixed;
  it("prefers more touches, then a longer span, then fewer crossings", () => {
    const more = { ...base, touches: 3 };
    expect(rankLines(more, base)).toBeLessThan(0);
    const longer = { ...base, lastTouchIdx: 30 };
    expect(rankLines(longer, base)).toBeLessThan(0);
    const crossed = { ...base, crossings: 2 };
    expect(rankLines(base, crossed)).toBeLessThan(0);
  });
  it("breaks the remaining ties by recency, origin, then anchor price", () => {
    const a = { ...base, i1: 0, lastTouchIdx: 20 };
    const b = { ...base, i1: 5, lastTouchIdx: 25 }; // same span 20, more recent
    expect(rankLines(b, a)).toBeLessThan(0);
    const c = { ...base, i1: 0, i2: 10, p1: 50 };
    expect(rankLines(c, base)).toBeLessThan(0); // lower p1 first
    expect(rankLines(base, base)).toBe(0);
  });
});

describe("isMajor and overCeilings with crossings", () => {
  const cfgC = { ...TRENDLINES_DEFAULTS, minSpanBars: 5 };
  it("floors on Min Crossings and silences on Max Crossings", () => {
    const l = { ...mixed, crossings: 1 };
    expect(isMajor(l, 12, { ...cfgC, minCrossings: 2 })).toBe(false);
    expect(isMajor(l, 12, { ...cfgC, minCrossings: 1 })).toBe(true);
    expect(overCeilings({ ...l, crossings: 3 }, { ...cfgC, maxCrossings: 2 })).toBe(true);
    expect(overCeilings({ ...l, crossings: 2 }, { ...cfgC, maxCrossings: 2 })).toBe(false);
    expect(overCeilings(l, cfgC)).toBe(false); // 0 = no limit
  });
  it("has no broken clock: coverage ends Max Projection past the last touch", () => {
    expect(isMajor(mixed, 10 + cfgC.maxProjBars, cfgC)).toBe(true);
    expect(isMajor(mixed, 11 + cfgC.maxProjBars, cfgC)).toBe(false);
  });
});
```

Update the `isSignificantSwing` and `hasSwingReach` blocks: every `"resistance"` argument becomes `"high"` and every `"support"` becomes `"low"` (the semantics are unchanged: a high's leg runs to the last low turn and vice versa). Delete the `hasBackClearance` block entirely. Update the import list at the top of the test file to `{ computeTrendlines, inTouchBand, isMajor, isSignificantSwing, hasSwingReach, overCeilings, projectAt, rankLines, sideSign, stepCrossing, withinSlope, aboveSlope, type TrendLine }` plus whatever later tasks add (the file will not be green until Task 4; that is expected. In THIS task only run the blocks above with `-t`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t "projectAt|inTouchBand|sideSign|rankLines|isMajor and overCeilings"`
Expected: FAIL to compile (`sideSign`, `stepCrossing` missing; `TrendLine` has no `k1`).

- [ ] **Step 3: Rewrite the types and helpers**

In `trendlines.ts`:

1. Replace the file header comment's first paragraph with:
```ts
// TRENDLINES: major sloping lines through confirmed fractal pivots of EITHER
// kind. A line is two significant swings, high or low in any mix, that later
// swings land on within one symmetric tolerance. Price may cross a line freely;
// crossings are COUNTED (a filter and a label), never a fault, so there is no
// pierce rule and no broken state.
```
Keep the PARITY paragraphs (the cross-multiplication contract still holds; `pierces` in that text becomes `inTouchBand, sideSign`).

2. Replace `TrendSide`, `TrendPivots`, `pivotPrice`, `TrendLine`, `projectAt`, `pierces`, `inTouchBand`, `rankLines`, `TrendlinesPoint`, `SIDES`, `isLive`, `overCeilings`, `isMajor` with:

```ts
export type PivotKind = "high" | "low";

/** The pivots that PASSED the pivot filter, ONE POOL for both kinds in confirm
 * order (high before low when one bar is both). `idxs[q]` is the bar,
 * `kinds[q]` says whether its price is that bar's high or low. `highs`/`lows`
 * are REFERENCES to the detector's per-bar arrays, so carrying the pool costs
 * no allocation; under a timeframe pin every index here is an HTF bar index. */
export interface TrendPivots {
  idxs: number[];
  kinds: PivotKind[];
  highs: number[];
  lows: number[];
}

/** The price pool entry q turned at. */
export function pivotPriceAt(pivots: TrendPivots, q: number): number {
  const idx = pivots.idxs[q];
  return pivots.kinds[q] === "high" ? pivots.highs[idx] : pivots.lows[idx];
}

/** A line is two anchor pivots and NEVER rotates once defined. Later touches
 * move lastTouchIdx (coverage), never i2/p2. `k1`/`k2` record which extreme
 * each anchor is; no gate reads them (draw and MTF snapping do). */
export interface TrendLine {
  i1: number;
  p1: number;
  k1: PivotKind;
  i2: number; // i2 > i1 strictly
  p2: number;
  k2: PivotKind;
  touches: number;
  /** The bars that touched, INCLUDING the anchors (length === touches).
   * Insertion order, not bar order. DRAW-ONLY: no gate reads it. */
  touchIdxs: number[];
  /** Parallel to touchIdxs: which extreme of that bar touched. DRAW-ONLY, for
   * the coarser-pin snap (which chart candle carries the HTF extreme). */
  touchKinds: PivotKind[];
  lastTouchIdx: number; // seeded to i2, only ever moves forward
  /** Times the close has changed side of the line since i1. Detector state
   * (a gate and a rank key read it), so it is ported and part of parity. */
  crossings: number;
  /** Last NON-ZERO side the close sat on: 1 above, -1 below, 0 none yet. A
   * close exactly on the line keeps the previous sign. */
  lastSign: number;
  maxTouchGap: number; // widest gap between consecutive touches; only grows
  minTouchGap: number; // narrowest; only shrinks
  maxTouchIdx: number; // running maximum of touchIdxs
}

/** The line's price at bar j. The ONLY division in this module. */
export function projectAt(line: TrendLine, j: number): number {
  return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1);
}

/** True when `price` at bar j lies within `tol` of the line on EITHER side.
 * Cross-multiplied by the positive integer span, no quotient. */
export function inTouchBand(line: TrendLine, j: number, price: number, tol: number): boolean {
  const span = line.i2 - line.i1;
  const lhs = (price - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  const t = tol * span;
  return lhs >= rhs - t && lhs <= rhs + t;
}

/** Which side of the line the close sits on at bar j: 1 above, -1 below, 0
 * exactly on it. Same cross-multiplied form as inTouchBand. */
export function sideSign(line: TrendLine, j: number, close: number): -1 | 0 | 1 {
  const span = line.i2 - line.i1;
  const lhs = (close - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}

/** Fold bar j's close into the line's crossing count. The first non-zero sign
 * is the baseline and does not count; a zero keeps the previous sign. */
export function stepCrossing(line: TrendLine, j: number, close: number): void {
  const s = sideSign(line, j, close);
  if (s === 0) return;
  if (line.lastSign !== 0 && s !== line.lastSign) line.crossings += 1;
  line.lastSign = s;
}

/** Full deterministic ordering (Python rank_key sorts identically): most
 * touches, longest span, FEWEST crossings, most recent, oldest origin, lowest
 * anchor price. p1 is a STORED price, so ranking cannot depend on the bar. */
export function rankLines(a: TrendLine, b: TrendLine): number {
  if (a.touches !== b.touches) return b.touches - a.touches;
  const spanA = a.lastTouchIdx - a.i1;
  const spanB = b.lastTouchIdx - b.i1;
  if (spanA !== spanB) return spanB - spanA;
  if (a.crossings !== b.crossings) return a.crossings - b.crossings;
  if (a.lastTouchIdx !== b.lastTouchIdx) return b.lastTouchIdx - a.lastTouchIdx;
  if (a.i1 !== b.i1) return a.i1 - b.i1;
  return a.p1 - b.p1;
}

/** One calc row: the ranked operands plus the nearest. The template-literal
 * index lets `point[tlOutputName(r)]` type-check while `lines`/`pivots` on the
 * calc row stay outside the pattern. */
export interface TrendlinesPoint {
  tl_nearest?: number;
  [rank: `tl_${number}`]: number | undefined;
}

const KINDS: readonly PivotKind[] = ["high", "low"];

/** Live means not aged out past its projection horizon. */
function isLive(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  return i - line.lastTouchIdx <= cfg.maxProjBars;
}

/** True when a line has grown past one of the user's ceilings (Max Touches,
 * Max Span, Max Touch Spacing, Max Crossings) or under the Min Touch Spacing
 * floor. 0 means no limit. SILENCES rather than deletes: these quantities move
 * one way only, so the line can never re-qualify, and it stays in live state
 * so the touch pass still sees it. Also the live cap's first sort key. */
export function overCeilings(line: TrendLine, cfg: TrendlinesConfig): boolean {
  if (cfg.maxTouches > 0 && line.touches > cfg.maxTouches) return true;
  if (cfg.maxSpanBars > 0 && line.lastTouchIdx - line.i1 > cfg.maxSpanBars) return true;
  if (cfg.maxTouchSpacing > 0 && line.maxTouchGap > cfg.maxTouchSpacing) return true;
  if (cfg.minTouchSpacing > 0 && line.minTouchGap < cfg.minTouchSpacing) return true;
  if (cfg.maxCrossings > 0 && line.crossings > cfg.maxCrossings) return true;
  return false;
}

/** Major means: enough touches, enough span, enough crossings, and covering
 * this bar. The floors live here because a line can still grow into them. */
export function isMajor(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.touches < cfg.minTouches) return false;
  if (overCeilings(line, cfg)) return false;
  const span = line.lastTouchIdx - line.i1;
  if (span < cfg.minSpanBars) return false;
  if (line.crossings < cfg.minCrossings) return false;
  return i >= line.i1 && i <= line.lastTouchIdx + cfg.maxProjBars;
}
```

3. `isSignificantSwing(highs, lows, oppositeTurns, k, kind: PivotKind, atrK, mult)`: rename the `side` parameter to `kind` and the comparison to `kind === "high"`; the leg is `kind === "high" ? highs[k] - lows[h] : highs[h] - lows[k]`. Same for `hasSwingReach(vals, k, kind: PivotKind, bars)`: `kind === "high" ? vals[j] >= vals[k] : vals[j] <= vals[k]`.

4. Delete `pierces` and `hasBackClearance` (and their doc comments). Keep `touchGaps`, `withinSlope`, `aboveSlope` unchanged.

- [ ] **Step 4: Run the targeted tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t "projectAt|inTouchBand|sideSign|rankLines|isMajor and overCeilings|isSignificantSwing|hasSwingReach|withinSlope|aboveSlope"`
Expected: these PASS. The rest of the file still fails to compile against the old detector loop; Task 3 fixes that. If vitest refuses to run because the file does not compile, temporarily also apply Task 3's Step 3 before running, then continue.

- [ ] **Step 5: Commit** (only if the file compiles; otherwise fold into Task 3's commit)

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts
git commit -m "feat(trendlines): sideless line type, symmetric touch band, crossing counter"
```

---

### Task 3: TS detector loop, session and emission

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (`TlState`, `buildTlState`, `computeTrendlines`, `pivotsOf`, `stepTrendlinesBar`, `cloneTrendLine`, `advanceTlBar`, `createTrendlinesSession` fork)
- Test: `frontend/src/lib/indicators/trendlines.test.ts` (`describe("computeTrendlines")`, `describe("mixed-pivot touches")` (delete), `describe("windowed buildTlState")`, `describe("session compute floor")`)
- Test: `frontend/src/lib/indicators/trendlines.incremental.test.ts`

**Interfaces:**
- Consumes: Task 1 config, Task 2 types.
- Produces:
  ```ts
  interface TlState { startIdx; atr; highs; lows; closes: number[]; pool: { idxs: number[]; kinds: PivotKind[] }; turns: Record<PivotKind, number[]>; lines: TrendLine[]; points: TrendlinesPoint[] }
  export function buildTlState(dataList, m, cfg, startIdx = 0): TlState
  export function computeTrendlines(dataList, cfg): { points: TrendlinesPoint[]; lines: TrendLine[]; atr: number[]; pivots: TrendPivots }
  ```

- [ ] **Step 1: Write the failing tests**

Replace `describe("computeTrendlines", ...)` and delete `describe("mixed-pivot touches", ...)`. New block (the `bar`, `flat`, `cfg` helpers at the top of the file stay; `cfg()` must no longer set `minBackBars`, so edit it to `{ ...TRENDLINES_DEFAULTS, pivotLen: 2, minSpanBars: 5 }`):

```ts
describe("computeTrendlines", () => {
  it("returns one point per bar and emits nothing before warm-up", () => {
    const { points } = computeTrendlines(flat(30), cfg());
    expect(points).toHaveLength(30);
    expect(points[0]).toEqual({});
  });

  it("finds a rising line through two swing lows", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l).toBeDefined();
    expect([l!.k1, l!.k2, l!.p1, l!.p2]).toEqual(["low", "low", 90, 94]);
  });

  it("connects a swing HIGH to a later swing LOW: the sideless case", () => {
    // A high poking above the corridor at 20 and a low poking below at 40,
    // the line falls from 110 to 90. Price between them sits ~100, i.e. BELOW
    // the line near 20 and ABOVE it near 40, so it also crosses once.
    const bars = flat(60);
    bars[20] = bar(20, 99.5, 110);
    bars[40] = bar(40, 90, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l).toBeDefined();
    expect([l!.k1, l!.k2, l!.p1, l!.p2]).toEqual(["high", "low", 110, 90]);
    expect(l!.crossings).toBe(1);
  });

  it("never pairs a bar's own high with its own low (span would be 0)", () => {
    // A lone spike is a strict high AND a strict low pivot on one bar.
    const bars = flat(60);
    bars[20] = bar(20, 90, 110);
    bars[40] = bar(40, 92, 108);
    const { lines, pivots } = computeTrendlines(bars, cfg());
    // Both kinds of pivot at 20 exist, high first.
    const at20 = pivots.idxs.map((idx, q) => [idx, pivots.kinds[q]]).filter(([idx]) => idx === 20);
    expect(at20).toEqual([[20, "high"], [20, "low"]]);
    for (const l of lines) expect(l.i2).toBeGreaterThan(l.i1);
  });

  it("does not break a line when price runs far beyond it; it counts crossings", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 90, 100.5); // flat support-shaped line at 90
    for (let j = 60; j < 70; j++) bars[j] = bar(j, 80, 81); // close 80.5, far below
    for (let j = 70; j < 80; j++) bars[j] = bar(j, 99.5, 100.5); // back above
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l).toBeDefined();
    expect(l!.crossings).toBe(2); // above -> below at 60, below -> above at 70
  });

  it("counts a later pivot of EITHER kind within Max Touch Gap as a touch", () => {
    const bars = flat(100);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 90, 100.5);
    // A swing HIGH whose high lands on the line at 90.4 (ATR is 1, tol 0.75).
    for (let j = 55; j < 66; j++) bars[j] = bar(j, 85, 86);
    bars[60] = bar(60, 85, 90.4);
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l!.touches).toBe(3);
    expect(l!.touchIdxs).toContain(60);
    expect(l!.touchKinds[l!.touchIdxs.indexOf(60)]).toBe("high");
    expect(l!.lastTouchIdx).toBe(60);
  });

  it("emits tl_1..tl_N by rank and tl_nearest by distance to the close", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5); // rising line, projects ABOVE the close later
    bars[25] = bar(25, 99.5, 108);
    bars[45] = bar(45, 99.5, 104); // falling line
    const c = { ...cfg(), maxLines: 2 };
    const { points, lines } = computeTrendlines(bars, c);
    const last = points[79];
    const majors = lines.filter((l) => isMajor(l, 79, c)).sort(rankLines);
    expect(majors.length).toBeGreaterThanOrEqual(2);
    expect(last.tl_1).toBe(projectAt(majors[0], 79));
    expect(last.tl_2).toBe(projectAt(majors[1], 79));
    expect(last.tl_3).toBeUndefined();
    const close = bars[79].close;
    const nearest = majors.reduce((b, l) =>
      Math.abs(projectAt(l, 79) - close) < Math.abs(projectAt(b, 79) - close) ? l : b);
    expect(last.tl_nearest).toBe(projectAt(nearest, 79));
  });

  it("stops projecting past Max Projection", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const c = { ...cfg(), maxProjBars: 30 };
    const { points } = computeTrendlines(bars, c);
    expect(points[70].tl_1).toBeDefined(); // 40 + 30
    expect(points[71].tl_1).toBeUndefined();
  });

  it("is causal: a prefix computes the same values as the full series", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 99.5, 108);
    const full = computeTrendlines(bars, cfg()).points;
    const pre = computeTrendlines(bars.slice(0, 80), cfg()).points;
    for (let i = 0; i < 80; i++) expect(pre[i]).toEqual(full[i]);
  });

  it("caps live state at MAX_LIVE_MULT x maxLines in total", () => {
    // A zigzag with many pivots seeds far more than the cap.
    const bars = flat(400).map((b, i) =>
      bar(i, 99.5 + Math.sin(i / 3) * 4, 100.5 + Math.sin(i / 3) * 4));
    const c = { ...cfg(), maxLines: 1, minSpanBars: 3 };
    const { lines } = computeTrendlines(bars, c);
    expect(lines.length).toBeLessThanOrEqual(MAX_LIVE_MULT * c.maxLines);
  });
});
```

Add `MAX_LIVE_MULT` and `TRENDLINES_DEFAULTS` to the imports from `./trendlinesOutputs`, and `isMajor`, `rankLines`, `projectAt` from `./trendlines`.

In `trendlines.incremental.test.ts`, replace every read of `.tl_support` / `.tl_resistance` / `.tl_broken_*` with `.tl_1` and `.tl_nearest`, every `l.side` filter is deleted, and `brokenIdx` assertions are removed. Its intent (session per-tick result equals from-scratch `computeTrendlines`) stays.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t computeTrendlines`
Expected: FAIL (old loop still references `side`, `brokenIdx`).

- [ ] **Step 3: Rewrite state, loop and emission**

Replace `TlState`, `buildTlState`, `computeTrendlines`, `pivotsOf`, `stepTrendlinesBar`, `cloneTrendLine` with:

```ts
interface TlState {
  startIdx: number;
  atr: Array<number | null>;
  highs: number[];
  lows: number[];
  closes: number[];
  /** Filter-passing pivots of BOTH kinds, in confirm order (high before low
   * within a bar). What may seed or touch a line. */
  pool: { idxs: number[]; kinds: PivotKind[] };
  /** EVERY confirmed fractal pivot per kind, including the ones the size and
   * reach gates reject, because the Min Pivot Size leg runs to the previous
   * turn of the other kind whether or not that turn was big enough to trade. */
  turns: Record<PivotKind, number[]>;
  lines: TrendLine[];
  points: TrendlinesPoint[];
}

export function buildTlState(
  dataList: KLineData[],
  m: number,
  cfg: TrendlinesConfig,
  startIdx = 0,
): TlState {
  const prefix = m === dataList.length ? dataList : dataList.slice(0, m);
  const atr: Array<number | null> =
    startIdx > 0 ? new Array(m).fill(null) : atrSeries(prefix, TL_ATR_LEN);
  if (startIdx > 0) {
    const windowed = atrSeries(prefix.slice(startIdx), TL_ATR_LEN);
    for (let i = 0; i < windowed.length; i++) atr[startIdx + i] = windowed[i];
  }
  const st: TlState = {
    startIdx,
    atr,
    highs: prefix.map((d) => d.high),
    lows: prefix.map((d) => d.low),
    closes: prefix.map((d) => d.close),
    pool: { idxs: [], kinds: [] },
    turns: { high: [], low: [] },
    lines: [],
    points: Array.from({ length: m }, () => ({})),
  };
  for (let i = startIdx; i < m; i++) stepTrendlinesBar(st, i, cfg);
  return st;
}

export function computeTrendlines(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
): { points: TrendlinesPoint[]; lines: TrendLine[]; atr: number[]; pivots: TrendPivots } {
  const n = dataList.length;
  if (n === 0)
    return { points: [], lines: [], atr: [], pivots: { idxs: [], kinds: [], highs: [], lows: [] } };
  const st = buildTlState(dataList, n, cfg);
  return { points: st.points, lines: st.lines, atr: st.atr as number[], pivots: pivotsOf(st) };
}

function pivotsOf(st: TlState): TrendPivots {
  return { idxs: st.pool.idxs, kinds: st.pool.kinds, highs: st.highs, lows: st.lows };
}

/** One bar of the detector. Reads/writes state only at indices <= i (causal),
 * which the incremental session relies on. Ported line for line to Python. */
function stepTrendlinesBar(st: TlState, i: number, cfg: TrendlinesConfig): void {
  const { atr, highs, lows, closes, pool, turns, points } = st;
  let lines = st.lines;
  const a = atr[i];

  // 1. PER-BAR crossing step for every existing line. Every line here was
  //    seeded at an earlier confirm bar and has consumed closes through it, so
  //    this bar is the next one. Needs no ATR.
  for (const line of lines) stepCrossing(line, i, closes[i]);

  // 2. CONFIRM-BAR work for the pivot at bar k = i - pivotLen.
  const k = i - cfg.pivotLen;
  if (k >= 0 && a !== null) {
    for (const kind of KINDS) {
      const vals = kind === "high" ? highs : lows;
      if (!isPivotAt(vals, k, cfg.pivotLen, cfg.pivotLen, kind, true)) continue;
      turns[kind].push(k);
      // Size gate first, so a rejected bar is not a pivot in any sense. atr[k],
      // not atr[i]: measured where the swing happened. Whole block behind
      // minSwingAtr > 0 so that off means untouched.
      if (cfg.minSwingAtr > 0) {
        const atrK = atr[k];
        if (atrK === null) continue;
        const opposite = turns[kind === "high" ? "low" : "high"];
        if (!isSignificantSwing(highs, lows, opposite, k, kind, atrK, cfg.minSwingAtr)) continue;
      }
      if (!hasSwingReach(vals, k, kind, cfg.minSwingReach)) continue;
      const price = vals[k];

      // 2a. Test the new pivot against every existing line, whatever kind
      //     either is. `k > line.i2` keeps the gap bookkeeping O(1): pivots
      //     confirm in bar order, so k is right of every recorded touch.
      const tolA = atr[k];
      if (tolA !== null) {
        for (const line of lines) {
          if (k <= line.i2) continue;
          if (inTouchBand(line, k, price, cfg.touchMult * tolA)) {
            line.touches += 1;
            line.touchIdxs.push(k);
            line.touchKinds.push(kind);
            const gap = k - line.maxTouchIdx;
            if (gap > line.maxTouchGap) line.maxTouchGap = gap;
            if (gap < line.minTouchGap) line.minTouchGap = gap;
            line.maxTouchIdx = k;
            line.lastTouchIdx = k;
          }
        }
      }

      // 2b. Seed candidates against the previous pairPivots pool entries, of
      //     either kind. The pool push happens AFTER this loop.
      const from = Math.max(0, pool.idxs.length - cfg.pairPivots);
      for (let q = from; q < pool.idxs.length; q++) {
        const i1 = pool.idxs[q];
        // A bar's own high and low confirm together and would give span 0.
        if (i1 >= k) continue;
        const k1 = pool.kinds[q];
        const p1 = k1 === "high" ? highs[i1] : lows[i1];
        const cand: TrendLine = {
          i1, p1, k1,
          i2: k, p2: price, k2: kind,
          touches: 2,
          touchIdxs: [i1, k],
          touchKinds: [k1, kind],
          lastTouchIdx: k,
          crossings: 0,
          lastSign: 0,
          maxTouchGap: k - i1,
          minTouchGap: k - i1,
          maxTouchIdx: k,
        };
        // Slope first: one comparison, asked once because the line never
        // rotates.
        if (cfg.maxSlopeAtr > 0 || cfg.minSlopeAtr > 0) {
          const atrK = atr[k];
          if (atrK === null) continue;
          if (!withinSlope(cand, atrK, cfg.maxSlopeAtr)) continue;
          if (!aboveSlope(cand, atrK, cfg.minSlopeAtr)) continue;
        }
        // Crossings over (i1, i]: the closes between the anchors and since the
        // second anchor, all of which have already happened.
        for (let j = i1 + 1; j <= i; j++) stepCrossing(cand, j, closes[j]);
        // Retro touches: pool entries strictly between the anchors, of either
        // kind. The pool is in bar order and i1 IS pool.idxs[q], so the window
        // starts at q + 1 and ends at the first entry reaching k. An entry AT
        // i1 (the other extreme of the anchor bar) is not a touch.
        for (let q2 = q + 1; q2 < pool.idxs.length; q2++) {
          const pj = pool.idxs[q2];
          if (pj >= k) break;
          if (pj === i1) continue;
          const tolP = atr[pj];
          if (tolP === null) continue;
          const kj = pool.kinds[q2];
          const pv = kj === "high" ? highs[pj] : lows[pj];
          if (inTouchBand(cand, pj, pv, cfg.touchMult * tolP)) {
            cand.touches += 1;
            cand.touchIdxs.push(pj);
            cand.touchKinds.push(kj);
          }
        }
        // Recomputed once every seed-time touch is in (touchIdxs is not in
        // bar order; touchGaps sorts a copy).
        const seedGaps = touchGaps(cand.touchIdxs);
        cand.maxTouchGap = seedGaps.widest;
        cand.minTouchGap = seedGaps.narrowest;
        cand.maxTouchIdx = cand.i2;
        lines.push(cand);
      }
      pool.idxs.push(k);
      pool.kinds.push(kind);
    }

    // 3. Prune the dead, then cap live state by rank, IN TOTAL. Ceiling-failed
    //    lines sort last: they can never re-qualify, and rankLines would
    //    otherwise hand them the front of the queue.
    if (lines.some((l) => !isLive(l, i, cfg))) lines = lines.filter((l) => isLive(l, i, cfg));
    const cap = MAX_LIVE_MULT * cfg.maxLines;
    if (lines.length > cap) {
      lines.sort(
        (x, y) => Number(overCeilings(x, cfg)) - Number(overCeilings(y, cfg)) || rankLines(x, y),
      );
      lines = lines.slice(0, cap);
    }
  }

  // 4. Emit: the live majors in rank order fill tl_1..tl_maxLines; the one
  //    nearest the close fills tl_nearest (ties to the better rank, since the
  //    walk is in rank order and only a STRICTLY nearer line displaces).
  const close = closes[i];
  const point: TrendlinesPoint = {};
  const majors = lines.filter((l) => isLive(l, i, cfg) && isMajor(l, i, cfg));
  majors.sort(rankLines);
  let nearestV = 0;
  let nearestD = Infinity;
  for (let r = 0; r < majors.length; r++) {
    const v = projectAt(majors[r], i);
    if (r < cfg.maxLines) point[tlOutputName(r + 1) as `tl_${number}`] = v;
    const d = Math.abs(v - close);
    if (d < nearestD) {
      nearestD = d;
      nearestV = v;
    }
  }
  if (majors.length) point.tl_nearest = nearestV;
  points[i] = point;
  st.lines = lines;
}

const cloneTrendLine = (l: TrendLine): TrendLine => ({
  ...l,
  touchIdxs: l.touchIdxs.slice(),
  touchKinds: l.touchKinds.slice(),
});
```

Then:
- `advanceTlBar`: add `st.closes[i] = dataList[i].close;` beside the highs/lows writes and call `stepTrendlinesBar(st, i, cfg)` (no `dataList` argument).
- In `createTrendlinesSession`, the fork becomes:
  ```ts
  pool: { idxs: b.pool.idxs.slice(), kinds: b.pool.kinds.slice() },
  turns: { high: b.turns.high.slice(), low: b.turns.low.slice() },
  lines: b.lines.map(cloneTrendLine),
  ```
  and the base state's `closes` array is shared like `highs`/`lows` (index n-1 is the scratch slot the next tick overwrites). Wherever the session builds an empty state for `n === 0`, add `closes: []`, `pool: { idxs: [], kinds: [] }`, `turns: { high: [], low: [] }`.
- Import `tlOutputName` from `./trendlinesOutputs`.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t "computeTrendlines|windowed buildTlState|session compute floor" && npx vitest run src/lib/indicators/trendlines.incremental.test.ts`
Expected: PASS. If `windowed buildTlState` / `session compute floor` blocks reference `tl_support` or `side`, apply the same substitutions as in the incremental test (`tl_1`, no side filter).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts frontend/src/lib/indicators/trendlines.incremental.test.ts
git commit -m "feat(trendlines): shared pivot pool, crossing count, ranked emission"
```

---

### Task 4: TS draw path, selection, MTF alignment, template

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (everything after the session: `TrendlinesMtf`, `TrendlinesExtend`, `lineKey`, `sharesPivot`, `dropDuplicates`, `selectDrawnLines`, colours, `lineExtent`, `alignMtfTrendlines`, `htfExtremeSnap`, `paintPivotMarks`, `drawTrendlines`, `TRENDLINES_TEMPLATE`)
- Test: `frontend/src/lib/indicators/trendlines.test.ts` (remaining blocks), `trendlines.clip.test.ts`, `trendlinesMtf.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TL_LINE_COLOR = "#3b82f6";
  export interface TrendlinesMtf extends MtfSeriesBase { htfStarts?; htfMs?; htfOutputs?: string[]; htfPoints?: TrendlinesPoint[]; htfLines?; htfPivots?; htfAtr? }
  export function lineKey(line, dataList, starts?): string  // `${t1}:${t2}`
  export function selectDrawnLines(lines, atIdx, close, maxLines, emitted: TrendlinesPoint, dedupe, nearTol = 0): TrendLine[]
  export function lineExtent(line, mode, cfg, drawn, lastIdx, pinnedEdge)  // mode: "ray"|"segment"|"extended"|"cross"|"lastbar"
  export function alignMtfTrendlines(dataList, mtf): TrendlinesCalcPoint[]
  ```
  `TrendlinesExtend.extend` loses `"apex"`; `hideBroken` and `dimBroken` are removed from the interface.

- [ ] **Step 1: Update the tests**

In `trendlines.test.ts`:
- `describe("selectDrawnLines")`: rewrite to the new contract. Replace the block with:

```ts
describe("selectDrawnLines", () => {
  const mk = (i1: number, i2: number, p1: number, p2: number, touches = 2): TrendLine => ({
    i1, p1, k1: "low", i2, p2, k2: "low", touches,
    touchIdxs: [i1, i2], touchKinds: ["low", "low"], lastTouchIdx: i2,
    crossings: 0, lastSign: 0, maxTouchGap: i2 - i1, minTouchGap: i2 - i1, maxTouchIdx: i2,
  });
  const strong = mk(0, 40, 100, 100, 5);
  const mid = mk(0, 40, 90, 90, 3);
  const weak = mk(0, 40, 80, 80, 2);
  const lines = [weak, strong, mid];

  it("draws the top maxLines by rank, in rank order", () => {
    expect(selectDrawnLines(lines, 50, 79, 2, {}, null)).toEqual([strong, mid]);
  });
  it("adds back a line an operand reads even when it falls outside the budget", () => {
    const emitted = { tl_nearest: projectAt(weak, 50) };
    expect(selectDrawnLines(lines, 50, 79, 1, emitted, null)).toEqual([strong, weak]);
  });
  it("keeps a pinned line whatever its rank", () => {
    expect(selectDrawnLines(lines, 50, 79, 1, {}, { tol: 0, keep: new Set([weak]) })).toEqual([strong, weak]);
  });
  it("cuts lines far from price when nearTol is set, never the first", () => {
    // close 79: weak (80) is 1 away, strong (100) 21, mid (90) 11.
    expect(selectDrawnLines(lines, 50, 79, 3, {}, null, 5)).toEqual([strong, weak]);
  });
  it("merges near-twins through a shared pivot before the budget", () => {
    const twin = { ...mid, i1: 0, p1: 90, i2: 40, p2: 90.5, touches: 3 };
    const out = selectDrawnLines([strong, mid, twin], 50, 79, 3, {}, { tol: 1, keep: new Set() });
    expect(out).toEqual([strong, mid]);
  });
});
```
- `describe("selectDrawnLines dedup")`: keep the tests about `dedupeTolerance` and shared-pivot merging; delete every case that mentions `broken`, `wantBroken`, `tl_support`, `tl_resistance`. Where a test builds a `TrendLine` literal, use the `mk` shape above (no `side`, no `brokenIdx`, no `firstTouchIdx`; add `k1`, `k2`, `touchKinds`, `crossings`, `lastSign`).
- `describe("TRENDLINES_TEMPLATE")`: `calcParams` expectation becomes `Object.values(TRENDLINES_DEFAULTS)`; reads of `tl_support` become `tl_1`.
- `describe("TRENDLINES_TEMPLATE.draw")`: colour assertions (`#26a69a` / `#ef5350`) become `TL_LINE_COLOR`; label assertions `×N` stay; add one case: a line with `crossings: 2` labels `×2 ⇅2`; drop dashed-stroke and `hideBroken` / `dimBroken` cases.
- Delete `describe("TRENDLINES_TEMPLATE.draw break marker and meeting modes")` cases about the break dot; keep the `cross` and `lastbar` meeting cases; delete `apex` cases.
- `describe("lineKey")`: expected key is `` `${t1}:${t2}` `` (no side prefix).
- `describe("lineExtent")`: `jLeft` is `line.i1` (or `i1 - maxProjBars` in `extended`); no `firstTouchIdx`. Delete `describe("lineExtent with mixed touches")`.
- `describe("TRENDLINES pivot marks")` / `("TRENDLINES line-pivot marks")`: pivots are `{ idxs, kinds, highs, lows }`; a low pivot's mark points up, a high's down, both in `TL_LINE_COLOR`.
- In `trendlinesMtf.test.ts` and `trendlines.clip.test.ts`: MTF stashes are `htfOutputs: ["tl_1", ..., "tl_nearest"]` and `htfPoints: TrendlinesPoint[]`; reads of `tl_support` become `tl_1`; `side` fields are removed from any `TrendLine` literal.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/indicators/trendlines.clip.test.ts`
Expected: FAIL (old draw path).

- [ ] **Step 3: Rewrite the draw-side code**

In `trendlines.ts`:

1. `TrendlinesMtf`: replace the four `htf*` arrays with
```ts
  htfOutputs?: string[]; // trendlinesOutputs(cfg) at build time
  htfPoints?: TrendlinesPoint[]; // one calc row per HTF bar
```
2. `TrendlinesExtend`: `extend?: "ray" | "segment" | "extended" | "cross" | "lastbar";` delete `hideBroken` and `dimBroken` with their comments.
3. `lineKey`: `return \`${t1}:${t2}\`;`
4. `TrendlinesCalcPoint` stays `TrendlinesPoint & { lines?; atr?; pivots?; lineIdx? }`.
5. `sharesPivot`: unchanged logic; drop the "sides never merge" sentence.
6. `dropDuplicates(entries, dedupe, emittedVals: ReadonlySet<number>)`: `exempt = emittedVals.has(e.proj) || keep.has(e.line)`.
7. `selectDrawnLines`:
```ts
export function selectDrawnLines(
  lines: TrendLine[],
  atIdx: number,
  close: number,
  maxLines: number,
  emitted: TrendlinesPoint,
  dedupe: TrendlineDedupe | null,
  nearTol = 0,
): TrendLine[] {
  // The emitted values on this bar: any line projecting to one of them is a
  // line an operand is reading and must be drawn (exact match: the emitted
  // number IS projectAt's result on the same bar).
  const emittedVals = new Set<number>();
  for (const v of Object.values(emitted)) if (typeof v === "number") emittedVals.add(v);
  const ranked: DrawEntry[] = lines
    .map((l) => {
      const proj = projectAt(l, atIdx);
      return { line: l, proj, dist: Math.abs(proj - close) };
    })
    .sort((x, y) => rankLines(x.line, y.line));
  const kept = dedupe ? dropDuplicates(ranked, dedupe, emittedVals) : ranked;
  // Distance cut: keeps the top-ranked line always, so the pane never blanks.
  const near =
    nearTol > 0
      ? kept.filter((e, idx) =>
          idx === 0 || e.dist <= nearTol || dedupe?.keep.has(e.line) || emittedVals.has(e.proj))
      : kept;
  const out: TrendLine[] = [];
  near.forEach((e, idx) => {
    if (idx < maxLines || dedupe?.keep.has(e.line) || emittedVals.has(e.proj)) out.push(e.line);
  });
  return out;
}
```
8. Colours: `export const TL_LINE_COLOR = "#3b82f6";` replacing both side colours; delete `TL_BREAK_RADIUS`.
9. `lineExtent`: `const jLeft = mode === "extended" ? line.i1 - cfg.maxProjBars : line.i1;` `const jEnd = line.lastTouchIdx;` the `apex || cross` branch becomes `if (mode === "cross") { const others = drawn.filter((o) => o !== line); ... }`.
10. `alignMtfTrendlines`:
```ts
  const outputs = mtf.htfOutputs ?? [];
  const rows = mtf.htfPoints ?? [];
  const aligned = outputs.map((name) =>
    alignHtfToChart(ts, htfBars, rows.map((p) => p[name as `tl_${number}`]), htfMs, true, mtf.formingIdx, mtf.chartMs));
  const out: TrendlinesCalcPoint[] = ts.map((_, i) => {
    const row: TrendlinesPoint = {};
    outputs.forEach((name, o) => {
      const v = aligned[o][i];
      if (v !== undefined) row[name as `tl_${number}`] = v;
    });
    return row;
  });
```
(the rest of the function, computing `lineIdx`, is unchanged).
11. `htfExtremeSnap(...)`: returns `(j: number, kind: PivotKind) => number`; `key = j * 2 + (kind === "low" ? 0 : 1)`; the extreme scan uses `kind === "low" ? dataList[i].low : dataList[i].high`.
12. `paintPivotMarks(ctx, pivots, xAt: (j, kind) => number, yOf, right, height, used, showAll, showLineUsed)`: `ctx.fillStyle = TL_LINE_COLOR` once; loop `for (const stemmed of [true, false])` then `for (let q = 0; q < pivots.idxs.length; q++) { const idx = pivots.idxs[q]; const kind = pivots.kinds[q]; const dir = kind === "low" ? 1 : -1; ... y = yOf(pivotPriceAt(pivots, q)); x = xAt(idx, kind); ... }`. One `ctx.fill()` per stemmed/plain batch.
13. `drawTrendlines`:
   - delete `hideBroken`; `eligible = last.lines.filter((l) => isMajor(l, lastIdx, cfg))`.
   - `xAtPivot = (j, kind: PivotKind) => snap ? xAxis.convertToPixel(snap(j, kind)) : xAt(j)`.
   - per line: `const kindAt = (j: number): PivotKind | null => { const t = line.touchIdxs.indexOf(j); return t >= 0 ? line.touchKinds[t] : null; }; const xAtLine = (j) => { const kd = kindAt(j); return kd ? xAtPivot(j, kd) : xAt(j); };`
   - `alpha = trendlineDimmed(line, lastIdx, ext) ? trendlineDimAlpha(ext) : 1;`
   - `ctx.strokeStyle = TL_LINE_COLOR;` no `setLineDash` / `lineDashOffset`; delete the whole `if (broken) { ... }` break-dot block and every `broken` variable.
   - touch rings: `const xT = xAtPivot(idx, line.touchKinds[t])` iterating with index `t`.
   - label: `const label = line.crossings > 0 ? \`×${line.touches} ⇅${line.crossings}\` : \`×${line.touches}\`;`
14. `TRENDLINES_TEMPLATE.calcParams: Object.values(TRENDLINES_DEFAULTS)`.
15. Remove every remaining `TrendSide` / `SIDES` / `pivotPrice` / `brokenIdx` / `firstTouchIdx` reference (`grep -n "TrendSide\|SIDES\|pivotPrice(\|brokenIdx\|firstTouchIdx\|apex" frontend/src/lib/indicators/trendlines.ts` must print nothing).

- [ ] **Step 4: Typecheck and run**

Run: `cd frontend && npx tsc -b 2>&1 | grep "indicators/trendlines" ; npx vitest run src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/indicators/trendlines.clip.test.ts`
Expected: no `trendlines.ts` type errors; the three files PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts frontend/src/lib/indicators/trendlinesMtf.test.ts frontend/src/lib/indicators/trendlines.clip.test.ts
git commit -m "feat(trendlines): one colour, ranked drawn set, crossings label, sideless MTF"
```

---

### Task 5: Frontend consumers (settings meta, expr, MTF coordinator)

**Files:**
- Modify: `frontend/src/lib/indicatorMeta.ts:176-206` (TL defaults/presets), the TRENDLINES `inputs` block (~lines 600-1020)
- Modify: `frontend/src/lib/exprInstances.ts:277-283, 358-370`
- Modify: `frontend/src/lib/exprChartToken.ts:157-173`
- Modify: `frontend/src/lib/mtfCoordinator.ts:1134-1152`
- Test: `frontend/src/lib/trendlines.register.test.ts`, `frontend/src/lib/exprChartToken.test.ts:196-240`, `frontend/src/lib/mtfCoordinator.test.ts:340-440`

**Interfaces:**
- Consumes: `trendlinesOutputs(cfg)`, `parseTrendlinesConfig`, `TRENDLINES_DEFAULTS`, `TrendlinesPoint`.

- [ ] **Step 1: Update the tests**

`trendlines.register.test.ts`:
- "has settings metadata ..." becomes: `expect(inputs.filter((i) => i.source === "calcParam")).toHaveLength(17);` and `expect(inputs.filter((i) => i.type === "number")).toHaveLength(21);` (17 calcParams + dedupeAtr + dimOpacity + dimTouches + dimStaleBars).
- The paired-rows expectation becomes:
```ts
    expect(chunks.map((c) => c.map((i) => i.label))).toEqual([
      ["Max Trendlines"],
      ["Min Pivot Length", "Max Pivot Pairs"],
      ["Min Pivot Size", "Min Pivot Reach"],
      ["Max Touch Gap"],
      ["Min Touches", "Max Touches"],
      ["Min Span", "Max Span"],
      ["Min Touch Spacing", "Max Touch Spacing"],
      ["Min Slope", "Max Slope"],
      ["Min Crossings", "Max Crossings"],
      ["Max Projection"],
      ["Extend"],
      ["Declutter"],
      ["Show pivots", "Mark line pivots"],
      ["Dim opacity"],
      ["Dim after touching"],
      ["Dim if untouched for"],
      ["Merge Lines within"],
    ]);
```
- "gives Pivot Size a default" finds `index === 6`.
- "is a referenceable expression instance exposing four outputs" becomes "...exposing tl_1..tl_N and tl_nearest": `expect(inst.outputs).toEqual(["tl_1", "tl_2", "tl_3", "tl_nearest"]);` and add `const nine = exprInstancesFor([{ id: "t", type: "TRENDLINES", calcParams: [5, 0.75, 2, 20, 250, 9], extendData: {} }] as never)[0]; expect(nine.outputs).toHaveLength(10);`.
- Replace `TRENDLINES_OUTPUTS` import with `trendlinesOutputs, TRENDLINES_DEFAULTS`.

`exprChartToken.test.ts` TRENDLINES block: `"TRENDLINES.tl_support"` becomes `"TRENDLINES.tl_1"`, the explicit figureKey case uses `"tl_nearest"` and expects `"TRENDLINES.tl_nearest"`; an unknown key (`"tl_support"`) expects `"TRENDLINES.tl_1"`. The 8-param case (`[9, 0, 1.5, 3, 40, 100, 10, 6]`) expects `"TRENDLINES.tl_1"`.

`mtfCoordinator.test.ts`: `toHaveLength(19)` becomes `17`; the two slot pins become `expect(Object.values(TRENDLINES_DEFAULTS)[15]).toBe(0); // minCrossings` and `[16]` `// maxCrossings`; `MAX_PAIR_PIVOTS` stays imported. Any stash assertion on `htfSupport` becomes `htfPoints` / `htfOutputs`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/trendlines.register.test.ts src/lib/exprChartToken.test.ts src/lib/mtfCoordinator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update the consumers**

`indicatorMeta.ts`:
- `TL_DEFAULT_PARAMS = Object.values(TL) as number[]` (delete the hand-written list).
- Presets:
```ts
    tlPreset("Clean", { 5: 2, 2: 3, 3: 40, 6: 0.75 }),
    tlPreset("Balanced", {}),
    tlPreset("Busy", { 5: 8, 3: 10 }),
```
- TRENDLINES `inputs`: re-index every `num(<slot>, ...)` to the new slots (0 pivotLen, 1 touchMult, 2 minTouches, 3 minSpanBars, 4 maxProjBars, 5 maxLines, 6 minSwingAtr, 7 minSwingReach, 8 pairPivots, 9 maxTouches, 10 maxSpanBars, 11 maxSlopeAtr, 12 minSlopeAtr, 13 maxTouchSpacing, 14 minTouchSpacing). Delete the rows `Max Pierce`, `Min Back Clearance`, `Mix Low and High Pivots`, `Max Break Hold`, `Hide broken lines`, `Dim broken lines`. `Max Pivot Pairs` `default: 40`, tip: `["How many earlier pivots a new pivot tries to pair a line with, highs and lows together.", "Counted in pivots, not bars, so filtering pivots out lets the same slots reach further back."]`. `Max Touch Gap` tip: `["How far a pivot may sit from a line, above or below, and still count as a touch, in ATR(14).", "Zero: only a pivot exactly on the line counts."]`. Remove the "Mixed touches count too" lines from the Spacing tips and the "Once price breaks a line" line from Max Projection. Add after the Slope pair:
```ts
      {
        ...num(15, "Min Crossings", { min: 0 }),
        group: "cross",
        default: 0,
        suffix: "times",
        range: {
          label: "Crossings",
          tip: [
            "How many times the close must have crossed the line, at least and at most.",
            "A line price never crosses is a clean trend edge; one it crosses often is a pivot line price keeps returning to.",
            "Empty right box: no limit.",
          ],
        },
        tip: ["Min times the close must have crossed the line. Zero: no floor."],
      },
      {
        ...num(16, "Max Crossings", { min: 0 }),
        group: "cross",
        default: 0,
        unbounded: true,
        suffix: "times",
        tip: ["Max times the close may have crossed the line. Empty: no limit."],
      },
```
- Extend options: delete the `apex` entry.
- `desc`: `"Sloping lines through confirmed swing highs and lows, in any mix: a line is two significant swings that later swings land on. Price may cross a line; the count of crossings is shown beside the touch count and can be filtered. The strongest lines are drawn and tagged. Pivots confirm a few bars late, so nothing repaints."`

`exprInstances.ts`:
- warm-up branch: `if (inst.type === "TRENDLINES") { const cfg = parseTrendlinesConfig(inst.calcParams); return trendlinesOutputs(cfg).includes(output) ? trendlinesWarmup(cfg) : 0; }`
- instance branch: `outputs: trendlinesOutputs(cfg),` and `detail: \`pivot ${cfg.pivotLen} · span ${cfg.minSpanBars}+ · touches ${cfg.minTouches}+ · ${cfg.maxLines} ranked\``.
- Import `trendlinesOutputs` instead of `TRENDLINES_OUTPUTS`.

`exprChartToken.ts` TRENDLINES case:
```ts
    case "TRENDLINES": {
      const id = opts?.instanceId;
      if (!id) return null;
      const outs = trendlinesOutputs(parseTrendlinesConfig(calcParams));
      const key = opts?.figureKey;
      const output = key && outs.includes(key) ? key : outs[0];
      return `${id}.${output}`;
    }
```
(`calcParams` is the function's second parameter; import `parseTrendlinesConfig, trendlinesOutputs`.)

`mtfCoordinator.ts` `buildTrendlinesMtf`:
```ts
  const { points, lines, atr, pivots } = computeTrendlines(bars, config);
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfMs,
    htfOutputs: trendlinesOutputs(config),
    htfPoints: points,
    htfLines: lines,
    htfPivots: pivots,
    htfAtr: atr[atr.length - 1],
  };
```
Import `trendlinesOutputs` from `./indicators/trendlinesOutputs`.

- [ ] **Step 4: Typecheck and run**

Run: `cd frontend && npx tsc -b 2>&1 | grep -v node_modules | head -40; npx vitest run src/lib/trendlines.register.test.ts src/lib/exprChartToken.test.ts src/lib/mtfCoordinator.test.ts src/lib/indicators/trendlinesOutputs.test.ts`
Expected: no new type errors in the touched files; all PASS. Then `grep -rn "TRENDLINES_OUTPUTS\|tl_support\|tl_resistance\|tl_broken" frontend/src --include='*.ts' --include='*.tsx' | grep -v "indicatorParityGolden\|Dxy\|Tsla"` prints nothing (the parity/acceptance tests are Tasks 7 and 8).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorMeta.ts frontend/src/lib/exprInstances.ts frontend/src/lib/exprChartToken.ts frontend/src/lib/mtfCoordinator.ts frontend/src/lib/trendlines.register.test.ts frontend/src/lib/exprChartToken.test.ts frontend/src/lib/mtfCoordinator.test.ts
git commit -m "feat(trendlines): settings, presets and rule operands for the sideless model"
```

---

### Task 6: Python twin (`trendlines.py`) and its unit tests

**Files:**
- Rewrite: `backend/auto_trader/indicators/trendlines.py`
- Rewrite: `backend/tests/test_trendlines_indicator.py`
- Verify unchanged: `backend/auto_trader/indicators/registry.py:89-95`

**Interfaces:**
- Produces (module `auto_trader.indicators.trendlines`):
  ```python
  TL_ATR_LEN = 14; MAX_PAIR_PIVOTS = 40; MAX_LIVE_MULT = 4; TL_NEAREST = "tl_nearest"
  PivotKind = Literal["high", "low"]
  @dataclass(frozen=True, slots=True) class TrendlinesConfig(pivot_len, touch_mult, min_touches, min_span_bars, max_proj_bars, max_lines, min_swing_atr, min_swing_reach, pair_pivots, max_touches, max_span_bars, max_slope_atr, min_slope_atr, max_touch_spacing, min_touch_spacing, min_crossings, max_crossings, timeframe=None)
  @dataclass(slots=True) class TrendLine(i1, p1, k1, i2, p2, k2, touches, last_touch_idx, crossings, last_sign, max_touch_gap, min_touch_gap, max_touch_idx)
  def tl_output_name(rank: int) -> str
  def trendlines_outputs(cfg) -> tuple[str, ...]
  def parse_trendlines_config(calc_params, extend_data) -> TrendlinesConfig
  def project_at, in_touch_band(line, j, price, tol), side_sign, step_crossing, within_slope, above_slope, rank_key, touch_gaps, over_ceilings, is_live, is_major
  def compute_trendlines(candles, cfg) -> tuple[list[dict[str, float]], list[TrendLine]]
  def trendlines_warmup(cfg, output) -> int
  def trendlines_series(cfg, output, candles, bar_hours) -> list[float | None]
  ```

- [ ] **Step 1: Rewrite the tests**

Overwrite `backend/tests/test_trendlines_indicator.py` with (helpers `bar`, `flat` and `_T0` copied from the current file, `cfg()` drops `min_back_bars`):

```python
"""TRENDLINES (sideless): config parsing, outputs, the geometry gates and the
detector. Ported from frontend/src/lib/indicators/trendlines.test.ts so both
runtimes are pinned by the same behaviours."""

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.trendlines import (
    MAX_LIVE_MULT,
    MAX_PAIR_PIVOTS,
    TL_ATR_LEN,
    TL_NEAREST,
    TrendLine,
    compute_trendlines,
    in_touch_band,
    is_major,
    over_ceilings,
    parse_trendlines_config,
    project_at,
    rank_key,
    side_sign,
    step_crossing,
    tl_output_name,
    trendlines_outputs,
    trendlines_series,
    trendlines_warmup,
)

_T0 = datetime(2020, 1, 1, tzinfo=UTC)


def bar(i: int, low: float, high: float) -> Candle:
    mid = (low + high) / 2
    return Candle(time=_T0 + timedelta(minutes=i), open=mid, high=high, low=low, close=mid, volume=1.0)


def flat(n: int, frm: int = 0) -> list[Candle]:
    return [bar(frm + k, 99.5, 100.5) for k in range(n)]


def cfg(**over):
    base = replace(parse_trendlines_config([], {}), pivot_len=2, min_span_bars=5)
    return replace(base, **over)


def _mixed() -> TrendLine:
    return TrendLine(i1=0, p1=100.0, k1="high", i2=10, p2=90.0, k2="low", touches=2,
                     last_touch_idx=10, crossings=0, last_sign=0,
                     max_touch_gap=10, min_touch_gap=10, max_touch_idx=10)


# ---------------------------------------------------------------- config

def test_defaults_from_empty_params():
    c = parse_trendlines_config([], {})
    assert (c.pivot_len, c.touch_mult, c.min_touches, c.min_span_bars, c.max_proj_bars,
            c.max_lines) == (5, 0.75, 2, 20, 250, 3)
    assert c.pair_pivots == MAX_PAIR_PIVOTS == 40
    assert (c.min_crossings, c.max_crossings) == (0, 0)
    assert c.timeframe is None


def test_reads_every_slot_in_order():
    c = parse_trendlines_config([4, 0.5, 3, 30, 100, 9, 3, 6, 25, 7, 300, 0.2, 0.01, 60, 3, 1, 4], {})
    assert (c.pivot_len, c.touch_mult, c.min_touches, c.min_span_bars, c.max_proj_bars, c.max_lines,
            c.min_swing_atr, c.min_swing_reach, c.pair_pivots, c.max_touches, c.max_span_bars,
            c.max_slope_atr, c.min_slope_atr, c.max_touch_spacing, c.min_touch_spacing,
            c.min_crossings, c.max_crossings) == (4, 0.5, 3, 30, 100, 9, 3, 6, 25, 7, 300, 0.2, 0.01, 60, 3, 1, 4)


def test_zero_survives_on_the_ge_zero_params_and_integers_floor():
    c = parse_trendlines_config([2.9, 0, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {})
    assert c.pivot_len == 2 and c.touch_mult == 0 and c.min_touches == 2
    assert c.min_span_bars == 20 and c.max_lines == 3
    assert c.min_swing_atr == 0 and c.max_touches == 0 and c.max_crossings == 0


@pytest.mark.parametrize("junk", [None, "", [], "x", -1, float("nan"), float("inf")])
def test_junk_falls_back_to_the_default(junk):
    assert parse_trendlines_config([junk] * 17, {}) == parse_trendlines_config([], {})


def test_huge_int_literal_falls_back_instead_of_raising():
    assert parse_trendlines_config([10 ** 400], {}).pivot_len == 5


def test_non_list_calc_params_take_the_defaults():
    assert parse_trendlines_config("junk", {}) == parse_trendlines_config([], {})


def test_mtf_timeframe_pin():
    assert parse_trendlines_config([], {"mtf": {"timeframe": "DAY"}}).timeframe == "DAY"
    assert parse_trendlines_config([], {"mtf": {"timeframe": "chart"}}).timeframe is None


def test_outputs_are_ranked_then_nearest():
    assert trendlines_outputs(cfg(max_lines=3)) == ("tl_1", "tl_2", "tl_3", TL_NEAREST)
    assert tl_output_name(7) == "tl_7"
    assert len(trendlines_outputs(cfg(max_lines=9))) == 10


def test_warmup():
    c = parse_trendlines_config([], {})
    assert trendlines_warmup(c, "tl_1") == TL_ATR_LEN + 2 * 5 + 20
    assert trendlines_warmup(c, TL_NEAREST) == TL_ATR_LEN + 10 + 20
    assert trendlines_warmup(c, "tl_9") == 0  # not exposed at max_lines 3
    assert trendlines_warmup(c, "tl_support") == 0


# -------------------------------------------------------------- geometry

def test_project_at():
    l = _mixed()
    assert (project_at(l, 0), project_at(l, 10), project_at(l, 5), project_at(l, 20)) == (100, 90, 95, 80)


def test_in_touch_band_is_symmetric():
    l = _mixed()
    assert in_touch_band(l, 5, 95.5, 0.5) and in_touch_band(l, 5, 94.5, 0.5)
    assert not in_touch_band(l, 5, 95.6, 0.5) and not in_touch_band(l, 5, 94.4, 0.5)
    assert in_touch_band(l, 5, 95.0, 0) and not in_touch_band(l, 5, 95.0001, 0)


def test_side_sign_and_step_crossing():
    l = _mixed()
    assert (side_sign(l, 5, 96), side_sign(l, 5, 94), side_sign(l, 5, 95)) == (1, -1, 0)
    step_crossing(l, 1, 98)
    assert (l.crossings, l.last_sign) == (0, -1)
    step_crossing(l, 3, 97)  # exactly on the line: keeps -1
    assert (l.crossings, l.last_sign) == (0, -1)
    step_crossing(l, 4, 99)
    assert (l.crossings, l.last_sign) == (1, 1)
    step_crossing(l, 5, 90)
    assert l.crossings == 2


def test_rank_key_order():
    base = _mixed()
    assert rank_key(replace(base, touches=3)) < rank_key(base)
    assert rank_key(replace(base, last_touch_idx=30)) < rank_key(base)
    assert rank_key(base) < rank_key(replace(base, crossings=2))
    a = replace(base, i1=0, last_touch_idx=20)
    b = replace(base, i1=5, last_touch_idx=25)
    assert rank_key(b) < rank_key(a)
    assert rank_key(replace(base, p1=50.0)) < rank_key(base)


def test_crossings_floor_and_ceiling():
    l = replace(_mixed(), crossings=1)
    c = cfg(min_span_bars=5)
    assert not is_major(l, 12, replace(c, min_crossings=2))
    assert is_major(l, 12, replace(c, min_crossings=1))
    assert over_ceilings(replace(l, crossings=3), replace(c, max_crossings=2))
    assert not over_ceilings(replace(l, crossings=2), replace(c, max_crossings=2))


def test_coverage_ends_max_projection_past_the_last_touch():
    c = cfg()
    assert is_major(_mixed(), 10 + c.max_proj_bars, c)
    assert not is_major(_mixed(), 11 + c.max_proj_bars, c)


# -------------------------------------------------------------- detector

def test_returns_one_point_per_bar_and_emits_nothing_before_warmup():
    points, _ = compute_trendlines(flat(30), cfg())
    assert len(points) == 30 and points[0] == {}


def test_finds_a_rising_line_through_two_swing_lows():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert (l.k1, l.k2, l.p1, l.p2) == ("low", "low", 90, 94)


def test_connects_a_swing_high_to_a_later_swing_low():
    bars = flat(60)
    bars[20] = bar(20, 99.5, 110)
    bars[40] = bar(40, 90, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert (l.k1, l.k2, l.p1, l.p2, l.crossings) == ("high", "low", 110, 90, 1)


def test_never_pairs_a_bars_own_high_with_its_own_low():
    bars = flat(60)
    bars[20] = bar(20, 90, 110)
    bars[40] = bar(40, 92, 108)
    _, lines = compute_trendlines(bars, cfg())
    assert all(l.i2 > l.i1 for l in lines)


def test_counts_crossings_instead_of_breaking():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 90, 100.5)
    for j in range(60, 70):
        bars[j] = bar(j, 80, 81)
    for j in range(70, 80):
        bars[j] = bar(j, 99.5, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert l.crossings == 2


def test_a_later_pivot_of_either_kind_touches():
    bars = flat(100)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 90, 100.5)
    for j in range(55, 66):
        bars[j] = bar(j, 85, 86)
    bars[60] = bar(60, 85, 90.4)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert l.touches == 3 and l.last_touch_idx == 60


def test_emits_ranked_outputs_and_the_nearest():
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[25] = bar(25, 99.5, 108)
    bars[45] = bar(45, 99.5, 104)
    c = cfg(max_lines=2)
    points, lines = compute_trendlines(bars, c)
    majors = sorted((l for l in lines if is_major(l, 79, c)), key=rank_key)
    assert len(majors) >= 2
    last = points[79]
    assert last["tl_1"] == project_at(majors[0], 79)
    assert last["tl_2"] == project_at(majors[1], 79)
    assert "tl_3" not in last
    close = bars[79].close
    nearest = min(majors, key=lambda l: (abs(project_at(l, 79) - close), rank_key(l)))
    assert last[TL_NEAREST] == project_at(nearest, 79)


def test_stops_projecting_past_max_proj_bars():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    points, _ = compute_trendlines(bars, cfg(max_proj_bars=30))
    assert "tl_1" in points[70] and "tl_1" not in points[71]


def test_is_causal():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 99.5, 108)
    full, _ = compute_trendlines(bars, cfg())
    pre, _ = compute_trendlines(bars[:80], cfg())
    assert pre == full[:80]


def test_caps_live_state_in_total():
    bars = [bar(i, 99.5 + math.sin(i / 3) * 4, 100.5 + math.sin(i / 3) * 4) for i in range(400)]
    c = cfg(max_lines=1, min_span_bars=3)
    _, lines = compute_trendlines(bars, c)
    assert len(lines) <= MAX_LIVE_MULT * c.max_lines


# ---------------------------------------------------------------- series

def test_series_returns_one_value_per_bar_and_none_for_an_unknown_output():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    s = trendlines_series(cfg(), "tl_1", bars, 1.0)
    assert len(s) == 60 and any(v is not None for v in s)
    assert trendlines_series(cfg(), "tl_support", bars, 1.0) == [None] * 60
    assert trendlines_series(cfg(), "tl_1", [], 1.0) == []


def test_registered_in_the_series_registry():
    spec = SERIES_INDICATORS["TRENDLINES"]
    c = spec.parse_config([], {})
    assert spec.outputs(c) == ("tl_1", "tl_2", "tl_3", TL_NEAREST)
    assert spec.warmup(c, "tl_1") == TL_ATR_LEN + 10 + 20
```

Keep `test_resolves_through_the_request_path` from the current file if it does not reference the old output names; otherwise adapt its asserted output to `"tl_1"`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_trendlines_indicator.py -x -q`
Expected: FAIL at import (`TL_NEAREST`, `side_sign` missing).

- [ ] **Step 3: Rewrite the module**

Overwrite `backend/auto_trader/indicators/trendlines.py` with:

```python
"""TRENDLINES (sideless): major sloping lines through confirmed fractal pivots
of EITHER kind. Ported operation-for-operation from
frontend/src/lib/indicators/trendlines.ts (computeTrendlines) and
frontend/src/lib/indicators/trendlinesOutputs.ts.

A line is two significant swings, high or low in any mix, that later swings
land on within one symmetric tolerance. Price may cross a line freely;
crossings are COUNTED (a gate and a rank key), never a fault. No pierce rule,
no broken state.

Validity here is a BOOLEAN THAT GATES SET MEMBERSHIP: every side test
multiplies through by the exact positive integer (i2 - i1) instead of
computing a slope. Division survives only in project_at. Do NOT "improve" the
arithmetic (see core.py's parity contract). Values at index i depend only on
inputs [0..i].
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

TL_ATR_LEN = 14
# ONE POOL holds highs and lows, so this reaches about half as far back in time
# as the old per-side 20; hence 40. Counted in pivots, not bars.
MAX_PAIR_PIVOTS = 40
# Live state keeps this multiple of max_lines lines IN TOTAL.
MAX_LIVE_MULT = 4
TL_NEAREST = "tl_nearest"

PivotKind = Literal["high", "low"]
KINDS: tuple[PivotKind, ...] = ("high", "low")

# [pivot_len, touch_mult, min_touches, min_span_bars, max_proj_bars, max_lines,
#  min_swing_atr, min_swing_reach, pair_pivots, max_touches, max_span_bars,
#  max_slope_atr, min_slope_atr, max_touch_spacing, min_touch_spacing,
#  min_crossings, max_crossings]: TRENDLINES_DEFAULTS in trendlinesOutputs.ts.
_DEFAULTS = (5, 0.75, 2, 20, 250, 3, 0.0, 0, MAX_PAIR_PIVOTS, 0, 0, 0.0, 0.0, 0, 0, 0, 0)


def tl_output_name(rank: int) -> str:
    return f"tl_{rank}"


@dataclass(frozen=True, slots=True)
class TrendlinesConfig:
    pivot_len: int
    touch_mult: float  # symmetric touch tolerance in ATR(14); 0 = exact
    min_touches: int
    min_span_bars: int
    max_proj_bars: int
    max_lines: int  # live-state size (x MAX_LIVE_MULT) and the ranked output count
    min_swing_atr: float  # 0 = off
    min_swing_reach: int  # 0 = off
    pair_pivots: int  # earlier pivots of either kind a new pivot pairs with
    max_touches: int  # 0 = no limit
    max_span_bars: int  # 0 = no limit
    max_slope_atr: float  # 0 = no limit
    min_slope_atr: float  # 0 = no floor
    max_touch_spacing: int  # 0 = no limit
    min_touch_spacing: int  # 0 = off
    min_crossings: int  # floor; a line can grow into it
    max_crossings: int  # ceiling; 0 = no limit; silences like max_touches
    timeframe: str | None = None


@dataclass(slots=True)
class TrendLine:
    """Two anchor pivots; the line NEVER rotates. k1/k2 say which extreme each
    anchor is; no gate reads them (kept so the two TrendLine shapes match).
    No touch_idxs here: draw-only in the TS."""

    i1: int
    p1: float
    k1: str
    i2: int
    p2: float
    k2: str
    touches: int
    last_touch_idx: int
    crossings: int  # times the close changed side since i1
    last_sign: int  # last NON-ZERO side: 1 above, -1 below, 0 none yet
    max_touch_gap: int
    min_touch_gap: float  # float only because the no-gap guard is math.inf
    max_touch_idx: int


def trendlines_outputs(cfg: TrendlinesConfig) -> tuple[str, ...]:
    return tuple(tl_output_name(r) for r in range(1, cfg.max_lines + 1)) + (TL_NEAREST,)


def parse_trendlines_config(calc_params: object, extend_data: object) -> TrendlinesConfig:
    """Mirrors TS parseTrendlinesConfig. `mtf.timeframe` is the ONE extendData
    key read. Number coercion diverges from the TS on None, "" and [] (float()
    raises, Number() gives 0); deliberate and tested on both sides."""
    p: list[Any] = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    d = _DEFAULTS
    ext = extend_data if isinstance(extend_data, dict) else {}
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")

    def num_at(i: int, default: float, allow_zero: bool) -> float:
        try:
            v = float(p[i])
        except (IndexError, OverflowError, TypeError, ValueError):
            return default
        if not math.isfinite(v):
            return default
        return v if (v >= 0 if allow_zero else v > 0) else default

    def int_at(i: int, default: float) -> int:
        return max(1, math.floor(num_at(i, default, False)))

    def zero_int(i: int, default: float) -> int:
        return max(0, math.floor(num_at(i, default, True)))

    return TrendlinesConfig(
        pivot_len=int_at(0, d[0]),
        touch_mult=num_at(1, d[1], True),
        min_touches=max(2, math.floor(num_at(2, d[2], False))),
        min_span_bars=int_at(3, d[3]),
        max_proj_bars=int_at(4, d[4]),
        max_lines=int_at(5, d[5]),
        min_swing_atr=num_at(6, d[6], True),
        min_swing_reach=zero_int(7, d[7]),
        pair_pivots=int_at(8, d[8]),
        max_touches=zero_int(9, d[9]),
        max_span_bars=zero_int(10, d[10]),
        max_slope_atr=num_at(11, d[11], True),
        min_slope_atr=num_at(12, d[12], True),
        max_touch_spacing=zero_int(13, d[13]),
        min_touch_spacing=zero_int(14, d[14]),
        min_crossings=zero_int(15, d[15]),
        max_crossings=zero_int(16, d[16]),
        timeframe=tf if isinstance(tf, str) and tf and tf != "chart" else None,
    )


def project_at(line: TrendLine, j: int) -> float:
    """The ONLY division in this module."""
    return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1)


def in_touch_band(line: TrendLine, j: int, price: float, tol: float) -> bool:
    """Within `tol` of the line on EITHER side. Cross-multiplied."""
    span = line.i2 - line.i1
    lhs = (price - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    t = tol * span
    return lhs >= rhs - t and lhs <= rhs + t


def side_sign(line: TrendLine, j: int, close: float) -> int:
    span = line.i2 - line.i1
    lhs = (close - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    return 1 if lhs > rhs else (-1 if lhs < rhs else 0)


def step_crossing(line: TrendLine, j: int, close: float) -> None:
    """First non-zero sign is the baseline; a zero keeps the previous sign."""
    s = side_sign(line, j, close)
    if s == 0:
        return
    if line.last_sign != 0 and s != line.last_sign:
        line.crossings += 1
    line.last_sign = s


def within_slope(line: TrendLine, atr_at: float, mult: float) -> bool:
    if mult <= 0:
        return True
    return abs(line.p2 - line.p1) <= mult * atr_at * (line.i2 - line.i1)


def above_slope(line: TrendLine, atr_at: float, mult: float) -> bool:
    if mult <= 0:
        return True
    return abs(line.p2 - line.p1) >= mult * atr_at * (line.i2 - line.i1)


def rank_key(line: TrendLine) -> tuple[int, int, int, int, int, float]:
    """TS rankLines as a total-order key: most touches, longest span, FEWEST
    crossings, most recent, oldest origin, lowest anchor price."""
    return (
        -line.touches,
        -(line.last_touch_idx - line.i1),
        line.crossings,
        -line.last_touch_idx,
        line.i1,
        line.p1,
    )


def _is_pivot_at(values: Sequence[float], i: int, lb_l: int, lb_r: int, want: str) -> bool:
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
        elif w >= v:
            return False
    return True


def _is_significant_swing(
    highs: Sequence[float], lows: Sequence[float], opposite_turns: Sequence[int],
    k: int, kind: str, atr_k: float, mult: float,
) -> bool:
    """SIZE of the swing as the LEG to the most recent turn of the other kind,
    strictly before k. No opposite turn yet is a REJECT."""
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


def _has_swing_reach(vals: Sequence[float], k: int, kind: str, bars: int) -> bool:
    if bars <= 0:
        return True
    if k - bars < 0:
        return False
    for j in range(k - bars, k):
        if (vals[j] >= vals[k]) if kind == "high" else (vals[j] <= vals[k]):
            return False
    return True


def is_live(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    return i - line.last_touch_idx <= cfg.max_proj_bars


def touch_gaps(touch_idxs: Sequence[int]) -> tuple[int, float]:
    if len(touch_idxs) < 2:
        return 0, math.inf
    ordered = sorted(touch_idxs)
    gaps = [b - a for a, b in zip(ordered, ordered[1:])]
    return max(gaps), min(gaps)


def over_ceilings(line: TrendLine, cfg: TrendlinesConfig) -> bool:
    """Mirrors TS overCeilings: SILENCES, does not delete."""
    if cfg.max_touches > 0 and line.touches > cfg.max_touches:
        return True
    if cfg.max_span_bars > 0 and line.last_touch_idx - line.i1 > cfg.max_span_bars:
        return True
    if cfg.max_touch_spacing > 0 and line.max_touch_gap > cfg.max_touch_spacing:
        return True
    if cfg.min_touch_spacing > 0 and line.min_touch_gap < cfg.min_touch_spacing:
        return True
    if cfg.max_crossings > 0 and line.crossings > cfg.max_crossings:
        return True
    return False


def is_major(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    if line.touches < cfg.min_touches:
        return False
    if over_ceilings(line, cfg):
        return False
    if line.last_touch_idx - line.i1 < cfg.min_span_bars:
        return False
    if line.crossings < cfg.min_crossings:
        return False
    return i >= line.i1 and i <= line.last_touch_idx + cfg.max_proj_bars


def compute_trendlines(
    candles: Sequence[Candle], cfg: TrendlinesConfig
) -> tuple[list[dict[str, float]], list[TrendLine]]:
    """Transliteration of TS stepTrendlinesBar over every bar: same loop order,
    same branch order, same arithmetic order. Returns (points, live lines)."""
    n = len(candles)
    points: list[dict[str, float]] = [{} for _ in range(n)]
    if n == 0:
        return points, []

    atr = atr_series(candles, TL_ATR_LEN)
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    closes = [c.close for c in candles]
    pool_idxs: list[int] = []
    pool_kinds: list[str] = []
    turns: dict[str, list[int]] = {"high": [], "low": []}
    lines: list[TrendLine] = []

    for i in range(n):
        a = atr[i]

        # 1. Per-bar crossing step for every existing line.
        for line in lines:
            step_crossing(line, i, closes[i])

        # 2. Confirm-bar work for the pivot at k = i - pivot_len.
        k = i - cfg.pivot_len
        if k >= 0 and a is not None:
            for kind in KINDS:
                vals = highs if kind == "high" else lows
                if not _is_pivot_at(vals, k, cfg.pivot_len, cfg.pivot_len, kind):
                    continue
                turns[kind].append(k)
                if cfg.min_swing_atr > 0:
                    atr_k = atr[k]
                    if atr_k is None:
                        continue
                    opposite = turns["low" if kind == "high" else "high"]
                    if not _is_significant_swing(highs, lows, opposite, k, kind, atr_k, cfg.min_swing_atr):
                        continue
                if not _has_swing_reach(vals, k, kind, cfg.min_swing_reach):
                    continue
                price = vals[k]

                # 2a. Touch test against every existing line, any kind.
                tol_a = atr[k]
                if tol_a is not None:
                    for line in lines:
                        if k <= line.i2:
                            continue
                        if in_touch_band(line, k, price, cfg.touch_mult * tol_a):
                            line.touches += 1
                            gap = k - line.max_touch_idx
                            if gap > line.max_touch_gap:
                                line.max_touch_gap = gap
                            if gap < line.min_touch_gap:
                                line.min_touch_gap = gap
                            line.max_touch_idx = k
                            line.last_touch_idx = k

                # 2b. Seed against the previous pair_pivots pool entries.
                frm = max(0, len(pool_idxs) - cfg.pair_pivots)
                for q in range(frm, len(pool_idxs)):
                    i1 = pool_idxs[q]
                    if i1 >= k:
                        continue
                    k1 = pool_kinds[q]
                    p1 = highs[i1] if k1 == "high" else lows[i1]
                    cand = TrendLine(
                        i1=i1, p1=p1, k1=k1, i2=k, p2=price, k2=kind, touches=2,
                        last_touch_idx=k, crossings=0, last_sign=0,
                        max_touch_gap=k - i1, min_touch_gap=k - i1, max_touch_idx=k,
                    )
                    if cfg.max_slope_atr > 0 or cfg.min_slope_atr > 0:
                        atr_k = atr[k]
                        if atr_k is None:
                            continue
                        if not within_slope(cand, atr_k, cfg.max_slope_atr):
                            continue
                        if not above_slope(cand, atr_k, cfg.min_slope_atr):
                            continue
                    for j in range(i1 + 1, i + 1):
                        step_crossing(cand, j, closes[j])
                    seed_touches = [i1, k]
                    for q2 in range(q + 1, len(pool_idxs)):
                        pj = pool_idxs[q2]
                        if pj >= k:
                            break
                        if pj == i1:
                            continue
                        tol_p = atr[pj]
                        if tol_p is None:
                            continue
                        kj = pool_kinds[q2]
                        pv = highs[pj] if kj == "high" else lows[pj]
                        if in_touch_band(cand, pj, pv, cfg.touch_mult * tol_p):
                            cand.touches += 1
                            seed_touches.append(pj)
                    cand.max_touch_gap, cand.min_touch_gap = touch_gaps(seed_touches)
                    cand.max_touch_idx = cand.i2
                    lines.append(cand)
                pool_idxs.append(k)
                pool_kinds.append(kind)

            # 3. Prune the dead, then cap live state by rank IN TOTAL.
            if any(not is_live(line, i, cfg) for line in lines):
                lines = [line for line in lines if is_live(line, i, cfg)]
            cap = MAX_LIVE_MULT * cfg.max_lines
            if len(lines) > cap:
                lines.sort(key=lambda line: (over_ceilings(line, cfg), rank_key(line)))
                lines = lines[:cap]

        # 4. Emit ranked outputs and the nearest to the close.
        close = closes[i]
        point: dict[str, float] = {}
        majors = [line for line in lines if is_live(line, i, cfg) and is_major(line, i, cfg)]
        majors.sort(key=rank_key)
        nearest_v = 0.0
        nearest_d = math.inf
        for r, line in enumerate(majors):
            v = project_at(line, i)
            if r < cfg.max_lines:
                point[tl_output_name(r + 1)] = v
            d = abs(v - close)
            if d < nearest_d:
                nearest_d = d
                nearest_v = v
        if majors:
            point[TL_NEAREST] = nearest_v
        points[i] = point

    return points, lines


def trendlines_warmup(cfg: TrendlinesConfig, output: str) -> int:
    """ATR(14) warm-up + two pivot confirms + the minimum span. An output this
    config does not expose costs 0. Mirrors TS trendlinesWarmup."""
    if output not in trendlines_outputs(cfg):
        return 0
    return TL_ATR_LEN + 2 * cfg.pivot_len + cfg.min_span_bars


def trendlines_series(
    cfg: TrendlinesConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    """bar_hours is unused; the IndicatorSeriesSpec signature requires it."""
    if output not in trendlines_outputs(cfg):
        return [None] * len(candles)
    points, _lines = compute_trendlines(candles, cfg)
    return [p.get(output) for p in points]
```

Check `registry.py:89-95` needs no change (`outputs=_tl.trendlines_outputs` already takes `cfg`). Run `grep -rn "TRENDLINES_OUTPUTS\|tl_support\|broken_idx\|mixed_touches\|viol_mult\|min_back_bars" backend/auto_trader` and fix any hit outside `trendlines.py` (expected: none).

- [ ] **Step 4: Run the tests**

Run: `cd backend && python3 -m pytest tests/test_trendlines_indicator.py -x -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/trendlines.py backend/tests/test_trendlines_indicator.py
git commit -m "feat(trendlines): Python twin of the sideless detector"
```

---

### Task 7: Parity golden regeneration

**Files:**
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts:120-200, 242-270, ~300-320`
- Regenerate: `backend/tests/fixtures/indicator_golden.json`
- Modify: `backend/tests/test_indicator_parity.py:121-end` (every `test_trendlines*`)

**Interfaces:**
- Golden series keys: `TL_1`, `TL_2`, `TL_3`, `TL_NEAREST` for the base config, and `TL_<VARIANT>_1` / `TL_<VARIANT>_NEAREST` for each variant in `SWING, REACH, PAIR, CAP, SPAN, SLOPE, FLAT, SPACING, SPACING_MIN, CROSS_MIN, CROSS_MAX`.

- [ ] **Step 1: Rewrite the TS generator section**

Replace the TRENDLINES section of the generator (from the `TL_CFG` comment through the `tlSpacingMinPoints` computation) with:

```ts
    // TRENDLINES: config mirrored by test_indicator_parity.test_trendlines
    // VALUE FOR VALUE. pivotLen 3 / minSpanBars 10 keep this 500-bar walk
    // producing many lines; maxProjBars 60 makes lines actually expire.
    const TL_CFG = {
      pivotLen: 3, touchMult: 0.75, minTouches: 2, minSpanBars: 10, maxProjBars: 60,
      maxLines: 3, minSwingAtr: 0, minSwingReach: 0, pairPivots: 40, maxTouches: 0,
      maxSpanBars: 0, maxSlopeAtr: 0, minSlopeAtr: 0, maxTouchSpacing: 0,
      minTouchSpacing: 0, minCrossings: 0, maxCrossings: 0,
    };
    const tlPoints = computeTrendlines(candles, TL_CFG).points;
    // One variant per gate, each against its own off state in TL_CFG, so a port
    // that ignored a param would fail exactly one pair.
    const TL_VARIANTS: Record<string, Partial<typeof TL_CFG>> = {
      SWING: { minSwingAtr: 2 },
      REACH: { minSwingReach: 12 },
      PAIR: { pairPivots: 5 },
      CAP: { maxTouches: 3 },
      SPAN: { maxSpanBars: 40 },
      SLOPE: { maxSlopeAtr: 0.1 },
      FLAT: { minSlopeAtr: 0.05 },
      SPACING: { maxTouchSpacing: 30 },
      SPACING_MIN: { minTouchSpacing: 4, minTouches: 3 },
      CROSS_MIN: { minCrossings: 2 },
      CROSS_MAX: { maxCrossings: 1 },
    };
    const tlVariantSeries: Record<string, Array<number | null>> = {};
    for (const [name, patch] of Object.entries(TL_VARIANTS)) {
      const pts = computeTrendlines(candles, { ...TL_CFG, ...patch }).points;
      tlVariantSeries[`TL_${name}_1`] = toNull(pts.map((p) => p.tl_1 ?? null));
      tlVariantSeries[`TL_${name}_NEAREST`] = toNull(pts.map((p) => p.tl_nearest ?? null));
      // Each variant must MOVE something against the base, or the Python port
      // could ignore the param and still pass.
      expect(JSON.stringify(pts), name).not.toBe(JSON.stringify(tlPoints));
    }
```
and in the `series` object replace every `TL_*` entry with:
```ts
      TL_1: toNull(tlPoints.map((p) => p.tl_1 ?? null)),
      TL_2: toNull(tlPoints.map((p) => p.tl_2 ?? null)),
      TL_3: toNull(tlPoints.map((p) => p.tl_3 ?? null)),
      TL_NEAREST: toNull(tlPoints.map((p) => p.tl_nearest ?? null)),
      ...tlVariantSeries,
```
Delete the old `tlMixedPoints` / `tlSpacing*` guards further down.

- [ ] **Step 2: Regenerate the fixture**

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS and `backend/tests/fixtures/indicator_golden.json` rewritten (`git status --porcelain backend/tests/fixtures` shows it modified). If a variant's "must MOVE something" guard fails, raise that variant's value (e.g. `maxCrossings: 1` to `2`, `minCrossings: 2` to `1`) until it bites, then re-run.

- [ ] **Step 3: Rewrite the Python verifier**

Replace every `test_trendlines*` in `test_indicator_parity.py` with:

```python
_TL_BASE = dict(
    pivot_len=3, touch_mult=0.75, min_touches=2, min_span_bars=10, max_proj_bars=60,
    max_lines=3, min_swing_atr=0.0, min_swing_reach=0, pair_pivots=40, max_touches=0,
    max_span_bars=0, max_slope_atr=0.0, min_slope_atr=0.0, max_touch_spacing=0,
    min_touch_spacing=0, min_crossings=0, max_crossings=0,
)

# Mirrors TL_VARIANTS in indicatorParityGolden.test.ts VALUE FOR VALUE.
_TL_VARIANTS = {
    "SWING": dict(min_swing_atr=2.0),
    "REACH": dict(min_swing_reach=12),
    "PAIR": dict(pair_pivots=5),
    "CAP": dict(max_touches=3),
    "SPAN": dict(max_span_bars=40),
    "SLOPE": dict(max_slope_atr=0.1),
    "FLAT": dict(min_slope_atr=0.05),
    "SPACING": dict(max_touch_spacing=30),
    "SPACING_MIN": dict(min_touch_spacing=4, min_touches=3),
    "CROSS_MIN": dict(min_crossings=2),
    "CROSS_MAX": dict(max_crossings=1),
}


def test_trendlines(golden):
    from auto_trader.indicators.trendlines import TrendlinesConfig, trendlines_series

    candles, _, series = golden
    cfg = TrendlinesConfig(**_TL_BASE)
    for output, key in (("tl_1", "TL_1"), ("tl_2", "TL_2"), ("tl_3", "TL_3"), ("tl_nearest", "TL_NEAREST")):
        expected = series[key]
        assert any(v is not None for v in expected), f"{key}: golden is all-None"
        assert_series_equal(trendlines_series(cfg, output, candles, 1.0), expected, key)


@pytest.mark.parametrize("name", sorted(_TL_VARIANTS))
def test_trendlines_variant(golden, name):
    from auto_trader.indicators.trendlines import TrendlinesConfig, trendlines_series

    candles, _, series = golden
    cfg = TrendlinesConfig(**{**_TL_BASE, **_TL_VARIANTS[name]})
    for output, key in (("tl_1", f"TL_{name}_1"), ("tl_nearest", f"TL_{name}_NEAREST")):
        expected = series[key]
        assert any(v is not None for v in expected), f"{key}: golden is all-None"
        assert_series_equal(trendlines_series(cfg, output, candles, 1.0), expected, key)
```
If the TS guard forced a different variant value in Step 2, mirror it here.

- [ ] **Step 4: Run the Python parity suite**

Run: `cd backend && python3 -m pytest tests/test_indicator_parity.py -x -q`
Expected: PASS. A mismatch means a transliteration slip in Task 6: diff the first differing bar index printed by `assert_series_equal`, compare the TS and Python loop at that bar, and fix the Python (never the TS) until identical.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorParityGolden.test.ts backend/tests/fixtures/indicator_golden.json backend/tests/test_indicator_parity.py
git commit -m "test(trendlines): regenerate parity golden for the sideless detector"
```

---

### Task 8: Acceptance fixtures (EURUSD weekly, DXY, TSLA)

**Files:**
- Create: `frontend/src/lib/indicators/trendlinesEurusd.fixture.json`
- Create: `frontend/src/lib/indicators/trendlinesEurusd.test.ts`
- Modify: `frontend/src/lib/indicators/trendlinesDxy.test.ts`, `frontend/src/lib/indicators/trendlinesTsla.test.ts`

**Interfaces:**
- Consumes: `computeTrendlines`, `isMajor`, `TRENDLINES_DEFAULTS`.

- [ ] **Step 1: Capture the EURUSD weekly bars**

The backend must be running locally (`http://localhost:8000`, dev mode, no auth). Confirm the parameter names first:
```bash
grep -n "def broker_query" -A 6 backend/auto_trader/api/deps.py
grep -n "WEEK" backend/auto_trader/core/models.py | head -3
```
Then (substituting the broker query name and the weekly `Resolution` value those prints show; expected `broker` and `WEEK`):
```bash
curl -s 'http://localhost:8000/api/candles?epic=EURUSD&resolution=WEEK&bars=1000&broker=capital' \
  | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(json.dumps([{"timestamp": r["time"]*1000, "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"], "volume": r["volume"]} for r in rows]))' \
  > frontend/src/lib/indicators/trendlinesEurusd.fixture.json
python3 -c 'import json; b=json.load(open("frontend/src/lib/indicators/trendlinesEurusd.fixture.json")); import datetime; print(len(b), datetime.datetime.utcfromtimestamp(b[0]["timestamp"]/1000), datetime.datetime.utcfromtimestamp(b[-1]["timestamp"]/1000)); print([ (datetime.datetime.utcfromtimestamp(x["timestamp"]/1000).date().isoformat(), x["high"]) for x in b if x["high"]>1.234])'
```
Expected: several hundred bars ending this month, and a bar in the week of 2021-01-04 with high `1.23495`. If the capture is shorter than 2021, re-run with `from_ts`/`to_ts` (unix seconds) windows and concatenate.

- [ ] **Step 2: Write the acceptance test**

```ts
// ACCEPTANCE: the line a trader drew on EURUSD weekly, from the 2021-01-04 high
// (1.23495) down through the Nov-2025 low. Its two anchors are a HIGH and a
// LOW, and price sat 2-3 ATR above it for most of 2025: the sided detector
// could never build it. If this stops passing, the feature does not do the
// one thing it was rewritten for.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, isMajor } from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import fixture from "./trendlinesEurusd.fixture.json";

const bars = fixture as unknown as KLineData[];
const month = (t: number): string => new Date(t).toISOString().slice(0, 7);

// The user's live 1W settings on chartkar.app (2026-09-16): pivot length 4,
// pivot size 3 ATR, 9 lines. Everything else default.
const CFG = { ...TRENDLINES_DEFAULTS, pivotLen: 4, minSwingAtr: 3, maxLines: 9 };

describe("TRENDLINES on EURUSD weekly", () => {
  it("has the fixture it expects", () => {
    expect(bars.length).toBeGreaterThan(280);
    expect(bars.some((b) => month(b.timestamp) === "2021-01" && b.high === 1.23495)).toBe(true);
  });

  it("builds the 2021-01 high to 2025-11 low line and reads it at the last bar", () => {
    const { lines } = computeTrendlines(bars, CFG);
    const found = lines.filter(
      (l) => l.k1 === "high" && month(bars[l.i1].timestamp) === "2021-01" &&
             l.k2 === "low" && month(bars[l.i2].timestamp) === "2025-11",
    );
    // Diagnostic on failure: which pivots the pool holds around the anchors.
    if (!found.length) {
      const { pivots } = computeTrendlines(bars, CFG);
      const near = pivots.idxs
        .map((idx, q) => `${month(bars[idx].timestamp)}:${pivots.kinds[q]}`)
        .filter((s) => s.startsWith("2021-01") || s.startsWith("2025-1"));
      console.log("pool near the anchors:", near, "pool size:", pivots.idxs.length);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].p1).toBe(1.23495);
    expect(isMajor(found[0], bars.length - 1, CFG)).toBe(true);
    expect(found[0].crossings).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesEurusd.test.ts`
Expected: PASS. If it fails:
- "pool near the anchors" lacks `2021-01:high`: the pivot gates reject the anchor; lower `minSwingAtr` in `CFG` only if the 2021 high genuinely fails the 3-ATR leg, and record the value that passes in the test comment.
- Both anchors are in the pool but no line: the pair is out of `pairPivots` reach (count pool entries between them from the printed list). Raise `MAX_PAIR_PIVOTS` in BOTH `trendlinesOutputs.ts` and `trendlines.py` to the smallest value that reaches (then rerun Task 7 Step 2 and 4 because the golden's `pairPivots: 40` base is explicit and unchanged, the regeneration should be a no-op; verify with `git status`), and update the spec's default in the configuration table.
- The Nov-2025 low pivot is a different month (Oct or Dec): use the printed month.

- [ ] **Step 4: Update the DXY and TSLA acceptance tests**

`trendlinesDxy.test.ts`: `EXPECTED` entries drop `side`; the match becomes `month(bars[l.i1].timestamp) === want.from && month(bars[l.i2].timestamp) === want.to` with the kinds asserted (`support` rows become `k1: "low", k2: "low"`, `resistance` rows `k1: "high", k2: "high"`). Delete any case about `tl_broken_resistance`, `brokenIdx` or `pierces`; reads of `tl_resistance` / `tl_support` become `tl_nearest`. If the 2011-05 to 2021-01 monthly line falls out of `pairPivots` reach, set `pairPivots: 60` in that test's config and say so in a comment (the default stays as tuned in Step 3). Same substitutions in `trendlinesTsla.test.ts`.

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesDxy.test.ts src/lib/indicators/trendlinesTsla.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesEurusd.fixture.json frontend/src/lib/indicators/trendlinesEurusd.test.ts frontend/src/lib/indicators/trendlinesDxy.test.ts frontend/src/lib/indicators/trendlinesTsla.test.ts
git commit -m "test(trendlines): EURUSD weekly acceptance, sideless DXY and TSLA expectations"
```

---

### Task 9: Sweep, typecheck, live check

**Files:**
- Verify: whole `frontend/src` and `backend/auto_trader` for leftovers.

- [ ] **Step 1: Grep for leftovers**

```bash
grep -rn "TRENDLINES_OUTPUTS\|tl_support\|tl_resistance\|tl_broken\|TrendSide\|brokenIdx\|broken_idx\|mixedTouches\|mixed_touches\|violMult\|viol_mult\|minBackBars\|min_back_bars\|breakHoldBars\|break_hold_bars\|firstTouchIdx\|first_touch_idx\|hideBroken\|dimBroken\|TL_SUPPORT_COLOR\|TL_RESISTANCE_COLOR" frontend/src backend/auto_trader backend/tests --include='*.ts' --include='*.tsx' --include='*.py' | grep -v "srLevels\|sr_levels\|SR_ZONE\|srZone"
```
Expected: nothing. (`dimBroken` legitimately remains in SR_LEVELS code.) Fix any hit.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b 2>&1 | grep -v node_modules | head -60`
Expected: no errors in any file this plan touched (compare against `git stash`-free baseline by checking that every reported file is untouched by `git diff --name-only HEAD~9`).

- [ ] **Step 3: Run the touched test files together**

```bash
cd frontend && npx vitest run src/lib/indicators/trendlinesOutputs.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlines.incremental.test.ts src/lib/indicators/trendlines.clip.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/indicators/trendlinesDxy.test.ts src/lib/indicators/trendlinesTsla.test.ts src/lib/indicators/trendlinesEurusd.test.ts src/lib/trendlines.register.test.ts src/lib/exprChartToken.test.ts src/lib/mtfCoordinator.test.ts src/lib/indicatorParityGolden.test.ts
cd ../backend && python3 -m pytest tests/test_trendlines_indicator.py tests/test_indicator_parity.py -x -q
```
Expected: all PASS.

- [ ] **Step 4: Live check on the EURUSD 1W chart**

With the dev frontend running, open the EURUSD 1W chart, remove the old Trendlines instances (they predate the layout change), add a fresh Trendlines, set Min Pivot Length 4, Min Pivot Size 3, Max Trendlines 9. Confirm: lines in one colour, `×N ⇅C` labels, a line from the 2021 top through the Nov-2025 low is drawn, the Inputs panel shows the Crossings range and no Max Pierce / Mixed / Break Hold / Hide broken / Dim broken rows. Report what you see to the user with a screenshot; do not tune defaults without asking.

- [ ] **Step 5: Final commit (only if Step 1-3 required fixes)**

```bash
git add <explicit paths changed in this task>
git commit -m "chore(trendlines): remove sided leftovers"
```
