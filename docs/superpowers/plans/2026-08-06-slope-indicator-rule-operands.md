# SLOPE Indicator as a Rule Operand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a backtest rule reference a configured SLOPE pane's output — `SLOPE.slope0 > 0.5` — so the rule follows the pane's settings with nothing to edit.

**Architecture:** A rule names an *output of an instance*, never a parameter. The expression layer resolves `IndicatorRef(instance, output)` through a generic descriptor registry and holds no slope math; all of it lives in `indicators/slope.ts` (pane) and a new `indicators/slope.py` (rule), held in parity by a golden fixture. Instance configs ride to the backend on the request, alongside the candles.

**Tech Stack:** Python 3 / FastAPI / pytest (backend); TypeScript / React / vitest / CodeMirror + Lezer (frontend); klinecharts for the chart.

**Spec:** `docs/superpowers/specs/2026-08-06-slope-indicator-rule-operands-design.md`

## Global Constraints

- **`strategy/expr/` contains no slope math and no slope-specific branch.** It may import only from `auto_trader.indicators.registry`. A test enforces this (Task 13).
- **Parity is operation-for-operation.** Do not "improve" arithmetic in the Python port — no replacing a running accumulator with `sum(window)/n`. Both runtimes are IEEE-754 float64 and identical operation order is what makes the parity suite exact. This convention is stated in `backend/auto_trader/indicators/core.py:1-16`; follow it.
- **Every ported function returns a list the same length as its input,** `None` where the TS emits `undefined`.
- **No lookahead:** values at index `i` depend only on inputs `[0..i]`.
- **`bar_hours` is nominal**, derived from the resolution (`resolution_seconds / 3600`) — never inferred from candle gaps, on either side.
- **Names must match across the two languages:** TS `slopeLineSeries` ↔ Python `slope_line_series`, TS `accelSeries` ↔ Python `accel_series`, etc. (camelCase ↔ snake_case of the same word).
- Backend tests: `cd backend && python -m pytest`. Frontend tests: `cd frontend && npx vitest run`.
- Commit after every task.

## File Structure

**Backend (new)**
- `auto_trader/indicators/slope.py` — the entire slope pipeline + `SlopeConfig`. ~200 lines.
- `auto_trader/indicators/registry.py` — `IndicatorSeriesSpec`, `SERIES_INDICATORS`. The only thing `strategy/expr/` imports. ~40 lines.
- `tests/test_slope_parity.py`, `tests/test_indicator_ref.py`, `tests/test_expr_boundary.py`.

**Backend (modified)**
- `indicators/core.py` — price sources, `vwma_series`, `evwma_series`.
- `strategy/expr/{lexer,nodes,parser,validate,evaluate,warmup,errors}.py` — the ref node and the config threading.
- `api/schemas.py`, `api/routers/expr.py` — transport.

**Frontend (new)**
- `src/lib/indicators/slopeParityGolden.test.ts` — fixture generator.

**Frontend (modified)**
- `lib/indicators/slope.ts` — `slopeOutputs`, `barHours` from extendData.
- `lib/exprChartToken.ts` — SLOPE case.
- `lib/expr/{parser,catalog,highlight,complete,grammar.lezer}.ts` — ref parsing/highlighting/completion.
- `lib/indicators.ts` — write `barHours` into extendData.
- `api.ts`, `BacktestButton.tsx` — collect and ship instance configs.

---

### Task 1: Price sources and volume-weighted MAs in Python

Ports `mtf.ts::priceOf`, `vwma`, and `evwma`. No slope yet.

**Files:**
- Modify: `backend/auto_trader/indicators/core.py`
- Test: `backend/tests/test_indicator_parity.py` (new cases appended in Task 3; unit tests here)
- Create: `backend/tests/test_ma_kinds.py`

**Interfaces:**
- Consumes: `Candle` from `auto_trader.core.models` (fields `open/high/low/close/volume/time`).
- Produces:
  - `price_of(c: Candle, src: str) -> float`
  - `PRICE_SOURCES: tuple[str, ...]`
  - `vwma_series(candles: Sequence[Candle], prices: Sequence[float], length: int) -> list[float | None]`
  - `evwma_series(candles: Sequence[Candle], prices: Sequence[float], length: int) -> list[float | None]`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_ma_kinds.py`:

```python
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    PRICE_SOURCES, evwma_series, price_of, vwma_series,
)


def mk(n, vols=None):
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(
            time=t0 + timedelta(hours=i),
            open=100.0 + i, high=102.0 + i, low=99.0 + i, close=101.0 + i,
            volume=(vols[i] if vols else 10.0),
        )
        for i in range(n)
    ]


def test_price_sources_cover_the_chart_set():
    assert PRICE_SOURCES == (
        "close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4",
    )


def test_price_of_each_source():
    c = mk(1)[0]  # o=100 h=102 l=99 c=101
    assert price_of(c, "open") == 100.0
    assert price_of(c, "high") == 102.0
    assert price_of(c, "low") == 99.0
    assert price_of(c, "close") == 101.0
    assert price_of(c, "hl2") == (102.0 + 99.0) / 2
    assert price_of(c, "hlc3") == (102.0 + 99.0 + 101.0) / 3
    assert price_of(c, "ohlc4") == (100.0 + 102.0 + 99.0 + 101.0) / 4
    assert price_of(c, "hlcc4") == (102.0 + 99.0 + 101.0 + 101.0) / 4


def test_price_of_unknown_source_falls_back_to_close():
    assert price_of(mk(1)[0], "nonsense") == 101.0


def test_vwma_warms_up_then_equals_the_weighted_mean():
    candles = mk(4, vols=[1.0, 2.0, 3.0, 4.0])
    prices = [c.close for c in candles]  # 101, 102, 103, 104
    out = vwma_series(candles, prices, 2)
    assert out[0] is None
    assert out[1] == (101.0 * 1 + 102.0 * 2) / 3
    assert out[2] == (102.0 * 2 + 103.0 * 3) / 5
    assert out[3] == (103.0 * 3 + 104.0 * 4) / 7


def test_vwma_is_none_when_the_whole_window_has_no_volume():
    candles = mk(3, vols=[0.0, 0.0, 5.0])
    prices = [c.close for c in candles]
    out = vwma_series(candles, prices, 2)
    assert out[1] is None          # both bars volumeless
    assert out[2] is not None      # one volume-carrying bar in the window


def test_vwma_length_below_one_is_all_none():
    candles = mk(3)
    assert vwma_series(candles, [c.close for c in candles], 0) == [None] * 3


def test_evwma_seeds_from_price_not_zero():
    candles = mk(3, vols=[1.0, 1.0, 1.0])
    prices = [c.close for c in candles]
    out = evwma_series(candles, prices, 2)
    assert out[0] is None
    assert out[1] == 102.0         # seeds from the source price, no zero-ramp
    nbfs = 2.0
    assert out[2] == (102.0 * (nbfs - 1.0) + 1.0 * 103.0) / nbfs


def test_evwma_reseeds_after_a_volumeless_window():
    candles = mk(4, vols=[1.0, 0.0, 0.0, 2.0])
    prices = [c.close for c in candles]
    out = evwma_series(candles, prices, 2)
    assert out[2] is None          # window [0,0] has no volume
    assert out[3] == 104.0         # recursion re-seeds from price
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_ma_kinds.py -v`
Expected: FAIL — `ImportError: cannot import name 'PRICE_SOURCES'`

- [ ] **Step 3: Implement**

Append to `backend/auto_trader/indicators/core.py`:

```python
# Price sources, ported from mtf.ts priceOf. Order matters only for the tuple's
# use as a validation/error message list; "close" first because it is the default.
PRICE_SOURCES: tuple[str, ...] = (
    "close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4",
)


def price_of(c: Candle, src: str) -> float:
    """mtf.ts `priceOf`. Unknown sources fall back to close, matching the TS
    switch's `default` arm — a stored config with a stale source must not crash."""
    if src == "open":
        return c.open
    if src == "high":
        return c.high
    if src == "low":
        return c.low
    if src == "hl2":
        return (c.high + c.low) / 2
    if src == "hlc3":
        return (c.high + c.low + c.close) / 3
    if src == "ohlc4":
        return (c.open + c.high + c.low + c.close) / 4
    if src == "hlcc4":
        return (c.high + c.low + c.close + c.close) / 4
    return c.close


def vwma_series(
    candles: Sequence[Candle], prices: Sequence[float], length: int
) -> list[float | None]:
    """mtf.ts `vwma`: rolling sum(price*vol)/sum(vol). The subtractive rolling
    sums accumulate float residue, so a separate INTEGER count of
    volume-carrying bars is the emptiness test, not `v == 0` — otherwise a tiny
    residue would divide into garbage."""
    out: list[float | None] = [None] * len(prices)
    if length < 1:
        return out
    pv = 0.0
    v = 0.0
    nz = 0
    for i in range(len(prices)):
        vol = candles[i].volume or 0.0
        pv += prices[i] * vol
        v += vol
        if vol > 0:
            nz += 1
        if i >= length:
            old_vol = candles[i - length].volume or 0.0
            pv -= prices[i - length] * old_vol
            v -= old_vol
            if old_vol > 0:
                nz -= 1
        if i >= length - 1 and nz > 0:
            out[i] = pv / v
    return out


def evwma_series(
    candles: Sequence[Candle], prices: Sequence[float], length: int
) -> list[float | None]:
    """mtf.ts `evwma`: LazyBear's elastic volume-weighted MA. Seeds from the
    source PRICE at the first usable bar (not Pine's nz->0, which draws a
    near-zero ramp). A zero-volume WINDOW is undefined and re-seeds after."""
    out: list[float | None] = [None] * len(prices)
    if length < 1:
        return out
    nbfs = 0.0
    nz = 0
    prev: float | None = None
    for i in range(len(prices)):
        vol = candles[i].volume or 0.0
        nbfs += vol
        if vol > 0:
            nz += 1
        if i >= length:
            old_vol = candles[i - length].volume or 0.0
            nbfs -= old_vol
            if old_vol > 0:
                nz -= 1
        if i < length - 1:
            continue
        if nz <= 0:
            prev = None
            continue
        prev = prices[i] if prev is None else (prev * (nbfs - vol) + vol * prices[i]) / nbfs
        out[i] = prev
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_ma_kinds.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 5: Run the existing suite for regressions**

