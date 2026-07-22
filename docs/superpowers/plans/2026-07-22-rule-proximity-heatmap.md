# Rule Proximity Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart overlay that colors every bar by how close the current entry rule group is to firing, computed on the rule's authored timeframe and visible on all higher timeframes.

**Architecture:** The backend owns all computation. A new pure module (`strategy/expr/closeness.py`) turns each rule row into a per-bar closeness in `[0,1]` (signed gap toward firing, normalized by the row's own volatility or ATR, ramped linearly), folds the rows by the group operator (AND→min, OR→max), and aggregates the base-timeframe values into the display bars the chart shows. A new endpoint `POST /api/expr/closeness` fetches candles, runs that module, and returns one value per visible bar. The frontend fetches on config/window/control change and paints full-height translucent columns via a figure-less klinecharts price-pane indicator, mirroring `timeHighlight.ts`.

**Tech Stack:** Python + pytest (backend), TypeScript + vitest (frontend), klinecharts custom indicator (canvas draw).

## Global Constraints

- No em dashes in end-user text (tooltip/label copy). Code/tests/commits fine.
- Tooltip/label copy: direct statements, never "how much/far" framing. Use the shared `Tooltip`/`InfoTip` components, never native `title=`.
- No new persisted strategy fields. Heatmap reads the live backtest config; its controls (side, basis, width, agg) are view state only.
- Strict fold only: AND→min, OR→max. No mean/RMS.
- Two normalization bases only: volatility (default) and ATR. No percent-of-reference.
- Any operand `None`/NaN on a bar → that row undefined → folded bar undefined → unpainted. A rolling window not yet full → undefined.
- Backend tests: `cd backend && uv run pytest tests/<file> -q`. Frontend tests: `cd frontend && npx vitest run <file>`.
- Commit directly to `main` after each task.

## File Structure

- Create `backend/auto_trader/strategy/expr/closeness.py` — pure closeness math (gap, ramp, scales, per-row + group folding, HTF aggregation). No FastAPI, no I/O.
- Create `backend/tests/test_expr_closeness.py` — unit tests for the module.
- Modify `backend/auto_trader/api/schemas.py` — add `NormSpec` + `ExprClosenessRequest`.
- Modify `backend/auto_trader/api/routers/expr.py` — add the `/api/expr/closeness` endpoint + a `referenced_tfs` walker.
- Modify `backend/tests/test_expr_router.py` (or create `test_expr_closeness_router.py`) — endpoint tests.
- Modify `frontend/src/api.ts` — add `fetchClosenessHeatmap`.
- Create `frontend/src/lib/proximityHeatmap.ts` — closeness→color mapping + resolution-gating predicate (pure, node-testable).
- Create `frontend/src/lib/proximityHeatmap.test.ts` — unit tests for the above.
- Create `frontend/src/lib/indicators/proximityHeatmap.ts` — the klinecharts indicator template (calc + draw).
- Modify the chart control surface (`frontend/src/ChartCore.tsx` and a new small control component) — toggle + controls + refetch wiring.

Task-to-interface names below are the contract; keep them byte-identical across tasks.

---

### Task 1: Per-row gap and ramp (backend core)

**Files:**
- Create: `backend/auto_trader/strategy/expr/closeness.py`
- Test: `backend/tests/test_expr_closeness.py`

**Interfaces:**
- Produces: `signed_gap(op: str, left: float | None, right: float | None) -> float | None`; `ramp(gap: float | None, scale: float | None) -> float | None`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_closeness.py`:

```python
import math

from auto_trader.strategy.expr.closeness import ramp, signed_gap


def test_signed_gap_orientation():
    # ">": fires when left > right, so gap = left - right
    assert signed_gap(">", 101, 100) == 1
    assert signed_gap(">=", 100, 100) == 0
    # "<": fires when left < right, so gap = right - left
    assert signed_gap("<", 99, 100) == 1
    assert signed_gap("<=", 100, 100) == 0
    # any None -> None
    assert signed_gap(">", None, 100) is None
    assert signed_gap(">", 100, None) is None


def test_ramp_shape():
    # firing (gap >= 0) -> 1
    assert ramp(0.0, 5.0) == 1.0
    assert ramp(2.0, 5.0) == 1.0
    # halfway short -> 0.5
    assert ramp(-2.5, 5.0) == 0.5
    # one full scale short -> 0
    assert ramp(-5.0, 5.0) == 0.0
    # beyond a scale -> clamped to 0
    assert ramp(-6.0, 5.0) == 0.0
    # undefined inputs -> None
    assert ramp(None, 5.0) is None
    assert ramp(-1.0, None) is None
    # non-positive or NaN scale -> None (can't normalize)
    assert ramp(-1.0, 0.0) is None
    assert ramp(-1.0, math.nan) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: FAIL with `ModuleNotFoundError: ... closeness`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/auto_trader/strategy/expr/closeness.py`:

```python
from __future__ import annotations

import math
from collections.abc import Sequence


def _defined(v: float | None) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def signed_gap(op: str, left: float | None, right: float | None) -> float | None:
    """Gap oriented so >= 0 means the comparison holds."""
    if not (_defined(left) and _defined(right)):
        return None
    if op in (">", ">="):
        return left - right
    if op in ("<", "<="):
        return right - left
    raise ValueError(f"unsupported comparison op: {op}")


def ramp(gap: float | None, scale: float | None) -> float | None:
    """clamp(1 - relu(-gap)/scale, 0, 1). None if either input is undefined or
    scale is not a positive finite number."""
    if not _defined(gap) or not _defined(scale) or scale <= 0:
        return None
    short = max(0.0, -gap)
    return max(0.0, min(1.0, 1.0 - short / scale))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(closeness): per-row signed gap and linear ramp"
```

---

### Task 2: Normalization scales — volatility and ATR (backend core)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py`
- Test: `backend/tests/test_expr_closeness.py`

**Interfaces:**
- Consumes: `_defined` from Task 1.
- Produces: `avg_abs_gap(gaps: Sequence[float | None], window: int) -> list[float | None]`; `scale_series(gaps, basis, width, window, atr) -> list[float | None]` where `atr: Sequence[float | None] | None`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_expr_closeness.py`:

```python
from auto_trader.strategy.expr.closeness import avg_abs_gap, scale_series


def test_avg_abs_gap_rolling_window_full_only():
    gaps = [-2.0, 1.0, -3.0, 2.0]
    # window 2: first bar has no full window -> None; then mean of |last 2|
    out = avg_abs_gap(gaps, 2)
    assert out[0] is None
    assert out[1] == (2.0 + 1.0) / 2
    assert out[2] == (1.0 + 3.0) / 2
    assert out[3] == (3.0 + 2.0) / 2


def test_avg_abs_gap_none_in_window_poisons():
    gaps = [1.0, None, 2.0, 3.0]
    out = avg_abs_gap(gaps, 2)
    assert out[1] is None  # window [1.0, None]
    assert out[2] is None  # window [None, 2.0]
    assert out[3] == (2.0 + 3.0) / 2


def test_scale_series_volatility_applies_width():
    gaps = [-2.0, 1.0, -3.0, 2.0]
    out = scale_series(gaps, "volatility", width=2.0, window=2, atr=None)
    assert out[0] is None
    assert out[1] == 2.0 * 1.5  # width * avgAbsGap


def test_scale_series_atr_applies_width():
    gaps = [0.0, 0.0, 0.0]
    atr = [None, 4.0, 5.0]
    out = scale_series(gaps, "atr", width=2.0, window=50, atr=atr)
    assert out[0] is None
    assert out[1] == 8.0
    assert out[2] == 10.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: FAIL with `ImportError: cannot import name 'avg_abs_gap'`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/strategy/expr/closeness.py`:

```python
def avg_abs_gap(gaps: Sequence[float | None], window: int) -> list[float | None]:
    """Rolling mean of |gap| over the last `window` bars. A bar is None until it
    has a full window, and any None/NaN inside the window poisons that bar."""
    n = len(gaps)
    out: list[float | None] = [None] * n
    for i in range(n):
        if i + 1 < window:
            continue
        w = gaps[i - window + 1 : i + 1]
        if any(not _defined(v) for v in w):
            continue
        out[i] = sum(abs(float(v)) for v in w) / window  # type: ignore[arg-type]
    return out


def scale_series(
    gaps: Sequence[float | None],
    basis: str,
    width: float,
    window: int,
    atr: Sequence[float | None] | None,
) -> list[float | None]:
    """Per-bar normalization scale. volatility: width * rolling avg |gap|.
    atr: width * ATR (atr must be supplied, same length as gaps)."""
    n = len(gaps)
    if basis == "volatility":
        base = avg_abs_gap(gaps, window)
    elif basis == "atr":
        if atr is None:
            raise ValueError("atr basis requires an atr series")
        base = list(atr)
    else:
        raise ValueError(f"unknown normalization basis: {basis}")
    out: list[float | None] = [None] * n
    for i in range(n):
        b = base[i] if i < len(base) else None
        out[i] = width * b if _defined(b) else None
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(closeness): volatility and ATR normalization scales"
```

---

### Task 3: Per-row closeness series (comparison + cross)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py`
- Test: `backend/tests/test_expr_closeness.py`

**Interfaces:**
- Consumes: `signed_gap`, `ramp`, `scale_series` (Tasks 1-2); `series_of` from `auto_trader.strategy.expr.evaluate`; `atr_series` from `auto_trader.indicators.core`; nodes `N.Compare`, `N.Cross`.
- Produces: `Norm` dataclass `(basis: str, width: float, window: int, atr_length: int)`; `row_gap_series(node, candles, resolution, htf) -> list[float | None]`; `row_closeness(node, candles, resolution, htf, norm) -> list[float | None]`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_expr_closeness.py`:

```python
from auto_trader.core.models import Candle
from auto_trader.strategy.expr.closeness import Norm, row_closeness, row_gap_series
from auto_trader.strategy.expr.parser import parse
from datetime import datetime, timezone


def _c(close: float, i: int) -> Candle:
    t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
    return Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                  open=close, high=close + 1, low=close - 1, close=close, volume=100)


