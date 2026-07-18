# Candle Patterns Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `CANDLE_PATTERNS` main-pane indicator that labels 24 candlestick patterns on the chart and exposes each (plus Any-bullish/Any-bearish aggregates) as 0/1 backtest rule operands.

**Architecture:** One pure detector module (`candlePatterns.ts`, no klinecharts runtime imports) shared by the chart template's `calc` and by `computeIndicatorRecipe`, so chart visuals and rule series can never disagree. Wiring follows the existing custom-indicator + chart-operand patterns (TIME_HIGHLIGHT for the figure-less main-pane draw, SLOPE/RSI-divergence for multi-line operands).

**Tech Stack:** TypeScript, React, klinecharts v10, vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-candle-patterns-indicator-design.md` — read it first.

## Global Constraints

- Engulfing uses the ANALYSIS definition (body-engulf, `backend/auto_trader/engine/context_features.py::classify_candle`), NOT the TV script's stricter one.
- TV exact-equality conditions become `|a-b| <= eps` with `eps = 0.05 * ATR14` (SMA of true range, 14; fallback `1e-4 * close` while fewer than 14 TRs exist).
- Closed bars only, no lookahead; a pattern needing N prior bars yields 0 for the first N bars.
- Canonical pattern order (below) is the operand `line` index — it must NEVER depend on the enable-set.
- The detector module must not import klinecharts at runtime (`backtestConfig.ts` import-cycle rule; type-only imports are fine, but prefer a structural `Bar` type).
- No em dashes in any user-facing copy. Light theme is canonical.
- Frontend only; zero backend changes.
- Run all commands from `frontend/` (`npx vitest run <file>`, `npx tsc --noEmit`).

## Canonical pattern registry (used by every task)

Order = `line` index. Polarity: bull / bear / neutral. Toggle = settings checkbox group.

| # | id | label | short | polarity | toggle |
|---|----|-------|-------|----------|--------|
| 0 | bull_engulfing | Bullish Engulfing | Engulf | bull | engulfing |
| 1 | bear_engulfing | Bearish Engulfing | Engulf | bear | engulfing |
| 2 | pin_top | Pin Top | Pin | bear | pin_top |
| 3 | pin_bottom | Pin Bottom | Pin | bull | pin_bottom |
| 4 | doji | Doji | Doji | neutral | doji |
| 5 | inside | Inside Bar | Inside | neutral | inside |
| 6 | outside | Outside Bar | Outside | neutral | outside |
| 7 | bull_harami | Bullish Harami | Harami | bull | harami |
| 8 | bear_harami | Bearish Harami | Harami | bear | harami |
| 9 | piercing_line | Piercing Line | Pierce | bull | piercing |
| 10 | dark_cloud_cover | Dark Cloud Cover | Dark Cloud | bear | piercing |
| 11 | morning_star | Morning Star | M Star | bull | star |
| 12 | evening_star | Evening Star | E Star | bear | star |
| 13 | bull_belt_hold | Bullish Belt Hold | Belt | bull | belt_hold |
| 14 | bear_belt_hold | Bearish Belt Hold | Belt | bear | belt_hold |
| 15 | three_white_soldiers | Three White Soldiers | 3 Soldiers | bull | soldiers |
| 16 | three_black_crows | Three Black Crows | 3 Crows | bear | soldiers |
| 17 | three_stars_south | Three Stars in the South | 3 Stars S | bull | stars_south |
| 18 | stick_sandwich | Stick Sandwich | Sandwich | bull | sandwich |
| 19 | bull_meeting_line | Bullish Meeting Line | Meet | bull | meeting_line |
| 20 | bear_meeting_line | Bearish Meeting Line | Meet | bear | meeting_line |
| 21 | bull_kicking | Bullish Kicking | Kick | bull | kicking |
| 22 | bear_kicking | Bearish Kicking | Kick | bear | kicking |
| 23 | ladder_bottom | Ladder Bottom | Ladder | bull | ladder |

Aggregates: line 24 = "Any bullish pattern" (OR of enabled bull patterns), line 25 = "Any bearish pattern" (OR of enabled bear patterns). Neutral patterns belong to neither.

16 toggles: engulfing, pin_top, pin_bottom, doji, inside, outside, harami, piercing, star, belt_hold, soldiers, stars_south, sandwich, meeting_line, kicking, ladder. All on by default.

---

### Task 1: Detector module + golden tests

**Files:**
- Create: `frontend/src/lib/indicators/candlePatterns.ts` (detector half only; the template is Task 2)
- Test: `frontend/src/lib/indicators/candlePatterns.test.ts`

**Interfaces (Produces):**
```ts
export type PatternPolarity = "bull" | "bear" | "neutral";
export interface CandlePatternDef {
  id: string; label: string; short: string; polarity: PatternPolarity; toggle: string;
}
export const CANDLE_PATTERN_DEFS: readonly CandlePatternDef[];      // 24 entries, table order
export const CANDLE_PATTERN_TOGGLES: ReadonlyArray<{ id: string; label: string }>; // 16
export const ANY_BULL_LINE = 24; export const ANY_BEAR_LINE = 25;
export interface PatternBar { open: number; high: number; low: number; close: number }
/** hits[i] = Set of matched pattern ids at bar i (ALL patterns, no enable filtering). */
export function detectAllPatterns(bars: readonly PatternBar[]): Array<Set<string>>;
/** 0/1 series for one canonical line; lines 24/25 OR over `members` ids. */
export function patternLineSeries(bars: readonly PatternBar[], line: number, members?: readonly string[]): number[];
export function defaultMembers(polarity: "bull" | "bear"): string[]; // all bull / all bear ids
```

- [ ] **Step 1: Write the detector**

Pure module, no klinecharts import. Epsilon helper first:

```ts
// eps[i] = 0.05 * SMA14 of true range up to and including bar i; while fewer
// than 14 TRs exist, fall back to 1e-4 * close (index data has no fixed tick).
function epsSeries(bars: readonly PatternBar[]): number[] {
  const eps: number[] = new Array(bars.length);
  let sum = 0; const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    trs.push(tr); sum += tr;
    if (trs.length > 14) sum -= trs[trs.length - 15];
    eps[i] = trs.length >= 14 ? 0.05 * (sum / 14) : 1e-4 * b.close;
  }
  return eps;
}
const eq = (a: number, b: number, e: number) => Math.abs(a - b) <= e;
```

Per-bar detection in `detectAllPatterns` (o/h/l/c arrays indexed `[0]`=current bar i, `[1]`=i-1, etc., exactly like the Pine script; a pattern needing bar `[k]` requires `i >= k`). Analysis-7 definitions ported verbatim from `classify_candle` (body engulf, wick ratios, `body <= 0.10 * rng` doji, inside/outside on high/low, first-match NOT applied — every matching pattern reports, unlike the backend's first-match, because operands are independent). TV ports (e = eps[i]):

```ts
// Harami
bull_harami: o[1]>c[1] && c[1]<c[2] && o[0]>c[1] && o[0]<o[1] && c[0]>c[1] && c[0]<o[1] && h[0]<h[1] && l[0]>l[1] && c[0]>=o[0]
bear_harami: o[1]<c[1] && c[1]>c[2] && o[0]<c[1] && o[0]>o[1] && c[0]<c[1] && c[0]>o[1] && h[0]<h[1] && l[0]>l[1] && c[0]<=o[0]
// Piercing / Dark Cloud
piercing_line: c[2]>c[1] && o[0]<l[1] && c[0]>(o[1]+c[1])/2 && c[0]<o[1]
dark_cloud_cover: c[2]<c[1] && o[0]>h[1] && c[0]<(o[1]+c[1])/2 && c[0]>o[1]
// Morning / Evening Star
morning_star: c[3]>c[2] && c[2]<o[2] && o[1]<c[2] && c[1]<c[2] && o[0]>o[1] && o[0]>c[1] && c[0]>c[2] && (o[2]-c[2])>(c[0]-o[0])
evening_star: c[3]<c[2] && c[2]>o[2] && o[1]>c[2] && c[1]>c[2] && o[0]<o[1] && o[0]<c[1] && c[0]<c[2] && (c[2]-o[2])>(o[0]-c[0])
// Belt Hold (avg(close,open) comparison reduces to close vs open)
bull_belt_hold: c[1]<o[1] && l[1]>o[0] && c[1]>o[0] && eq(o[0],l[0],e) && c[0]>o[0]
bear_belt_hold: c[1]>o[1] && h[1]<o[0] && c[1]<o[0] && eq(o[0],h[0],e) && c[0]<o[0]
// Soldiers / Crows (avg comparisons reduce to close vs open)
three_white_soldiers: c[3]<o[3] && o[2]<c[3] && c[2]>o[2] && o[1]>o[2] && o[1]<c[2] && c[1]>o[1] && o[0]>o[1] && o[0]<c[1] && c[0]>o[0] && h[1]>h[2] && h[0]>h[1]
three_black_crows:    c[3]>o[3] && o[2]>c[3] && c[2]<o[2] && o[1]<o[2] && o[1]>c[2] && c[1]<o[1] && o[0]<o[1] && o[0]>c[1] && c[0]<o[0] && l[1]<l[2] && l[0]<l[1]
// Three Stars in the South
three_stars_south: o[3]>c[3] && o[2]>c[2] && eq(o[2],h[2],e) && o[1]>c[1] && o[1]<o[2] && o[1]>c[2] && l[1]>l[2] && eq(o[1],h[1],e) && o[0]>c[0] && o[0]<o[1] && o[0]>c[1] && eq(o[0],h[0],e) && eq(c[0],l[0],e) && c[0]>=l[1]
// Stick Sandwich
stick_sandwich: o[2]>c[2] && o[1]>c[2] && o[1]<c[1] && o[0]>c[1] && o[0]>c[0] && eq(c[0],c[2],e)
// Meeting Line
bull_meeting_line: o[2]>c[2] && o[1]>c[1] && eq(c[1],c[0],e) && o[0]<c[0] && o[1]>=h[0]
bear_meeting_line: o[2]<c[2] && o[1]<c[1] && eq(c[1],c[0],e) && o[0]>c[0] && o[1]<=l[0]
// Kicking
bull_kicking: o[1]>c[1] && eq(o[1],h[1],e) && eq(c[1],l[1],e) && o[0]>o[1] && eq(o[0],l[0],e) && eq(c[0],h[0],e) && (c[0]-o[0])>(o[1]-c[1])
bear_kicking: o[1]<c[1] && eq(o[1],l[1],e) && eq(c[1],h[1],e) && o[0]<o[1] && eq(o[0],h[0],e) && eq(c[0],l[0],e) && (o[0]-c[0])>(c[1]-o[1])
// Ladder Bottom
ladder_bottom: o[4]>c[4] && o[3]>c[3] && o[3]<o[4] && o[2]>c[2] && o[2]<o[3] && o[1]>c[1] && o[1]<o[2] && o[0]<c[0] && o[0]>o[1] && l[4]>l[3] && l[3]>l[2] && l[2]>l[1]
```

`patternLineSeries(bars, line, members?)`: for `line < 24`, `1` where `detectAllPatterns` hit contains that id, else `0`. For 24/25: `members ?? defaultMembers(polarity)`, `1` where any member id hit. Compute `detectAllPatterns` once per call.

- [ ] **Step 2: Write golden tests (TDD: write them against the not-yet-written exports first if practical, or per-pattern red/green as you build each block)**

Fixture helper + required coverage:

```ts
const B = (open: number, high: number, low: number, close: number): PatternBar => ({ open, high, low, close });
// Pad with 20 flat lead-in bars so eps uses the ATR path:
const pad = Array.from({ length: 20 }, () => B(100, 101, 99, 100));
```

Required cases (each `it()` asserts the hit at the LAST bar index and asserts the near-miss does not hit):
1. Per pattern (all 24): one triggering sequence built from its definition above, and one near-miss that flips exactly one condition (e.g. for `stick_sandwich`, move `c[0]` outside eps of `c[2]`).
2. Tolerance boundary: `bull_kicking` where `o[0]` differs from `l[0]` by exactly `0.04 * ATR14` (must hit) and by `0.5 * ATR14` (must not).
3. Analysis parity: `bull_engulfing`/`bear_engulfing`/`pin_top`/`pin_bottom`/`doji`/`inside`/`outside` fixtures mirror `classify_candle` semantics (body-engulf without high/low requirement must STILL hit engulfing).
4. Aggregates: a bar hitting `bear_engulfing` gives `patternLineSeries(bars, 25)` = 1 there and `patternLineSeries(bars, 24)` = 0; `members: ["bull_kicking"]` restricted aggregate ignores other bull hits.
5. Warm-up: patterns needing k prior bars return 0 at indices < k (feed a 3-bar array, assert no morning_star crash/hit).

- [ ] **Step 3: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicators/candlePatterns.test.ts`
Expected: PASS (all patterns + boundary + aggregate + warm-up cases).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/indicators/candlePatterns.ts frontend/src/lib/indicators/candlePatterns.test.ts
git commit -m "feat(chart): candle pattern detector with 24 patterns + tests"
```

---

### Task 2: Chart template (calc + draw) + registration

**Files:**
- Modify: `frontend/src/lib/indicators/candlePatterns.ts` (append template half)
- Modify: `frontend/src/lib/customIndicators.ts` (type union, barrel export, BASE_TEMPLATES, OVERLAY_INDICATORS)
- Modify: `frontend/src/lib/indicatorMeta.ts` (INDICATOR_META entry)

**Interfaces:**
- Consumes: `detectAllPatterns`, `CANDLE_PATTERN_DEFS` from Task 1.
- Produces: `CANDLE_PATTERNS_TEMPLATE: Omit<IndicatorTemplate, "name">`, `CandlePatternsExtend`, `CandlePatternsPoint`.

- [ ] **Step 1: Add extend type + calc + draw to candlePatterns.ts**

Model on `timeHighlight.ts` (figure-less, `series: 'price'`, `figures: []`, draw returns `true`):

```ts
export interface CandlePatternsExtend {
  disabled?: Record<string, boolean>;  // by TOGGLE id; absent = enabled
  showLabels?: boolean;                // default true
  bullColor?: string;                  // default "#1FADA2"
  bearColor?: string;                  // default "#F35A54"
  neutralColor?: string;               // default "#787B86"
  hideLegendValue?: boolean;
}
export interface CandlePatternsPoint { hits?: number[] } // canonical line indices of ENABLED matches
```

`calc`: map klinecharts `KLineData[]` (structurally a `PatternBar[]`) through `detectAllPatterns`, filter by the toggle enable-set, store canonical indices.

`draw` (mirror `drawTimeHighlight`'s structure and the wick/body pixel math at `timeHighlight.ts:149-166`): for each bar with hits, group by polarity. Bull hits: filled up-triangle (6px half-width) 4px below `yAxis.convertToPixel(k.low)`, label text stacked beneath (10px sans-serif, `textAlign: "center"`, one line per hit, 11px line height). Bear + neutral hits: down-triangle above `k.high`, labels stacked upward. `showLabels === false` draws triangles only. Iterate the full result list like timeHighlight does (off-screen draws are harmless). Return `true`.

- [ ] **Step 2: Register in customIndicators.ts**

Following the existing pattern exactly: add `export * from "./indicators/candlePatterns";`, import `CANDLE_PATTERNS_TEMPLATE`, add `"CANDLE_PATTERNS"` to `CustomIndicatorType` (customIndicators.ts:40), to `BASE_TEMPLATES` (:55), and to `OVERLAY_INDICATORS` (:82).

- [ ] **Step 3: Menu meta in indicatorMeta.ts**

Add to `INDICATOR_META` (indicatorMeta.ts:93):

```ts
CANDLE_PATTERNS: {
  inputs: [],
  title: "Candle Patterns",
  desc: "Marks candlestick patterns (engulfing, harami, stars, pins and more) on the chart. Each pattern is usable as a backtest rule condition.",
},
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib/indicators/candlePatterns.test.ts`
Expected: clean typecheck, tests still PASS.
Then a quick manual check is Task 5's job; do not start the dev server here.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/candlePatterns.ts frontend/src/lib/customIndicators.ts frontend/src/lib/indicatorMeta.ts
git commit -m "feat(chart): Candle Patterns main-pane indicator (labels + registration)"
```