Run: `cd backend && python -m pytest -q`
Expected: PASS — no existing behavior changed, only additions.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/indicators/core.py backend/tests/test_ma_kinds.py
git commit -m "feat(indicators): price sources and volume-weighted MAs in Python"
```

---

### Task 2: The Python slope pipeline

The whole indicator, ported. Still no expression-layer contact.

**Files:**
- Create: `backend/auto_trader/indicators/slope.py`
- Create: `backend/tests/test_slope_indicator.py`

**Interfaces:**
- Consumes: `price_of`, `vwma_series`, `evwma_series` (Task 1); `ema_series`, `sma_series` from `indicators/core.py`.
- Produces:
  - `Smoothing = tuple[str, int] | None` (`("sma" | "ema" | "none", length)`)
  - `SlopeConfig` frozen dataclass with fields `lengths: tuple[int, ...]`, `ma_type: str`, `source: str`, `slope_period: int`, `units: str`, `smoothing: Smoothing`, `show_accel: bool`, `accel_period: int`, `accel_smoothing: Smoothing`, `accel_absolute: bool`, `timeframe: str | None`
  - `parse_slope_config(calc_params: list, extend_data: dict) -> SlopeConfig`
  - `slope_outputs(cfg: SlopeConfig) -> tuple[str, ...]`
  - `slope_series(cfg, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]`
  - `slope_warmup(cfg, output: str) -> int`
  - Internals later tasks do NOT call: `ma_base`, `slope_with_units`, `smooth_series`, `accel_series`, `slope_line_series`, `accel_line_series`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_slope_indicator.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.slope import (
    SlopeConfig, accel_series, parse_slope_config, slope_outputs,
    slope_series, slope_warmup, slope_with_units, smooth_series,
)


def mk(n):
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=100.0 + i, high=101.0 + i,
               low=99.0 + i, close=100.0 + i, volume=10.0)
        for i in range(n)
    ]


def cfg(**kw):
    base = dict(
        lengths=(3,), ma_type="ema", source="close", slope_period=2,
        units="pctHr", smoothing=None, show_accel=False, accel_period=2,
        accel_smoothing=None, accel_absolute=False, timeframe=None,
    )
    base.update(kw)
    return SlopeConfig(**base)


# --- slope_with_units --------------------------------------------------------

def test_slope_units_price_bar():
    raw = [10.0, 12.0, 14.0, 16.0]
    assert slope_with_units(raw, 2, 1.0, "priceBar") == [None, None, 2.0, 2.0]


def test_slope_units_pct_bar_and_pct_hr_differ_by_bar_hours():
    raw = [10.0, 10.0, 20.0]
    per_bar = slope_with_units(raw, 2, 4.0, "pctBar")
    per_hr = slope_with_units(raw, 2, 4.0, "pctHr")
    assert per_bar[2] == pytest.approx((20.0 - 10.0) / 10.0 / 2 * 100)
    assert per_hr[2] == pytest.approx(per_bar[2] / 4.0)


def test_slope_is_none_on_a_zero_denominator_except_price_bar():
    raw = [0.0, 5.0]
    assert slope_with_units(raw, 1, 1.0, "pctHr")[1] is None
    assert slope_with_units(raw, 1, 1.0, "priceBar")[1] == 5.0


def test_slope_passes_none_inputs_through():
    assert slope_with_units([None, 1.0, 2.0], 1, 1.0, "priceBar") == [None, None, 1.0]


# --- smooth_series -----------------------------------------------------------

def test_smoothing_none_returns_the_input_unchanged():
    v = [1.0, 2.0, None]
    assert smooth_series(v, None) == v
    assert smooth_series(v, ("none", 5)) == v
    assert smooth_series(v, ("sma", 1)) == v   # length <= 1 is a no-op


def test_sma_smoothing_needs_a_full_window_of_defined_values():
    assert smooth_series([1.0, 2.0, 3.0], ("sma", 2)) == [None, 1.5, 2.5]
    assert smooth_series([1.0, None, 3.0], ("sma", 2)) == [None, None, None]


def test_ema_smoothing_is_gappy_none_passes_through_and_does_not_reset():
    out = smooth_series([None, 4.0, 6.0], ("ema", 3))
    assert out[0] is None
    assert out[1] == 4.0
    assert out[2] == pytest.approx(6.0 * 0.5 + 4.0 * 0.5)


# --- accel_series ------------------------------------------------------------

def test_accel_is_an_absolute_difference_not_a_percentage():
    # -1 -> +1 must not blow up the way a /|prev| renormalization would.
    # (1 - (-1)) / (n2=2 * 1) == 1.0, a finite number; the percentage form
    # would divide by |prev| == 1 near a sign flip and diverge as prev -> 0.
    assert accel_series([-1.0, 0.0, 1.0], 2, 1.0, False)[2] == 1.0


def test_accel_divides_by_hours_when_the_slope_is_per_hour():
    assert accel_series([0.0, 0.0, 4.0], 2, 2.0, True)[2] == 1.0


def test_non_positive_accel_period_is_refused_not_lookahead():
    assert accel_series([1.0, 2.0, 3.0], 0, 1.0, False) == [None, None, None]
    assert accel_series([1.0, 2.0, 3.0], -1, 1.0, False) == [None, None, None]


# --- outputs / config --------------------------------------------------------

def test_outputs_track_the_configured_lengths():
    assert slope_outputs(cfg(lengths=(9, 21))) == ("slope0", "slope1")


def test_outputs_include_accel_only_when_enabled():
    assert slope_outputs(cfg(lengths=(9,), show_accel=True)) == ("slope0", "accel0")


def test_outputs_never_include_the_threshold_figure_keys():
    assert "thHi" not in slope_outputs(cfg(show_accel=True))
    assert "thLo" not in slope_outputs(cfg(show_accel=True))


def test_parse_defaults_match_the_pane_defaults():
    c = parse_slope_config([], {})
    assert c.lengths == (9,)          # slopeLengths default
    assert c.ma_type == "ema"
    assert c.source == "close"
    assert c.slope_period == 3
    assert c.units == "pctHr"
    assert c.smoothing is None
    assert c.show_accel is False


def test_parse_caps_lengths_at_five_and_drops_garbage():
    c = parse_slope_config([1, 2, 0, 3, 4, 5, 6, "x"], {})
    assert c.lengths == (1, 2, 3, 4, 5)


def test_parse_coerces_an_unknown_ma_type_to_ema():
    assert parse_slope_config([9], {"maType": "nonsense"}).ma_type == "ema"


# --- series / warmup ---------------------------------------------------------

def test_slope_series_rejects_an_unknown_output():
    with pytest.raises(KeyError):
        slope_series(cfg(), "slope7", mk(20), 1.0)


def test_slope_series_produces_defined_values_after_warmup():
    out = slope_series(cfg(lengths=(3,), slope_period=2), "slope0", mk(20), 1.0)
    assert len(out) == 20
    assert out[-1] is not None


def test_accel_absolute_makes_the_accel_output_non_negative():
    candles = mk(40)
    signed = slope_series(cfg(lengths=(3,), show_accel=True), "accel0", candles, 1.0)
    absolute = slope_series(
        cfg(lengths=(3,), show_accel=True, accel_absolute=True), "accel0", candles, 1.0
    )
    assert all(v is None or v >= 0 for v in absolute)
    assert [None if v is None else abs(v) for v in signed] == absolute


def test_warmup_sums_the_pipeline_lengths():
    assert slope_warmup(cfg(lengths=(9,), slope_period=3), "slope0") == 12
    assert slope_warmup(cfg(lengths=(9,), slope_period=3, smoothing=("sma", 5)), "slope0") == 16
    assert slope_warmup(
        cfg(lengths=(9,), slope_period=3, show_accel=True, accel_period=4), "accel0"
    ) == 16
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_slope_indicator.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.indicators.slope'`

- [ ] **Step 3: Implement**

Create `backend/auto_trader/indicators/slope.py`:

