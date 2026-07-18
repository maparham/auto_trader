# Candle Patterns indicator — design

Date: 2026-07-18
Status: approved

## Why

Backtest analysis of the last US100 5-min run showed entries whose signal candle
was a bearish engulfing bar lost consistently (19 trades, 26% win, -430). The
rule engine cannot express candle patterns today (price operands are
current-bar only). Rather than hardcoding a filter, we add a Candle Patterns
chart indicator whose outputs are usable as rule operands via the existing
`series`-operand plumbing — no engine changes.

## What

A new `CANDLE_PATTERNS` custom indicator:

- **Main-pane overlay** (like Time Highlight): draws a small triangle + short
  text label on each matching candle — below the bar (up triangle, bull color)
  for bullish patterns, above the bar (down triangle, bear color) for bearish.
  Neutral patterns (doji, inside, outside) label above the bar in a neutral
  color. Two+ patterns on one bar stack vertically.
- **Patterns (16)** — all individually toggleable, all on by default:
  - From the backtest Analysis classifier (definitions mirrored exactly from
    `backend/auto_trader/engine/context_features.py::classify_candle`):
    bull engulfing, bear engulfing, pin top, pin bottom, doji, inside, outside.
    Engulfing uses the Analysis (body-engulf) definition — NOT the stricter TV
    one — so rules built from Analysis findings translate 1:1.
  - Ported from the TV "Candle Patterns Alert" Pine script (bull/bear variants
    where the script defines both): harami, piercing line / dark cloud cover,
    morning star / evening star, belt hold, three white soldiers / three black
    crows, three stars in the south, stick sandwich, meeting line, kicking,
    ladder bottom.
  - The Pine script's MA-filter option is intentionally dropped (the rule
    builder already does trend filtering better).
- **Rule operands**: in the chart-operand picker the indicator exposes one 0/1
  line per enabled pattern plus two aggregates: "Any bullish pattern" and
  "Any bearish pattern" (OR of the enabled bullish/bearish patterns; neutral
  patterns belong to neither aggregate). Example rule: long entry AND
  `Bear Engulfing < 1`.

## Detection semantics

- Pure function `detectPatterns(bars, enabled)` in
  `frontend/src/lib/indicators/candlePatterns.ts`, shared verbatim by the chart
  `calc` and by `computeIndicatorRecipe` in `backtestSeries.ts` — chart visuals
  and rule series can never disagree.
- Evaluated on **closed bars only**; a pattern needing N prior bars yields 0
  for the first N bars (no lookahead, consistent with other operands).
- The Pine script's exact-equality conditions (`open == low`,
  `close[0] == close[2]`, …) become tolerance comparisons:
  `|a - b| <= 0.05 * ATR(14)` (fallback when ATR is not yet available:
  `0.0001 * close`). `avg(x, y)` ports as the arithmetic mean.
- Multi-bar TV patterns follow the script's bar-index logic verbatim otherwise.

## Integration points

1. `frontend/src/lib/indicators/candlePatterns.ts` — detector + template
   (`series: 'price'`, `figures: []`, custom `draw`), pattern registry with
   id, display label, short chart label, polarity (bull/bear/neutral).
2. `frontend/src/lib/customIndicators.ts` — add to `CustomIndicatorType`,
   `BASE_TEMPLATES`, `OVERLAY_INDICATORS`.
3. `frontend/src/lib/indicatorMeta.ts` — menu title + description.
4. `frontend/src/lib/chartOperand.ts` — `indicatorOutputs` case: one output per
   enabled pattern + the two aggregates; `indicatorToRecipe` handling.
5. `frontend/src/lib/backtestSeries.ts` — `computeIndicatorRecipe` case +
   `LINE_KEYS` entries, emitting 0/1 arrays from the shared detector.
6. `frontend/src/IndicatorSettings.tsx` + a small
   `indicatorSettings/CandlePatternsPanel.tsx` — per-pattern checkboxes
   (grouped bullish / bearish / neutral), show-labels toggle, bull/bear/neutral
   colors.
7. Backend: none. `series` operands are posted arrays; the engine consumes
   them generically.

Settings live in the instance's `extendData`/`calcParams` like other custom
indicators, so presets/defaults (per-type Defaults menu) work unchanged.

## Error handling

- Pattern series for a disabled pattern are simply absent from the picker;
  an existing rule referencing a since-disabled pattern still works because the
  recipe re-enables computation for that seriesKey (a per-pattern recipe
  carries the pattern id, not the enable-set). An aggregate operand's recipe
  snapshots the list of member pattern ids at rule-creation time, so later
  toggling patterns on the chart never silently changes an existing rule.
- Bars with zero range (high == low) match nothing except where the definition
  explicitly allows it; guard against divide-by-zero in ratio checks.

## Testing

- Vitest golden fixtures: per pattern, a hand-built bar sequence that must
  trigger it and near-miss sequences that must not (tolerance boundary cases
  for the ported equality checks).
- Parity: assert the chart `calc` output equals the `computeIndicatorRecipe`
  series for a fixture (both call the shared detector; test guards against
  future drift).
- Aggregate lines: any-bullish/any-bearish equal the OR of member patterns.

## Out of scope

- MA filter from the Pine script.
- Server-side recompute of pattern series.
- Alerts on pattern occurrence (chart alerts can be added later; the indicator
  emits ordinary series so nothing blocks it).