---

### Task 3: Rule-operand wiring + parity test

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (`SeriesIndicatorType` :32, `operandBaseLen` :418)
- Modify: `frontend/src/lib/backtestSeries.ts` (`computeIndicatorRecipe` case)
- Modify: `frontend/src/lib/chartOperand.ts` (`SUPPORTED_INDICATORS` :20, `indicatorToRecipe` :63, `recipeLabel`, `indicatorOutputs` :205)
- Test: extend `frontend/src/lib/indicators/candlePatterns.test.ts` (parity block) and `frontend/src/lib/chartOperand.test.ts`

**Interfaces:**
- Consumes: `patternLineSeries`, `CANDLE_PATTERN_DEFS`, `ANY_BULL_LINE`, `ANY_BEAR_LINE`, `defaultMembers`, `CandlePatternsExtend` from Tasks 1-2.
- Produces: `"CANDLE_PATTERNS"` as a full `SeriesIndicatorType`; recipes `{source:"indicator", indicatorType:"CANDLE_PATTERNS", calcParams:[], line:N}` with `extend.members: string[]` ONLY on aggregate lines (24/25).

- [ ] **Step 1: Type + supported set**

`backtestConfig.ts:32`: add `"CANDLE_PATTERNS"` to `SeriesIndicatorType`. `chartOperand.ts:20`: add to `SUPPORTED_INDICATORS`.

