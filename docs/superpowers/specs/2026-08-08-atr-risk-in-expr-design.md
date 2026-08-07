# ATR Risk Stops on the Expression Surface — Design

**Status:** implemented 2026-08-08. Two details differ from the design as first
written; both are marked **[as built]** below.
**Supersedes:** the `atr_risk_unsupported` limitation recorded in
`docs/superpowers/specs/2026-07-21-remove-structured-rule-model-design.md:36`

## Problem

ATR-kind risk stops/targets (`stop.kind` / `target.kind` in `("atr", "trailAtr")`)
are rejected on every expression surface with a 422:

> ATR-based risk stops are not available for expression backtests in this version.

The guard exists for a real reason. The expr surface constructs
`BacktestEngine(..., series={})`, and `BacktestEngine._atr_at` (`engine/backtest.py:351`)
resolves an ATR stop by reading `self.series[f"ATR_{length}"]`. With an empty
series map it returns `None`, `stop_level` produces no stop, and the position
runs **stop-less and silently**. The 422 trades a missing feature for a loud
failure — the right call at the time, but it has been the wrong shape ever since
the structured rule model was removed and expressions became the only rule mode.

There is a second, unguarded instance of the same defect. ATR **scaling spacing**
(`ScalingConfigDTO.spacing.kind == "atr"`) reads the same series map at
`engine/backtest.py:211`. Nothing on the expr path checks it, so an ATR-spaced
scaling config today degrades silently: the spacing gate reads `None` and stops
gating. `ScalingConfigDTO.atr_series_names()` (`api/schemas.py:229`) already
exists and is simply never consulted on this path.

The UI never gated ATR stop kinds on expr mode (`BacktestSettingsModal.tsx:3407`,
`:3459`, `:3526`), so users pick an ATR stop, run, and get the raw 422 back.

## Goal

ATR stops, ATR trailing stops, ATR targets, and ATR scaling spacing work on the
expression surface — single backtest, sweep/WFO, and live evaluate — with no
frontend change and no wire-format change.

## Approach

The backend computes the `ATR_{length}` series it needs from the candles the
request already carries, and passes them to the engine as `series=`.

Two facts make this the cheap, correct option:

- **Lengths are static per request.** The sweep risk-target regex
  (`sweep_apply.py:353`) is `^risk:(long|short)\.(stop|target)\.(value|mult)$` —
  `length` is not sweepable. One series build per request/combo, no per-bar or
  per-combo recompute.
- **Parity is already pinned.** `tests/test_indicator_parity.py:77` asserts
  backend `atr_series(candles, 14)` equals the frontend's `ATR_14` fixture, so
  computing server-side reproduces exactly the array the browser would have
  posted.

Alternatives rejected:

- **Frontend posts the series** (mirroring the coded path, which already builds
  them in `frontend/src/lib/backtestSeries.ts`). Requires a `series` field on
  `ExprBacktestRequest`, ships redundant float arrays over the wire, and the
  sweep-job payload would have to carry them into pool workers — all to
  reproduce a number the backend can compute exactly.
- **Compute lazily inside the engine** when `_atr_at` misses. Buries an
  indicator computation in the execution loop and makes the warm-up failure
  invisible at request time, which is the failure mode this design exists to end.

## Non-goals

- **Risk ATR stays RMA/Wilder, keyed by length only.** `RiskConfigDTO` and
  `SpacingSpecDTO` carry `length` and no smoothing field. Chart pane instances
  (`ATR#id`, with SMA/EMA/WMA smoothing, from the in-flight ATR indicator work in
  `docs/specs/2026-08-07-atr-indicator-design.md`) are **not** referenceable as a
  stop basis. That doc already fixes plain ATR as RMA-only; this design does not
  change it.
- No change to the coded path (`/api/backtest` with `codedStrategy`), which
  continues to require posted ATR series and validate them by name presence
  (`routers/backtest.py:138`).
- No frontend change.

## Architecture

### The shared builder

New leaf module `backend/auto_trader/api/risk_series.py`. One public function and
one exception:

```python
class AtrWarmupError(Exception):
    """An ATR risk/scaling series is still None at the first bar that needs it."""
    def __init__(self, length: int, have: int): ...
    message: str

def build_atr_risk_series(
    candles: Sequence[Candle],
    risks: Iterable[RiskConfigDTO | None],
    scalings: Iterable[ScalingConfigDTO | None],
    ready_index: int,
) -> dict[str, list[float | None]]:
    ...
```

Behavior:

1. Union the names the DTOs already report — `RiskConfigDTO.atr_series_names()`
   (`api/schemas.py:196`) and `ScalingConfigDTO.atr_series_names()`
   (`api/schemas.py:229`) — skipping `None` entries.
2. Parse each `ATR_{n}` name back to its length (or collect lengths directly
   while unioning; the names are the map keys the engine reads).
3. Compute each length **once** with `atr_series(candles, length)` from
   `auto_trader.indicators.core` — the same call `strategy/coded.py:240` makes.
4. Raise `AtrWarmupError(length, have=len(candles))` if any series is `None` at
   `ready_index`.
5. Return `{f"ATR_{n}": series}`.

The exception is a plain `Exception`, not an `HTTPException`, because the three
callers raise different error types. The module imports only schemas, engine
Candle, and `indicators.core` — no router imports, so it stays picklable-safe and
free of the import cycle `routers/expr.py:277` already works around.

### Index alignment

Series span the **full** `req.candles` including warm-up bars, because
`_atr_at` does a raw `arr[i]` against the engine's candle index. This matches
what the frontend's `buildSeries` does for the coded path (base candles, no
slicing).

WFO exact mode is safe with a single build per combo: `sweep_worker.py:128-136`
compiles once via `build_expr_engine` and replays sub-windows by passing
`stop_index` to `engine.run(candles)` — it never slices the candle list, so
indices are stable across every sub-window.

### Warm-up policy: 422, not silent degradation

`atr_series` (`indicators/core.py:176`) leaves indices `0 .. length-2` as `None`
and defines the first value at index `length - 1`. If the requested ATR is not
yet defined at the first bar that needs it, the run would proceed stop-less —
precisely the failure the original guard prevented, just quieter. So it is a 422.

This is deliberately **stricter than the coded path**, which only checks that a
series of the right name is present (`routers/backtest.py:138`) and would happily
accept an all-`None` array. It mirrors `_ensure_htf`'s stated principle
(`routers/expr.py:169`): "a shortfall is a 422, never a silent misrun."
Tightening the coded path to match is out of scope here.

**[as built]** Implementation briefly relaxed this to "undefined across the whole
window" because the strict rule 422s any run whose `tradeFromTime` is the first
candle. That relaxation was reverted: a debug run showed it lets an entry that
fires before the ATR warms carry `stop_initial: None` for the position's entire
life, which is the silent stop-less trade this design exists to prevent (a
bracket is seeded once, at entry — it does not pick up a later-warming ATR). The
usability objection turned out to be a synthetic-test artifact: the frontend
already sizes its history fetch by `riskAtrLengths`/`scalingAtrLengths`
(`frontend/src/lib/backtestWindow.ts:47`), so a real request always carries
`length` bars of warm-up before the window. Tests were updated to post warm-up
bars the way the real client does.

`ready_index` per surface:

| Surface | `ready_index` |
|---|---|
| `POST /api/expr/backtest` | index of the first candle with `time >= req.tradeFromTime` |
| expr sweep / WFO (`build_expr_engine`) | same |
| `POST /api/strategy/evaluate` (`exprMode`) | `len(candles) - 1` (the decision bar) |

Message form:

> not enough history for ATR(500): the ATR is undefined at the first tradeable
> bar (500 bars of warm-up needed, 300 posted). Start the range later or shorten
> the ATR length.

## Call sites

### 1. `routers/expr.py::expr_backtest`

Delete the `atr_risk_unsupported` block (L215–226). After `candles` is built and
before constructing the engine, call `build_atr_risk_series` with
`(req.longRisk, req.shortRisk)`, `(req.longScaling, req.shortScaling)`, and the
first-tradeable index. Pass the result as `series=` at L269 in place of `{}`.