```python
"""Slope of a moving average, ported operation-for-operation from
frontend/src/lib/indicators/slope.ts so a rule operand equals the plotted line.

Pipeline, in this exact order (slope.ts:151-173):
    MA (price source only, NO MA-side smoothing)
      -> slope (units)
      -> slope smoothing
      -> accel (absolute difference)
      -> accel smoothing
      -> optional absolute value

`bar_hours` is the NOMINAL bar width from the resolution, never inferred from
candle gaps — the same number the frontend now puts on extendData. See the
design doc's barHours section.

Do NOT "improve" the arithmetic; see indicators/core.py's header."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    ema_series, evwma_series, price_of, sma_series, vwma_series,
)

MA_KINDS: tuple[str, ...] = ("ema", "sma", "vwma", "evwma")
SLOPE_UNITS: tuple[str, ...] = ("pctHr", "pctBar", "priceBar")
SMOOTHING_KINDS: tuple[str, ...] = ("none", "sma", "ema")
MAX_LENGTHS = 5

# ("sma" | "ema" | "none", length); None means off.
Smoothing = tuple[str, int] | None


@dataclass(frozen=True, slots=True)
class SlopeConfig:
    lengths: tuple[int, ...]
    ma_type: str
    source: str
    slope_period: int
    units: str
    smoothing: Smoothing
    show_accel: bool
    accel_period: int
    accel_smoothing: Smoothing
    accel_absolute: bool
    timeframe: str | None


def _smoothing_of(raw: object) -> Smoothing:
    """extendData stores {type, length}; anything else is off."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in SMOOTHING_KINDS or kind == "none":
        return None
    try:
        length = int(raw.get("length") or 0)
    except (TypeError, ValueError):
        return None
    return None if length <= 1 else (kind, length)


def _lengths_of(calc_params: object) -> tuple[int, ...]:
    """slope.ts `slopeLengths`: finite non-zero numbers, first 5; else [9]."""
    xs: list[int] = []
    for v in calc_params if isinstance(calc_params, (list, tuple)) else ():
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if n == n and n not in (float("inf"), float("-inf")) and n != 0:
            xs.append(int(n))
    return tuple(xs[:MAX_LENGTHS]) if xs else (9,)


def parse_slope_config(calc_params: object, extend_data: object) -> SlopeConfig:
    ext = extend_data if isinstance(extend_data, dict) else {}
    ma_type = ext.get("maType")
    units = ext.get("units")
    source = ext.get("source")
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    try:
        slope_period = int(ext.get("slopePeriod") or 0) or 3
    except (TypeError, ValueError):
        slope_period = 3
    try:
        accel_period = int(ext.get("accelPeriod") or 0) or 3
    except (TypeError, ValueError):
        accel_period = 3
    return SlopeConfig(
        lengths=_lengths_of(calc_params),
        ma_type=ma_type if ma_type in MA_KINDS else "ema",
        source=source if isinstance(source, str) else "close",
        slope_period=slope_period,
        units=units if units in SLOPE_UNITS else "pctHr",
        smoothing=_smoothing_of(ext.get("smoothing")),
        show_accel=bool(ext.get("showAccel")),
        accel_period=accel_period,
        accel_smoothing=_smoothing_of(ext.get("accelSmoothing")),
        accel_absolute=bool(ext.get("accelAbsolute")),
        timeframe=(mtf.get("timeframe") or None),
    )


def slope_outputs(cfg: SlopeConfig) -> tuple[str, ...]:
    """The pane's DATA outputs. Excludes thHi/thLo: those are figure keys the
    pane emits only to drive its y-axis auto-scale, not values a rule may read."""
    lines = tuple(f"slope{i}" for i in range(len(cfg.lengths)))
    if not cfg.show_accel:
        return lines
    return lines + tuple(f"accel{i}" for i in range(len(cfg.lengths)))


def ma_base(
    candles: Sequence[Candle], ma_type: str, length: int, source: str
) -> list[float | None]:
    """mtf.ts `maSeries` called with { source } ONLY — slopeLineSeries
    (slope.ts:188) deliberately does not pass ext.smoothing here. That smoothing
    applies to the slope, after differentiation."""
    prices = [price_of(c, source) for c in candles]
    if ma_type == "sma":
        return sma_series(prices, length)
    if ma_type == "vwma":
        return vwma_series(candles, prices, length)
    if ma_type == "evwma":
        return evwma_series(candles, prices, length)
    return ema_series(prices, length)


def slope_with_units(
    raw: Sequence[float | None], n: int, bar_hours: float, units: str
) -> list[float | None]:
    """slope.ts `slopeWithUnits`:
        pctBar   = (v - prev) / |prev| / n * 100
        pctHr    = (v - prev) / |prev| / (n * bar_hours) * 100
        priceBar = (v - prev) / n
    None for the first n bars, where raw is None, or on a zero denominator
    (priceBar has no denominator, so a zero prev is fine there)."""
    out: list[float | None] = [None] * len(raw)
    for i, v in enumerate(raw):
        if i < n or v is None:
            continue
        prev = raw[i - n]
        if prev is None:
            continue
        if units == "priceBar":
            out[i] = (v - prev) / n
            continue
        if prev == 0:
            continue
        denom = n * bar_hours if units == "pctHr" else n
        out[i] = (v - prev) / abs(prev) / denom * 100
    return out


def smooth_series(
    values: Sequence[float | None], s: Smoothing
) -> list[float | None]:
    """slope.ts `smoothSeries`. SMA needs a full window of DEFINED values; EMA is
    the gappy variant (mtf.ts emaGappy) — None passes through and does NOT reset
    the accumulator."""
    if s is None or s[0] == "none" or s[1] <= 1:
        return list(values)
    kind, length = s
    if kind == "ema":
        k = 2 / (length + 1)
        out: list[float | None] = []
        prev: float | None = None
        for v in values:
            if v is None:
                out.append(None)
                continue
            prev = v if prev is None else v * k + prev * (1 - k)
            out.append(prev)
        return out
    out = [None] * len(values)
    for i in range(len(values)):
        if i < length - 1:
            continue
        total = 0.0
        ok = True
        for j in range(i - length + 1, i + 1):
            v = values[j]
            if v is None:
                ok = False
                break
            total += v
        if ok:
            out[i] = total / length
    return out


def accel_series(
    slope: Sequence[float | None], n2: int, bar_hours: float, per_hour: bool
) -> list[float | None]:
    """slope.ts `accelSeries`: ABSOLUTE difference, not the percentage
    renormalization slope_with_units applies — the slope crosses zero, so
    dividing by |prev| would blow up at the crossing.

    A non-positive n2 would make slope[i - n2] read a FUTURE index, a silent
    lookahead. Refuse with an all-None series."""
    if not n2 >= 1:
        return [None] * len(slope)
    out: list[float | None] = [None] * len(slope)
    for i, v in enumerate(slope):
        if i < n2 or v is None:
            continue
        prev = slope[i - n2]
        if prev is None:
            continue
        denom = n2 * (bar_hours if per_hour else 1)
        if denom == 0:
            continue
        out[i] = (v - prev) / denom
    return out


def slope_line_series(
    candles: Sequence[Candle], cfg: SlopeConfig, length: int, bar_hours: float
) -> list[float | None]:
    """slope.ts `slopeLineSeries`: MA -> slope (units) -> slope smoothing."""
    base = ma_base(candles, cfg.ma_type, length, cfg.source)
    raw = slope_with_units(base, cfg.slope_period, bar_hours, cfg.units)
    return smooth_series(raw, cfg.smoothing)


def accel_line_series(
    candles: Sequence[Candle], cfg: SlopeConfig, length: int, bar_hours: float
) -> list[float | None]:
    """slope.ts `accelLineSeries`. The accel TIME BASE follows the slope's units:
    a pctHr slope accelerates per hour; pctBar and priceBar accelerate per bar.
    That is why there is no separate accel-units control."""
    slope = slope_line_series(candles, cfg, length, bar_hours)
    accel = accel_series(slope, cfg.accel_period, bar_hours, cfg.units == "pctHr")
    out = smooth_series(accel, cfg.accel_smoothing)
    if cfg.accel_absolute:
        return [None if v is None else abs(v) for v in out]
    return out


def slope_series(
    cfg: SlopeConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    if output not in slope_outputs(cfg):
        raise KeyError(output)
    idx = int(output.removeprefix("accel").removeprefix("slope"))
    length = cfg.lengths[idx]
    if output.startswith("accel"):
        return accel_line_series(candles, cfg, length, bar_hours)
    return slope_line_series(candles, cfg, length, bar_hours)


def _smoothing_warmup(s: Smoothing) -> int:
    return 0 if s is None else max(0, s[1] - 1)


def slope_warmup(cfg: SlopeConfig, output: str) -> int:
    if output not in slope_outputs(cfg):
        raise KeyError(output)
    idx = int(output.removeprefix("accel").removeprefix("slope"))
    n = cfg.lengths[idx] + cfg.slope_period + _smoothing_warmup(cfg.smoothing)
    if output.startswith("accel"):
        n += cfg.accel_period + _smoothing_warmup(cfg.accel_smoothing)
    return n
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_slope_indicator.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/slope.py backend/tests/test_slope_indicator.py
git commit -m "feat(indicators): Python slope pipeline ported from slope.ts"
```

---

### Task 3: Golden-fixture parity, TS → Python

The gate that keeps the two implementations equal. The fixture deliberately includes an irregular candle series so a `bar_hours` divergence can fail the test.

**Files:**
- Create: `frontend/src/lib/indicators/slopeParityGolden.test.ts`
- Create: `backend/tests/fixtures/slope_golden.json` (generated)
- Create: `backend/tests/test_slope_parity.py`

**Interfaces:**
- Consumes: TS `slopeLineSeries`, `accelLineSeries` (`lib/indicators/slope.ts`); Python `SlopeConfig`, `slope_line_series`, `accel_line_series` (Task 2).
- Produces: `backend/tests/fixtures/slope_golden.json` with shape
  `{ candles: [...], irregularCandles: [...], cases: [{ name, series, config: {...}, barHours, values }] }`

- [ ] **Step 1: Write the fixture generator**

Create `frontend/src/lib/indicators/slopeParityGolden.test.ts`:

```ts
// Golden-master generator for the Python slope parity suite. Runs the SAME TS
// functions the pane uses over deterministic synthetic candles and writes
// backend/tests/fixtures/slope_golden.json. Re-run to regenerate after changing
// TS slope math. Mirrors indicatorParityGolden.test.ts.
/// <reference types="node" />
import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { slopeLineSeries, accelLineSeries, type SlopeUnit, type SlopeSmoothing } from "./slope";
import type { MaKind, PriceSource } from "../mtf";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../../backend/tests/fixtures/slope_golden.json");

/** Deterministic LCG — NO Math.random/Date.now. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const START = 1700000000000;

function makeCandles(n: number, gapAt: number[] = []): KLineData[] {
  const rnd = lcg(7);
  const out: KLineData[] = [];
  let close = 100;
  let t = START;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(1, open + (rnd() - 0.5) * 2);
    const high = Math.max(open, close) + rnd() * 0.5;
    const low = Math.min(open, close) - rnd() * 0.5;
    // Bars 2-4 volumeless so vwma/evwma exercise their empty-window paths.
    const volume = i >= 2 && i <= 4 ? 0 : Math.floor(rnd() * 1000) + 1;
    out.push({ timestamp: t, open, high, low, close, volume });
    // An "irregular" series skips bars entirely at the given indices: the min
    // positive gap stays 1h but the series is no longer contiguous, which is
    // exactly where an inferred bar width and a nominal one used to diverge.
    t += (gapAt.includes(i) ? 3 : 1) * 3600_000;
  }
  return out;
}

const MA_KINDS: MaKind[] = ["ema", "sma", "vwma", "evwma"];
const SOURCES: PriceSource[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];
const UNITS: SlopeUnit[] = ["pctHr", "pctBar", "priceBar"];
const SMOOTHINGS: Array<SlopeSmoothing | undefined> = [
  undefined,
  { type: "sma", length: 4 },
  { type: "ema", length: 4 },
];

const toNull = (a: Array<number | undefined>) => a.map((v) => (v === undefined ? null : v));

describe("slope parity golden fixture", () => {
  it("writes the fixture", () => {
    const clean = makeCandles(80);
    const irregular = makeCandles(80, [10, 11, 30, 55]);
    const barHours = 1; // NOMINAL, from the resolution — never inferred.

    const cases: unknown[] = [];
    let n = 0;
    for (const series of ["clean", "irregular"] as const) {
      const candles = series === "clean" ? clean : irregular;
      for (const maType of MA_KINDS) {
        for (const source of SOURCES) {
          for (const units of UNITS) {
            for (const smoothing of SMOOTHINGS) {
              const length = 5;
              const period = 3;
              cases.push({
                name: `slope-${n++}`,
                series,
                kind: "slope",
                config: { maType, source, length, period, units, smoothing: smoothing ?? null },
                barHours,
                values: toNull(
                  slopeLineSeries(candles, maType, length, period, units, source, smoothing, barHours),
                ),
              });
            }
          }
        }
      }
      // Acceleration: signed and absolute, over each unit (the accel time base
      // follows the slope's units, so all three must be covered).
      for (const units of UNITS) {
        for (const absolute of [false, true]) {
          for (const accelSmoothing of SMOOTHINGS) {
            const length = 5;
            const period = 3;
            const accelPeriod = 2;
            const raw = accelLineSeries(
              candles, "ema", length, period, accelPeriod, units, "close",
              undefined, accelSmoothing, barHours,
            );
            cases.push({
              name: `accel-${n++}`,
              series,
              kind: "accel",
              config: {
                maType: "ema", source: "close", length, period, units,
                smoothing: null, accelPeriod,
                accelSmoothing: accelSmoothing ?? null, accelAbsolute: absolute,
              },
              barHours,
              values: toNull(absolute ? raw.map((v) => (v === undefined ? undefined : Math.abs(v))) : raw),
            });
          }
        }
      }
    }

    // Non-vacuous: every case must produce at least one defined finite value,
    // so a port that silently returns all-null cannot pass.
    for (const c of cases as Array<{ name: string; values: Array<number | null> }>) {
      expect(
        c.values.some((v) => v !== null && Number.isFinite(v)),
        `${c.name} produced no defined values`,
      ).toBe(true);
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          candles: clean.map((k) => ({ time: k.timestamp / 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
          irregularCandles: irregular.map((k) => ({ time: k.timestamp / 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
          cases,
        },
        null,
        2,
      ) + "\n",
    );
    expect(cases.length).toBeGreaterThan(400);
  });
});
```

- [ ] **Step 2: Generate the fixture**

Run: `cd frontend && npx vitest run src/lib/indicators/slopeParityGolden.test.ts`
Expected: PASS, and `backend/tests/fixtures/slope_golden.json` now exists.

- [ ] **Step 3: Write the failing Python parity test**

Create `backend/tests/test_slope_parity.py`:

```python
"""Golden-master parity: the Python slope pipeline must reproduce the TS math
(frontend/src/lib/indicators/slope.ts) exactly. The fixture is generated by
frontend/src/lib/indicators/slopeParityGolden.test.ts — regenerate it there
whenever the TS math changes."""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.slope import (
    SlopeConfig, accel_line_series, slope_line_series,
)

FIXTURE = Path(__file__).parent / "fixtures" / "slope_golden.json"


def _candles(rows):
    return [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"],
            volume=c["volume"],
        )
        for c in rows
    ]


@pytest.fixture(scope="module")
def golden():
    data = json.loads(FIXTURE.read_text())
    return {
        "clean": _candles(data["candles"]),
        "irregular": _candles(data["irregularCandles"]),
        "cases": data["cases"],
    }


def _smoothing(raw):
    return None if raw is None else (raw["type"], raw["length"])


def _cfg(c):
    return SlopeConfig(
        lengths=(c["length"],),
        ma_type=c["maType"],
        source=c["source"],
        slope_period=c["period"],
        units=c["units"],
        smoothing=_smoothing(c.get("smoothing")),
        show_accel=True,
        accel_period=c.get("accelPeriod", 3),
        accel_smoothing=_smoothing(c.get("accelSmoothing")),
        accel_absolute=c.get("accelAbsolute", False),
        timeframe=None,
    )


def test_every_case_matches(golden):
    assert golden["cases"], "fixture is empty — regenerate it"
    for case in golden["cases"]:
        candles = golden[case["series"]]
        cfg = _cfg(case["config"])
        fn = slope_line_series if case["kind"] == "slope" else accel_line_series
        actual = fn(candles, cfg, case["config"]["length"], case["barHours"])
        expected = case["values"]
        assert len(actual) == len(expected), case["name"]
        for i, (a, e) in enumerate(zip(actual, expected)):
            if e is None:
                assert a is None, f"{case['name']}[{i}]: expected None, got {a}"
            else:
                assert a is not None, f"{case['name']}[{i}]: expected {e}, got None"
                assert math.isclose(a, e, rel_tol=1e-12, abs_tol=1e-12), (
                    f"{case['name']}[{i}]: {a} != {e}"
                )


def test_fixture_is_non_vacuous(golden):
    for case in golden["cases"]:
        assert any(v is not None for v in case["values"]), case["name"]
```

- [ ] **Step 4: Run it to verify it fails, then passes**

Run: `cd backend && python -m pytest tests/test_slope_parity.py -v`

If it fails, the port is wrong — fix `indicators/slope.py`, not the fixture. The fixture is generated from the TS source of truth.
Expected once correct: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slopeParityGolden.test.ts \
        backend/tests/fixtures/slope_golden.json backend/tests/test_slope_parity.py
git commit -m "test(indicators): golden TS/Python slope parity fixture"
```

---

### Task 4: `barHours` becomes resolution-driven on the frontend

Removes the inferred-vs-nominal divergence at its source.

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts` (`inferBarHours`, `computeSlopeCalc`, `computeAccelCalc`)
- Modify: `frontend/src/lib/indicators.ts` (write `barHours` into `extendData` on apply)
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Produces: `SlopeExtend.barHours?: number` — the nominal hours per bar for the chart's current resolution.
- Consumes: `RESOLUTION_SECONDS` from `lib/feed.ts` (already the source `catalog.ts` duplicates).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicators/slope.test.ts`:

```ts
describe("barHours resolution", () => {
  it("prefers extendData.barHours over inferring from candle gaps", () => {
    const candles = [0, 1, 2, 3].map((i) => ({
      timestamp: 1700000000000 + i * 3600_000,
      open: 10, high: 10, low: 10, close: 10 + i, volume: 1,
    }));
    // barHours 4 (a 4H chart) must win even though the gaps say 1h.
    expect(resolveBarHours(candles, { barHours: 4 })).toBe(4);
  });

  it("falls back to inferring when extendData carries no barHours", () => {
    const candles = [0, 1, 2].map((i) => ({
      timestamp: 1700000000000 + i * 7200_000,
      open: 10, high: 10, low: 10, close: 10, volume: 1,
    }));
    expect(resolveBarHours(candles, {})).toBe(2);
  });

  it("falls back to 1 hour for a window too short to infer from", () => {
    expect(resolveBarHours([], {})).toBe(1);
  });
});
```

Add `resolveBarHours` to the destructured import at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: FAIL — `resolveBarHours is not a function`

- [ ] **Step 3: Implement in `slope.ts`**

Add beside `inferBarHours`, and replace every `inferBarHours(candles)` call inside `computeSlopeCalc` / `computeAccelCalc` with `resolveBarHours(candles, ext)`:

```ts
/** Hours per bar for the slope's time normalization.
 *
 * The CANONICAL value is nominal — derived from the chart's resolution and
 * written onto extendData by applyIndicator — because the backend rule path can
 * only compute a nominal width and the two must agree bar-for-bar (see the
 * design doc's barHours section). inferBarHours remains as the fallback for a
 * stored config written before barHours existed. */
export function resolveBarHours(
  candles: KLineData[],
  ext: { barHours?: number },
): number {
  const h = Number(ext.barHours);
  return Number.isFinite(h) && h > 0 ? h : inferBarHours(candles);
}
```

Add `barHours?: number;` to `SlopeExtend`.

- [ ] **Step 4: Write `barHours` on apply**

In `frontend/src/lib/indicators.ts`, in `applyIndicator`, when the resolved type is `SLOPE`, merge the nominal value into `extendData` before the chart write:

```ts
// The slope's %/hr normalization must use the NOMINAL bar width so the rule
// path (which has only the resolution) matches the pane bar-for-bar.
if (type === "SLOPE") {
  const secs = RESOLUTION_SECONDS[resolution];
  if (secs) extendData = { ...extendData, barHours: secs / 3600 };
}
```

`applySlopeAccel` copies `extendData` wholesale, so the companion inherits it with no extra work.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts src/lib/indicators.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators.ts \
        frontend/src/lib/indicators/slope.test.ts
git commit -m "fix(indicators): slope uses the nominal bar width, not an inferred one"
```

---

### Task 5: The indicator descriptor registry

The single import surface `strategy/expr/` is allowed.

**Files:**
- Create: `backend/auto_trader/indicators/registry.py`
- Create: `backend/tests/test_indicator_registry.py`

**Interfaces:**
- Consumes: `parse_slope_config`, `slope_outputs`, `slope_series`, `slope_warmup` (Task 2).
- Produces:
  - `@dataclass IndicatorSeriesSpec` with fields `parse_config`, `outputs`, `series`, `warmup`, `timeframe`
  - `SERIES_INDICATORS: dict[str, IndicatorSeriesSpec]` keyed by indicator TYPE
  - `@dataclass ResolvedInstance` with fields `type: str`, `config: Any`, `spec: IndicatorSeriesSpec`
    (`Any`, not `object` — `IndicatorSeriesSpec`'s fields are `Callable[[Any], ...]`, and the
    config is deliberately opaque to every consumer outside its own indicator module)
  - `resolve_instances(raw: dict[str, dict]) -> dict[str, ResolvedInstance]`
  - `instance_type_of(instance_id: str) -> str` — strips the `#suffix`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_indicator_registry.py`:

```python
import pytest

from auto_trader.indicators.registry import (
    SERIES_INDICATORS, instance_type_of, resolve_instances,
)


def test_slope_is_registered():
    assert "SLOPE" in SERIES_INDICATORS


def test_instance_type_strips_the_uniqueness_suffix():
    assert instance_type_of("SLOPE") == "SLOPE"
    assert instance_type_of("SLOPE#a1b2c3") == "SLOPE"


def test_resolve_parses_each_instance_config():
    resolved = resolve_instances({
        "SLOPE": {"type": "SLOPE", "calcParams": [21], "extendData": {"units": "pctBar"}},
    })
    inst = resolved["SLOPE"]
    assert inst.type == "SLOPE"
    assert inst.config.lengths == (21,)
    assert inst.config.units == "pctBar"
    assert inst.spec.outputs(inst.config) == ("slope0",)


def test_resolve_infers_the_type_from_the_id_when_absent():
    resolved = resolve_instances({"SLOPE#zz9": {"calcParams": [9], "extendData": {}}})
    assert resolved["SLOPE#zz9"].type == "SLOPE"