- [ ] **Step 2: computeIndicatorRecipe case (backtestSeries.ts)**

```ts
case "CANDLE_PATTERNS": {
  // line < 24 = one canonical pattern; 24/25 = aggregate over the member ids
  // snapshotted in the recipe (never the live enable-set — spec: toggling
  // patterns on the chart must not silently change an existing rule).
  const members = ext.members as string[] | undefined;
  return patternLineSeries(candles, line, members);
}
```

- [ ] **Step 3: indicatorToRecipe + recipeLabel (chartOperand.ts)**

In `indicatorToRecipe`, before the generic `sanitizeExtend` branch, special-case the type (its extendData is all render state — colors, toggles, labels — none of it computes, EXCEPT the aggregate membership snapshot):

```ts
if (indType === "CANDLE_PATTERNS") {
  const recipe: IndicatorRecipe = { source: "indicator", indicatorType: "CANDLE_PATTERNS", calcParams: [], line };
  if (line === ANY_BULL_LINE || line === ANY_BEAR_LINE) {
    const dis = ((extendData as CandlePatternsExtend | undefined)?.disabled) ?? {};
    const pol = line === ANY_BULL_LINE ? "bull" : "bear";
    recipe.extend = { members: CANDLE_PATTERN_DEFS.filter((d) => d.polarity === pol && !dis[d.toggle]).map((d) => d.id) };
  }
  return { recipe, timeframe: undefined };
}
```

