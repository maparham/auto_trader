# Candle patterns as rule operands — design

Date: 2026-08-06
Status: approved

## Motivation

The CANDLE_PATTERNS indicator detects 24 candlestick patterns and draws them on
the chart, but rules cannot reference any of them. `candlePatterns.ts` already
exports the operand machinery (`patternLineSeries`, `ANY_BULL_LINE`,
`ANY_BEAR_LINE`) and its header claims to be "shared by the backtest
rule-operand builder" — but nothing consumes it. The expression catalog has no
pattern function, on either stack.

This wires them in:

```
bullEngulfing(candle)          <- one row
RSI(14) < 30                   <- a second row; rows are ANDed by the group
count(doji(candle), 5) >= 2
bearPattern(candle@4H)
```

(The language has no `and`/`or` operators — conditions are combined by adding
rows to a group, per the 2026-08-04 count/predicates design.)

## Module boundary (the governing constraint)

**All detection logic lives in the indicator modules. The backtest/expr layer
holds no pattern math** — it calls an interface only. This is the convention
`evaluate.py` already follows for EMA/RSI/ATR/AVWAP (`evaluate.py:9-12` imports
from `auto_trader.indicators.core` and `.mtf`).

### Backend interface

New `auto_trader/indicators/candle_patterns.py`, beside `core.py` and `mtf.py`.
Its entire public surface:

```python
CANDLE_PATTERN_DEFS: tuple[CandlePatternDef, ...]   # id, polarity, fn
PATTERN_FNS: dict[str, PatternFn]                    # "bullEngulfing" -> selector
def pattern_series(bars: Sequence[Candle], fn: str) -> list[float]   # 1.0 / 0.0
```

`strategy/expr/` touches only those three names:

- `registry.py` re-exports `tuple(PATTERN_FNS)` so `PREDICATE_FNS` and
  `validate.py` learn the legal names without knowing what a pattern is.
- `evaluate.py` gains one branch that calls `pattern_series`, and nothing else.

A float (1.0/0.0) series rather than bool because it feeds `align_htf_to_base`
unchanged (see HTF alignment below).

### Frontend interface

Logic already lives in `lib/indicators/candlePatterns.ts`; nothing moves. It
gains the two mirroring exports:

```ts
export const PATTERN_PREDICATE_FNS: Record<string, number>  // fn name -> canonical line
export function patternSeriesByFn(bars, fn): number[]        // wraps patternLineSeries
```

`expr/catalog.ts` **derives** its 26 entries by mapping over
`PATTERN_PREDICATE_FNS` rather than hardcoding them, so the name set cannot
drift from the detector.

Note the one import-direction change: `expr/catalog.ts` is currently
dependency-free and will now import from `lib/indicators/candlePatterns.ts`.
That module's only klinecharts imports are type-only, so it stays safe in the
parser's context, and it matches the direction the backend already uses.

## Grammar & AST

No new node type and no grammar change. Pattern predicates ride the existing
`Predicate(fn, candle_expr)` node added by the count/predicates work
(2026-08-04). `PREDICATE_FNS` grows from 2 names to 26; `bullish`/`bearish` are
untouched.

This is what makes the change cheap:

- `checkPredicate` (`parser.ts:428`) / `_check_predicate` (`validate.py:26`)
  already enforce a bare `candle` base wrapped only by offsets and at most one
  `@tf` pin. Only the accepted-name set changes.
- `count(cond, n)` already consumes a condition series, so
  `count(doji(candle), 5) >= 2` works with no count-specific work.
- `highlight.ts:49` and `parser.ts:70` both read `PREDICATE_FNS` from
  `catalog.ts`, so highlighting and parsing follow from the catalog change
  alone. `grammar.lezer` classifies predicates as a group, not by name. (The
  completion list and rule palette do each need a one-line group addition —
  see Files.)

## The 26 names

camelCase, derived from `CANDLE_PATTERN_DEFS` ids:

| def id | predicate | def id | predicate |
|---|---|---|---|
| `bull_engulfing` | `bullEngulfing` | `bear_engulfing` | `bearEngulfing` |
| `pin_top` | `pinTop` | `pin_bottom` | `pinBottom` |
| `doji` | `doji` | `inside` | `insideBar` |
| `outside` | `outsideBar` | `bull_harami` | `bullHarami` |
| `bear_harami` | `bearHarami` | `piercing_line` | `piercingLine` |
| `dark_cloud_cover` | `darkCloudCover` | `morning_star` | `morningStar` |
| `evening_star` | `eveningStar` | `bull_belt_hold` | `bullBeltHold` |
| `bear_belt_hold` | `bearBeltHold` | `three_white_soldiers` | `threeWhiteSoldiers` |
| `three_black_crows` | `threeBlackCrows` | `three_stars_south` | `threeStarsSouth` |
| `stick_sandwich` | `stickSandwich` | `bull_meeting_line` | `bullMeetingLine` |
| `bear_meeting_line` | `bearMeetingLine` | `bull_kicking` | `bullKicking` |
| `bear_kicking` | `bearKicking` | `ladder_bottom` | `ladderBottom` |

