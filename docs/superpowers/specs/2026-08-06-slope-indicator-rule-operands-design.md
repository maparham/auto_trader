# Slope indicator as a rule operand — design

Date: 2026-08-06
Status: approved

## Motivation

The SLOPE chart indicator plots the rate of change of a moving average, with a
full settings surface: MA kind, price source, MA-side smoothing, up to five MA
lengths, slope period, units, slope smoothing, an acceleration companion, and an
MTF pin. None of it reaches backtest rules.

Today the expression language offers only `slope(EMA(9), 3)` — a wrapper that
reproduces the pane's default `pctHr` case on an `ema`/`sma` over `close` with no
smoothing, and nothing else. The chart→rule bridge refuses the pane outright:
`chartIndicatorToExprToken` returns `null` for `"SLOPE"`
(`exprChartToken.test.ts:43`).

This makes the configured pane itself referenceable:

```
SLOPE.slope0 > 0.5
SLOPE#a1b2c3.slope1 < 0
crossAbove(SLOPE.accel0, 0)
```

## The governing principle: reference outputs, never restate settings

A rule names an **output of a configured indicator instance**. It never carries
the indicator's parameters. The pane's settings are the single source of truth;
a rule that repeated them would create a second one that silently drifts.

The direct consequence, and the test any part of this design must pass: **change
the pane's MA length from 21 to 50 and every rule referencing it follows, with
nothing to edit.** This is why the reference cannot encode any parameter value —
it rules out `SLOPE(21, 3)`, `SLOPE_21`, and every parameterized variant.

## Module boundary

**All slope math lives in the indicator modules. The backtest/expr layer holds
none of it** — it calls an interface only. This is the same constraint the candle
pattern operands work adopted (`2026-08-06-candle-pattern-rule-operands-design.md`)
and the convention `evaluate.py` already follows for EMA/RSI/ATR/AVWAP.

`strategy/expr/` gains **no** slope-specific branch. It resolves an indicator
reference through a generic registry: given an instance's config and an output
name, ask for a per-bar array and a warm-up count. `evaluate.py` never learns
what a slope is, and a second pickable indicator later means writing one more
indicator module — no expression-layer edit.

### Backend interface

New `auto_trader/indicators/slope.py`, beside `core.py` and `mtf.py`. Its entire
public surface:

```python
@dataclass(frozen=True, slots=True)
class SlopeConfig:
    lengths: tuple[int, ...]          # up to 5 MA lengths
    ma_type: str                      # ema | sma | vwma | evwma
    source: str                       # close | open | high | low | hl2 | hlc3 | ohlc4 | hlcc4
    slope_period: int
    units: str                        # pctHr | pctBar | priceBar
    smoothing: Smoothing | None       # (type, length) — the slope-side smoothing
    show_accel: bool
    accel_period: int
    accel_smoothing: Smoothing | None
    accel_absolute: bool

def slope_outputs(cfg: SlopeConfig) -> tuple[str, ...]
def slope_series(cfg: SlopeConfig, output: str, candles, bar_hours: float) -> list[float | None]
def slope_warmup(cfg: SlopeConfig, output: str) -> int
```

`slope_outputs` is the **only** gate for a legal output name, and it is dynamic:
`slope0..slope{n-1}` for `n = len(cfg.lengths)` (capped at 5, defaulting to
`[9]` — `slopeLengths`, `slope.ts:207`), plus the matching `accel*` names only
when `show_accel` is on. It deliberately excludes `thHi`/`thLo`: those are figure
keys the pane emits (`slopeFigures`) purely to drive the pane's auto-scale, not
data outputs, and threshold guides are out of scope. "Outputs are the pane's
figure keys" is the intuition, not the rule.

A generic descriptor registry sits beside it so the expression layer stays
indicator-agnostic:

```python
# auto_trader/indicators/registry.py (new)
@dataclass(frozen=True, slots=True)
class IndicatorSeriesSpec:
    parse_config: Callable[[dict], object]
    outputs: Callable[[object], tuple[str, ...]]
    series: Callable[[object, str, Sequence[Candle], float], list[float | None]]
    warmup: Callable[[object, str], int]

SERIES_INDICATORS: dict[str, IndicatorSeriesSpec]   # keyed by indicator TYPE, e.g. "SLOPE"
```

`strategy/expr/` touches only `SERIES_INDICATORS`.

### Frontend interface

The math already lives in `lib/indicators/slope.ts` and does not move. It gains
one export mirroring the backend's output enumeration so the pick-from-chart
bridge and the parser agree on legal output names:

```ts
export function slopeOutputs(calcParams, ext: SlopeExtend): string[]
```

`chartIndicatorToExprToken` gains a `SLOPE` case that returns
`` `${instanceId}.${output}` `` — which means its signature grows an instance-id
parameter (today it takes only type/calcParams/extendData).

### Two implementations, one contract

"Logic stays in the indicator" holds **per language**. There is no shared
evaluator: `indicators/slope.ts` computes the pane, `indicators/slope.py`
computes the rule. These are two implementations of one contract, held together
by the golden fixture below — not one implementation. This is stated explicitly
so nobody later reads the constraint as "there should only be one copy."

## Reference syntax

`<instanceId>.<output>`, where the instance id is the existing persisted id
(`mintInstanceId`, `indicators.ts:311`) — `SLOPE` for the first instance,
`SLOPE#a1b2c3` for later ones — and the output is a figure key the pane already
uses.

| Reference | Meaning |
|---|---|
| `SLOPE.slope0` | first MA length's slope line on the first SLOPE pane |
| `SLOPE#a1b2c3.slope1` | second MA length's slope line on another pane |
| `SLOPE.accel0` | the acceleration companion's line 0, for the same parent |

Acceleration hangs off the **parent** id rather than exposing the
`<parent>__accel` companion id. The companion is derived, not independently
configured: `applySlopeAccel` (`indicators.ts:573-624`) spawns it only when the
parent's `showAccel` is on and copies the parent's `calcParams`/`extendData`
wholesale. Referencing `SLOPE__accel` would expose an implementation detail and
give a second name for the same configuration.

A reference composes like any other series operand — offsets, `@tf`, wrappers,
`count`, arithmetic all work unchanged:

```
slope(SLOPE.slope0, 5) > 0
SLOPE.slope0[-1] < SLOPE.slope0
count(SLOPE.slope0 > 0, 10) >= 7
SLOPE.slope0 @1H > 0
```

### Grammar changes

Two, both small:

1. **`#` becomes legal inside a name**, after the first character. The lexer's
   NAME rule (`lexer.py:47-52`, and the TS mirror) extends to accept it, so an
   instance id lexes verbatim with no id↔token mapping table. `#` is otherwise
   unused in the language and currently raises `bad_char`.
2. **A new `IndicatorRef(instance, output)` node**, produced when a NAME that is
   not a registered indicator/wrapper/cross/keyword is followed by `.` and an
   identifier. Output selection reuses the existing `.field` postfix — no new
   token.

`validate.py:107-110` currently raises `field_on_call` for a field on a call
(`EMA(9).signal` → "EMA has no named outputs"). That check is scoped to
`root.name in {*INDICATORS, *WRAPPERS}` and is untouched: an `IndicatorRef` is
not a `Call`.

`grammar.lezer` needs the `#` character added to its `Identifier` token and a
highlight class for refs; `highlight.ts::classify` gains a ref branch.

## Config transport

Every endpoint that accepts expression rows gains an `indicators` map carrying
the saved config of each referenced instance:

```python
class ExprBacktestRequest(BaseModel):
    ...
    indicators: dict[str, IndicatorInstanceDTO] = {}   # instanceId -> {type, calcParams, extendData}
```

Affected: `POST /api/expr/backtest`, `/api/expr/sweep/jobs`,
`/api/expr/walkforward/jobs`, `/api/expr/series`, `/api/expr/closeness`,
`/api/expr/literals` (the last only insofar as it parses rows). The frontend
populates it from `loadIndicatorConfigs(scope)` for exactly the instances the
rows reference.

### Threading the map through the AST walkers

An `IndicatorRef` cannot be evaluated, warmed up, or validated without the
configs, so the map rides alongside `htf` — which is already threaded exactly
this way — through every walker that currently has no config parameter:

| Function | Today | Callers to update |
|---|---|---|
| `evaluate.py::series_of` | `(node, candles, resolution, htf)` | `_cond_matches`, `CompiledRow._val`, `_precompute`, `compile_row` |
| `warmup.py::warmup_bars` | `(node, resolution)` | `compile_row`, `expr.py::_tf_inner_warmup` |
| `validate.py::validate` | `(node, *, is_exit)` | `expr.py::_parse_group` |
| `parser.ts::warmupOf` | `(node, baseSeconds)` | editor lint path |
| `parser.ts` validation pass | — | editor lint path |

This is a cross-cutting signature change, not a leaf addition; the plan should
sequence it as its own step before the ref node is wired up.

