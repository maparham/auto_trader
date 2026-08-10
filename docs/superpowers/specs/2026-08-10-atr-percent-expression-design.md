# ATR%(length) expression function

**Date:** 2026-08-10
**Status:** Approved

## Goal

Expose the chart legend's ATR% readout (ATR ÷ price × 100) as a first-class
function in the backtest rule expression language, named `ATR%`, usable like
`ATR%(14) < 0.8`.

## Background

The legend's `atrPct` value (`frontend/src/lib/indicators/atr.ts`) is
display-only today; rule authors can only reach the absolute `ATR(length)`.
The expression engine is two hand-written parser stacks (TS `parser.ts` +
Python `lexer.py`/`parser.py`) kept in lockstep by `corpus.json`; highlight.ts
reuses the TS tokenizer, so there are exactly two lexers.

## Design

### Lexing

`%` becomes a legal mid-name character in both lexers, joining `#` in the same
character class (`parser.ts` name loop, `lexer.py::tokenize` name loop). `ATR%`
then lexes as one NAME. `%` stays illegal leading a name and everywhere else —
there is no modulo operator, so nothing conflicts. `foo%bar` becomes an
unknown-name lint diagnostic (same treatment as `foo#bar`), no longer a
`bad_char` lex error.

### Registration

Both stacks are registry-driven; one entry each:

- `frontend/src/lib/expr/catalog.ts`:
  - `INDICATORS`: `{ name: "ATR%", insert: "ATR%(14)", signature: "ATR%(length)", detail: "ATR as % of close" }`
  - `INDICATOR_SPECS["ATR%"] = { arity: 1, argKind: "length" }`
- `backend/auto_trader/strategy/expr/registry.py`:
  - `"ATR%": IndicatorSpec(1, "length")`

Completion, highlighting, linting, literal sweeps, and warmup all key off
these tables generically — no further per-feature wiring.

### Evaluation (backend only)

Expressions evaluate only in `backend/auto_trader/strategy/expr/evaluate.py::_indicator_raw`.
New branch: `atr_series(candles, length)` with each value divided by that
bar's close × 100; `None` when ATR is `None` or close ≤ 0. This mirrors the
legend's defaults: RMA (Wilder) smoothing, close as the divisor.

Deliberate scope limit (matches how `ATR(length)` already behaves): the
function does NOT follow a chart pane's custom Smoothing or ATR%-price-source
settings. A pane configured away from the defaults will read differently from
`ATR%(n)`.

### Warmup

= length, for free via `arg_kind "length"` in both `warmup.py` and the TS
warmup port.

### Tests

- `corpus.json`: valid parse of `ATR%(14) < 0.8`, `ATR%` inside a wrapper
  (`avg(ATR%(14), 5)`), and an error case exercising `%` in a wrong position.
  Corpus parity tests on both stacks pick these up automatically.
- Backend: evaluate test asserting `ATR%(n)` == `ATR(n) / close × 100`
  bar-for-bar, including None propagation.
- Frontend: parser test that `ATR%` lexes/parses as an indicator call.

## Out of scope

- Pane instance refs exposing pct (`ATR1.14pct`)
- A price-source argument (`ATR%(14, hl2)`)
- Frontend expression evaluation (none exists)