def test_row_gap_series_comparison_orientation():
    candles = [_c(c, i) for i, c in enumerate([98, 99, 100, 101])]
    node = parse("candle.close > 100")
    gaps = row_gap_series(node, candles, "MINUTE", {})
    assert gaps == [98 - 100, 99 - 100, 100 - 100, 101 - 100]


def test_row_closeness_hits_one_when_firing():
    candles = [_c(c, i) for i, c in enumerate([90, 95, 100, 105, 110, 100])]
    node = parse("candle.close > 100")
    norm = Norm(basis="volatility", width=1.0, window=2, atr_length=14)
    out = row_closeness(node, candles, "MINUTE", {}, norm)
    # bars where close > 100 fire -> 1.0; early bars undefined until window fills
    assert out[3] == 1.0  # close 105 > 100
    assert out[4] == 1.0  # close 110 > 100
    assert 0.0 <= out[5] <= 1.0  # close 100, not firing, some warmth


def test_row_closeness_cross_is_symmetric_line_proximity():
    # a and b equal on a bar -> proximity 1 regardless of side
    candles = [_c(c, i) for i, c in enumerate([100, 100, 100, 100])]
    node = parse("crossAbove(candle.close, 100)")
    norm = Norm(basis="volatility", width=1.0, window=2, atr_length=14)
    out = row_closeness(node, candles, "MINUTE", {}, norm)
    # gap |close - 100| is 0 everywhere -> scale is 0 -> undefined (no spread);
    # this documents the degenerate all-equal case.
    assert out[-1] is None or out[-1] == 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: FAIL with `ImportError: cannot import name 'Norm'`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/strategy/expr/closeness.py`:

```python
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.evaluate import series_of