`recipeLabel`: add `if (t === "CANDLE_PATTERNS") return "Candle Patterns";` alongside the PIVOT_BANDS branch.

- [ ] **Step 4: indicatorOutputs case (chartOperand.ts:205)**

One output per ENABLED pattern (lineIndex = canonical index, so it stays stable when toggles change) plus the two aggregates. `chipLabel` carries the pattern name verbatim (SLOPE precedent: the parent name doesn't distinguish lines):

```ts
case "CANDLE_PATTERNS": {
  const dis = ((ext.disabled ?? {}) as Record<string, boolean>);
  const out: OutputChoice[] = [];
  CANDLE_PATTERN_DEFS.forEach((d, i) => {
    if (!dis[d.toggle]) out.push({ lineIndex: i, label: d.label, chipLabel: d.label });
  });
  out.push({ lineIndex: ANY_BULL_LINE, label: "Any bullish pattern", chipLabel: "Any bullish pattern" });
  out.push({ lineIndex: ANY_BEAR_LINE, label: "Any bearish pattern", chipLabel: "Any bearish pattern" });
  return out;
}
```

- [ ] **Step 5: operandBaseLen case (backtestConfig.ts:418)**

```ts
// Candle Patterns: eps needs 14 TRs (15 bars); the deepest pattern (ladder
// bottom) needs 5. 15 covers both.
if (r.indicatorType === "CANDLE_PATTERNS") return 15;
```

- [ ] **Step 6: Tests**

In `candlePatterns.test.ts`: a parity block asserting the template `calc` hits equal `patternLineSeries` per line for a mixed fixture (both call the shared detector; the test guards drift). In `chartOperand.test.ts`: extend the supported-type test (`chartOperand.test.ts:35`) with `"CANDLE_PATTERNS"`; assert `indicatorToRecipe("CANDLE_PATTERNS", [], {disabled:{kicking:true}}, 24)` snapshots members WITHOUT the kicking patterns; assert per-pattern recipes carry NO extend; assert two aggregate recipes with different member sets hash to different `recipeKey`s.

Run: `cd frontend && npx vitest run src/lib/indicators/candlePatterns.test.ts src/lib/chartOperand.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit` — expected clean (the `SeriesIndicatorType` union widening can surface exhaustive-switch errors elsewhere; fix by adding the new case, never by loosening types).

```bash
git add -A frontend/src/lib
git commit -m "feat(backtest): candle patterns as rule operands (per-pattern + aggregates)"
```

---

### Task 4: Settings panel

**Files:**
- Create: `frontend/src/indicatorSettings/CandlePatternsPanel.tsx`
- Modify: `frontend/src/IndicatorSettings.tsx` (type branch, like the Sessions/PivotBands branches)

**Interfaces:**
- Consumes: `CANDLE_PATTERN_TOGGLES`, `CandlePatternsExtend` from Tasks 1-2.
- Produces: `<CandlePatternsPanel ext={CandlePatternsExtend} onChange={(next: CandlePatternsExtend) => void} />`.

- [ ] **Step 1: Panel component**

Follow `SessionsPanels.tsx` conventions (controlled, writes through `onChange`, shared checkbox/color styles). Content: a "Patterns" grid of 16 checkboxes (label from `CANDLE_PATTERN_TOGGLES`, checked = `!disabled[toggle]`), a "Show labels" checkbox (default on), and three `ColorLineStylePicker`-style color swatches (Bullish / Bearish / Neutral) writing `bullColor`/`bearColor`/`neutralColor`. Reuse the app's shared components (Tooltip/InfoTip per CLAUDE.md; existing color picker; no new one-off widgets).

- [ ] **Step 2: Branch in IndicatorSettings.tsx**

Mirror how `isPivotBands` (IndicatorSettings.tsx:162) and the Sessions panels are wired: when the instance's type is `CANDLE_PATTERNS`, render `CandlePatternsPanel` in the inputs tab, persist edits to the live instance's `extendData` eagerly like the other custom panels. No numeric calcParams.

- [ ] **Step 3: Verify + commit**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib src/indicatorSettings 2>/dev/null || npx vitest run`
Expected: clean typecheck; full vitest suite green.

```bash
git add frontend/src/indicatorSettings/CandlePatternsPanel.tsx frontend/src/IndicatorSettings.tsx
git commit -m "feat(chart): Candle Patterns settings panel (toggles, labels, colors)"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only; fix-forward anything found and commit fixes).