The frontend side is the sharper one: the editor's lint and completion paths need
the **live chart's** instance list, not a static catalog import. `catalog.ts`
stays static and dependency-free; the instance list is injected into `parser.ts`
and `complete.ts` at call time from the chart, the same way the editor already
receives its resolution.

**Config, not computed series.** Shipping the frontend's already-computed array
was considered and rejected: backtest, sweep, and walk-forward windows routinely
exceed the chart's loaded candles, and a deployed strategy has no frontend at
all. The backend must be able to recompute over any window.

Deployed strategies persist the same map alongside their rows, so live trading
resolves references identically.

## Python parity port

Because the backend recomputes from config, `indicators/slope.py` is a direct
port of the TS pipeline. Currently Python has none of it — `indicators/core.py`
offers only `ema_series`/`sma_series` over closes.

| TS source | Port |
|---|---|
| `mtf.ts::priceOf` | 7 price sources: open, high, low, hl2, hlc3, ohlc4, hlcc4 (close exists) |
| `mtf.ts::vwma`, `evwma` | volume-weighted MA kinds |
| `slope.ts::slopeWithUnits` | `pctBar`, `priceBar` (`pctHr` exists as `slope_of`) |
| `slope.ts::smoothSeries` | gappy SMA/EMA slope smoothing (`emaGappy`; SMA needs a full window of defined values) |
| `slope.ts::accelSeries` | **absolute** difference, not the percentage renormalization — the slope crosses zero, so dividing by `|prev|` would blow up at the crossing |
| `slope.ts::accelLineSeries` | pipeline order: MA → slope → slope-smoothing → accel → accel-smoothing |

Three semantics that must survive the port verbatim:

- **The MA is taken with the price source only — no MA-side smoothing.**
  `slopeLineSeries` calls `maSeries(candles, maType, length, { source })`
  (`slope.ts:188`), deliberately not passing `ext.smoothing`. That smoothing
  applies to the slope series, after differentiation. Wiring it into `maSeries`
  would silently change every existing pane's values.
- **The accel time base follows the slope's units.** A `pctHr` slope accelerates
  per hour; `pctBar` and `priceBar` accelerate per bar (`slope.ts:168-171`). There
  is no separate accel-units control.
- **A non-positive `accelPeriod` yields an all-undefined series**, not a
  lookahead. `slope.ts:138-141` refuses it explicitly because `slope[i - n2]`
  with `n2 <= 0` would read a future index.

### `accelAbsolute` resolves in favour of what's plotted

`accelAbsolute` makes the companion pane plot `|acceleration|`. Under the
reference-the-output principle it **does** change the rule value for an `accel*`
output — the user picks the line they are looking at, and a rule that quietly
used the signed series would violate the pane↔rule equality this design is built
on. The parent's own signed `slope*` lines are unaffected.