`AtrWarmupError` maps to a 422 preserving the envelope shape this route already
returns and the frontend already parses:

```python
{"code": "atr_warmup", "message": str(e), "start": None, "end": None, "group": None, "row": None}
```

### 2. `sweep_apply.py::build_expr_engine`

Delete the guard (L264–274). Build from the **combo-patched** `long_risk` /
`short_risk` parameters (not `req.longRisk`/`req.shortRisk` — the combo may have
patched `value`/`mult`) plus `req.longScaling` / `req.shortScaling`. Pass at
L332. `AtrWarmupError` maps to `SweepValidationError(422, str(e))`, matching how
every other validation failure on this path is reported.

This runs inside a pool worker; the builder takes candles and DTOs and returns
floats, so nothing unpicklable crosses the boundary.

### 3. `routers/strategy.py::evaluate_strategy`

In the `exprMode` branch, replace the guard (L122–130) with a build using
`ready_index = len(candles) - 1`. The two `_atr(...)` calls at L314 and L317
currently read `req.series` directly; they must read a local series map that is
`req.series` for the non-expr branch and the computed map for `exprMode`.

The non-expr (coded) branch keeps its existing missing-series check (L143–146)
unchanged.

### Scaling spacing

Covered at all three sites by the same builder, since `scalings` is a first-class
parameter. No separate change — the silent-degradation bug is fixed as a
consequence of routing scaling names through the same path as risk names.

## Testing

**Cross-surface equivalence (load-bearing).** Same candles, same `longRisk` with
an `atr` stop: run `/api/backtest` with a frontend-shaped posted `ATR_14` against
a trivial coded strategy, and `/api/expr/backtest` with an equivalent expression
rule computing its own series. Assert identical trades. This is what proves
backend-compute matches what the browser would have shipped, beyond the
element-wise parity `test_indicator_parity.py` already covers.

**Guard removal.** `tests/test_api_expr.py:88` currently asserts
`detail["code"] == "atr_risk_unsupported"`. It inverts: the run succeeds and the
ATR stop actually fires (assert a trade exits on the stop, not merely that the
request 200s). Check `tests/test_api_backtest_sweep.py:180` and
`tests/test_expr_evaluate_api.py` for sibling assertions and flip those too.

**Warm-up 422** on each of the three surfaces: an ATR longer than the posted
history → 422 whose message names the length, plus a boundary case (with 10
warm-up bars, ATR(11) is exactly warm at the first tradeable bar and ATR(12) is
not) and a case proving the check is measured at the first *tradeable* bar rather
than bar 0.

**[as built]** On the sweep surface this is a per-row error, not a submit-time
422: `/api/expr/sweep/jobs` dry-validates combo *shape* at submit, while warm-up
is only knowable at engine build time inside the worker. `AtrWarmupError` →
`SweepValidationError` → the row's `error` field, which is how every other
build-time validation failure already surfaces there. The test asserts the row
error rather than a 422 at submit.

**Scaling spacing.** An expr run with `longScaling.spacing.kind == "atr"` and
`maxConcurrent > 1` now gates the second entry by ATR distance; previously the
gate silently passed. Assert the entry count differs from the ungated run.

**Sweep.** A `risk:long.stop.mult` combo over an ATR stop yields per-combo
varying results — exercises the patched-DTO path (not `req.longRisk`) and
confirms one build per combo.

**Live evaluate.** `exprMode` with an ATR stop returns a populated stop level in
the response rather than 422.

## Documentation

`docs/superpowers/specs/2026-07-21-remove-structured-rule-model-design.md:36`
describes the `atr_risk_unsupported` guard as a standing property of the expr
surface. Add a superseded-by note pointing at this design.

## Risks

- **Behavior change for existing saved configs.** A config with an ATR stop that
  previously 422'd on the expr surface will now run and produce trades. That is
  the intent, but a user who saved such a config and never saw it run will see
  results appear where an error used to be.
- **Stricter than coded on warm-up.** A short-window expr run with a long ATR
  now 422s where the same setup on the coded path would run with an all-`None`
  series. This asymmetry is deliberate and documented above; the coded path is
  the one that is wrong, and tightening it is separate work.