@dataclass(frozen=True, slots=True)
class Norm:
    basis: str          # "volatility" | "atr"
    width: float
    window: int         # rolling window for the volatility basis
    atr_length: int     # Wilder length for the ATR basis


def row_gap_series(
    node: N.Compare | N.Cross,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
) -> list[float | None]:
    """Gap oriented toward firing per bar. Comparison: signed_gap(op,l,r).
    Cross: symmetric line distance abs(a - b) (proximity to touching)."""
    n = len(candles)
    if isinstance(node, N.Compare):
        left = series_of(node.left, candles, resolution, htf)
        right = series_of(node.right, candles, resolution, htf)
        return [signed_gap(node.op, left[i], right[i]) for i in range(n)]
    a = series_of(node.a, candles, resolution, htf)
    b = series_of(node.b, candles, resolution, htf)
    out: list[float | None] = []
    for i in range(n):
        if _defined(a[i]) and _defined(b[i]):
            # symmetric: distance to the cross, oriented as "short" so ramp warms
            # toward 1 as they converge. Represent as a non-positive gap.
            out.append(-abs(a[i] - b[i]))
        else:
            out.append(None)
    return out


def row_closeness(
    node: N.Compare | N.Cross,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    norm: Norm,
) -> list[float | None]:
    gaps = row_gap_series(node, candles, resolution, htf)
    atr = atr_series(candles, norm.atr_length) if norm.basis == "atr" else None
    scale = scale_series(gaps, norm.basis, norm.width, norm.window, atr)
    return [ramp(gaps[i], scale[i]) for i in range(len(gaps))]
```

Note for the cross case: `row_gap_series` returns `-abs(a-b)` (a non-positive
"gap short"), so `ramp` warms toward 1 as the lines converge and the volatility
scale is built from that same magnitude series.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(closeness): per-row closeness for comparison and cross rows"
```

---

### Task 4: Group fold (rows → one value per bar)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py`
- Test: `backend/tests/test_expr_closeness.py`

**Interfaces:**
- Consumes: `row_closeness`, `Norm` (Task 3).
- Produces: `group_closeness(rows: list[N.Compare | N.Cross], combine: str, candles, resolution, htf, norm: Norm) -> list[float | None]`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_expr_closeness.py`:

```python
from auto_trader.strategy.expr.closeness import group_closeness


def test_group_fold_and_takes_min_or_none_poisons():
    candles = [_c(c, i) for i, c in enumerate([100, 100, 100, 100, 100, 99])]
    rows = [parse("candle.close > 100"), parse("candle.close < 200")]
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    out = group_closeness(rows, "AND", candles, "MINUTE", {}, norm)
    # both rows must be defined; AND folds to the min of the two
    per = [row_closeness(r, candles, "MINUTE", {}, norm) for r in rows]
    for i in range(len(candles)):
        vals = [p[i] for p in per]
        if any(v is None for v in vals):
            assert out[i] is None
        else:
            assert out[i] == min(vals)


def test_group_fold_or_takes_max():
    candles = [_c(c, i) for i, c in enumerate([90, 95, 100, 105, 110, 100])]
    rows = [parse("candle.close > 108"), parse("candle.close > 100")]
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    out = group_closeness(rows, "OR", candles, "MINUTE", {}, norm)
    per = [row_closeness(r, candles, "MINUTE", {}, norm) for r in rows]
    for i in range(len(candles)):
        vals = [p[i] for p in per]
        if any(v is None for v in vals):
            assert out[i] is None
        else:
            assert out[i] == max(vals)


def test_group_empty_rows_all_none():
    candles = [_c(100, i) for i in range(3)]
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    assert group_closeness([], "AND", candles, "MINUTE", {}, norm) == [None, None, None]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: FAIL with `ImportError: cannot import name 'group_closeness'`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/strategy/expr/closeness.py`:

```python
def group_closeness(
    rows: list[N.Compare | N.Cross],
    combine: str,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    norm: Norm,
) -> list[float | None]:
    """Fold per-row closeness by the group operator, strict fuzzy logic:
    AND -> min, OR -> max. Any undefined row poisons the bar. No rows -> all
    None (an empty group never fires)."""
    n = len(candles)
    if not rows:
        return [None] * n
    per = [row_closeness(r, candles, resolution, htf, norm) for r in rows]
    fold = min if combine == "AND" else max
    out: list[float | None] = []
    for i in range(n):
        vals = [p[i] for p in per]
        out.append(None if any(v is None for v in vals) else fold(vals))
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(closeness): strict min/max group fold"
```

---

### Task 5: Aggregate base closeness into display bars

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py`
- Test: `backend/tests/test_expr_closeness.py`

**Interfaces:**
- Produces: `aggregate_to_display(base_times: Sequence[int], base_vals: Sequence[float | None], display_seconds: int, agg: str) -> tuple[list[int], list[float | None]]`. Returns (display bucket start epochs ascending, one aggregated value each). `agg` in `"max" | "avg" | "last"`. `None` base values are skipped inside a bucket; a bucket with no defined values yields `None`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_expr_closeness.py`:

```python
from auto_trader.strategy.expr.closeness import aggregate_to_display


def test_aggregate_buckets_by_display_resolution():
    # base at 60s, display at 180s -> 3 base bars per display bar
    base_times = [0, 60, 120, 180, 240, 300]
    base_vals = [0.2, 0.8, 0.5, None, 0.4, 0.9]
    t_max, v_max = aggregate_to_display(base_times, base_vals, 180, "max")
    assert t_max == [0, 180]
    assert v_max == [0.8, 0.9]
    _, v_last = aggregate_to_display(base_times, base_vals, 180, "last")
    assert v_last == [0.5, 0.9]   # last DEFINED in each bucket
    _, v_avg = aggregate_to_display(base_times, base_vals, 180, "avg")
    assert v_avg[0] == (0.2 + 0.8 + 0.5) / 3
    assert v_avg[1] == (0.4 + 0.9) / 2