def test_resolve_skips_unregistered_types_rather_than_raising():
    # A chart may carry MACD/BOLL panes; only registered ones become referenceable.
    assert resolve_instances({"MACD": {"type": "MACD"}}) == {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_indicator_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.indicators.registry'`

- [ ] **Step 3: Implement**

Create `backend/auto_trader/indicators/registry.py`:

```python
"""Generic series-indicator descriptors. This module is the ONLY thing
strategy/expr/ may import from the indicator layer: the expression evaluator
resolves an IndicatorRef through a spec and never learns what a slope is.

Registering a new referenceable indicator means adding one entry here plus its
own module — no expression-layer edit."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from auto_trader.core.models import Candle
from auto_trader.indicators import slope as _slope


@dataclass(frozen=True, slots=True)
class IndicatorSeriesSpec:
    # (calcParams, extendData) -> an opaque config object
    parse_config: Callable[[Any, Any], Any]
    # config -> the legal output names, in pane order
    outputs: Callable[[Any], tuple[str, ...]]
    # (config, output, candles, bar_hours) -> per-bar values
    series: Callable[[Any, str, Sequence[Candle], float], list[float | None]]
    # (config, output) -> warm-up bars
    warmup: Callable[[Any, str], int]
    # config -> the instance's own timeframe pin, or None
    timeframe: Callable[[Any], str | None]


SERIES_INDICATORS: dict[str, IndicatorSeriesSpec] = {
    "SLOPE": IndicatorSeriesSpec(
        parse_config=_slope.parse_slope_config,
        outputs=_slope.slope_outputs,
        series=_slope.slope_series,
        warmup=_slope.slope_warmup,
        timeframe=lambda cfg: cfg.timeframe,
    ),
}


@dataclass(frozen=True, slots=True)
class ResolvedInstance:
    type: str
    config: Any
    spec: IndicatorSeriesSpec


def instance_type_of(instance_id: str) -> str:
    """`mintInstanceId` (frontend indicators.ts) names the first instance after
    its type and suffixes later ones with "#<rand>"."""
    return instance_id.split("#", 1)[0]


def resolve_instances(raw: dict[str, dict]) -> dict[str, ResolvedInstance]:
    """Parse the request's instance map. Unregistered types are skipped, not
    raised: a chart legitimately carries MACD/BOLL panes that no rule can
    reference, and shipping them must not 500."""
    out: dict[str, ResolvedInstance] = {}
    for instance_id, payload in (raw or {}).items():
        payload = payload or {}
        ind_type = payload.get("type") or instance_type_of(instance_id)
        spec = SERIES_INDICATORS.get(ind_type)
        if spec is None:
            continue
        cfg = spec.parse_config(payload.get("calcParams"), payload.get("extendData"))
        out[instance_id] = ResolvedInstance(ind_type, cfg, spec)
    return out
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/test_indicator_registry.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/registry.py backend/tests/test_indicator_registry.py
git commit -m "feat(indicators): generic series-indicator descriptor registry"
```

---

### Task 6: Backend lexer, `IndicatorRef` node, and parsing

**Files:**
- Modify: `backend/auto_trader/strategy/expr/lexer.py`
- Modify: `backend/auto_trader/strategy/expr/nodes.py`
- Modify: `backend/auto_trader/strategy/expr/parser.py`
- Create: `backend/tests/test_indicator_ref_parse.py`

**Interfaces:**
- Produces: `N.IndicatorRef(instance: str, output: str, start: int, end: int)`, added to the `Node` union and handled by `contains_tf` / `contains_bars_since_entry`.

Note: today a bare unknown name parses to `Call(name, [])` and `NAME.field` on it becomes `Field(Call(...), field)`. The parser rewrites that specific shape into `IndicatorRef` so the walkers get a first-class node.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_indicator_ref_parse.py`:

```python
import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse


def test_hash_is_legal_inside_a_name():
    row = parse("SLOPE#a1b2c3.slope0 > 0")
    assert isinstance(row.left, N.IndicatorRef)
    assert row.left.instance == "SLOPE#a1b2c3"
    assert row.left.output == "slope0"


def test_a_plain_instance_ref_parses():
    row = parse("SLOPE.slope0 > 0.5")
    assert isinstance(row.left, N.IndicatorRef)
    assert (row.left.instance, row.left.output) == ("SLOPE", "slope0")


def test_a_ref_composes_under_offset_and_timeframe():
    row = parse("SLOPE.slope0[-2] @1H > 0")
    tf = row.left
    assert isinstance(tf, N.Tf) and tf.tf == "1H"
    assert isinstance(tf.base, N.Offset)
    assert isinstance(tf.base.base, N.IndicatorRef)


def test_a_ref_composes_inside_a_wrapper():
    row = parse("slope(SLOPE.slope0, 5) > 0")
    assert isinstance(row.left, N.Call)
    assert isinstance(row.left.args[0], N.IndicatorRef)


def test_a_registered_indicator_call_is_still_a_call_not_a_ref():
    row = parse("EMA(9) > 0")
    assert isinstance(row.left, N.Call) and row.left.name == "EMA"


def test_a_field_on_a_registered_call_is_untouched():
    # Still Field(Call), so validate keeps reporting field_on_call.
    row = parse("EMA(9).signal > 0")
    assert isinstance(row.left, N.Field)


def test_hash_still_rejected_as_a_leading_character():
    with pytest.raises(ExprError) as e:
        parse("#SLOPE > 0")
    assert e.value.code == "bad_char"


def test_contains_tf_sees_through_a_ref():
    assert N.contains_tf(parse("SLOPE.slope0 @1H > 0").left) is True
    assert N.contains_tf(parse("SLOPE.slope0 > 0").left) is False
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_indicator_ref_parse.py -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'IndicatorRef'`

- [ ] **Step 3: Lexer — allow `#` inside a name**

In `backend/auto_trader/strategy/expr/lexer.py`, in the alpha branch (line 47-52), extend the continuation test. `#` is legal only *after* the first character, so a leading `#` still raises `bad_char`:

```python
        if c.isalpha() or c == "_":
            j = i
            # "#" is legal INSIDE a name (never leading) so a chart indicator's
            # instance id — "SLOPE#a1b2c3", minted by the frontend's
            # mintInstanceId — lexes verbatim, with no id<->token mapping table.
            while j < n and (src[j].isalnum() or src[j] in "_#"):
                j += 1
            out.append(Token("NAME", src[i:j], i, j))
            i = j
            continue
```

- [ ] **Step 4: Node**

In `nodes.py`, add the dataclass, extend the `Node` union, and add the two walker cases:

```python
@dataclass(frozen=True, slots=True)
class IndicatorRef:
    """A configured chart-indicator instance's output, e.g. SLOPE#a1b2c3.slope0.
    Carries NO parameters: the pane's settings are the single source of truth
    and travel on the request's `indicators` map."""
    instance: str
    output: str
    start: int
    end: int
```

Add `| IndicatorRef` to `Node`. Both `contains_tf` and `contains_bars_since_entry` fall through to `return False` for unknown node types, which is already correct for a ref (it has no children) — add no case, but add a test asserting it (done in Step 1).

- [ ] **Step 5: Parser — rewrite `Field(Call(name, []), output)` into a ref**

In `parser.py::parse_postfix`, in the `DOT` branch, replace the `else` arm:

```python
                if isinstance(node, N.Candle):
                    node = N.Candle(field.value, node.start, field.end)
                elif (
                    isinstance(node, N.Call)
                    and not node.args
                    and node.name not in INDICATORS
                    and node.name not in WRAPPERS
                    and node.name not in N.CROSS_FNS
                    and node.name not in N.PREDICATE_FNS
                ):
                    # A bare unknown name with a field is an indicator-instance
                    # reference. Registered names keep the Field(Call) shape so
                    # validate still reports field_on_call for EMA(9).signal.
                    node = N.IndicatorRef(node.name, field.value, node.start, field.end)
                else:
                    node = N.Field(node, field.value, node.start, field.end)
```

Import `INDICATORS, WRAPPERS` from `registry` at the top of `parser.py`.

- [ ] **Step 6: Run the tests**

Run: `cd backend && python -m pytest tests/test_indicator_ref_parse.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS. Rows referencing unknown names now reach validate as `IndicatorRef` instead of `Call` only when a `.field` follows — bare unknown names are unchanged.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/strategy/expr/lexer.py \
        backend/auto_trader/strategy/expr/nodes.py \
        backend/auto_trader/strategy/expr/parser.py \
        backend/tests/test_indicator_ref_parse.py
git commit -m "feat(expr): parse indicator instance references"
```

---

### Task 7: Thread the instance map through the backend walkers

A cross-cutting signature change, done as its own step *before* any ref is evaluated. The map rides alongside `htf`, which is already threaded exactly this way.

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py`, `warmup.py`, `validate.py`
- Modify: `backend/auto_trader/api/routers/expr.py` (call sites)
- Test: existing suites must stay green

**Interfaces:**
- Produces (new signatures — every later task uses these):
  - `series_of(node, candles, resolution, htf, instances: dict[str, ResolvedInstance] | None = None)`
  - `_cond_matches(cond, candles, resolution, htf, instances=None)`
  - `compile_row(node, candles, resolution, htf, instances=None) -> CompiledRow`
  - `CompiledRow` gains an `instances` field
  - `warmup_bars(node, resolution=None, instances=None)`
  - `validate(node, *, is_exit, instances=None)`

Defaulting to `None` keeps every existing caller and test compiling; a ref with `instances=None` behaves exactly as a missing instance (Task 8's error).

- [ ] **Step 1: Add the parameter, defaulting to None**

Thread `instances` through in this order, changing signatures and forwarding at every recursive call:

1. `evaluate.py::series_of` — forward to itself in the `Field`, `Offset`, `Tf`, `Unary`, `Binary`, `Count`, and `Call` branches.
2. `evaluate.py::_cond_matches` — forward into its `series_of` calls.
3. `evaluate.py::_precompute` and `compile_row` — store on `CompiledRow`; `CompiledRow._val` forwards `self.instances` into its defensive `series_of` call.
4. `warmup.py::warmup_bars` — forward in every recursive call.
5. `validate.py::validate` and `_walk` — forward in every recursive call.

- [ ] **Step 2: Update the call sites in `api/routers/expr.py`**

`_tf_inner_warmup`, `_parse_group`, and each route's `compile_row` call gain the argument. For now pass `None` — Task 10 populates it.

- [ ] **Step 3: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS — this task changes no behavior, only signatures.

- [ ] **Step 4: Add a guard test**

Create `backend/tests/test_expr_instances_threading.py`:

```python
import inspect

from auto_trader.strategy.expr import evaluate, validate, warmup


def test_every_walker_accepts_the_instances_map():
    for fn in (evaluate.series_of, evaluate.compile_row, warmup.warmup_bars, validate.validate):
        assert "instances" in inspect.signature(fn).parameters, fn.__name__


def test_instances_defaults_to_none_so_legacy_callers_still_work():
    for fn in (evaluate.series_of, evaluate.compile_row, warmup.warmup_bars, validate.validate):
        assert inspect.signature(fn).parameters["instances"].default is None, fn.__name__
```

Run: `cd backend && python -m pytest tests/test_expr_instances_threading.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/ backend/auto_trader/api/routers/expr.py \
        backend/tests/test_expr_instances_threading.py
git commit -m "refactor(expr): thread the indicator instance map through the walkers"
```

---

### Task 8: Validate indicator references

**Files:**
- Modify: `backend/auto_trader/strategy/expr/validate.py`
- Modify: `backend/auto_trader/strategy/expr/errors.py` (if it enumerates codes)
- Create: `backend/tests/test_indicator_ref_validate.py`

**Interfaces:**
- Consumes: `ResolvedInstance` (Task 5), `N.IndicatorRef` (Task 6), the threaded `instances` (Task 7).
- Produces: error codes `unknown_indicator_ref`, `unknown_indicator_output`, `indicator_ref_needs_output`, `nested_tf` (reused).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_indicator_ref_validate.py`:

```python
import pytest

from auto_trader.indicators.registry import resolve_instances
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate

INSTANCES = resolve_instances({
    "SLOPE": {
        "type": "SLOPE", "calcParams": [9, 21],
        "extendData": {"showAccel": True, "slopePeriod": 3},
    },
    "SLOPE#p1n": {
        "type": "SLOPE", "calcParams": [50],
        "extendData": {"mtf": {"timeframe": "1H"}},
    },
})


def check(src, instances=INSTANCES):
    validate(parse(src), is_exit=False, instances=instances)


def test_a_valid_ref_passes():
    check("SLOPE.slope0 > 0.5")
    check("SLOPE.slope1 > 0.5")
    check("SLOPE.accel0 > 0")


def test_a_missing_instance_is_its_own_error():
    with pytest.raises(ExprError) as e:
        check("NOPE.slope0 > 0")
    assert e.value.code == "unknown_indicator_ref"
    assert "NOPE" in e.value.message


def test_no_instance_map_at_all_is_the_same_error():
    with pytest.raises(ExprError) as e:
        check("SLOPE.slope0 > 0", instances=None)
    assert e.value.code == "unknown_indicator_ref"


def test_an_output_beyond_the_configured_lengths_is_rejected():
    with pytest.raises(ExprError) as e:
        check("SLOPE.slope2 > 0")     # only two lengths configured
    assert e.value.code == "unknown_indicator_output"
    assert "slope0" in e.value.message   # lists what IS available


def test_accel_is_rejected_when_the_companion_is_off():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.accel0 > 0")   # showAccel not set
    assert e.value.code == "unknown_indicator_output"


def test_the_threshold_figure_keys_are_not_outputs():
    for key in ("thHi", "thLo"):
        with pytest.raises(ExprError) as e:
            check(f"SLOPE.{key} > 0")
        assert e.value.code == "unknown_indicator_output"


def test_a_bare_instance_name_asks_for_an_output():
    with pytest.raises(ExprError) as e:
        check("SLOPE > 0")
    assert e.value.code == "indicator_ref_needs_output"
    assert "SLOPE.slope0" in e.value.message


def test_pinning_an_already_pinned_pane_is_a_nested_pin():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.slope0 @4H > 0")
    assert e.value.code == "nested_tf"


def test_pinning_an_unpinned_pane_is_fine():
    check("SLOPE.slope0 @4H > 0")


def test_a_field_on_a_registered_call_still_reports_field_on_call():
    with pytest.raises(ExprError) as e:
        check("EMA(9).signal > 0")
    assert e.value.code == "field_on_call"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_indicator_ref_validate.py -v`
Expected: FAIL — refs currently raise `unknown_name`.

- [ ] **Step 3: Implement in `validate.py`**

Add the ref case to `_walk`, before the `N.Call` case:

```python
    if isinstance(node, N.IndicatorRef):
        inst = (instances or {}).get(node.instance)
        if inst is None:
            raise ExprError(
                "unknown_indicator_ref",
                f"No indicator named {node.instance} on this chart.",
                node.start, node.end,
            )
        available = inst.spec.outputs(inst.config)
        if node.output not in available:
            raise ExprError(
                "unknown_indicator_output",
                f"{node.instance} has no output {node.output}. "
                f"Available: {', '.join(available)}.",
                node.start, node.end,
            )
        return
```

In the `N.Call` case, before the final `unknown_name` raise, add the friendlier bare-name message:

```python
        if (instances or {}).get(node.name) is not None and not node.args:
            inst = instances[node.name]
            first = inst.spec.outputs(inst.config)[0]
            raise ExprError(
                "indicator_ref_needs_output",
                f"{node.name} needs an output, like {node.name}.{first}.",
                node.start, node.end,
            )
```

For the nested pin, extend the `N.Tf` case so an instance's own pin counts:

```python
    if isinstance(node, N.Tf):
        if tf_resolution(node.tf) is None:
            raise ExprError(...)   # unchanged
        # A pane pinned in its own settings is already a pinned series; pinning
        # it again in the rule would be a nested pin, same as EMA(9)@1H@4H.
        inner = _pinned_instance(node.base, instances)
        if inner is not None:
            raise ExprError(
                "nested_tf",
                "A timeframe pin cannot be nested inside another one.",
                node.start, node.end,
            )
        _walk(node.base, is_exit=is_exit, instances=instances)
        return
```

with the helper:

```python
def _pinned_instance(node: N.Node, instances) -> str | None:
    """The instance id of a ref inside `node` whose own config carries a
    timeframe pin, or None."""
    if isinstance(node, N.IndicatorRef):
        inst = (instances or {}).get(node.instance)
        if inst is not None and inst.spec.timeframe(inst.config):
            return node.instance
        return None
    if isinstance(node, (N.Field, N.Offset, N.Tf)):
        return _pinned_instance(node.base, instances)
    if isinstance(node, N.Unary):
        return _pinned_instance(node.operand, instances)
    return None
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/test_indicator_ref_validate.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/validate.py backend/tests/test_indicator_ref_validate.py
git commit -m "feat(expr): validate indicator references with their own error codes"
```

---

### Task 9: Evaluate and warm up indicator references

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py`, `warmup.py`
- Create: `backend/tests/test_indicator_ref_evaluate.py`

**Interfaces:**
- Consumes: `ResolvedInstance.spec.series` / `.warmup` / `.timeframe`, `resolution_seconds`, `align_htf_to_base`.
- Produces: no new public names — `series_of` and `warmup_bars` gain an `IndicatorRef` branch.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_indicator_ref_evaluate.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import resolve_instances
from auto_trader.indicators.slope import parse_slope_config, slope_line_series
from auto_trader.strategy.expr.evaluate import series_of
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.warmup import warmup_bars


def mk(n):
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=100.0 + i, high=101.0 + i,
               low=99.0 + i, close=100.0 + (i % 7), volume=10.0)
        for i in range(n)
    ]


PAYLOAD = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                     "extendData": {"slopePeriod": 3, "showAccel": True, "accelPeriod": 2}}}
INSTANCES = resolve_instances(PAYLOAD)


def expr(src):
    return parse(src).left


def test_a_ref_evaluates_to_the_indicator_module_series():
    candles = mk(40)
    got = series_of(expr("SLOPE.slope0 > 0"), candles, "HOUR", {}, INSTANCES)
    cfg = parse_slope_config([5], {"slopePeriod": 3, "showAccel": True, "accelPeriod": 2})
    want = slope_line_series(candles, cfg, 5, 1.0)
    assert got == want


def test_bar_hours_come_from_the_resolution_not_the_candle_gaps():
    candles = mk(40)
    hourly = series_of(expr("SLOPE.slope0 > 0"), candles, "HOUR", {}, INSTANCES)
    four_hourly = series_of(expr("SLOPE.slope0 > 0"), candles, "HOUR_4", {}, INSTANCES)
    # Same candles, different nominal width -> pctHr values scale by 4.
    i = next(i for i, v in enumerate(hourly) if v not in (None, 0.0))
    assert four_hourly[i] == pytest.approx(hourly[i] / 4)


def test_an_offset_shifts_a_ref():
    candles = mk(40)
    plain = series_of(expr("SLOPE.slope0 > 0"), candles, "HOUR", {}, INSTANCES)
    shifted = series_of(expr("SLOPE.slope0[-2] > 0"), candles, "HOUR", {}, INSTANCES)
    assert shifted[5] == plain[3]


def test_a_missing_instance_evaluates_to_all_none_rather_than_crashing():
    # validate() is the gate; series_of must still be defensive, like the Tf branch.
    out = series_of(expr("GONE.slope0 > 0"), mk(10), "HOUR", {}, INSTANCES)
    assert out == [None] * 10


def test_warmup_comes_from_the_instance_config():
    # length 5 + slopePeriod 3
    assert warmup_bars(expr("SLOPE.slope0 > 0"), "HOUR", INSTANCES) == 8
    # + accelPeriod 2
    assert warmup_bars(expr("SLOPE.accel0 > 0"), "HOUR", INSTANCES) == 10
    # offsets still stack on top
    assert warmup_bars(expr("SLOPE.slope0[-4] > 0"), "HOUR", INSTANCES) == 12


def test_warmup_of_an_unknown_ref_is_zero():
    assert warmup_bars(expr("GONE.slope0 > 0"), "HOUR", INSTANCES) == 0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_indicator_ref_evaluate.py -v`
Expected: FAIL — `ValueError: cannot evaluate IndicatorRef as a series`

- [ ] **Step 3: Implement in `evaluate.py`**

Add before the `N.Call` branch in `series_of`:

```python
    if isinstance(node, N.IndicatorRef):
        inst = (instances or {}).get(node.instance)
        if inst is None:
            # validate() rejects this first; be defensive like the Tf branch so a
            # stale row can never 500 a run.
            return [None] * n
        pin = inst.spec.timeframe(inst.config)
        if pin:
            # The pane's own timeframe is a SETTING, so the ref already means the
            # HTF series: compute on native HTF bars and align, exactly as the
            # pane does (mtfCoordinator.applySlopeTimeframe).
            tf_res = tf_resolution(pin) or pin
            tf_candles = htf.get(tf_res) or htf.get(pin) or []
            if not tf_candles:
                return [None] * n
            tf_vals = inst.spec.series(
                inst.config, node.output, tf_candles, _tf_hours(tf_res)
            )
            base_ms = [int(c.time.timestamp() * 1000) for c in candles]
            return align_htf_to_base(base_ms, tf_candles, tf_vals, resolution_seconds(tf_res) * 1000)
        return inst.spec.series(inst.config, node.output, candles, _tf_hours(resolution))
```

- [ ] **Step 4: Implement in `warmup.py`**

Add before the `N.Call` branch:

```python
    if isinstance(node, N.IndicatorRef):
        inst = (instances or {}).get(node.instance)
        if inst is None:
            return 0
        if inst.spec.timeframe(inst.config) and resolution is not None:
            # A pinned instance is warmed from its own HTF history, exactly like
            # an @tf pin — it costs zero BASE bars.
            return 0
        return inst.spec.warmup(inst.config, node.output)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && python -m pytest tests/test_indicator_ref_evaluate.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py \
        backend/auto_trader/strategy/expr/warmup.py \
        backend/tests/test_indicator_ref_evaluate.py
git commit -m "feat(expr): evaluate and warm up indicator references"
```

---

### Task 10: Transport — ship instance configs on the request

**Files:**
- Modify: `backend/auto_trader/api/schemas.py`
- Modify: `backend/auto_trader/api/routers/expr.py`
- Create: `backend/tests/test_expr_instances_route.py`

**Interfaces:**
- Produces: `IndicatorInstanceDTO { type: str | None, calcParams: list | None, extendData: dict | None }` and an `indicators: dict[str, IndicatorInstanceDTO] = {}` field on `ExprBacktestRequest`, `ExprSeriesRequest`, `ExprClosenessRequest`, `ExprLiteralsRequest`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_expr_instances_route.py`:

```python
from fastapi.testclient import TestClient

from auto_trader.api.main import app

client = TestClient(app)


def _candles(n):
    return [
        {"time": 1700000000 + i * 3600, "open": 100.0 + i, "high": 101.0 + i,
         "low": 99.0 + i, "close": 100.0 + (i % 7), "volume": 10.0}
        for i in range(n)
    ]


BASE = {
    "epic": "TEST", "resolution": "HOUR", "candles": _candles(200),
    "costs": {"spread": 0.0, "commission": 0.0, "slippage": 0.0},
    "tradeFromTime": 0, "shortEnabled": False,
}


def test_a_rule_referencing_a_shipped_instance_runs():
    r = client.post("/api/expr/backtest", json={
        **BASE,
        "indicators": {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                                 "extendData": {"slopePeriod": 3}}},
        "longEntry": [{"expr": "SLOPE.slope0 > 0"}],
        "longExit": [{"expr": "SLOPE.slope0 < 0"}],
    })
    assert r.status_code == 200, r.text