Plus two aggregates matching the chart's `ANY_BULL_LINE` / `ANY_BEAR_LINE`:
`bullPattern` (any `polarity === "bull"` def hits) and `bearPattern` (any
`"bear"`). Neutral patterns (`doji`, `insideBar`, `outsideBar`) are in neither
aggregate — same as the chart.

## Semantics

A pattern predicate is true at bar `i` when that pattern's detector fires at
bar `i`. Detection is **independent of the chart indicator's enabled toggles**:
the `disabled` extendData is a display filter, and a rule must mean the same
thing regardless of what the user has drawn.

Unlike the backend's `classify_candle`, which is first-match single-label,
every matching pattern fires independently — `doji(candle)` and
`insideBar(candle)` can both be true on the same bar.

## Evaluation

Today's predicate path is pointwise: `evaluate.py:284-296` derives `open`/
`close` value nodes from `cond.base` and compares them at bar `j`. Multi-bar
patterns cannot work that way — `morningStar` needs bars `j-3..j`. Pattern
predicates therefore take a **series path**:

```
walk base through Offset/Tf     # the walk _check_predicate already does
  -> pick the bar series: pinned HTF candles if @tf, else base candles
  -> pattern_series(bars, fn)   # the only call into the indicator module
  -> align_htf_to_base(...) if pinned
  -> shift by the offset
```

This mirrors `patternLineSeries` on the TS side.

### HTF alignment

`align_htf_to_base(base_times_ms, htf_candles, htf_values, htf_ms)`
(`indicators/mtf.py:13`) accepts `Sequence[float | None]`, so the 1.0/0.0
pattern series feeds straight through and thresholds back to bool. No new
alignment code; `bullEngulfing(candle@4H)` uses the path indicators already
use.

### Warm-up

`warmup_bars` returns **18** base bars for a pattern predicate, plus whatever
offsets add:

- 14 for the epsilon series (`0.05 × SMA14(true range)`)
- 4 for the deepest lookback (`ladderBottom`, which needs `i >= 4`)

Below 14 TRs the detector falls back to `1e-4 × close` for epsilon rather than
erroring, so the difference is signal honesty, not crashes — but 18 is what a
row should demand. Currently `N.Predicate` returns just its base's warm-up
(`warmup.py`), mirrored by `parser.ts::warmupOf`.

## Parity

`candle_patterns.py` is a direct port of `detectAllPatterns`
(`candlePatterns.ts:138-252`): same epsilon series, same `eq()` tolerance, same
per-pattern lookback guards. It is memoized per candle sequence the way the TS
side memoizes on the array reference.

Parity is enforced with a golden fixture, the mechanism this repo already uses
for EMA/RSI/ATR/VWAP (`indicatorParityGolden.test.ts` → `test_indicator_parity.py`):

- `frontend/src/lib/indicators/candlePatternsGolden.test.ts` runs the TS
  detector over deterministic synthetic candles constructed to fire every one
  of the 24 patterns, and writes
  `backend/tests/fixtures/candle_patterns_golden.json`.
- `backend/tests/test_candle_patterns_parity.py` reproduces every bar's hit set
  exactly.

The fixture must be non-vacuous: a test asserts every one of the 24 patterns
fires at least once in it, so a detector that silently never matches cannot
pass.

## Out of scope

- `engine/context_features.py::classify_candle` stays untouched. It is
  first-match single-label, used for trade enrichment, and unifying it with the
  24-pattern detector is unrelated work.
- The chart indicator's rendering and settings are unchanged.

## Testing

| Area | Test |
|---|---|
| Detector parity | golden fixture, TS → Python, all 24 non-vacuous |
| Evaluator | each name fires; offsets; `@tf` pin; `count()` wrapping; aggregates OR their polarity group |
| Validation | pattern predicate rejects a non-candle base, unknown tf; unknown pattern name errors |
| Warm-up | `warmup_bars` and `warmupOf` both return 18, and 18 + n under an offset |
| Catalog | `catalog.ts` entries and `PATTERN_PREDICATE_FNS` agree; frontend and backend name tuples agree |

## Files

**Backend** — `indicators/candle_patterns.py` (new), `strategy/expr/registry.py`,
`nodes.py` (`PREDICATE_FNS`), `evaluate.py`, `warmup.py`, plus
`tests/test_candle_patterns_parity.py` (new) and evaluator/validation tests.

**Frontend** — `lib/indicators/candlePatterns.ts` (two exports),
`lib/expr/catalog.ts` (new `PATTERNS` array + extended `PREDICATE_FNS`),
`lib/expr/parser.ts` (`warmupOf`), plus `candlePatternsGolden.test.ts` (new)
and parser/catalog tests.

`complete.ts` and `RulePalette.tsx` each need **one line**: both enumerate the
catalog's groups by name (`complete.ts:65-68`, `RulePalette.tsx:36-38`), so a
new `PATTERNS` array must be added to each list. 26 entries folded into
`CONDITIONS` instead would bury `count`/`bullish`/`bearish`, so a separate
group is worth the two lines.

`highlight.ts` and `grammar.lezer` need no changes: `highlight.ts:49` reads
`PREDICATE_FNS`, and the grammar classifies predicates as a group rather than
by name.