def test_aggregate_empty_bucket_is_none():
    base_times = [0, 60]
    base_vals = [None, None]
    _, v = aggregate_to_display(base_times, base_vals, 60, "max")
    assert v == [None, None]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: FAIL with `ImportError: cannot import name 'aggregate_to_display'`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/strategy/expr/closeness.py`:

```python
def aggregate_to_display(
    base_times: Sequence[int],
    base_vals: Sequence[float | None],
    display_seconds: int,
    agg: str,
) -> tuple[list[int], list[float | None]]:
    """Group base bars into display buckets (floor of time to display_seconds)
    and reduce each. None values are skipped; an all-None bucket yields None."""
    buckets: dict[int, list[float]] = {}
    order: list[int] = []
    for t, v in zip(base_times, base_vals):
        key = t - (t % display_seconds)
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        if _defined(v):
            buckets[key].append(float(v))
    order.sort()
    out_t: list[int] = []
    out_v: list[float | None] = []
    for key in order:
        vals = buckets[key]
        out_t.append(key)
        if not vals:
            out_v.append(None)
        elif agg == "max":
            out_v.append(max(vals))
        elif agg == "avg":
            out_v.append(sum(vals) / len(vals))
        elif agg == "last":
            out_v.append(vals[-1])
        else:
            raise ValueError(f"unknown agg: {agg}")
    return out_t, out_v
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_expr_closeness.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(closeness): aggregate base bars into display buckets"
```

---

### Task 6: `/api/expr/closeness` endpoint

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (after `ExprSeriesRequest`, ~line 695)
- Modify: `backend/auto_trader/api/routers/expr.py` (imports + new endpoint after `expr_series`, ~line 262)
- Test: Create `backend/tests/test_expr_closeness_router.py`

**Interfaces:**
- Consumes: `group_closeness`, `aggregate_to_display`, `Norm` (Tasks 4-5); `parse`, `validate`, `deps._fetch_symbol_candles`, `resolution_seconds`.
- Produces: `POST /api/expr/closeness` returning `{ "times": [int], "values": [float | None] }`. Request `ExprClosenessRequest` fields: `broker`, `epic`, `priceSide`, `rows: list[str]`, `combine: str`, `baseResolution: str`, `displayResolution: str`, `fromTime: int`, `toTime: int`, `norm: NormSpec`, `agg: str`. `NormSpec`: `basis: str`, `width: float`, `window: int`, `atrLength: int`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_closeness_router.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient

from auto_trader.api.app import app  # adjust if the app factory differs


@pytest.mark.anyio
async def test_closeness_endpoint_returns_values(monkeypatch):
    from datetime import datetime, timezone
    from auto_trader.core.models import Candle
    from auto_trader.api import deps

    def _mk(i, close):
        t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
        return Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                      open=close, high=close + 1, low=close - 1, close=close, volume=100)

    candles = [_mk(i, 90 + i) for i in range(30)]

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    body = {
        "broker": "capital", "epic": "X", "priceSide": "mid",
        "rows": ["candle.close > 100"], "combine": "AND",
        "baseResolution": "MINUTE", "displayResolution": "MINUTE",
        "fromTime": int(candles[0].time.timestamp()),
        "toTime": int(candles[-1].time.timestamp()),
        "norm": {"basis": "volatility", "width": 2.0, "window": 5, "atrLength": 14},
        "agg": "max",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/api/expr/closeness", json=body)
    assert r.status_code == 200
    data = r.json()
    assert len(data["times"]) == len(data["values"])
    # later bars where close > 100 must be fully close
    assert data["values"][-1] == 1.0


@pytest.mark.anyio
async def test_closeness_endpoint_422_on_bad_expr(monkeypatch):
    from auto_trader.api import deps

    async def fake_fetch(*a, **k):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    body = {
        "broker": "capital", "epic": "X", "priceSide": "mid",
        "rows": ["candle.close >>> 100"], "combine": "AND",
        "baseResolution": "MINUTE", "displayResolution": "MINUTE",
        "fromTime": 0, "toTime": 60,
        "norm": {"basis": "volatility", "width": 2.0, "window": 5, "atrLength": 14},
        "agg": "max",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/api/expr/closeness", json=body)
    assert r.status_code == 422
```

If the test file needs an `anyio_backend` fixture, mirror the pattern already in
`backend/tests/test_expr_router.py` (check its top for the fixture/marker style
and copy it verbatim).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_closeness_router.py -q`
Expected: FAIL (404 / route not found).

- [ ] **Step 3: Add the schemas**

In `backend/auto_trader/api/schemas.py`, after `ExprSeriesRequest`:

```python
class NormSpec(BaseModel):
    basis: str = "volatility"   # "volatility" | "atr"
    width: float = 2.0
    window: int = 50
    atrLength: int = 14


class ExprClosenessRequest(BaseModel):
    epic: str
    broker: str = "capital"
    priceSide: str = "mid"
    rows: list[str]
    combine: str = "AND"        # "AND" | "OR"
    baseResolution: str
    displayResolution: str
    fromTime: int
    toTime: int
    norm: NormSpec = NormSpec()
    agg: str = "max"            # "max" | "avg" | "last"