def test_a_rule_referencing_a_missing_instance_is_a_422_not_a_500():
    r = client.post("/api/expr/backtest", json={
        **BASE,
        "longEntry": [{"expr": "SLOPE.slope0 > 0"}],
    })
    assert r.status_code == 422
    assert "unknown_indicator_ref" in r.text


def test_the_referenced_timeframe_set_includes_a_pinned_instances_pin():
    # An instance pinned to 1H must make the route fetch/require 1H candles even
    # though the expression text contains no @1H.
    r = client.post("/api/expr/backtest", json={
        **BASE,
        "indicators": {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                                 "extendData": {"mtf": {"timeframe": "1H"}}}},
        "longEntry": [{"expr": "SLOPE.slope0 > 0"}],
        "htfCandles": {"HOUR": _candles(80)},
    })
    assert r.status_code == 200, r.text
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_instances_route.py -v`
Expected: FAIL — refs reject with `unknown_indicator_ref` even when shipped.

- [ ] **Step 3: Schema**

In `backend/auto_trader/api/schemas.py`:

```python
class IndicatorInstanceDTO(BaseModel):
    """A chart indicator instance's settings, keyed by its instance id. Rules
    reference an instance's OUTPUT (SLOPE.slope0) and never restate its
    parameters, so this map is how the backend learns them."""
    type: str | None = None          # inferred from the id when absent
    calcParams: list[float] | None = None
    extendData: dict | None = None
```

Add `indicators: dict[str, IndicatorInstanceDTO] = {}` to `ExprBacktestRequest`, `ExprSeriesRequest`, `ExprClosenessRequest`, and `ExprLiteralsRequest`.

- [ ] **Step 4: Router**

In `api/routers/expr.py`:

- Build once per request: `instances = resolve_instances({k: v.model_dump() for k, v in req.indicators.items()})`.
- Pass it to `_parse_group` (which forwards to `validate`), to every `compile_row`, and to `_tf_inner_warmup`.
- Extend `_referenced_tfs` so a pinned instance's timeframe is included:

```python
def _referenced_tfs(node: N.Node, instances=None) -> set[str]:
    ...
    if isinstance(node, N.IndicatorRef):
        inst = (instances or {}).get(node.instance)
        pin = inst.spec.timeframe(inst.config) if inst else None
        # A pane pinned in its own SETTINGS needs HTF candles even though the
        # expression text carries no @tf.
        return {pin} if pin else set()
```

and thread `instances` through `_ensure_htf` / `_all_row_nodes` accordingly.

- [ ] **Step 5: Run the tests**

Run: `cd backend && python -m pytest tests/test_expr_instances_route.py -v`
Expected: PASS — all tests in the file

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/expr.py \
        backend/tests/test_expr_instances_route.py
git commit -m "feat(api): ship indicator instance configs with expression rows"
```

---

### Task 11: Frontend parser — lexer, ref node, validation, warm-up

