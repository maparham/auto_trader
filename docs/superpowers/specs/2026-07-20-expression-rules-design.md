# Expression-Based Rule Editor — Design

**Date:** 2026-07-20
**Status:** Approved for planning

## Goal

Replace the structured operand/condition editor with a typed expression language.
Each condition row is a free-form boolean expression such as
`slope(EMA(9), 3) > 0`, `EMA(21) / EMA(9) > 1`,
`EMA(50) > candle.high + 3 * ATR(14)`, `candle[-1].open > candle.open`.
Indicators, candle fields, and helper functions are variables/functions the user
types or drops in from a palette, with autocomplete.

## Decisions (from brainstorming)

- **Native expression AST replaces the structured model.** The dropdown operand
  editor goes away entirely.
- **One expression per condition row.** The row list survives (reorder,
  per-row enable/disable); rows combine exactly as they do today (AND).
- **Sweeps: any numeric literal is sweepable.** No named-parameter syntax.
- **Fresh start.** Existing saved presets are dropped, no converter, no
  legacy/migration code. Archived sweep/WFO configs that reference structured
  rules become unreadable; acceptable.
- **Backend-only evaluation.** One evaluator, in Python. The browser rule-series
  evaluator is deleted (pays off the known browser-eval debt).
- **Invert/mirror rule is dropped.** Short-side rules are written by hand.
- **HTF via postfix `@tf`** on any term.

## Language

### Grammar (per row)

```
row        := comparison
comparison := arith cmpop arith | crossfn "(" arith "," arith ")"
cmpop      := ">" | "<" | ">=" | "<="
crossfn    := crossAbove | crossBelow
arith      := term (("+"|"-") term)*
term       := factor (("*"|"/") factor)*
factor     := number | variable | call | "(" arith ")" | "-" factor
postfix    := X "[" -N "]"        # bar offset, any term
            | X "@" TF            # timeframe pin, any term
```

Standard precedence: `*` `/` over `+` `-`; parentheses group; unary minus
allowed. Whitespace insignificant. Names case-sensitive.

### Variables

- `candle.open .high .low .close .volume .body .range .wickTop .wickBottom`
  — anatomy fields keep the shipped definitions (body = |close−open|,
  range = high−low, wickTop = high−max(o,c), wickBottom = min(o,c)−low).
- `candle` alone is invalid; a field is required.
- `entry` — average entry price; valid only in exit rules (parse error in entry
  rules).

### Functions

- **Indicators** from the existing registry, called with their existing
  parameters: `EMA(9)`, `SMA(20)`, `ATR(14)`, `RSI(14)`, … Multi-output
  indicators expose outputs as fields, e.g. `MACD(12,26,9).signal`.
- **Wrappers**, applicable to any series-valued term:
  - `slope(x, n)` — same semantics as today's slope modifier.
  - `highest(x, n)`, `lowest(x, n)`, `avg(x, n)` — over the last `n` bars
    **including the current bar** (semantic change from the lookback modifier,
    which excluded it; write `highest(x, n)[-1]` to exclude).
- **Crosses**: `crossAbove(a, b)`, `crossBelow(a, b)` — same now/prev semantics
  as the current cross operators; only valid at the top level of a row.

### Postfix operators

- `x[-n]` — value of the term `n` bars back (`n ≥ 1`, integer literal). Applies
  to any term: `candle[-1].open`, `EMA(9)[-2]`, `(EMA(21)/EMA(9))[-3]`.
- `x@TF` — the whole term is computed on timeframe `TF` (from the existing TF
  set), then forward-filled onto the chart TF: `slope(EMA(21),3)@4H`,
  `candle@D.high`. `@tf` on a term nested inside another `@tf` term is a parse
  error.

### Evaluation semantics

- Comparison of arithmetic over aligned per-bar series; vectorized in the
  backend.
- Warm-up: derived from the AST (indicator length + wrapper windows + bar
  offsets, maxed across the row, summed along nesting chains) — same policy the
  structured engine uses today.
- Any `None`/NaN in a row's inputs at a bar → the row is false at that bar
  (poisoning, matching current behavior). Division by zero → NaN → false.
- A cross is true when the standard prev/now straddle holds and all four values
  are defined.

## Architecture

- **Source of truth is the expression text**, stored per row in the backtest
  config. The DTO carries the string (plus row enable flags and sweep ranges).