- [ ] **Step 1: Full suite + typecheck**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step 2: Live app check (superpowers:verification-before-completion)**

With the already-running dev server (do NOT kill/restart HMR servers): open the app in the browser, add "Candle Patterns" from the indicator menu (it must appear with title + description), confirm labels render on the candle pane on US100 5-min, open its settings and toggle a pattern off (labels disappear), then open the Backtest panel's rule builder, add a condition from chart operands, and confirm the indicator lists per-pattern entries plus "Any bullish pattern"/"Any bearish pattern". Build the rule `Bearish Engulfing < 1` on long entry and run a short backtest to confirm the series posts without error.

- [ ] **Step 3: Report**

Report actual observed results (screenshots optional). If anything failed, fix and re-verify before claiming done.

---

## Self-review notes

- Spec coverage: detector semantics (Task 1), display (Task 2), operands + aggregate snapshot + warm-up (Task 3), settings (Task 4), parity + golden tests (Tasks 1/3), out-of-scope items untouched. Backend untouched per spec.
- Type names are consistent across tasks (`CANDLE_PATTERN_DEFS`, `patternLineSeries`, `ANY_BULL_LINE`/`ANY_BEAR_LINE`, `CandlePatternsExtend`).
- Known intentional deviation from the backend classifier: the detector reports ALL matches per bar (backend `classify_candle` is first-match). Operands must be independent; the analysis parity requirement is that each analysis pattern's DEFINITION matches, not the first-match arbitration.