Mirrors Tasks 6–9 in TypeScript. The editor's lint path needs the *live chart's* instance list, so it is injected at call time.

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts`
- Modify: `frontend/src/lib/expr/catalog.ts` (the injected instance type)
- Test: `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Produces:
  - `export interface ExprInstance { id: string; outputs: string[]; timeframe: string | null }`
  - `analyze(src, opts?: { isExit?: boolean; instances?: ExprInstance[] })`
  - `warmupOf(src, baseSeconds?, instances?: ExprInstance[], warmupByRef?: (id: string, output: string) => number)`
- Consumes: `slopeOutputs` (Task 12) at the call site, not inside the parser — `parser.ts` stays free of indicator imports.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/expr/parser.test.ts`:

```ts
const INSTANCES = [
  { id: "SLOPE", outputs: ["slope0", "slope1", "accel0"], timeframe: null },
  { id: "SLOPE#p1n", outputs: ["slope0"], timeframe: "1H" },
];

describe("indicator references", () => {
  it("accepts a ref to a known instance and output", () => {
    expect(analyze("SLOPE.slope0 > 0.5", { instances: INSTANCES }).errors).toEqual([]);
    expect(analyze("SLOPE#p1n.slope0 > 0", { instances: INSTANCES }).errors).toEqual([]);
  });

  it("reports a missing instance with its own code", () => {
    const [err] = analyze("NOPE.slope0 > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("unknown_indicator_ref");
  });

  it("reports an unknown output and lists what is available", () => {
    const [err] = analyze("SLOPE.slope9 > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("unknown_indicator_output");
    expect(err.message).toContain("slope0");
  });

  it("asks for an output when only the instance is named", () => {
    const [err] = analyze("SLOPE > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("indicator_ref_needs_output");
  });

  it("rejects pinning an instance that is already pinned in its settings", () => {
    const [err] = analyze("SLOPE#p1n.slope0 @4H > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("nested_tf");
  });

  it("allows pinning an unpinned instance", () => {
    expect(analyze("SLOPE.slope0 @4H > 0", { instances: INSTANCES }).errors).toEqual([]);
  });

  it("still reports field_on_call for a registered indicator", () => {
    const [err] = analyze("EMA(9).signal > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("field_on_call");
  });

  it("lexes # inside a name but not as a leading character", () => {
    expect(analyze("SLOPE#p1n.slope0 > 0", { instances: INSTANCES }).errors).toEqual([]);
    expect(analyze("#SLOPE > 0", { instances: INSTANCES }).errors[0].code).toBe("bad_char");
  });

  it("takes warm-up from the caller's lookup, plus offsets", () => {
    const warmupByRef = () => 8;
    expect(warmupOf("SLOPE.slope0 > 0", 3600, INSTANCES, warmupByRef)).toBe(8);
    expect(warmupOf("SLOPE.slope0[-4] > 0", 3600, INSTANCES, warmupByRef)).toBe(12);
  });

  it("charges zero base bars for an instance pinned in its own settings", () => {
    expect(warmupOf("SLOPE#p1n.slope0 > 0", 3600, INSTANCES, () => 8)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: FAIL — `unknown_name` instead of `unknown_indicator_ref`.

- [ ] **Step 3: Implement**

In `parser.ts`, mirroring the Python changes exactly:

1. **Lexer** — in the alpha branch, allow `#` as a continuation character:
   ```ts
   const isNameChar = (c: string) => isAlnum(c) || c === "_" || c === "#";
   ```
   used only in the *continuation* loop, never the first-character test.
2. **Node** — add `interface IndicatorRefNode { kind: "IndicatorRef"; instance: string; output: string; start: number; end: number }` and extend the `Node` union.
3. **`parsePostfix`** — in the `DOT` branch, rewrite a zero-arg `Call` whose name is not in `INDICATOR_SPECS`, `WRAPPER_ARITY`, `CROSS_FNS`, or `PREDICATE_FNS` into an `IndicatorRef`.
4. **`walk`** — add the `IndicatorRef` case with the three error codes, and the bare-name `indicator_ref_needs_output` in the `Call` case.
5. **`Tf` case** — reject a pin over an already-pinned instance with `nested_tf`, via the same `pinnedInstance` helper shape as Python's `_pinned_instance`.
6. **`warmupOf`** — add the `IndicatorRef` case: `0` when the instance is pinned and `baseSeconds` is given, else `warmupByRef(instance, output)`, defaulting to `0` when no lookup is supplied.
7. **`containsTf`** — no case needed (a ref has no children); the `Tf` wrapper above it is what `containsTf` sees.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/catalog.ts \
        frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): parse and validate indicator references in the editor"
```

---

### Task 12: Frontend `slopeOutputs` and the pick-from-chart bridge

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts` (`slopeOutputs`)
- Modify: `frontend/src/lib/exprChartToken.ts`
- Test: `frontend/src/lib/exprChartToken.test.ts`, `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Produces:
  - `slopeOutputs(calcParams: unknown[] | undefined, ext: SlopeExtend): string[]` — mirrors Python `slope_outputs`
  - `chartIndicatorToExprToken(indType, calcParams, extendData, opts?: { instanceId?: string; lineIndex?: number; output?: "slope" | "accel" }): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicators/slope.test.ts`:

```ts
describe("slopeOutputs", () => {
  it("tracks the configured lengths", () => {
    expect(slopeOutputs([9, 21], {})).toEqual(["slope0", "slope1"]);
  });

  it("adds accel lines only when the companion is on", () => {
    expect(slopeOutputs([9], { showAccel: true })).toEqual(["slope0", "accel0"]);
  });

  it("never lists the threshold figure keys", () => {
    const out = slopeOutputs([9], { showAccel: true, threshold: { on: true, level: 1 } });
    expect(out).not.toContain("thHi");
    expect(out).not.toContain("thLo");
  });

  it("defaults to a single line when calcParams are empty", () => {
    expect(slopeOutputs([], {})).toEqual(["slope0"]);
  });
});
```

Append to `frontend/src/lib/exprChartToken.test.ts`:

```ts
describe("SLOPE instance references", () => {
  it("emits an instance ref for a clicked slope line", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9, 21], {}, { instanceId: "SLOPE", lineIndex: 1 }),
    ).toBe("SLOPE.slope1");
  });

  it("emits an accel ref for the companion pane", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9], { showAccel: true },
        { instanceId: "SLOPE#a1b", lineIndex: 0, output: "accel" }),
    ).toBe("SLOPE#a1b.accel0");
  });

  it("refuses an accel ref when the companion is off", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9], {},
        { instanceId: "SLOPE", lineIndex: 0, output: "accel" }),
    ).toBeNull();
  });

  it("refuses a line index the pane does not have", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9], {}, { instanceId: "SLOPE", lineIndex: 3 }),
    ).toBeNull();
  });

  it("refuses when no instance id is supplied", () => {
    expect(chartIndicatorToExprToken("SLOPE", [9], {})).toBeNull();
  });
});
```

Update the existing `"returns null for unsupported indicator types"` test to drop `"SLOPE"` from its list (it is now supported) — keep `MACD`, `BOLL`, `KDJ`, `CCI`, `AVWAP`, `VWAP`, `PIVOT_BANDS`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts src/lib/exprChartToken.test.ts`
Expected: FAIL — `slopeOutputs is not a function`

- [ ] **Step 3: Implement `slopeOutputs` in `slope.ts`**

```ts
/** The pane's DATA outputs, in pane order. Mirrors Python slope_outputs.
 * Excludes thHi/thLo: slopeFigures emits those only to drive the y-axis
 * auto-scale, so they are figure keys but not values a rule may read. */
export function slopeOutputs(calcParams: unknown[] | undefined, ext: SlopeExtend): string[] {
  const lines = slopeLengths(calcParams).map((_, i) => `slope${i}`);
  if (!ext.showAccel) return lines;
  return [...lines, ...slopeLengths(calcParams).map((_, i) => `accel${i}`)];
}
```

- [ ] **Step 4: Implement the bridge case in `exprChartToken.ts`**

Add the options parameter and the case:

```ts
    // The SLOPE pane's settings stay in the pane: the token references the
    // clicked LINE, never its parameters, so changing the pane's length or units
    // leaves every rule that uses it correct with no edit.
    case "SLOPE": {
      if (!opts?.instanceId) return null;
      const ext = (extendData ?? {}) as SlopeExtend;
      const kind = opts.output === "accel" ? "accel" : "slope";
      const output = `${kind}${opts.lineIndex ?? 0}`;
      if (!slopeOutputs(calcParams, ext).includes(output)) return null;
      return `${opts.instanceId}.${output}`;
    }
```

Update the module header comment: SLOPE is now supported via instance reference; VWMA/EVWMA MA panes and MACD/BOLL/KDJ/CCI still return null.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts src/lib/exprChartToken.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/exprChartToken.ts \
        frontend/src/lib/indicators/slope.test.ts frontend/src/lib/exprChartToken.test.ts
git commit -m "feat(expr): pick a slope line from the chart into a rule"
```

---

### Task 13: Editor surface — highlight, grammar, completion; and the boundary test

**Files:**
- Modify: `frontend/src/lib/expr/highlight.ts`, `grammar.lezer`, `complete.ts`
- Create: `backend/tests/test_expr_boundary.py`
- Test: `frontend/src/lib/expr/complete.test.ts`

**Interfaces:**
- Consumes: `ExprInstance[]` (Task 11) — `complete.ts` receives the live instance list the same way `parser.ts` does.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_expr_boundary.py`:

```python
"""The governing constraint: strategy/expr/ holds no slope math and no
slope-specific branch. It may reach the indicator layer only through the
generic descriptor registry."""

from pathlib import Path

EXPR_DIR = Path(__file__).resolve().parents[1] / "auto_trader" / "strategy" / "expr"


def test_expr_never_imports_a_concrete_indicator_module():
    offenders = []
    for path in EXPR_DIR.glob("*.py"):
        text = path.read_text()
        for bad in ("indicators.slope", "indicators import slope"):
            if bad in text:
                offenders.append(f"{path.name}: {bad}")
    assert not offenders, offenders


def test_expr_never_names_a_slope_concept():
    """No `if name == "SLOPE"`, no units/maType/accel handling. `slope_of` is
    the pre-existing slope(x, n) WRAPPER, which is a language feature, not the
    indicator — it stays."""
    offenders = []
    for path in EXPR_DIR.glob("*.py"):
        text = path.read_text()
        for bad in ('"SLOPE"', "'SLOPE'", "pctHr", "maType", "accel_line", "slope_line"):
            if bad in text:
                offenders.append(f"{path.name}: {bad}")
    assert not offenders, offenders
```

Append to `frontend/src/lib/expr/complete.test.ts`:

```ts
it("completes instance references from the live chart", () => {
  const instances = [{ id: "SLOPE", outputs: ["slope0", "accel0"], timeframe: null }];
  const opts = completions("SLO", 3, { instances }).map((c) => c.label);
  expect(opts).toContain("SLOPE.slope0");
  expect(opts).toContain("SLOPE.accel0");
});

it("offers no instance references when the chart has none", () => {
  const opts = completions("SLO", 3, { instances: [] }).map((c) => c.label);
  expect(opts.every((l) => !l.includes("."))).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_expr_boundary.py -v`
Run: `cd frontend && npx vitest run src/lib/expr/complete.test.ts`
Expected: boundary test may already pass (good — it is a guard); the completion test FAILS.