This contradicts the existing comment at `slope.ts:36-43` ("Does not touch the
signed accel rule operand"). That comment documents intent for the
`computeIndicatorRecipe` path, which does not exist — no such function is in the
tree. **Rewriting that comment is part of this work**, so an implementer reading
`slope.ts` does not do the reverse.

## The `barHours` decision

The pane computes `inferBarHours(candles)` — the smallest positive gap across the
loaded chart window, falling back to 1 hour (`slope.ts:56-65`). The backend uses
nominal `resolution_seconds / 3600` (`evaluate.py:40-41`). On clean regular
candles these agree, which means a golden fixture built from clean candles passes
while real usage diverges — and `pctHr` is the **default** unit.

**Canonical definition: nominal seconds derived from the resolution, on both
sides.** It is known to both without inspecting data, independent of how much
history is loaded, and it is already what the existing `slope()` wrapper uses.
`inferBarHours` is replaced by a resolution-driven value.

**Mechanism.** klinecharts' calc signature is `computeSlopeCalc(candles, ind)` —
no resolution is handed in. The value therefore travels on `extendData` as
`barHours`, written by `applyIndicator` when the chart's resolution is known and
on every resolution change. There is precedent in the same file: `units` lives on
`extendData` specifically so it participates in the recipe hash
(`slope.ts:1-6`). `inferBarHours` remains only as the fallback when `barHours` is
absent from a not-yet-migrated stored config.

On the MTF path both sides then land on the HTF's nominal seconds: the pane
computes on native HTF bars (`mtfCoordinator.applySlopeTimeframe`) and the
backend resolves `_tf_hours(tf_res)` for the pinned resolution. The pin agrees by
construction.

Visible consequence: on a window with fewer than 2 bars, or one containing
sub-nominal gaps, the pane's plotted values shift slightly from today's. This is
accepted — it is the case where today's pane value is not reproducible off-chart.

The parity fixture includes a deliberately irregular series so this test can
actually fail if the two definitions drift apart again.

## Warm-up

Warm-up comes from the indicator's config through `slope_warmup`, never from the
expression text — the expression has no numbers in it to read.

```
slope*:  ma_length + slope_period + smoothing_len
accel*:  the above + accel_period + accel_smoothing_len
```

Each smoothing term contributes `length - 1` (it needs a full window of defined
values) and 0 when off. `warmup_bars` / `warmupOf` gain an `IndicatorRef` case
that delegates; offsets and `@tf` continue to apply their existing rules on top
(a pin contributes zero base bars).

## Errors

| Code | When | Message |
|---|---|---|
| `unknown_indicator_ref` | referenced instance is absent from the request's `indicators` map | "No indicator named X on this chart." |
| `unknown_indicator_output` | output name is not one the instance declares (e.g. `.slope3` on a 2-length pane, or `.accel0` with `showAccel` off) | "X has no output Y. Available: …" |

Both are distinct from `unknown_name` so the editor can offer to re-pick from the
chart rather than suggesting a function name.

Deleting a referenced pane therefore surfaces a specific, actionable error rather
than a silent wrong result. Note the known sharp edge of referencing by id:
delete and re-add a pane and it mints a new id, so the rule must be re-picked.

## Testing

| Area | Test |
|---|---|
| Math parity | golden fixture, TS → Python: 4 MA kinds × 7 sources × 3 units × slope smoothing (off/sma/ema) × accel (on/off, signed/absolute), over both a clean and an irregular candle series |
| `barHours` | the irregular series produces identical values on both sides; a test asserts the resolution-derived value is used, not an inferred one |
| Pane ↔ rule | a configured pane's plotted line equals the rule's evaluated series bar-for-bar |
| Lexer/parser | `#` inside a name; `SLOPE.slope0` parses to `IndicatorRef`; refs compose under offset, `@tf`, wrappers, `count`, arithmetic |
| Validation | missing instance → `unknown_indicator_ref`; bad output → `unknown_indicator_output`; `.slope3` on a 2-length pane and `.accel0` with `showAccel` off both rejected; `.thHi` rejected; `EMA(9).signal` still → `field_on_call` |
| Warm-up | `warmup_bars` and `warmupOf` agree for slope and accel outputs, with and without smoothing, and under an offset |
| Transport | referenced instances are collected into the request map; an unreferenced pane is not shipped |
| Bridge | `chartIndicatorToExprToken` emits the right ref for a clicked line; still returns `null` for genuinely unsupported types |
| Boundary | a test asserts `strategy/expr/` contains no import from `indicators.slope` (only from the generic registry) |

The fixture must be non-vacuous: a test asserts every knob combination produces
at least one defined, finite value, so a port that silently returns all-`None`
cannot pass.

## Out of scope

- **Numeric-literal sweeps of slope parameters.** `lit:` targets find no literals
  inside `SLOPE.slope0`; it degrades gracefully to "nothing to sweep" rather than
  breaking. A new `ind:` sweep target that walks indicator configs is a separate
  feature.
- **Threshold guides as operands.** The ±level dotted lines stay visual-only.
- **The `slope(x, n)` wrapper** stays exactly as it is. It remains the way to take
  the slope of an arbitrary expression; this work adds a way to reference a
  configured pane, and the two do not merge.
- **The pane's rendering and settings UI** are unchanged, except that
  `inferBarHours` is replaced by a resolution-driven value.

## Files

**Backend** — `indicators/slope.py` (new), `indicators/registry.py` (new),
`indicators/core.py` (price sources, vwma/evwma), `strategy/expr/lexer.py`
(`#`), `nodes.py` (`IndicatorRef`), `parser.py`, `validate.py`, `evaluate.py`,
`warmup.py`, `errors.py`, `api/schemas.py` (`indicators` map),
`api/routers/expr.py`, plus `tests/test_slope_parity.py` (new) and
parser/validate/warmup/evaluator tests.

**Frontend** — `lib/indicators/slope.ts` (`slopeOutputs`, resolution-driven bar
hours), `lib/exprChartToken.ts` (SLOPE case, instance-id parameter),
`lib/expr/parser.ts` (lexer, `IndicatorRef`, `warmupOf`), `lib/expr/catalog.ts`,
`lib/expr/highlight.ts`, `lib/expr/grammar.lezer`, `lib/expr/complete.ts` (refs
in completion, sourced from live chart instances), `api.ts` (`indicators` map),
`BacktestButton.tsx` (collect referenced instances), plus a golden-fixture
generator test and parser/bridge tests.