```

- [ ] **Step 4: Add the endpoint + tf walker**

In `backend/auto_trader/api/routers/expr.py`, extend the imports:

```python
from auto_trader.strategy.expr.closeness import (
    Norm, aggregate_to_display, group_closeness,
)
from auto_trader.strategy.expr import nodes as N
```

Add `ExprClosenessRequest` to the `from ..schemas import (...)` block.

Then add, after the `expr_series` handler:

```python
def _referenced_tfs(node: N.Node) -> set[str]:
    """All @TF timeframes referenced anywhere in a row's tree."""
    if isinstance(node, N.Tf):
        return {node.tf} | _referenced_tfs(node.base)
    if isinstance(node, (N.Field, N.Offset)):
        return _referenced_tfs(node.base)
    if isinstance(node, N.Unary):
        return _referenced_tfs(node.operand)
    if isinstance(node, N.Call):
        return set().union(*(_referenced_tfs(a) for a in node.args)) if node.args else set()
    if isinstance(node, (N.Binary, N.Compare)):
        return _referenced_tfs(node.left) | _referenced_tfs(node.right)
    if isinstance(node, N.Cross):
        return _referenced_tfs(node.a) | _referenced_tfs(node.b)
    return set()


@router.post("/api/expr/closeness")
async def expr_closeness(req: ExprClosenessRequest):
    try:
        nodes = [parse(expr) for expr in req.rows]
        for node in nodes:
            validate(node, is_exit=False)
    except ExprError as e:
        raise HTTPException(422, {
            "code": e.code, "message": e.message, "start": e.start, "end": e.end,
        })

    base_s = resolution_seconds(req.baseResolution)
    display_s = resolution_seconds(req.displayResolution)
    if display_s < base_s:
        # below the authored timeframe there is no finer signal to show
        return {"times": [], "values": []}

    bars = max(1, (req.toTime - req.fromTime) // base_s + 2)
    candles = await deps._fetch_symbol_candles(
        req.broker, req.epic, req.baseResolution, bars, req.fromTime, req.toTime, req.priceSide,
    )

    tfs: set[str] = set()
    for node in nodes:
        tfs |= _referenced_tfs(node)
    htf: dict[str, list[Candle]] = {}
    for tf in tfs:
        tf_bars = max(1, (req.toTime - req.fromTime) // resolution_seconds(tf) + 2)
        htf[tf] = await deps._fetch_symbol_candles(
            req.broker, req.epic, tf, tf_bars, req.fromTime, req.toTime, req.priceSide,
        )

    norm = Norm(
        basis=req.norm.basis, width=req.norm.width,
        window=req.norm.window, atr_length=req.norm.atrLength,
    )
    base_vals = group_closeness(nodes, req.combine, candles, req.baseResolution, htf, norm)
    base_times = [int(c.time.timestamp()) for c in candles]
    times, values = aggregate_to_display(base_times, base_vals, display_s, req.agg)
    return {"times": times, "values": values}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_expr_closeness_router.py -q`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/expr.py backend/tests/test_expr_closeness_router.py
git commit -m "feat(closeness): POST /api/expr/closeness endpoint"
```

---

### Task 7: Frontend API client

**Files:**
- Modify: `frontend/src/api.ts` (near the other `/api/expr/*` clients, ~line 297)
- Test: extend an existing api test or add `frontend/src/api.closeness.test.ts`

**Interfaces:**
- Produces: exported types `ClosenessNorm = { basis: "volatility" | "atr"; width: number; window: number; atrLength: number }`, `ClosenessAgg = "max" | "avg" | "last"`, and `fetchClosenessHeatmap(req: ClosenessRequest): Promise<{ times: number[]; values: (number | null)[] }>` where `ClosenessRequest = { broker: string; epic: string; priceSide: string; rows: string[]; combine: "AND" | "OR"; baseResolution: string; displayResolution: string; fromTime: number; toTime: number; norm: ClosenessNorm; agg: ClosenessAgg }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api.closeness.test.ts`:

```ts
import { afterEach, expect, it, vi } from "vitest";
import { fetchClosenessHeatmap } from "./api";

afterEach(() => vi.restoreAllMocks());

it("posts the closeness request and returns times/values", async () => {
  const body = { times: [0, 60], values: [0.5, null] };
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }) as Response);
  vi.stubGlobal("fetch", fetchMock);

  const out = await fetchClosenessHeatmap({
    broker: "capital", epic: "X", priceSide: "mid",
    rows: ["close > 100"], combine: "AND",
    baseResolution: "MINUTE", displayResolution: "HOUR",
    fromTime: 0, toTime: 3600,
    norm: { basis: "volatility", width: 2, window: 50, atrLength: 14 },
    agg: "max",
  });

  expect(out).toEqual(body);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("/api/expr/closeness");
  expect(JSON.parse((init as RequestInit).body as string).rows).toEqual(["close > 100"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api.closeness.test.ts`
Expected: FAIL (`fetchClosenessHeatmap` is not exported).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/api.ts`, add near the other expr clients (use the file's existing `BASE` constant and error-handling idiom):

```ts
export type ClosenessNorm = {
  basis: "volatility" | "atr";
  width: number;
  window: number;
  atrLength: number;
};
export type ClosenessAgg = "max" | "avg" | "last";
export interface ClosenessRequest {
  broker: string;
  epic: string;
  priceSide: string;
  rows: string[];
  combine: "AND" | "OR";
  baseResolution: string;
  displayResolution: string;
  fromTime: number;
  toTime: number;
  norm: ClosenessNorm;
  agg: ClosenessAgg;
}

export async function fetchClosenessHeatmap(
  req: ClosenessRequest,
): Promise<{ times: number[]; values: (number | null)[] }> {
  const res = await fetch(`${BASE}/api/expr/closeness`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`closeness request failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api.closeness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/api.closeness.test.ts
git commit -m "feat(closeness): frontend api client"
```

---

### Task 8: Closeness→color mapping and resolution gating (pure)

**Files:**
- Create: `frontend/src/lib/proximityHeatmap.ts`
- Test: Create `frontend/src/lib/proximityHeatmap.test.ts`

**Interfaces:**
- Consumes: `RESOLUTION_SECONDS` from `frontend/src/lib/feed.ts` (already used across the chart lib).
- Produces: `heatColor(closeness: number): string` (rgba, cool→hot); `heatAlpha(closeness: number): number`; `heatmapVisible(displayResolution: string, baseResolution: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/proximityHeatmap.test.ts`:

```ts
import { expect, it } from "vitest";
import { heatAlpha, heatColor, heatmapVisible } from "./proximityHeatmap";

it("maps closeness to a cool→hot color", () => {
  expect(heatColor(0)).toMatch(/^rgba\(/);
  expect(heatColor(1)).toMatch(/^rgba\(/);
  // hot end is redder than cool end
  const cool = heatColor(0);
  const hot = heatColor(1);
  expect(cool).not.toEqual(hot);
});

it("alpha grows with closeness and is 0 at fully cold", () => {
  expect(heatAlpha(0)).toBe(0);
  expect(heatAlpha(1)).toBeGreaterThan(heatAlpha(0.5));
  expect(heatAlpha(0.5)).toBeGreaterThan(heatAlpha(0));
});

it("is visible only at or above the base resolution", () => {
  expect(heatmapVisible("HOUR", "MINUTE")).toBe(true);   // higher TF shows
  expect(heatmapVisible("MINUTE", "MINUTE")).toBe(true); // same TF shows
  expect(heatmapVisible("MINUTE", "HOUR")).toBe(false);  // below base hidden
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/proximityHeatmap.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/proximityHeatmap.ts`:

```ts
// Pure helpers for the rule proximity heatmap: closeness (0..1) to a canvas
// fill color/alpha, and whether the overlay should show at the current chart
// resolution (hidden below the rule's authored/base timeframe).
import { RESOLUTION_SECONDS } from "./feed";

// Cool (far from firing) to hot (about to fire). Blue-teal -> amber-red.
const COOL = { r: 43, g: 122, b: 155 };  // #2b7a9b
const HOT = { r: 217, g: 102, b: 58 };   // #d9663a

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function heatColor(closeness: number): string {
  const t = clamp01(closeness);
  const r = Math.round(COOL.r + (HOT.r - COOL.r) * t);
  const g = Math.round(COOL.g + (HOT.g - COOL.g) * t);
  const b = Math.round(COOL.b + (HOT.b - COOL.b) * t);
  return `rgba(${r}, ${g}, ${b}, 1)`;
}

// Fully cold contributes nothing; warmth fades the column in. Capped low so
// candles stay readable through the fill (matches timeHighlight's low alpha).
const MAX_ALPHA = 0.32;
export function heatAlpha(closeness: number): number {
  return clamp01(closeness) * MAX_ALPHA;
}

export function heatmapVisible(displayResolution: string, baseResolution: string): boolean {
  const d = RESOLUTION_SECONDS[displayResolution];
  const b = RESOLUTION_SECONDS[baseResolution];
  if (!d || !b) return false;
  return d >= b;
}
```

If `RESOLUTION_SECONDS` is not a plain record keyed by resolution string, adapt
the two lookups to the accessor `feed.ts` exposes (check its export before
implementing).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/proximityHeatmap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/proximityHeatmap.ts frontend/src/lib/proximityHeatmap.test.ts
git commit -m "feat(closeness): heatmap color mapping and resolution gating"
```

---

### Task 9: Heatmap indicator template (calc + draw)

**Files:**
- Create: `frontend/src/lib/indicators/proximityHeatmap.ts`
- Test: Create `frontend/src/lib/indicators/proximityHeatmap.test.ts`

**Interfaces:**
- Consumes: `heatColor`, `heatAlpha` (Task 8); the klinecharts `IndicatorTemplate`/`IndicatorDrawParams` types and the `timeHighlight.ts` draw idiom.
- Produces: `PROXIMITY_HEATMAP_TEMPLATE: Omit<IndicatorTemplate, "name">`; `ProximityHeatmapExtend = { values?: (number | null)[] }`; `computeHeatmapPoints(dataList, ext): ({ v: number | null })[]`.

The `values` array in `extendData` is per-DISPLAY-bar closeness aligned to the
chart's `dataList` by index (the caller in Task 10 aligns endpoint `times` to
the chart's bar timestamps before setting `extendData`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/indicators/proximityHeatmap.test.ts`:

```ts
import { expect, it } from "vitest";
import { computeHeatmapPoints } from "./proximityHeatmap";

it("maps extendData.values onto per-bar points by index", () => {
  const dataList = [{ timestamp: 0 }, { timestamp: 60 }, { timestamp: 120 }] as never[];
  const pts = computeHeatmapPoints(dataList, { values: [0.2, null, 0.9] });
  expect(pts).toEqual([{ v: 0.2 }, { v: null }, { v: 0.9 }]);
});

it("yields null points when no values are present", () => {
  const dataList = [{ timestamp: 0 }, { timestamp: 60 }] as never[];
  const pts = computeHeatmapPoints(dataList, {});
  expect(pts).toEqual([{ v: null }, { v: null }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/proximityHeatmap.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/indicators/proximityHeatmap.ts` (draw mirrors
`timeHighlight.ts`: figure-less, `series: 'price'`, paints in pixel space,
returns true so klinecharts skips its default figure loop):

```ts
import {
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { heatAlpha, heatColor } from "../proximityHeatmap";

export interface ProximityHeatmapExtend {
  values?: (number | null)[]; // per display bar, aligned to dataList by index
}

export interface HeatmapPoint {
  v: number | null;
}

export function computeHeatmapPoints(
  dataList: KLineData[],
  ext: ProximityHeatmapExtend,
): HeatmapPoint[] {
  const values = ext.values ?? [];
  return dataList.map((_, i) => ({ v: i < values.length ? values[i] ?? null : null }));
}

function drawHeatmap(
  params: IndicatorDrawParams<HeatmapPoint, unknown, unknown>,
): boolean {
  const { ctx, chart, indicator, xAxis, bounding } = params;
  const barSpace = chart.getBarSpace();
  const points = indicator.result ?? [];
  const halfBar = barSpace.halfBar;
  const H = bounding.height;
  ctx.save();
  for (let i = 0; i < points.length; i++) {
    const v = points[i].v;
    if (v == null) continue;
    const a = heatAlpha(v);
    if (a <= 0) continue;
    const x = xAxis.convertToPixel(i);
    const left = x - halfBar;
    const width = halfBar * 2;
    if (width <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = heatColor(v);
    ctx.fillRect(left, 0, width, H);
  }
  ctx.restore();
  return true;
}

export const PROXIMITY_HEATMAP_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Rule Proximity",
  series: "price",
  precision: 0,
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeHeatmapPoints(dataList, (ind.extendData ?? {}) as ProximityHeatmapExtend),
  draw: (params) =>
    drawHeatmap(params as IndicatorDrawParams<HeatmapPoint, unknown, unknown>),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/proximityHeatmap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/proximityHeatmap.ts frontend/src/lib/indicators/proximityHeatmap.test.ts
git commit -m "feat(closeness): proximity heatmap indicator template"
```

---

### Task 10: Wire the overlay into the chart (register, fetch, controls)

**Files:**
- Modify: `frontend/src/lib/customIndicators.ts` (register the template, ~line 81)
- Create: `frontend/src/lib/heatmapController.ts` — builds the request from the live config + view state, aligns endpoint `times` to chart bars, sets `extendData`.
- Create: `frontend/src/lib/heatmapController.test.ts`
- Modify: `frontend/src/ChartCore.tsx` — toggle + control popover + refetch effects.

**Interfaces:**
- Consumes: `fetchClosenessHeatmap`, `ClosenessRequest` (Task 7); `PROXIMITY_HEATMAP_TEMPLATE`, `ProximityHeatmapExtend` (Task 9); `heatmapVisible` (Task 8); `activeGroup` from `backtestConfig.ts`; the current backtest config, epic/broker/priceSide, and chart window from `ChartCore`.
- Produces: `buildClosenessRequest(cfg, view, window) -> ClosenessRequest | null` (null when the active side has no enabled rows); `alignValuesToBars(barTimes: number[], resp: { times: number[]; values: (number|null)[] }) -> (number|null)[]`.

- [ ] **Step 1: Write the failing test (pure helpers only)**

Create `frontend/src/lib/heatmapController.test.ts`:

```ts
import { expect, it } from "vitest";
import { alignValuesToBars, buildClosenessRequest } from "./heatmapController";

it("aligns endpoint values to chart bar timestamps by time", () => {
  const barTimes = [0, 60, 120, 180];
  const resp = { times: [0, 120], values: [0.4, 0.9] };
  // bars without a matching endpoint time are null
  expect(alignValuesToBars(barTimes, resp)).toEqual([0.4, null, 0.9, null]);
});

it("returns null request when the active side has no enabled rows", () => {
  const cfg = {
    longEntry: { combine: "AND", rules: [] },
    shortEntry: { combine: "AND", rules: [{ expr: "close > 100", enabled: true }] },
  };
  const view = {
    side: "long", basis: "volatility", width: 2, window: 50, atrLength: 14,
    agg: "max", baseResolution: "MINUTE",
  };
  const win = { broker: "capital", epic: "X", priceSide: "mid", displayResolution: "HOUR", fromTime: 0, toTime: 3600 };
  expect(buildClosenessRequest(cfg as never, view as never, win as never)).toBeNull();
});

it("builds a request from the active side's enabled rows", () => {
  const cfg = {
    longEntry: { combine: "OR", rules: [
      { expr: "close > 100", enabled: true },
      { expr: "close > 90", enabled: false },
    ] },
    shortEntry: { combine: "AND", rules: [] },
  };
  const view = {
    side: "long", basis: "volatility", width: 2, window: 50, atrLength: 14,
    agg: "max", baseResolution: "MINUTE",
  };
  const win = { broker: "capital", epic: "X", priceSide: "mid", displayResolution: "HOUR", fromTime: 0, toTime: 3600 };
  const req = buildClosenessRequest(cfg as never, view as never, win as never);
  expect(req).not.toBeNull();
  expect(req!.rows).toEqual(["close > 100"]);   // disabled row dropped
  expect(req!.combine).toBe("OR");
  expect(req!.baseResolution).toBe("MINUTE");
  expect(req!.displayResolution).toBe("HOUR");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/heatmapController.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the pure controller helpers**

Create `frontend/src/lib/heatmapController.ts`:

```ts
import type { BacktestConfig, RuleGroup } from "./backtestConfig";
import { activeGroup } from "./backtestConfig";
import type { ClosenessAgg, ClosenessRequest } from "../api";

export type HeatmapSide = "long" | "short";

export interface HeatmapView {
  side: HeatmapSide;
  basis: "volatility" | "atr";
  width: number;
  window: number;
  atrLength: number;
  agg: ClosenessAgg;
  baseResolution: string; // the rule's authored resolution
}

export interface HeatmapWindow {
  broker: string;
  epic: string;
  priceSide: string;
  displayResolution: string;
  fromTime: number;
  toTime: number;
}

// Enabled expression rows of the active side's entry group, or null if none.
function activeRows(cfg: BacktestConfig, side: HeatmapSide): RuleGroup | null {
  const group = side === "long" ? cfg.longEntry : cfg.shortEntry;
  const active = activeGroup(group);
  return active.rules.length ? active : null;
}

export function buildClosenessRequest(
  cfg: BacktestConfig,
  view: HeatmapView,
  win: HeatmapWindow,
): ClosenessRequest | null {
  const group = activeRows(cfg, view.side);
  if (!group) return null;
  const rows = group.rules
    .map((r) => r.expr)
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  if (!rows.length) return null;
  return {
    broker: win.broker,
    epic: win.epic,
    priceSide: win.priceSide,
    rows,
    combine: group.combine,
    baseResolution: view.baseResolution,
    displayResolution: win.displayResolution,
    fromTime: win.fromTime,
    toTime: win.toTime,
    norm: { basis: view.basis, width: view.width, window: view.window, atrLength: view.atrLength },
    agg: view.agg,
  };
}

export function alignValuesToBars(
  barTimes: number[],
  resp: { times: number[]; values: (number | null)[] },
): (number | null)[] {
  const byTime = new Map<number, number | null>();
  for (let i = 0; i < resp.times.length; i++) byTime.set(resp.times[i], resp.values[i] ?? null);
  return barTimes.map((t) => (byTime.has(t) ? byTime.get(t)! : null));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/heatmapController.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the indicator template**

In `frontend/src/lib/customIndicators.ts`, follow the existing `registerIndicator({ ...tmpl, name })` pattern to register `PROXIMITY_HEATMAP_TEMPLATE` under the name `"ProximityHeatmap"`:

```ts
import { PROXIMITY_HEATMAP_TEMPLATE } from "./indicators/proximityHeatmap";
// ...alongside the other registrations:
registerIndicator({ ...PROXIMITY_HEATMAP_TEMPLATE, name: "ProximityHeatmap" });
```

- [ ] **Step 6: Wire the toggle, controls, and refetch in `ChartCore.tsx`**

Follow the existing indicator-instance pattern in `ChartCore.tsx` (how other
custom price-pane overlays are created/removed and how their `extendData` is
updated). Add:

1. View state: `heatmapOn: boolean` and a `HeatmapView` (side/basis/width/window/atrLength/agg), with `baseResolution` seeded from the loaded config's authored resolution. Defaults: `side: "long"`, `basis: "volatility"`, `width: 2`, `window: 50`, `atrLength: 14`, `agg: "max"`.
2. A control popover on the chart (reuse the shared `Tooltip`/`InfoTip`). Controls and copy (no em dashes, no "how much/far"):
   - Side: Long | Short.
   - Scale: Volatility | ATR. InfoTip (Volatility): "Each condition is measured against how far it normally sits from its trigger." InfoTip (ATR): "Each condition is measured in ATR units."
   - Sensitivity (`width`): InfoTip: "Higher values light up the chart from further away."
   - On higher timeframes (`agg`): Max | Average | Last close. InfoTip: "How each higher-timeframe bar combines the base bars it covers."
3. Create/remove the `"ProximityHeatmap"` indicator instance when `heatmapOn` and `heatmapVisible(displayResolution, view.baseResolution)` are both true; remove it otherwise.
4. A refetch effect keyed on `[heatmapOn, config, view, epic, broker, priceSide, displayResolution, window]`: call `buildClosenessRequest`; if null, clear the overlay; else `fetchClosenessHeatmap`, `alignValuesToBars` against the chart's current bar timestamps, and set the indicator's `extendData = { values }` (then call the chart's override/refresh method the other overlays use, e.g. `overrideIndicator`). Guard against stale responses (ignore a resolved fetch if the request inputs changed) using the abort/sequence idiom already in `ChartCore`.

- [ ] **Step 7: Verify the frontend suite is green**

Run: `cd frontend && npx vitest run src/lib/heatmapController.test.ts src/lib/proximityHeatmap.test.ts src/lib/indicators/proximityHeatmap.test.ts src/api.closeness.test.ts`
Expected: PASS.

- [ ] **Step 8: Manual verification (drive the real app)**

Use the `verify` / `run` skill to launch the app. Load a backtest config with a
Long entry group, turn the heatmap on, and confirm: columns tint behind the
candles, hot near where the rule fires; switching Side/Scale/Sensitivity/agg
repaints; on a timeframe below the authored resolution the overlay disappears;
editing a rule repaints live.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/customIndicators.ts frontend/src/lib/heatmapController.ts frontend/src/lib/heatmapController.test.ts frontend/src/ChartCore.tsx
git commit -m "feat(closeness): wire proximity heatmap overlay, controls, and refetch"
```

---

## Self-Review

**Spec coverage:**
- Per-row gap/ramp → Task 1. Volatility + ATR scales → Task 2. Cross rows (symmetric line-proximity) → Task 3. Undefined poisoning → Tasks 2-4. Strict min/max fold → Task 4. HTF aggregation (max/avg/last) → Task 5. Endpoint + HTF-operand fetch + below-base hidden → Task 6. FE client → Task 7. Color/alpha + resolution gate → Task 8. Full-height column render → Task 9. Current-config source, Long/Short toggle, controls/copy, live refetch, register → Task 10.
- `count` modifier: spec says it does not affect closeness; the endpoint parses `expr` only and ignores `count`, so no task needed (documented here).

**Placeholder scan:** No TBD/TODO. Task 10 Step 6 is integration wiring described against the existing `ChartCore` overlay pattern rather than full code, because it depends on that file's private idioms; its testable pieces (request building, value alignment) are fully coded and tested in Steps 1-4.

**Type consistency:** `Norm(basis, width, window, atr_length)` used identically in Tasks 3, 4, 6. `NormSpec(basis, width, window, atrLength)` (camelCase) is the wire shape in Tasks 6-7, mapped to `Norm` in the endpoint. `group_closeness(rows, combine, candles, resolution, htf, norm)` signature consistent Tasks 4/6. `aggregate_to_display(...)` returns `(times, values)` consistent Tasks 5/6. FE `ClosenessRequest` fields match the endpoint's `ExprClosenessRequest` one-to-one.