- [ ] **Step 3: Implement**

1. `highlight.ts::classify` — return a new `"instanceRef"` class for an `IndicatorRef` token so a ref is visually distinct from an unknown name. Add the matching CSS class wherever the other classes are styled.
2. `grammar.lezer` — add `#` to the `Identifier` token's continuation set:
   ```
   Identifier { $[a-zA-Z_] $[a-zA-Z0-9_#]* }
   ```
   Leave `Field` alone: an output name never contains `#`.
3. `complete.ts` — accept `instances` in its options and emit one completion per `instance.id + "." + output`, in a group labelled "Chart indicators", ranked below the static catalog groups.

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/test_expr_boundary.py -v`
Run: `cd frontend && npx vitest run src/lib/expr/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/grammar.lezer \
        frontend/src/lib/expr/complete.ts frontend/src/lib/expr/complete.test.ts \
        backend/tests/test_expr_boundary.py
git commit -m "feat(expr): highlight and complete indicator references"
```

---

### Task 14: Wire the request — collect referenced instances and ship them

**Files:**
- Modify: `frontend/src/api.ts` (`indicators` on the request type)
- Modify: `frontend/src/BacktestButton.tsx` (collect from the live chart)
- Create: `frontend/src/lib/exprInstances.ts`
- Create: `frontend/src/lib/exprInstances.test.ts`

**Interfaces:**
- Produces:
  - `collectExprInstances(chart, rows: string[]): Record<string, { type: string; calcParams: number[]; extendData: unknown }>`
  - `exprInstancesFromChart(chart): ExprInstance[]` — the lint/completion list for Tasks 11 and 13

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/exprInstances.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { collectExprInstances, referencedInstanceIds } = await import("./exprInstances");

const LIVE = [
  { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar" } },
  { id: "SLOPE#a1b", type: "SLOPE", calcParams: [50], extendData: {} },
  { id: "EMA", type: "EMA", calcParams: [9], extendData: {} },
];

describe("referencedInstanceIds", () => {
  it("finds ids used in any row", () => {
    expect(referencedInstanceIds(["SLOPE.slope0 > 0", "SLOPE#a1b.slope0 < 0"]))
      .toEqual(new Set(["SLOPE", "SLOPE#a1b"]));
  });

  it("ignores registered function names", () => {
    expect(referencedInstanceIds(["EMA(9) > candle.close"])).toEqual(new Set());
  });

  it("ignores a bare instance name with no output", () => {
    expect(referencedInstanceIds(["SLOPE > 0"])).toEqual(new Set());
  });
});

describe("collectExprInstances", () => {
  it("ships only the instances the rows reference", () => {
    const out = collectExprInstances(LIVE, ["SLOPE.slope0 > 0"]);
    expect(Object.keys(out)).toEqual(["SLOPE"]);
    expect(out.SLOPE).toEqual({
      type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar" },
    });
  });

  it("ships nothing when no row references an instance", () => {
    expect(collectExprInstances(LIVE, ["EMA(9) > candle.close"])).toEqual({});
  });

  it("skips a referenced id that is not on the chart", () => {
    // The editor already flags this as unknown_indicator_ref; the request must
    // not invent an entry for it.
    expect(collectExprInstances(LIVE, ["GONE.slope0 > 0"])).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/exprInstances.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `frontend/src/lib/exprInstances.ts`**

```ts
// Collect the chart-indicator instances a set of expression rows references, for
// shipping on the request. Rules name an instance's OUTPUT and carry none of its
// settings, so the backend needs the config to recompute over any window (a
// backtest window routinely exceeds the chart's loaded candles).

export interface LiveInstance {
  id: string;
  type: string;
  calcParams?: number[];
  extendData?: unknown;
}

export interface ExprInstancePayload {
  type: string;
  calcParams: number[];
  extendData: unknown;
}

// <instanceId>.<output> — the id may carry the "#<rand>" uniqueness suffix that
// mintInstanceId adds to a second-or-later instance of a type.
const REF = /\b([A-Za-z_][A-Za-z0-9_]*(?:#[A-Za-z0-9_]+)?)\.([A-Za-z_][A-Za-z0-9_]*)/g;

export function referencedInstanceIds(rows: string[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    for (const m of row.matchAll(REF)) {
      // `candle.close` and `EMA(9).signal` are not instance refs; a following
      // "(" means it was a call, and `candle` is the language's own root.
      if (m[1] === "candle") continue;
      out.add(m[1]);
    }
  }
  return out;
}

export function collectExprInstances(
  live: LiveInstance[],
  rows: string[],
): Record<string, ExprInstancePayload> {
  const wanted = referencedInstanceIds(rows);
  const out: Record<string, ExprInstancePayload> = {};
  for (const inst of live) {
    if (!wanted.has(inst.id)) continue;
    out[inst.id] = {
      type: inst.type,
      calcParams: inst.calcParams ?? [],
      extendData: inst.extendData ?? {},
    };
  }
  return out;
}
```

- [ ] **Step 4: Wire it into the request**

In `frontend/src/api.ts`, add `indicators?: Record<string, ExprInstancePayload>` to the expression backtest request type (and the sweep/WFO/series/closeness request types that share it).

In `BacktestButton.tsx`, where `exprReq` is built, add:

```ts
indicators: collectExprInstances(liveIndicatorInstances(chart), allRowExpressions),
```

where `allRowExpressions` is the flattened `longEntry`/`longExit`/`shortEntry`/`shortExit` expression strings already assembled there.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/lib/exprInstances.test.ts src/BacktestButton.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/exprInstances.ts frontend/src/lib/exprInstances.test.ts \
        frontend/src/api.ts frontend/src/BacktestButton.tsx
git commit -m "feat(backtest): ship referenced indicator instances with expression rows"
```

---

### Task 15: End-to-end — the pane and the rule agree

The test the whole design exists to make true.

**Files:**
- Create: `backend/tests/test_slope_pane_rule_equality.py`
- Modify: `frontend/src/lib/indicators/slopeParityGolden.test.ts` (emit a pane-shaped case)
- Modify: `frontend/src/lib/indicators/slope.ts` (rewrite the stale `accelAbsolute` comment)

**Interfaces:**
- Consumes: the fixture from Task 3 plus a new `paneCases` array generated the way `computeSlopeCalc` builds pane values.

- [ ] **Step 1: Emit pane-shaped cases from the generator**

In `slopeParityGolden.test.ts`, add a `paneCases` array built through the same call `computeSlopeCalc` makes — one entry per configured line, for a multi-line pane with accel on:

```ts
const paneExt = {
  maType: "sma" as const, source: "hl2" as const, units: "pctHr" as const,
  slopePeriod: 3, smoothing: { type: "ema" as const, length: 4 },
  showAccel: true, accelPeriod: 2, accelSmoothing: null, accelAbsolute: true,
  barHours: 1,
};
const paneLengths = [5, 13];
const paneCases = [
  ...paneLengths.map((len, i) => ({
    output: `slope${i}`,
    values: toNull(slopeLineSeries(clean, "sma", len, 3, "pctHr", "hl2", paneExt.smoothing, 1)),
  })),
  ...paneLengths.map((len, i) => ({
    output: `accel${i}`,
    values: toNull(
      accelLineSeries(clean, "sma", len, 3, 2, "pctHr", "hl2", paneExt.smoothing, undefined, 1)
        .map((v) => (v === undefined ? undefined : Math.abs(v))),
    ),
  })),
];
```

Write `{ paneConfig: { calcParams: paneLengths, extendData: paneExt }, paneCases }` into the fixture JSON.

- [ ] **Step 2: Write the failing Python test**

Create `backend/tests/test_slope_pane_rule_equality.py`:

```python
"""The property the whole design exists to guarantee: a rule referencing a
configured pane's output evaluates to exactly the line the pane plots."""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import resolve_instances
from auto_trader.strategy.expr.evaluate import series_of
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate

FIXTURE = Path(__file__).parent / "fixtures" / "slope_golden.json"


@pytest.fixture(scope="module")
def pane():
    data = json.loads(FIXTURE.read_text())
    candles = [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"],
            volume=c["volume"],
        )
        for c in data["candles"]
    ]
    return candles, data["paneConfig"], data["paneCases"]


def test_every_pane_line_equals_its_rule_operand(pane):
    candles, config, cases = pane
    instances = resolve_instances({
        "SLOPE": {"type": "SLOPE", "calcParams": config["calcParams"],
                  "extendData": config["extendData"]},
    })
    assert cases, "fixture has no pane cases — regenerate it"
    for case in cases:
        src = f"SLOPE.{case['output']} > 0"
        row = parse(src)
        validate(row, is_exit=False, instances=instances)   # must not raise
        actual = series_of(row.left, candles, "HOUR", {}, instances)
        for i, (a, e) in enumerate(zip(actual, case["values"])):
            if e is None:
                assert a is None, f"{case['output']}[{i}]: expected None, got {a}"
            else:
                assert a is not None and math.isclose(a, e, rel_tol=1e-12, abs_tol=1e-12), (
                    f"{case['output']}[{i}]: {a} != {e}"
                )
```

- [ ] **Step 3: Regenerate the fixture and run**

Run: `cd frontend && npx vitest run src/lib/indicators/slopeParityGolden.test.ts`
Run: `cd backend && python -m pytest tests/test_slope_pane_rule_equality.py -v`
Expected: PASS

- [ ] **Step 4: Rewrite the stale comment**

In `frontend/src/lib/indicators/slope.ts`, the `accelAbsolute` doc comment currently ends "Does not touch the signed accel rule operand." That described a `computeIndicatorRecipe` path that does not exist. Replace with:

```ts
  // Plot |acceleration| instead of signed acceleration on the companion pane. A
  // display transform applied when computeAccelCalc builds the pane values (after
  // any smoothing/MTF align), so magnitude reads regardless of steepening vs
  // flattening. A rule referencing SLOPE.accelN reads the SAME transformed
  // series — the reference names the pane's output, so what a rule sees and what
  // the pane plots are equal by construction (see test_slope_pane_rule_equality).
```

Also fix the file's header block, which claims `computeSlopeCalc` is shared with `backtestSeries.computeIndicatorRecipe` — no such function exists. Point it at `indicators/slope.py` and the parity fixture instead.

- [ ] **Step 5: Run everything**

Run: `cd backend && python -m pytest -q`
Run: `cd frontend && npx vitest run`
Run: `cd frontend && npx tsc -b --noEmit && npx eslint .`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/tests/test_slope_pane_rule_equality.py \
        frontend/src/lib/indicators/slopeParityGolden.test.ts \
        frontend/src/lib/indicators/slope.ts \
        backend/tests/fixtures/slope_golden.json
git commit -m "test(expr): the pane's plotted line equals its rule operand"
```

---

## Verification checklist

Before calling the feature done:

- [ ] `cd backend && python -m pytest -q` — green
- [ ] `cd frontend && npx vitest run` — green
- [ ] `cd frontend && npx tsc -b --noEmit` — clean
- [ ] `cd frontend && npx eslint .` — clean
- [ ] `test_expr_boundary.py` passes — `strategy/expr/` imports no concrete indicator module and names no slope concept
- [ ] Manually: add a SLOPE pane, set it to VWMA / hl2 / %/bar with EMA smoothing and accel on, pick a line into a rule, run a backtest, then change the pane's MA length and re-run — the rule follows with no edit.