- **Backend (authoritative):** recursive-descent parser → typed AST →
  validation (unknown names, arity, `entry` placement, `@tf` nesting) →
  compiler that maps each indicator/wrapped/`@tf` term to a cached series
  (reusing the existing `rule_series` caching machinery) → vectorized
  evaluator. Parse/validation errors return structured messages with character
  spans.
- **Frontend (advisory):** a lightweight TS parser used only for inline error
  underlines, autocomplete context, palette insertion, and locating sweepable
  numeric literals. It never evaluates. A shared fixture corpus (expressions →
  expected token/literal spans and error codes) is tested against both parsers
  so their user-visible behavior agrees; the backend remains authoritative on
  disagreement.
- **Overlays/inspector:** new backend endpoint takes an expression (or a row's
  sub-term) + symbol/TF/range and returns the computed series; the chart and
  rule inspector consume it. `frontend/src/lib/backtestSeries.ts` is deleted.

## Editor UX

- **Built on CodeMirror 6**: single-line mode, custom Lezer grammar for
  highlighting, `@codemirror/autocomplete` for suggestions,
  `@codemirror/lint` for error underlines. No Excel-engine library — Excel
  formula libs (HyperFormula etc.) are JS evaluators with cell semantics and
  don't fit backend-Python per-bar evaluation; the CM6 Lezer grammar doubles
  as the frontend's advisory parser.
- Row list unchanged: add/remove/reorder rows, per-row enable toggle.
- Each row is a single-line code input with:
  - syntax highlighting (names, numbers, operators, `@tf`),
  - inline error underline + message from the frontend parser, backend errors
    surfaced on run,
  - subtle underline on numeric literals (sweepable affordance).
- **Autocomplete** (core feature): cursor-anchored dropdown while typing,
  ranked by prefix match.
  - `candle.` → field list; `@` → timeframe list; bare prefix → indicators,
    wrappers, crosses, variables; indicator entries show signature hints
    (`EMA(length)`).
  - Tab/Enter accepts, arrows navigate, Esc dismisses. Accepting an indicator
    inserts it with default args and the first argument selected for overtype
    (`EMA(9)`).
  - Same catalog drives the **palette**: a grouped panel (candle fields,
    indicators, wrappers, crosses, TFs) where click or drag inserts at the
    cursor.

## Sweeps

- The parser reports every numeric literal in a row with a stable id (row id +
  ordinal position in left-to-right token order) and a context label derived
  from the AST: "EMA length" for `EMA(9)`, "multiplier of ATR(14)" for the 3 in
  `3 * ATR(14)`, "threshold" for a bare comparison constant.
- The sweep panel lists these literals per row; assigning a range works as
  sweeping structured params does today. Sweep expansion substitutes values
  into the AST server-side (never string substitution).
- Editing an expression re-anchors literals by ordinal; if the literal count
  changes, ranges on vanished ordinals are dropped with a visible notice.

## What gets deleted

- Structured operand/condition model in `backtestConfig.ts` and its editor UI
  in `BacktestSettingsModal.tsx` (including the slope/lookback/scale modifier
  controls shipped 2026-07-20 — their concepts survive as `slope/highest/
  lowest/avg`, indexing, and arithmetic).
- `frontend/src/lib/backtestSeries.ts` and the series-key grammar + golden
  parity fixture.
- Backend structured-`Operand` evaluation in `strategy/rule.py` (replaced by
  the expression AST), structured DTOs in `api/schemas.py`.
- Invert/mirror rule feature.
- All saved presets referencing structured rules.

## Testing

- **Backend:** parser unit tests (grammar, precedence, spans, every error
  class); evaluator goldens on synthetic candles (each function/wrapper/postfix
  and combinations, warm-up, NaN poisoning, crosses, `@tf` forward-fill);
  sweep-substitution tests; API tests for the eval + overlay endpoints.
- **Frontend:** parser corpus parity (shared fixtures with backend); autocomplete
  context tests; sweep-literal detection/labeling tests; editor component tests.
- **E2E:** type a rule with autocomplete, run a backtest, inspect a trade,
  sweep a literal.

## Out of scope (v1)

- OR/grouping between rows (rows remain AND).
- Boolean operators inside a row (`and`/`or`/`not`).
- User-defined variables/functions or multi-line expressions.
- Mirroring/inversion tooling.
