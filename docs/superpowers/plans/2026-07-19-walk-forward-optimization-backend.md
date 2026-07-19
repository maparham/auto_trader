# Walk-Forward Optimization (Backend Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend walk-forward optimization: a job that per fold picks the best combo on train data only, evaluates it out-of-sample, stitches the OOS record, and scores robustness. Covers build-order steps 1-3 of `docs/walk-forward-optimization-design.md` (spec). UI is a separate follow-up plan.

**Architecture:** WFO is a meta-job over the existing sweep infrastructure. Grid evaluation runs each combo ONCE over the full range on the ProcessPoolExecutor and slices per-fold train metrics worker-side ("sliced" eval mode); OOS tests of fold winners are exact flat-start engine runs via the existing `period:from`/`period:to` env-combo machinery. Selection, stitching, stability, and scoring are pure arithmetic in the job thread. Results auto-persist to a new sqlite store.

**Tech Stack:** Python 3.12, FastAPI, pydantic v2, stdlib sqlite3/concurrent.futures, pytest. No new dependencies.

## Global Constraints

- Work directly on `main` (user rule: never branch unless asked).
- No em dashes in any end-user-facing copy (code comments/commits are fine, but avoid them anyway).
- Worker modules (`sweep_worker.py`, new `wfo_worker.py`) must import no FastAPI app/deps and do zero network (spawn-safe, macOS has no fork).
- All new metric/scoring code returns `None` for ill-conditioned cases, never raises (matches `engine/metrics.py` convention).
- Backend dir: `/Users/mahmoudparham/auto_trader/backend`. Run tests from there: `python -m pytest tests/<file> -v` (pytest>=8.3 configured in pyproject.toml).
- DTOs use camelCase field names (matches existing `schemas.py`); internal Python uses snake_case.
- v1 eval mode is sliced-only for the grid phase (exact OOS tests always); `evalMode` enum reserves `"exact"` but submitting it returns 422 "not yet supported".
- Commit after every task with a `feat(wfo):`/`refactor(wfo):` prefix and the standard Claude trailer.

## File Structure

| File | Responsibility |
|---|---|
| `backend/auto_trader/strategy/coded.py` (modify) | Accept an externally-owned indicator cache |
| `backend/auto_trader/api/sweep_apply.py` (modify) | Plumb `indicator_cache` into `run_coded_sync` |
| `backend/auto_trader/api/sweep_worker.py` (modify) | Worker-level indicator cache; extract `execute_combo` |
| `backend/auto_trader/engine/metrics.py` (modify) | `slice_window_metrics` (sub-window full metrics) |
| `backend/auto_trader/engine/plateau.py` (new) | Neighborhood plateau scoring (port of `frontend/src/lib/sweepPlateau.ts`) |
| `backend/auto_trader/api/wfo_plan.py` (new) | Span parsing + fold schedule math (pure) |
| `backend/auto_trader/engine/stability.py` (new) | Parameter stability + robustness score |
| `backend/auto_trader/api/wfo_select.py` (new) | Per-fold objective scoring + selection |
| `backend/auto_trader/api/wfo_stitch.py` (new) | OOS stitching, WFE, aggregate robustness block |
| `backend/auto_trader/api/schemas.py` (modify) | `WalkForwardDTO` + friends, `BacktestRequest.walkforward` |
| `backend/auto_trader/api/wfo_worker.py` (new) | Pool worker: grid combo (sliced folds) + exact test runs |
| `backend/auto_trader/api/wfo_jobs.py` (new) | `WfoJobManager` orchestrator (phases, progress, cancel) |
| `backend/auto_trader/core/wfo_store.py` (new) | Persistence, `backtest_wfo.db` |
| `backend/auto_trader/config.py` (modify) | `wfo_db_path` setting |
| `backend/auto_trader/api/routers/backtest.py` (modify) | Submit/status/cancel/fold/archive endpoints |

---

### Task 1: Worker-level indicator cache for coded strategies

Today every sweep combo rebuilds `CodedStrategy`, so every indicator series recomputes per combo. Candles are fixed for a whole job, so a worker-process-level cache keyed by candle identity makes repeat indicator computation free. This speeds up ordinary sweeps too and is independent of everything else.

**Files:**
- Modify: `backend/auto_trader/strategy/coded.py` (class `CodedStrategy`, ~line 341: `__init__` builds `self._cache = {}` today)
- Modify: `backend/auto_trader/api/sweep_apply.py:170` (`run_coded_sync`)
- Modify: `backend/auto_trader/api/sweep_worker.py`
- Test: `backend/tests/test_wfo_indicator_cache.py`

**Interfaces:**
- Produces: `CodedStrategy(..., indicator_cache: dict | None = None)` keyword arg; when given, the strategy stores/reads memoized series in that dict instead of a private one. `run_coded_sync(..., indicator_cache: dict | None = None)` passes it through. `sweep_worker` module global `_IND_CACHES: dict[tuple, dict]` keyed by `(len(candles), first_ts, last_ts)` so env-combo-truncated candle lists never share entries.

- [ ] **Step 1: Write the failing test**

```python
"""Worker-level indicator cache: a shared dict passed into CodedStrategy is
reused across instances, and truncated candle lists get separate caches."""
import datetime as dt

from auto_trader.core.models import Candle
from auto_trader.api import sweep_worker


def _candles(n: int) -> list[Candle]:
    t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return [
        Candle(time=t0 + dt.timedelta(hours=i), open=1.0 + i * 0.01,
               high=1.02 + i * 0.01, low=0.99 + i * 0.01,
               close=1.01 + i * 0.01, volume=100.0)
        for i in range(n)
    ]


def test_cache_key_distinguishes_truncated_candles():
    full = _candles(50)
    cut = full[:30]
    k_full = sweep_worker.indicator_cache_key(full)
    k_cut = sweep_worker.indicator_cache_key(cut)
    assert k_full != k_cut
    # Same list -> same key, and the cache dict is reused (identity).
    c1 = sweep_worker.indicator_cache_for(full)
    c2 = sweep_worker.indicator_cache_for(full)
    assert c1 is c2
    assert sweep_worker.indicator_cache_for(cut) is not c1


def test_coded_strategy_uses_external_cache(tmp_path, monkeypatch):
    from auto_trader.strategy import loader
    from auto_trader.strategy.coded import CodedStrategy

    (tmp_path / "s.py").write_text(
        "meta = {'name': 's', 'params': []}\n"
        "def on_bar(ctx):\n"
        "    ctx.ema(5)\n"
    )
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    module = loader.load_strategy("s.py", tmp_path)
    candles = _candles(50)
    shared: dict = {}
    s1 = CodedStrategy(module, candles, quantity=1.0, trade_from_time=0,
                       htf_candles={}, base_timeframe="HOUR", params={},
                       indicator_cache=shared)
    # Drive one series computation through the public cache mechanism.
    from auto_trader.indicators.core import ema_series
    s1_series = s1.indicator_cache
    assert s1_series is shared
    shared["EMA_5"] = ema_series([c.close for c in candles], 5)
    s2 = CodedStrategy(module, candles, quantity=1.0, trade_from_time=0,
                       htf_candles={}, base_timeframe="HOUR", params={},
                       indicator_cache=shared)
    assert s2.indicator_cache is shared
    assert "EMA_5" in s2.indicator_cache
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_wfo_indicator_cache.py -v`
Expected: FAIL with `AttributeError: module ... has no attribute 'indicator_cache_key'` (and the second test fails on the unknown `indicator_cache=` kwarg).

- [ ] **Step 3: Implement**

In `coded.py`, `CodedStrategy.__init__` currently creates the memo dict it hands to each `StrategyContext` (the attribute passed as `cache=` when contexts are built; find the line assigning `self._cache = {}` or equivalent near the constructor). Change to:

```python
# externally-owned cache (worker-level reuse across combos); private when absent
self._cache: dict[str, list[float | None]] = (
    indicator_cache if indicator_cache is not None else {}
)
```

with the new keyword-only parameter `indicator_cache: dict | None = None` appended to `__init__`, and add a read-only property:

```python
@property
def indicator_cache(self) -> dict:
    """The memoized indicator-series dict (shared when injected by a worker)."""
    return self._cache
```

In `sweep_apply.py`, `run_coded_sync` gains a trailing keyword arg `indicator_cache: dict | None = None` and passes `indicator_cache=indicator_cache` into the `CodedStrategy(...)` construction (only the inner `CodedStrategy`, not `CodedWithRuleExits`).

In `sweep_worker.py`, add at module level and wire into `run_combo`'s coded branch:

```python
# Per-worker indicator-series caches, keyed by candle-list identity so an
# env-combo (period:to) truncated list never shares series with the full one.
_IND_CACHES: dict[tuple, dict] = {}


def indicator_cache_key(candles: list[Candle]) -> tuple:
    if not candles:
        return (0, 0, 0)
    return (len(candles), candles[0].time.timestamp(), candles[-1].time.timestamp())


def indicator_cache_for(candles: list[Candle]) -> dict:
    return _IND_CACHES.setdefault(indicator_cache_key(candles), {})
```

In `run_combo`, change the coded call to:

```python
result, _ = sa.run_coded_sync(
    patched, candles, s.module, resolved, long_risk, short_risk, dict(s.htf),
    indicator_cache=indicator_cache_for(candles),
)
```

Also clear `_IND_CACHES.clear()` at the top of `worker_init` (fresh job, fresh candles).

- [ ] **Step 4: Run the new test and the existing sweep/coded suites**

Run: `python -m pytest tests/test_wfo_indicator_cache.py tests/test_api_backtest_sweep.py tests/test_api_backtest_coded.py tests/test_api_backtest_rule_sweep.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/coded.py backend/auto_trader/api/sweep_apply.py backend/auto_trader/api/sweep_worker.py backend/tests/test_wfo_indicator_cache.py
git commit -m "perf(sweep): worker-level indicator cache for coded strategies"
```

---

### Task 2: `slice_window_metrics` in `engine/metrics.py`

Full sweep-grade metrics for one arbitrary sub-window of a continuous run. This is the sliced-eval primitive: trades attributed by entry time, equity rebased so risk metrics are window-local.

**Files:**
- Modify: `backend/auto_trader/engine/metrics.py`
- Test: `backend/tests/test_metrics_slice_window.py`

**Interfaces:**
- Produces: `slice_window_metrics(trades, equity, from_ts: float, to_ts: float, starting_cash: float, res_seconds: int) -> dict` returning `{"net_pnl", "n_trades", "win_rate"} | compute_metrics(...)` keys (`return_pct`, `sharpe`, `max_drawdown_pct`, `profit_factor`, `sqn`, ...). Trades: engine `Trade` objects (needs `.pnl`, `.entry_time`, `.exit_time`, `.bars_held`). Equity: `EquityPoint`-likes (`.time`, `.equity`).

- [ ] **Step 1: Write the failing test**

```python
"""slice_window_metrics: entry-time trade attribution, window-local rebased
equity, and compute_metrics-compatible keys."""
import datetime as dt
from types import SimpleNamespace

from auto_trader.engine.metrics import slice_window_metrics


def _t(entry_h: int, exit_h: int, pnl: float):
    t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return SimpleNamespace(
        pnl=pnl, bars_held=exit_h - entry_h,
        entry_time=t0 + dt.timedelta(hours=entry_h),
        exit_time=t0 + dt.timedelta(hours=exit_h),
    )


def _eq(points: list[tuple[int, float]]):
    t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return [SimpleNamespace(time=t0 + dt.timedelta(hours=h), equity=e)
            for h, e in points]


T0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()
H = 3600.0


def test_trades_attributed_by_entry_time():
    trades = [_t(1, 2, 10.0), _t(5, 6, -4.0), _t(9, 12, 7.0)]
    equity = _eq([(i, 1000.0 + i) for i in range(13)])
    m = slice_window_metrics(trades, equity, T0 + 4 * H, T0 + 8 * H, 1000.0, 3600)
    assert m["n_trades"] == 1
    assert m["net_pnl"] == -4.0
    assert m["win_rate"] == 0.0


def test_equity_rebased_to_starting_cash():
    # Run drifted to 1100 before the window; inside the window equity goes
    # 1100 -> 1150 -> 1120. Window-local drawdown must measure from the
    # rebased peak (1050), not from the run's absolute values.
    trades = [_t(5, 6, 50.0)]
    equity = _eq([(0, 1000.0), (2, 1100.0), (5, 1150.0), (7, 1120.0)])
    m = slice_window_metrics(trades, equity, T0 + 4 * H, T0 + 8 * H, 1000.0, 3600)
    # e0 (last point before window) = 1100 -> rebased points 1050, 1020.
    # Peak seeded at starting cash 1000 -> peak 1050, dd = 30/1050.
    assert abs(m["max_drawdown_pct"] - (30.0 / 1050.0 * 100)) < 1e-9


def test_empty_window_is_flat_not_error():
    m = slice_window_metrics([], _eq([(0, 1000.0)]), T0 + 10 * H, T0 + 20 * H, 1000.0, 3600)
    assert m["n_trades"] == 0
    assert m["net_pnl"] == 0.0
    assert m["sharpe"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_metrics_slice_window.py -v`
Expected: FAIL with `ImportError: cannot import name 'slice_window_metrics'`.

- [ ] **Step 3: Implement in `metrics.py`** (append after `window_metrics`)

```python
class _Pt:
    """Minimal EquityPoint stand-in for rebased window slices."""
    __slots__ = ("time", "equity")

    def __init__(self, time, equity):
        self.time = time
        self.equity = equity


def slice_window_metrics(trades, equity, from_ts: float, to_ts: float,
                         starting_cash: float, res_seconds: int) -> dict:
    """Full metrics for one sub-window of a continuous run, as if the window
    were its own run. Trades belong to the window their ENTRY falls in
    ([from_ts, to_ts)); equity points inside the window are rebased so the
    window starts at starting_cash (offset by the last pre-window equity).
    net_pnl is the sum of attributed trade pnls (entry attribution), which can
    differ slightly from the equity delta when a trade straddles the boundary;
    the sliced approximation is documented in the WFO design doc."""
    w_trades = [t for t in trades
                if from_ts <= t.entry_time.timestamp() < to_ts]
    e0 = starting_cash
    for pt in equity:
        if pt.time.timestamp() >= from_ts:
            break
        e0 = pt.equity
    offset = starting_cash - e0
    w_equity = [_Pt(pt.time, pt.equity + offset) for pt in equity
                if from_ts <= pt.time.timestamp() < to_ts]
    net = sum(t.pnl for t in w_trades)
    core = compute_metrics(w_trades, w_equity, net, starting_cash, res_seconds)
    leg = leg_metrics(w_trades, res_seconds, round_trip_cost=0.0)
    return {"net_pnl": round(net, 5), "n_trades": len(w_trades),
            "win_rate": round(leg["win_rate"], 4)} | core
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_metrics_slice_window.py tests/test_metrics.py -v` (the second file exists as `test_metrics*.py`; run `python -m pytest tests -k metrics -v` if the exact name differs)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/metrics.py backend/tests/test_metrics_slice_window.py
git commit -m "feat(wfo): slice_window_metrics for sub-window full metrics"
```

---

### Task 3: `engine/plateau.py` (backend port of sweepPlateau)

Port `frontend/src/lib/sweepPlateau.ts` semantics: `plateau_score = min(own, median(own + neighbors))`, neighbors at Chebyshev distance 1 on range axes and exact match on list axes. The backend version scores an arbitrary values list so any objective (not just net_pnl) can drive it.

**Files:**
- Create: `backend/auto_trader/engine/plateau.py`
- Test: `backend/tests/test_plateau.py`

**Interfaces:**
- Consumes: axes as `list[dict]`: `{"kind": "range"|"list", "targets": [str, ...]}` (range axes have exactly one target; list axes list every combo key they patch).
- Produces: `with_plateau(combos: list[dict], values: list[float | None], axes: list[dict]) -> tuple[list[float | None], list[bool]]` (scores, spike flags), aligned to input order. `values[i] is None` marks an ineligible row (errored / filtered); it gets score None and is excluded from neighborhoods.

- [ ] **Step 1: Write the failing test**

```python
"""Backend plateau scoring mirrors frontend lib/sweepPlateau.ts semantics."""
from auto_trader.engine.plateau import with_plateau

AXES = [{"kind": "range", "targets": ["param:fast"]}]


def rows(vals):
    return [{"param:fast": f} for f in vals]


def test_isolated_spike_scores_at_neighbor_median():
    combos = rows([5, 10, 15])
    values = [1.0, 100.0, 2.0]           # lucky middle cell
    scores, spikes = with_plateau(combos, values, AXES)
    # median(100, 1, 2) = 2, capped at own value -> 2. Not a spike (neighbors > 0).
    assert scores[1] == 2.0
    assert spikes[1] is False


def test_spike_flag_when_neighbors_nonpositive():
    combos = rows([5, 10, 15])
    values = [-1.0, 100.0, -2.0]
    scores, spikes = with_plateau(combos, values, AXES)
    assert spikes[1] is True


def test_list_axis_partitions_neighborhoods():
    axes = [{"kind": "range", "targets": ["param:fast"]},
            {"kind": "list", "targets": ["param:kind"]}]
    combos = [{"param:fast": 5, "param:kind": "a"},
              {"param:fast": 10, "param:kind": "a"},
              {"param:fast": 5, "param:kind": "b"},
              {"param:fast": 10, "param:kind": "b"}]
    values = [1.0, 3.0, 100.0, 200.0]
    scores, _ = with_plateau(combos, values, axes)
    # "a" rows never see "b" values: median(1,3)=2 for row 0.
    assert scores[0] == 1.0              # capped at own value
    assert scores[1] == 2.0


def test_none_values_excluded():
    combos = rows([5, 10, 15])
    values = [1.0, None, 3.0]
    scores, _ = with_plateau(combos, values, AXES)
    assert scores[1] is None
    # Row 0's only in-range neighbor (idx 1) is ineligible: median(own) = own.
    assert scores[0] == 1.0


def test_no_range_axes_yields_none_scores():
    axes = [{"kind": "list", "targets": ["param:kind"]}]
    combos = [{"param:kind": "a"}, {"param:kind": "b"}]
    scores, spikes = with_plateau(combos, [1.0, 2.0], axes)
    assert scores == [None, None]
    assert spikes == [False, False]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_plateau.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.engine.plateau'`.

- [ ] **Step 3: Implement `backend/auto_trader/engine/plateau.py`**

```python
"""Neighborhood plateau scoring over a sweep-style combo grid. The best cell in
a grid is, by selection, the luckiest cell; real edges live on plateaus.
plateau_score = median of the cell and its grid neighbors, capped at the cell's
own value, so a cell cannot borrow credit from a lucky neighbor. Neighbors
differ by at most one step (Chebyshev distance 1) on every range axis and match
exactly on every list axis. Pure functions; mirrors frontend
lib/sweepPlateau.ts so backend selection and frontend display agree."""
from __future__ import annotations

from itertools import product
from statistics import median


def with_plateau(
    combos: list[dict], values: list[float | None], axes: list[dict],
) -> tuple[list[float | None], list[bool]]:
    range_targets = [a["targets"][0] for a in axes if a["kind"] == "range"]
    list_targets = [t for a in axes if a["kind"] == "list" for t in a["targets"]]

    # Ordinal grid index per range axis from the swept values actually present.
    index_of: dict[str, dict[float, int]] = {}
    for t in range_targets:
        vals = sorted({c[t] for c in combos
                       if isinstance(c.get(t), (int, float))
                       and not isinstance(c.get(t), bool)})
        index_of[t] = {v: i for i, v in enumerate(vals)}

    def coord(c: dict) -> tuple[int, ...] | None:
        out: list[int] = []
        for t in range_targets:
            i = index_of[t].get(c.get(t))
            if i is None:
                return None
            out.append(i)
        return tuple(out)

    coords = [coord(c) if values[i] is not None else None
              for i, c in enumerate(combos)]
    list_key = [tuple(str(c.get(t)) for t in list_targets) for c in combos]

    by_cell: dict[tuple, list[int]] = {}
    for i in range(len(combos)):
        if values[i] is None or coords[i] is None:
            continue
        by_cell.setdefault((list_key[i], coords[i]), []).append(i)

    dims = len(range_targets)
    offsets = [o for o in product((-1, 0, 1), repeat=dims) if any(o)]

    scores: list[float | None] = []
    spikes: list[bool] = []
    for i in range(len(combos)):
        if values[i] is None or dims == 0 or coords[i] is None:
            scores.append(None)
            spikes.append(False)
            continue
        neighbors: list[float] = []
        for o in offsets:
            cell = by_cell.get(
                (list_key[i], tuple(c + d for c, d in zip(coords[i], o))))
            if not cell:
                continue
            neighbors.extend(values[j] for j in cell if j != i)
        own = values[i]
        scores.append(min(own, median([own, *neighbors])))
        spikes.append(own > 0 and len(neighbors) >= 2 and median(neighbors) <= 0)
    return scores, spikes
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_plateau.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/plateau.py backend/tests/test_plateau.py
git commit -m "feat(wfo): backend plateau scoring (port of sweepPlateau.ts)"
```

---

### Task 4: `api/wfo_plan.py` fold planning

Pure schedule math: span tokens to seconds, fold tiling anchored at the range end walking backwards, rolling and anchored modes, feasibility errors.

**Files:**
- Create: `backend/auto_trader/api/wfo_plan.py`
- Test: `backend/tests/test_wfo_plan.py`

**Interfaces:**
- Produces:
  - `parse_span(token: str, res_seconds: int) -> int` (seconds). Grammar: `<int><unit>`, units `d` (86400 s), `w` (7d), `m` (30d, approximate calendar month), `b` (bars, `n * res_seconds`). Raises `WfoPlanError(str)` on bad tokens.
  - `@dataclass(frozen=True) Fold: train_from: int; train_to: int; test_from: int; test_to: int` (unix seconds; `train_to == test_from`).
  - `plan(range_from: int, range_to: int, mode: str, train_s: int, test_s: int, step_s: int) -> list[Fold]` chronological order. Raises `WfoPlanError` when fewer than 3 folds fit.
  - `class WfoPlanError(Exception)` with a plain-language message.

- [ ] **Step 1: Write the failing test**

```python
"""Fold planning: backwards tiling from the range end, rolling and anchored."""
import pytest

from auto_trader.api.wfo_plan import Fold, WfoPlanError, parse_span, plan

D = 86400


def test_parse_span_units():
    assert parse_span("10d", 3600) == 10 * D
    assert parse_span("2w", 3600) == 14 * D
    assert parse_span("3m", 3600) == 90 * D
    assert parse_span("500b", 3600) == 500 * 3600
    for bad in ("", "d", "10", "10x", "-3d", "1.5m"):
        with pytest.raises(WfoPlanError):
            parse_span(bad, 3600)


def test_rolling_tiles_backwards_from_range_end():
    # 100 days total, train 20d, test 10d, step 10d -> tests tile the tail.
    folds = plan(0, 100 * D, "rolling", 20 * D, 10 * D, 10 * D)
    assert folds[-1].test_to == 100 * D
    assert folds[-1].test_from == 90 * D
    assert folds[-1].train_from == 70 * D
    assert folds[-1].train_to == 90 * D
    # Consecutive test segments are contiguous.
    for a, b in zip(folds, folds[1:]):
        assert a.test_to == b.test_from
    # Every fold fits inside the range.
    assert all(f.train_from >= 0 for f in folds)
    # 8 folds fit: earliest needs train_from >= 0.
    assert len(folds) == 8


def test_anchored_pins_train_start():
    folds = plan(0, 100 * D, "anchored", 20 * D, 10 * D, 10 * D)
    assert all(f.train_from == 0 for f in folds)
    # Earliest fold still needs a full minimum train span.
    assert folds[0].train_to - folds[0].train_from >= 20 * D
    # Latest fold trains on everything before its test.
    assert folds[-1].train_to == 90 * D


def test_too_few_folds_raises():
    with pytest.raises(WfoPlanError):
        plan(0, 35 * D, "rolling", 20 * D, 10 * D, 10 * D)  # only 1 fold fits
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_plan.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `backend/auto_trader/api/wfo_plan.py`**

```python
"""Walk-forward fold planning: pure schedule math, no I/O. Folds anchor to the
END of the range and walk backwards so the most recent data is always fully
used; any remainder drops at the oldest end. Chronological order returned."""
from __future__ import annotations

import re
from dataclasses import dataclass

_SPAN = re.compile(r"^(\d+)([dwmb])$")
_UNIT_SECONDS = {"d": 86400, "w": 7 * 86400, "m": 30 * 86400}

MIN_FOLDS = 3


class WfoPlanError(Exception):
    """A schedule that cannot be planned (bad token, infeasible range)."""


def parse_span(token: str, res_seconds: int) -> int:
    m = _SPAN.match(token or "")
    if not m or int(m.group(1)) <= 0:
        raise WfoPlanError(
            f"bad span '{token}': use e.g. 10d, 2w, 3m, or 500b (bars)")
    n, unit = int(m.group(1)), m.group(2)
    return n * res_seconds if unit == "b" else n * _UNIT_SECONDS[unit]


@dataclass(frozen=True)
class Fold:
    train_from: int
    train_to: int
    test_from: int
    test_to: int


def plan(range_from: int, range_to: int, mode: str,
         train_s: int, test_s: int, step_s: int) -> list[Fold]:
    if range_to <= range_from:
        raise WfoPlanError("empty date range")
    folds: list[Fold] = []
    end = range_to
    while True:
        test_from = end - test_s
        train_from = range_from if mode == "anchored" else test_from - train_s
        if test_from <= range_from or train_from < range_from:
            break
        if mode == "anchored" and test_from - range_from < train_s:
            break  # anchored still needs the minimum train span
        folds.append(Fold(train_from=int(train_from), train_to=int(test_from),
                          test_from=int(test_from), test_to=int(end)))
        end -= step_s
    folds.reverse()
    if len(folds) < MIN_FOLDS:
        raise WfoPlanError(
            f"only {len(folds)} fold(s) fit this range with train "
            f"{train_s}s / test {test_s}s; need at least {MIN_FOLDS}. "
            "Shorten the windows or extend the date range.")
    return folds
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_plan.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/wfo_plan.py backend/tests/test_wfo_plan.py
git commit -m "feat(wfo): fold schedule planner"
```

---

### Task 5: `engine/stability.py` parameter stability + robustness score

**Files:**
- Create: `backend/auto_trader/engine/stability.py`
- Test: `backend/tests/test_stability.py`

**Interfaces:**
- Consumes: axes dicts (Task 3 shape) plus per-range-axis ordered `values` list: `{"kind": "range", "targets": ["param:fast"], "values": [5, 10, 15, 20]}`.
- Produces:
  - `parameter_stability(chosen: list[dict], axes: list[dict], fold_tables: list[tuple[list[dict], list[float | None]]]) -> dict` where `chosen` is the winning combo per fold (chronological) and each fold table is `(combos, objective_values)`. Returns `{"per_axis": {target: {"stability": float, "adjacency": float, "values": [raw chosen values]}}, "overall": float, "adjacency": float}`. Stability per axis: `1 - pstdev(chosen step indices) / pstdev(uniform pick over the axis)`, clamped to [0, 1]. Overall: sensitivity-weighted mean (weight = pstdev over axis values of the median objective at that value, medianed across folds). Adjacency: fraction of consecutive folds where every axis moved at most one step.
  - `robustness_score(*, wfe_median, pct_folds_profitable, oos_sharpe, param_stability, oos_max_dd_pct, plateau_breadth, oos_trades_total, n_folds) -> float` implementing the spec formula (design doc section 6.6); any `None` component contributes 0.

- [ ] **Step 1: Write the failing test**

```python
"""Parameter stability across folds and the composite robustness score."""
from auto_trader.engine.stability import parameter_stability, robustness_score

AXES = [{"kind": "range", "targets": ["param:fast"], "values": [5, 10, 15, 20]}]


def _tables(objective_by_value: dict, n_folds: int):
    combos = [{"param:fast": v} for v in [5, 10, 15, 20]]
    values = [objective_by_value[c["param:fast"]] for c in combos]
    return [(combos, values)] * n_folds


def test_constant_winner_is_fully_stable():
    chosen = [{"param:fast": 10}] * 4
    out = parameter_stability(chosen, AXES, _tables({5: 0, 10: 3, 15: 1, 20: 0}, 4))
    assert out["per_axis"]["param:fast"]["stability"] == 1.0
    assert out["adjacency"] == 1.0
    assert out["overall"] == 1.0


def test_bouncing_winner_scores_low():
    chosen = [{"param:fast": 5}, {"param:fast": 20},
              {"param:fast": 5}, {"param:fast": 20}]
    out = parameter_stability(chosen, AXES, _tables({5: 3, 10: 0, 15: 0, 20: 3}, 4))
    assert out["per_axis"]["param:fast"]["stability"] < 0.2
    assert out["adjacency"] == 0.0


def test_robustness_score_bounds_and_penalty():
    hi = robustness_score(
        wfe_median=0.9, pct_folds_profitable=1.0, oos_sharpe=2.0,
        param_stability=1.0, oos_max_dd_pct=5.0, plateau_breadth=0.8,
        oos_trades_total=300, n_folds=10)
    assert 90 <= hi <= 100
    lo = robustness_score(
        wfe_median=-0.5, pct_folds_profitable=0.0, oos_sharpe=None,
        param_stability=0.0, oos_max_dd_pct=60.0, plateau_breadth=0.0,
        oos_trades_total=300, n_folds=10)
    assert lo == 0.0
    thin = robustness_score(
        wfe_median=0.9, pct_folds_profitable=1.0, oos_sharpe=2.0,
        param_stability=1.0, oos_max_dd_pct=5.0, plateau_breadth=0.8,
        oos_trades_total=20, n_folds=3)
    assert thin < hi * 0.5  # sample penalty bites
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_stability.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `backend/auto_trader/engine/stability.py`**

```python
"""Parameter stability across walk-forward folds, and the composite robustness
score. Pure arithmetic; conventions match engine/metrics.py (None in = 0
contribution, never raises)."""
from __future__ import annotations

from statistics import median, pstdev


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _ramp(x: float | None, lo: float, hi: float) -> float:
    if x is None:
        return 0.0
    return _clamp01((x - lo) / (hi - lo))


def parameter_stability(chosen, axes, fold_tables) -> dict:
    per_axis: dict[str, dict] = {}
    weights: dict[str, float] = {}
    range_axes = [a for a in axes if a["kind"] == "range"]
    for a in range_axes:
        target = a["targets"][0]
        values = list(a["values"])
        idx = {v: i for i, v in enumerate(values)}
        picks = [idx.get(c.get(target)) for c in chosen]
        picks = [p for p in picks if p is not None]
        uniform_sd = pstdev(range(len(values))) if len(values) > 1 else 0.0
        stability = 1.0
        if len(picks) >= 2 and uniform_sd > 0:
            stability = _clamp01(1.0 - pstdev(picks) / uniform_sd)
        adjacency = 1.0
        if len(picks) >= 2:
            adjacency = sum(
                1 for a_, b in zip(picks, picks[1:]) if abs(a_ - b) <= 1
            ) / (len(picks) - 1)
        per_axis[target] = {
            "stability": round(stability, 4),
            "adjacency": round(adjacency, 4),
            "values": [c.get(target) for c in chosen],
        }
        # Sensitivity weight: spread of the per-value median objective. An axis
        # the objective ignores should not drag the overall score.
        by_value_medians: list[float] = []
        for v in values:
            per_fold = []
            for combos, objs in fold_tables:
                vals = [o for c, o in zip(combos, objs)
                        if c.get(target) == v and o is not None]
                if vals:
                    per_fold.append(median(vals))
            if per_fold:
                by_value_medians.append(median(per_fold))
        weights[target] = pstdev(by_value_medians) if len(by_value_medians) > 1 else 0.0

    if not per_axis:
        return {"per_axis": {}, "overall": None, "adjacency": None}
    total_w = sum(weights.values())
    if total_w > 0:
        overall = sum(per_axis[t]["stability"] * weights[t] for t in per_axis) / total_w
    else:
        overall = sum(v["stability"] for v in per_axis.values()) / len(per_axis)
    # Overall adjacency: a fold transition counts only if EVERY axis stayed
    # within one step.
    n_steps = len(chosen) - 1
    joint = 0
    if n_steps > 0:
        for k in range(n_steps):
            ok = True
            for a in range_axes:
                t = a["targets"][0]
                idx = {v: i for i, v in enumerate(a["values"])}
                i0, i1 = idx.get(chosen[k].get(t)), idx.get(chosen[k + 1].get(t))
                if i0 is None or i1 is None or abs(i0 - i1) > 1:
                    ok = False
                    break
            joint += 1 if ok else 0
    return {
        "per_axis": per_axis,
        "overall": round(overall, 4),
        "adjacency": round(joint / n_steps, 4) if n_steps > 0 else None,
    }


def robustness_score(*, wfe_median, pct_folds_profitable, oos_sharpe,
                     param_stability, oos_max_dd_pct, plateau_breadth,
                     oos_trades_total, n_folds) -> float:
    core = (
        0.30 * _ramp(wfe_median, 0.0, 0.6)
        + 0.20 * (pct_folds_profitable or 0.0)
        + 0.15 * _ramp(oos_sharpe, 0.0, 1.5)
        + 0.15 * (param_stability or 0.0)
        + 0.10 * _ramp(-(oos_max_dd_pct or 100.0), -40.0, -10.0)
        + 0.10 * (plateau_breadth or 0.0)
    )
    penalty = min(1.0, (oos_trades_total or 0) / 100.0) * min(1.0, (n_folds or 0) / 5.0)
    return round(100.0 * _clamp01(core) * penalty, 1)
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_stability.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/stability.py backend/tests/test_stability.py
git commit -m "feat(wfo): parameter stability and robustness score"
```

---

### Task 6: `api/wfo_select.py` per-fold selection

**Files:**
- Create: `backend/auto_trader/api/wfo_select.py`
- Test: `backend/tests/test_wfo_select.py`

**Interfaces:**
- Consumes: `with_plateau` from Task 3.
- Produces:
  - `objective_values(rows: list[dict], objective: dict) -> list[float | None]` where each row is `{"combo": dict, "metrics": dict | None}` and `objective = {"metric": str, "composite": dict[str, float] | None, "min_trades": int}`. A row is ineligible (None) when metrics is None, `n_trades < min_trades`, or the metric value is None. Composite mode z-scores each named component across eligible rows and returns the weighted sum. Higher is always better; callers negate `max_drawdown_pct`-style metrics via a negative composite weight.
  - `select_fold(rows, axes, objective, selection: str) -> tuple[int | None, list[float | None], list[float | None]]` returning (chosen row index or None when nothing is eligible, objective values, plateau scores or Nones for `selection="best"`). Plateau mode picks the best plateau score, tie-broken by raw objective; falls back to best-raw when no plateau score exists (e.g. no range axes).
  - `plateau_breadth(values: list[float | None]) -> float | None`: share of eligible cells within 80 percent of the peak (peak must be > 0, else None).

- [ ] **Step 1: Write the failing test**

```python
"""Per-fold combo selection: objective evaluation, best vs plateau, breadth."""
from auto_trader.api.wfo_select import objective_values, plateau_breadth, select_fold

AXES = [{"kind": "range", "targets": ["param:fast"], "values": [5, 10, 15]}]


def _rows(metrics_list):
    return [{"combo": {"param:fast": v}, "metrics": m}
            for v, m in zip([5, 10, 15], metrics_list)]


def test_min_trades_filters_row():
    rows = _rows([{"sharpe": 2.0, "n_trades": 3},
                  {"sharpe": 1.0, "n_trades": 50},
                  None])
    vals = objective_values(rows, {"metric": "sharpe", "composite": None, "min_trades": 10})
    assert vals == [None, 1.0, None]


def test_composite_z_scores():
    rows = _rows([{"sharpe": 1.0, "max_drawdown_pct": 30.0, "n_trades": 50},
                  {"sharpe": 2.0, "max_drawdown_pct": 10.0, "n_trades": 50},
                  {"sharpe": 3.0, "max_drawdown_pct": 20.0, "n_trades": 50}])
    vals = objective_values(rows, {
        "metric": "sharpe",
        "composite": {"sharpe": 0.5, "max_drawdown_pct": -0.5},
        "min_trades": 0})
    # Row 1 has middling sharpe but the best (lowest) drawdown; row 2 best
    # sharpe but middling dd. Both must beat row 0.
    assert vals[0] < vals[1] and vals[0] < vals[2]


def test_plateau_selection_prefers_supported_cell():
    rows = _rows([{"sharpe": 1.8, "n_trades": 50},
                  {"sharpe": 2.0, "n_trades": 50},   # solid plateau center
                  {"sharpe": 0.1, "n_trades": 50}])
    spiky = _rows([{"sharpe": 0.1, "n_trades": 50},
                   {"sharpe": 5.0, "n_trades": 50},  # isolated spike
                   {"sharpe": 0.2, "n_trades": 50}])
    obj = {"metric": "sharpe", "composite": None, "min_trades": 0}
    i, _, _ = select_fold(rows, AXES, obj, "plateau")
    assert i == 1
    j, _, _ = select_fold(spiky, AXES, obj, "best")
    assert j == 1  # raw best still picks the spike


def test_select_none_when_no_eligible():
    rows = _rows([None, None, None])
    i, vals, _ = select_fold(rows, AXES, {"metric": "sharpe", "composite": None,
                                          "min_trades": 0}, "best")
    assert i is None and vals == [None, None, None]


def test_plateau_breadth():
    assert plateau_breadth([10.0, 9.0, 1.0, None]) == round(2 / 3, 4)
    assert plateau_breadth([-1.0, -2.0]) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_select.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `backend/auto_trader/api/wfo_select.py`**

```python
"""Per-fold combo selection for walk-forward optimization. Pure functions over
fold result tables; importable by the job thread (no FastAPI, no engine)."""
from __future__ import annotations

from statistics import pstdev

from auto_trader.engine.plateau import with_plateau


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def objective_values(rows: list[dict], objective: dict) -> list[float | None]:
    min_trades = objective.get("min_trades") or 0
    eligible = [
        r["metrics"] is not None
        and (r["metrics"].get("n_trades") or 0) >= min_trades
        for r in rows
    ]
    composite = objective.get("composite")
    if not composite:
        metric = objective["metric"]
        return [
            r["metrics"].get(metric) if ok and r["metrics"].get(metric) is not None
            else None
            for r, ok in zip(rows, eligible)
        ]
    # z-score each component across eligible rows, then weighted-sum. A row
    # missing any component is ineligible for the composite.
    comps: dict[str, tuple[float, float]] = {}
    for name in composite:
        vals = [r["metrics"].get(name) for r, ok in zip(rows, eligible) if ok]
        vals = [v for v in vals if v is not None]
        comps[name] = (_mean(vals), pstdev(vals) if len(vals) > 1 else 0.0)
    out: list[float | None] = []
    for r, ok in zip(rows, eligible):
        if not ok:
            out.append(None)
            continue
        score = 0.0
        bad = False
        for name, w in composite.items():
            v = r["metrics"].get(name)
            if v is None:
                bad = True
                break
            mean, sd = comps[name]
            score += w * ((v - mean) / sd if sd > 0 else 0.0)
        out.append(None if bad else score)
    return out


def select_fold(rows, axes, objective, selection: str):
    values = objective_values(rows, objective)
    combos = [r["combo"] for r in rows]
    scores: list[float | None] = [None] * len(rows)
    if selection == "plateau":
        scores, _ = with_plateau(combos, values, axes)
    ranked = scores if any(s is not None for s in scores) else values
    best_i: int | None = None
    for i, s in enumerate(ranked):
        if s is None:
            continue
        if best_i is None or s > ranked[best_i] or (
            s == ranked[best_i]
            and values[i] is not None and values[best_i] is not None
            and values[i] > values[best_i]
        ):
            best_i = i
    return best_i, values, scores


def plateau_breadth(values: list[float | None]) -> float | None:
    ok = [v for v in values if v is not None]
    if not ok:
        return None
    peak = max(ok)
    if peak <= 0:
        return None
    return round(sum(1 for v in ok if v >= 0.8 * peak) / len(ok), 4)
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_select.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/wfo_select.py backend/tests/test_wfo_select.py
git commit -m "feat(wfo): per-fold objective evaluation and selection"
```

---

### Task 7: `api/wfo_stitch.py` stitching, WFE, aggregates

**Files:**
- Create: `backend/auto_trader/api/wfo_stitch.py`
- Test: `backend/tests/test_wfo_stitch.py`

**Interfaces:**
- Consumes: `compute_metrics` (`engine/metrics.py`), `robustness_score`/`parameter_stability` (Task 5), `plateau_breadth` (Task 6).
- Produces:
  - `annualized_rate(return_pct: float | None, span_seconds: int) -> float | None` (simple scaling: `return_pct * (31_557_600 / span_seconds)`; fine for comparison ratios).
  - `fold_wfe(is_metrics, oos_metrics, train_seconds, test_seconds) -> float | None` (None when IS annualized return <= 0).
  - `stitch(fold_tests: list[dict], starting_cash: float, res_seconds: int) -> dict` where each fold test is `{"fold": {"test_from", "test_to", ...}, "trades": [{"entry_time", "exit_time", "pnl", "side"}], "equity": [[ts, eq], ...]}` chronological. Returns `{"equity": [[ts, eq], ...] (summed, each segment offset by prior cumulative pnl), "equity_scaled": [[ts, eq], ...] (each segment scaled by prior_end / starting_cash), "trades": [...] (flat, with "fold" index added), "metrics": compute_metrics dict over the summed curve}`.
  - `aggregate(folds: list[dict], stitched_metrics: dict, stability: dict, breadth: float | None) -> dict` producing the robustness block: `wfe_median`, `wfe_aggregate`, `pct_folds_profitable`, `median_fold_return_pct`, `worst_fold_return_pct`, `oos_sharpe`, `oos_max_drawdown_pct`, `oos_profit_factor`, `param_stability`, `n_folds`, `oos_trades_total`, `low_sample_folds`, `robustness_score`. Each fold dict carries `{"wfe", "oos_metrics", "low_sample"}`.

- [ ] **Step 1: Write the failing test**

```python
"""OOS stitching, walk-forward efficiency, and the aggregate robustness block."""
import datetime as dt

from auto_trader.api.wfo_stitch import aggregate, annualized_rate, fold_wfe, stitch

YEAR = 31_557_600


def _ts(day: int) -> int:
    return int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()) + day * 86400


def test_fold_wfe():
    is_m = {"return_pct": 12.0}
    oos_m = {"return_pct": 1.0}
    # 90d train at 12% vs 30d test at 1%: annualized 48.7% vs 12.2% -> ~0.25.
    w = fold_wfe(is_m, oos_m, 90 * 86400, 30 * 86400)
    assert abs(w - (annualized_rate(1.0, 30 * 86400) / annualized_rate(12.0, 90 * 86400))) < 1e-9
    assert fold_wfe({"return_pct": -5.0}, oos_m, 90 * 86400, 30 * 86400) is None


def test_stitch_offsets_segments():
    tests = [
        {"fold": {"test_from": _ts(0), "test_to": _ts(10)},
         "trades": [{"entry_time": _ts(1), "exit_time": _ts(2), "pnl": 100.0, "side": "LONG"}],
         "equity": [[_ts(0), 1000.0], [_ts(9), 1100.0]]},
        {"fold": {"test_from": _ts(10), "test_to": _ts(20)},
         "trades": [{"entry_time": _ts(11), "exit_time": _ts(12), "pnl": -50.0, "side": "SHORT"}],
         "equity": [[_ts(10), 1000.0], [_ts(19), 950.0]]},
    ]
    out = stitch(tests, 1000.0, 86400)
    # Summed: second segment offset by +100 cumulative pnl.
    assert out["equity"][-1] == [_ts(19), 1050.0]
    # Scaled: second segment scaled by 1100/1000.
    assert abs(out["equity_scaled"][-1][1] - 950.0 * 1.1) < 1e-9
    assert [t["fold"] for t in out["trades"]] == [0, 1]
    assert out["metrics"]["return_pct"] == 5.0  # 50 on 1000


def test_aggregate_block():
    folds = [
        {"wfe": 0.8, "low_sample": False,
         "oos_metrics": {"return_pct": 2.0, "net_pnl": 20.0}},
        {"wfe": 0.4, "low_sample": False,
         "oos_metrics": {"return_pct": -1.0, "net_pnl": -10.0}},
        {"wfe": None, "low_sample": True,
         "oos_metrics": {"return_pct": 1.0, "net_pnl": 10.0}},
    ]
    stitched = {"sharpe": 1.2, "max_drawdown_pct": 8.0, "profit_factor": 1.5}
    stability = {"overall": 0.9}
    out = aggregate(folds, stitched, stability, breadth=0.5,
                    oos_trades_total=120)
    assert out["wfe_median"] == 0.6
    assert out["pct_folds_profitable"] == round(2 / 3, 4)
    assert out["worst_fold_return_pct"] == -1.0
    assert out["low_sample_folds"] == 1
    assert out["n_folds"] == 3
    assert 0 <= out["robustness_score"] <= 100
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_stitch.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `backend/auto_trader/api/wfo_stitch.py`**

```python
"""Stitch per-fold out-of-sample test runs into one OOS record, compute
walk-forward efficiency, and assemble the aggregate robustness block."""
from __future__ import annotations

import datetime as dt
from statistics import median
from types import SimpleNamespace

from auto_trader.engine.metrics import compute_metrics
from auto_trader.engine.stability import robustness_score

_YEAR = 31_557_600


def annualized_rate(return_pct: float | None, span_seconds: int) -> float | None:
    if return_pct is None or span_seconds <= 0:
        return None
    return return_pct * (_YEAR / span_seconds)


def fold_wfe(is_metrics: dict, oos_metrics: dict,
             train_seconds: int, test_seconds: int) -> float | None:
    is_rate = annualized_rate(is_metrics.get("return_pct"), train_seconds)
    oos_rate = annualized_rate(oos_metrics.get("return_pct"), test_seconds)
    if is_rate is None or oos_rate is None or is_rate <= 0:
        return None
    return round(oos_rate / is_rate, 4)


def stitch(fold_tests: list[dict], starting_cash: float, res_seconds: int) -> dict:
    equity: list[list[float]] = []
    scaled: list[list[float]] = []
    trades: list[dict] = []
    cum_pnl = 0.0
    factor = 1.0
    for k, ft in enumerate(fold_tests):
        seg = ft["equity"]
        for ts, eq in seg:
            equity.append([ts, eq + cum_pnl])
            scaled.append([ts, eq * factor])
        for t in ft["trades"]:
            trades.append({**t, "fold": k})
        seg_end = seg[-1][1] if seg else starting_cash
        cum_pnl += seg_end - starting_cash
        factor *= seg_end / starting_cash if starting_cash > 0 else 1.0
    # compute_metrics over the summed curve via minimal stand-ins.
    utc = dt.timezone.utc
    eq_pts = [SimpleNamespace(time=dt.datetime.fromtimestamp(ts, tz=utc), equity=eq)
              for ts, eq in equity]
    tr_objs = [SimpleNamespace(
        pnl=t["pnl"], bars_held=None,
        entry_time=dt.datetime.fromtimestamp(t["entry_time"], tz=utc),
        exit_time=dt.datetime.fromtimestamp(t["exit_time"], tz=utc),
    ) for t in trades]
    metrics = compute_metrics(tr_objs, eq_pts, cum_pnl, starting_cash, res_seconds)
    return {"equity": equity, "equity_scaled": scaled,
            "trades": trades, "metrics": metrics}


def aggregate(folds: list[dict], stitched_metrics: dict, stability: dict,
              breadth: float | None, oos_trades_total: int) -> dict:
    wfes = [f["wfe"] for f in folds if f.get("wfe") is not None]
    rets = [f["oos_metrics"].get("return_pct") for f in folds
            if f.get("oos_metrics")]
    rets = [r for r in rets if r is not None]
    nets = [f["oos_metrics"].get("net_pnl") or 0.0 for f in folds
            if f.get("oos_metrics")]
    n = len(folds)
    block = {
        "wfe_median": round(median(wfes), 4) if wfes else None,
        "wfe_aggregate": None,  # filled by the orchestrator (needs IS totals)
        "pct_folds_profitable": round(
            sum(1 for x in nets if x > 0) / n, 4) if n else None,
        "median_fold_return_pct": round(median(rets), 4) if rets else None,
        "worst_fold_return_pct": round(min(rets), 4) if rets else None,
        "oos_sharpe": stitched_metrics.get("sharpe"),
        "oos_max_drawdown_pct": stitched_metrics.get("max_drawdown_pct"),
        "oos_profit_factor": stitched_metrics.get("profit_factor"),
        "param_stability": stability.get("overall"),
        "plateau_breadth": breadth,
        "n_folds": n,
        "oos_trades_total": oos_trades_total,
        "low_sample_folds": sum(1 for f in folds if f.get("low_sample")),
    }
    block["robustness_score"] = robustness_score(
        wfe_median=block["wfe_median"],
        pct_folds_profitable=block["pct_folds_profitable"],
        oos_sharpe=block["oos_sharpe"],
        param_stability=block["param_stability"],
        oos_max_dd_pct=block["oos_max_drawdown_pct"],
        plateau_breadth=breadth,
        oos_trades_total=oos_trades_total,
        n_folds=n,
    )
    return block
```

(Adjust the test's `aggregate` call signature note: it passes `oos_trades_total=120` as shown in Step 1.)

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_stitch.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/wfo_stitch.py backend/tests/test_wfo_stitch.py
git commit -m "feat(wfo): OOS stitching, WFE, aggregate robustness block"
```

---

### Task 8: Schemas + config

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (add DTOs after `SweepRowDTO`, ~line 477; add `walkforward` field to `BacktestRequest`, next to `sweep` at line 438)
- Modify: `backend/auto_trader/config.py` (add `wfo_db_path: str = "backtest_wfo.db"` next to `sweeps_db_path` at line 70)
- Test: `backend/tests/test_wfo_schemas.py`

**Interfaces:**
- Produces (all pydantic BaseModel, camelCase):

```python
class WfoAxisDTO(BaseModel):
    kind: Literal["range", "list"]
    targets: list[str]
    values: list[float] | None = None   # ordered swept values, range axes only

class WfoScheduleDTO(BaseModel):
    mode: Literal["rolling", "anchored"] = "rolling"
    trainSpan: str
    testSpan: str
    step: str | None = None             # default = testSpan
    minTrainTrades: int = 30
    minTestTrades: int = 5

class WfoObjectiveDTO(BaseModel):
    metric: str = "sharpe"
    selection: Literal["best", "plateau"] = "plateau"
    composite: dict[str, float] | None = None

class WalkForwardDTO(BaseModel):
    combos: list[dict[str, float | int | bool | str]]
    axes: list[WfoAxisDTO]
    schedule: WfoScheduleDTO
    matrixTrainSpans: list[str] = []
    evalMode: Literal["auto", "sliced", "exact"] = "auto"

class WfoJobSubmitResponse(BaseModel):
    jobId: str
    total: int
    schemes: list[dict]                 # per scheme: trainSpan + fold windows

class WfoJobStatusResponse(BaseModel):
    phase: str                          # "grid" | "test" | "aggregate" | "done"
    done: int
    total: int
    running: bool
    cancelled: bool
    error: str | None = None
    etaSeconds: float | None = None
    foldRows: list[dict]                # streamed winner rows from cursor
    result: dict | None = None          # final WfoResult once finished
```

- `BacktestRequest.walkforward: WalkForwardDTO | None = None` with a comment matching the `sweep` field's style.
- `axes` conversion helper for the pure modules: `def axis_dicts(axes: list[WfoAxisDTO]) -> list[dict]` in `schemas.py` returning `{"kind", "targets", "values"}` dicts.

- [ ] **Step 1: Write the failing test**

```python
"""Walk-forward DTO shapes and defaults."""
from auto_trader.api.schemas import (
    BacktestRequest, WalkForwardDTO, WfoAxisDTO, WfoObjectiveDTO, WfoScheduleDTO,
    axis_dicts,
)


def test_walkforward_dto_defaults():
    dto = WalkForwardDTO(
        combos=[{"param:fast": 5}],
        axes=[WfoAxisDTO(kind="range", targets=["param:fast"], values=[5, 10])],
        schedule=WfoScheduleDTO(trainSpan="3m", testSpan="1m"),
    )
    assert dto.schedule.mode == "rolling"
    assert dto.schedule.step is None
    assert dto.schedule.minTrainTrades == 30
    assert dto.evalMode == "auto"
    assert dto.matrixTrainSpans == []
    assert WfoObjectiveDTO().selection == "plateau"
    assert axis_dicts(dto.axes) == [
        {"kind": "range", "targets": ["param:fast"], "values": [5.0, 10.0]}]


def test_backtest_request_accepts_walkforward():
    assert "walkforward" in BacktestRequest.model_fields
    assert BacktestRequest.model_fields["walkforward"].default is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_schemas.py -v`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement** the DTOs exactly as in the Interfaces block (plus `objective: WfoObjectiveDTO = WfoObjectiveDTO()` field on `WalkForwardDTO` — note: pydantic default instance is fine since DTOs are immutable in practice; use `Field(default_factory=WfoObjectiveDTO)`), the `walkforward` field on `BacktestRequest`, `axis_dicts`, and the config setting:

```python
# config.py, next to sweeps_db_path
wfo_db_path: str = "backtest_wfo.db"
```

Docstring on `WalkForwardDTO`:

```python
class WalkForwardDTO(BaseModel):
    """Walk-forward optimization job spec (POST /api/backtest/walkforward/jobs).
    combos/targets use the sweep grammar (see SweepDTO); axes describe the grid
    structure so the backend can do plateau selection and stability. Spans use
    the wfo_plan token grammar: 10d, 2w, 3m, 500b."""
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_schemas.py tests/test_api_backtest.py -v`
Expected: PASS (existing request tests unaffected: new field defaults to None).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/config.py backend/tests/test_wfo_schemas.py
git commit -m "feat(wfo): walk-forward DTOs and config"
```

---

### Task 9: `api/wfo_worker.py` pool worker + `execute_combo` extraction

**Files:**
- Modify: `backend/auto_trader/api/sweep_worker.py` (extract the engine-run core of `run_combo` into `execute_combo`)
- Create: `backend/auto_trader/api/wfo_worker.py`
- Test: `backend/tests/test_wfo_worker.py`

**Interfaces:**
- Produces in `sweep_worker.py`:

```python
def execute_combo(s: _State, req: BacktestRequest, combo: dict) -> BacktestResult:
    """Apply one combo (env + strategy patches) and run the engine. Raises on
    any problem; run_combo wraps this into never-raising row semantics."""
```

  `run_combo` becomes a thin wrapper: patch windows onto req (as today), `try: result = execute_combo(...); return sa.sweep_row(req, combo, result).model_dump() except ...` (identical error-row behavior).
- Produces in `wfo_worker.py`:

```python
def worker_init(req_dict, htf_candles, strategies_dir, train_windows: list[list[int]]) -> None
    # calls sweep_worker.worker_init(req_dict, htf_candles, strategies_dir, None)
    # and stores train_windows ([[from_ts, to_ts], ...] union over schemes) in a module global

def run_grid_combo(combo: dict) -> dict
    # ONE full-range engine run; returns
    # {"combo": combo, "folds": [slice_window_metrics per train window], "error": None}
    # or {"combo": combo, "folds": None, "error": str} — never raises

def run_test(payload: dict) -> dict
    # payload: {"key": str, "combo": dict, "test_from": int, "test_to": int}
    # Exact OOS run: executes execute_combo with {**combo, "period:from": test_from,
    # "period:to": test_to} (flat start, warm indicators via the candle prefix).
    # Returns {"key", "combo", "metrics": slice-style dict, "trades": [minimal dicts],
    # "equity": [[ts, eq], ...] clipped to [test_from, test_to) and rebased to
    # startingCash, downsampled to <= 500 points, "error": None} — never raises
```

- [ ] **Step 1: Write the failing test**

Uses the same fixture style as `tests/test_api_backtest_sweep.py` (check its request-building helpers in `tests/conftest.py` / that file first and reuse them; the test below builds a minimal coded request directly).

```python
"""wfo_worker: sliced grid metrics per train window and exact OOS test runs,
driven in-process (no pool) via worker_init + run_* calls."""
import datetime as dt

from auto_trader.api import wfo_worker

T0 = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp())
H = 3600


def _candles_dto(n: int) -> list[dict]:
    out = []
    price = 100.0
    for i in range(n):
        price += 0.1 if (i // 20) % 2 == 0 else -0.1   # gentle regime waves
        out.append({"time": T0 + i * H, "open": price, "high": price + 0.2,
                    "low": price - 0.2, "close": price + 0.05, "volume": 100.0})
    return out


STRAT = """
meta = {"name": "t", "params": [
    {"name": "fast", "label": "fast", "type": "int", "default": 5, "min": 2, "max": 50, "step": 1},
]}
def on_bar(ctx):
    f = ctx.ema(ctx.param("fast"))
    s = ctx.ema(20)
    if f is None or s is None:
        return
    if ctx.position.side is None and f > s:
        ctx.buy()
    elif ctx.position.side == "LONG" and f < s:
        ctx.close_long()
"""


def _req_dict(n_candles: int) -> dict:
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": _candles_dto(n_candles),
        "series": {}, "longEntry": empty, "longExit": empty,
        "shortEntry": empty, "shortExit": empty,
        "costs": {"startingCash": 10000, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "spread": 0,
                  "quantity": 1},
        "tradeFromTime": T0, "codedStrategy": "t.py",
    }


def _init(tmp_path, n_candles, train_windows):
    (tmp_path / "t.py").write_text(STRAT)
    wfo_worker.worker_init(_req_dict(n_candles), {}, str(tmp_path), train_windows)


def test_grid_combo_slices_per_train_window(tmp_path):
    w1 = [T0 + 100 * H, T0 + 300 * H]
    w2 = [T0 + 200 * H, T0 + 400 * H]
    _init(tmp_path, 500, [w1, w2])
    row = wfo_worker.run_grid_combo({"param:fast": 5})
    assert row["error"] is None
    assert len(row["folds"]) == 2
    for fm in row["folds"]:
        assert "net_pnl" in fm and "sharpe" in fm and "n_trades" in fm


def test_bad_combo_yields_error_row(tmp_path):
    _init(tmp_path, 200, [[T0, T0 + 100 * H]])
    row = wfo_worker.run_grid_combo({"param:nope": 1})
    assert row["folds"] is None and row["error"]


def test_run_test_returns_clipped_rebased_equity(tmp_path):
    _init(tmp_path, 500, [[T0, T0 + 100 * H]])
    out = wfo_worker.run_test({"key": "s0f0", "combo": {"param:fast": 5},
                               "test_from": T0 + 300 * H, "test_to": T0 + 400 * H})
    assert out["error"] is None
    assert out["key"] == "s0f0"
    ts = [p[0] for p in out["equity"]]
    assert min(ts) >= T0 + 300 * H and max(ts) < T0 + 400 * H
    assert len(out["equity"]) <= 500
    assert out["equity"][0][1] == 10000.0  # rebased to starting cash
    for t in out["trades"]:
        assert set(t) >= {"entry_time", "exit_time", "pnl", "side"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_worker.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.api.wfo_worker'`.

- [ ] **Step 3a: Extract `execute_combo` in `sweep_worker.py`**

```python
def execute_combo(s: _State, req: BacktestRequest, combo: dict) -> "BacktestResult":
    """Apply one combo (env split + strategy patch) and run the engine over the
    worker's candles. Raises on any problem; callers own error-row semantics."""
    env, rest = sa.split_env_combo(combo)
    patched, candles = sa.apply_env_combo(req, s.candles, env)
    if s.module is None:
        patched = sa.apply_rule_combo(patched, rest)
        return sa.run_rule_sync(patched, candles, dict(s.htf))
    params, long_risk, short_risk = sa.apply_combo(patched, rest)
    resolved = resolve_params(s.module, params)
    result, _ = sa.run_coded_sync(
        patched, candles, s.module, resolved, long_risk, short_risk, dict(s.htf),
        indicator_cache=indicator_cache_for(candles),
    )
    return result
```

`run_combo` keeps its windows-patching preamble and becomes:

```python
    try:
        result = execute_combo(s, req, combo)
        return sa.sweep_row(req, combo, result).model_dump()
    except Exception as e:  # noqa: BLE001  one combo must never kill the worker
        return {"combo": combo, "metrics": None, "windows": None, "error": str(e)}
```

Add `from auto_trader.engine.backtest import BacktestResult` under TYPE_CHECKING or as a plain import (sweep_apply already imports it; a plain import is fine).

- [ ] **Step 3b: Create `backend/auto_trader/api/wfo_worker.py`**

```python
"""ProcessPool worker for walk-forward jobs. Reuses sweep_worker's init-once
state and engine execution; adds per-train-window sliced metrics (one engine
run per combo, sliced N ways) and exact out-of-sample test runs. Spawn-safe,
zero network, no FastAPI imports."""
from __future__ import annotations

from auto_trader.api import sweep_worker
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.engine.metrics import slice_window_metrics

_TRAIN_WINDOWS: list[list[int]] | None = None
_EQUITY_CAP = 500


def worker_init(req_dict, htf_candles, strategies_dir, train_windows) -> None:
    global _TRAIN_WINDOWS
    sweep_worker.worker_init(req_dict, htf_candles, strategies_dir, None)
    _TRAIN_WINDOWS = train_windows


def run_grid_combo(combo: dict) -> dict:
    """One full-range engine run, sliced into per-train-window metrics.
    Never raises."""
    s = sweep_worker._STATE
    assert s is not None and _TRAIN_WINDOWS is not None, "worker_init not called"
    try:
        result = sweep_worker.execute_combo(s, s.req, combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        folds = [
            slice_window_metrics(result.trades, result.equity, w[0], w[1], cash, res_s)
            for w in _TRAIN_WINDOWS
        ]
        return {"combo": combo, "folds": folds, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"combo": combo, "folds": None, "error": str(e)}


def _downsample(points: list[list[float]], cap: int) -> list[list[float]]:
    if len(points) <= cap:
        return points
    step = len(points) / cap
    out = [points[int(i * step)] for i in range(cap - 1)]
    out.append(points[-1])
    return out


def run_test(payload: dict) -> dict:
    """Exact flat-start OOS run of one fold winner over its test window, via
    the period env-combo (entries gate at test_from, candles truncate at
    test_to; the warm-up prefix keeps indicators warm). Never raises."""
    s = sweep_worker._STATE
    assert s is not None, "worker_init not called"
    combo = payload["combo"]
    test_from, test_to = payload["test_from"], payload["test_to"]
    try:
        run_combo = {**combo, "period:from": test_from, "period:to": test_to}
        result = sweep_worker.execute_combo(s, s.req, run_combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        metrics = slice_window_metrics(
            result.trades, result.equity, test_from, test_to, cash, res_s)
        # Rebase equity inside the window to starting cash (same offset rule as
        # slice_window_metrics: last pre-window equity maps to cash).
        e0 = cash
        for pt in result.equity:
            if pt.time.timestamp() >= test_from:
                break
            e0 = pt.equity
        offset = cash - e0
        equity = [[int(pt.time.timestamp()), round(pt.equity + offset, 5)]
                  for pt in result.equity
                  if test_from <= pt.time.timestamp() < test_to]
        trades = [{
            "entry_time": int(t.entry_time.timestamp()),
            "exit_time": int(t.exit_time.timestamp()),
            "pnl": round(t.pnl, 5),
            "side": t.side,
        } for t in result.trades if test_from <= t.entry_time.timestamp() < test_to]
        return {"key": payload["key"], "combo": combo, "metrics": metrics,
                "trades": trades, "equity": _downsample(equity, _EQUITY_CAP),
                "error": None}
    except Exception as e:  # noqa: BLE001
        return {"key": payload.get("key"), "combo": combo, "metrics": None,
                "trades": None, "equity": None, "error": str(e)}
```

Note: `t.side` may be an enum; if `result.trades[*].side` is not a plain string, serialize with `str(t.side)` or `t.side.value` (check `core/models.py` `Trade.side` while implementing and match how `sweep_apply`/`routers` serialize trades today).

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_worker.py tests/test_api_backtest_sweep.py tests/test_api_backtest_rule_sweep.py -v`
Expected: PASS (sweep behavior unchanged by the extraction).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/sweep_worker.py backend/auto_trader/api/wfo_worker.py backend/tests/test_wfo_worker.py
git commit -m "feat(wfo): pool worker for sliced grid eval and exact OOS tests"
```

---

### Task 10: `api/wfo_jobs.py` orchestrator

The manager mirrors `SweepJobManager` (FIFO gate, daemon thread, bounded-wait cancel loop, reap-and-kill) but drives three phases. Reuse by copy-adaptation is acceptable here (the sweep manager's loop is interwoven with its row semantics; a shared abstraction would be speculative).

**Files:**
- Create: `backend/auto_trader/api/wfo_jobs.py`
- Test: `backend/tests/test_wfo_jobs.py`

**Interfaces:**
- Consumes: `wfo_worker.worker_init/run_grid_combo/run_test`, `wfo_plan.Fold`, `wfo_select.select_fold/objective_values/plateau_breadth`, `wfo_stitch.stitch/fold_wfe/aggregate/annualized_rate`, `stability.parameter_stability`, `schemas.axis_dicts`.
- Produces:

```python
@dataclass
class WfoJob:
    job_id: str; epic: str; timeframe: str
    total: int          # grid combos + total winner tests
    done: int = 0
    phase: str = "grid" # "grid" | "test" | "aggregate" | "done"
    fold_rows: list[dict] = field(default_factory=list)  # streamed winner rows
    result: dict | None = None
    fold_tables: dict[str, list[dict]] = field(default_factory=dict)
        # "s{scheme}/f{fold}" -> ranked table rows for the lazy endpoint
    running: bool = True; cancelled: bool = False; error: str | None = None
    eta_seconds: float | None = None; created_at: float = 0.0; finished_at: float = 0.0

class WfoJobManager:
    def submit(*, req_dict, htf_candles, strategies_dir, schemes, axes, objective,
               schedule_meta, epic, timeframe, workers=None, on_complete=None) -> WfoJob
    def get(job_id) -> WfoJob | None
    def cancel(job_id) -> bool
    def list() -> list[WfoJob]

WFO_JOBS = WfoJobManager()  # module singleton
```

  - `schemes: list[dict]` each `{"train_span": str, "folds": [Fold-as-dict with train_from/train_to/test_from/test_to], "min_train_trades": int, "min_test_trades": int}` (already planned/validated by the router).
  - `objective: dict` = `{"metric", "composite", "min_trades", "selection"}`.
  - `on_complete: Callable[[WfoJob], None] | None` called in the job thread after a successful finish (the router passes the store's sync insert).
  - Result dict shape (the `result` attribute and the persisted record):

```python
{
  "eval_mode": "sliced",
  "objective": {...}, "schedule": {...}, "axes": [...],
  "schemes": [
    {
      "train_span": "3m",
      "folds": [
        {"train_from": ..., "train_to": ..., "test_from": ..., "test_to": ...,
         "combo": {...} | None, "is_metrics": {...} | None,
         "oos_metrics": {...} | None, "wfe": float | None,
         "low_sample": bool, "error": str | None}
      ],
      "stitched": {"equity": [...], "equity_scaled": [...], "trades": [...],
                   "metrics": {...}},
      "stability": {...},
      "robustness": {... aggregate block ...},
    }
  ],
}
```

- [ ] **Step 1: Write the failing test**

Drive the manager end-to-end with a synchronous fake pool (same technique as the existing `tests/test_sweep_jobs*.py`; read that file first and mirror its `pool_factory` fake). Core assertions:

```python
"""WfoJobManager: end-to-end orchestration with an in-process fake pool."""
import time
from concurrent.futures import Future

from auto_trader.api import wfo_jobs, wfo_worker


class _SyncPool:
    """Runs submitted fns inline; mimics the ProcessPoolExecutor surface."""
    def __init__(self, max_workers=None, initializer=None, initargs=()):
        if initializer:
            initializer(*initargs)
    def submit(self, fn, *args):
        f = Future()
        try:
            f.set_result(fn(*args))
        except Exception as e:  # pragma: no cover
            f.set_exception(e)
        return f
    def shutdown(self, wait=True, cancel_futures=False):
        pass


def _wait(job, timeout=30.0):
    t0 = time.time()
    while job.running and time.time() - t0 < timeout:
        time.sleep(0.02)
    assert not job.running, "job did not finish"


def test_wfo_job_end_to_end(tmp_path):
    # Reuse the request/strategy fixtures from tests/test_wfo_worker.py by
    # importing its helpers (move _req_dict/_candles_dto/STRAT into
    # tests/wfo_fixtures.py in this task and import from both test files).
    from tests.wfo_fixtures import make_req_dict, write_strategy, T0, H
    write_strategy(tmp_path)
    day = 24 * H
    folds = [
        {"train_from": T0, "train_to": T0 + 10 * day,
         "test_from": T0 + 10 * day, "test_to": T0 + 13 * day},
        {"train_from": T0 + 3 * day, "train_to": T0 + 13 * day,
         "test_from": T0 + 13 * day, "test_to": T0 + 16 * day},
        {"train_from": T0 + 6 * day, "train_to": T0 + 16 * day,
         "test_from": T0 + 16 * day, "test_to": T0 + 19 * day},
    ]
    mgr = wfo_jobs.WfoJobManager(pool_factory=_SyncPool)
    done_jobs = []
    job = mgr.submit(
        req_dict=make_req_dict(19 * 24),  # 19 days of hourly candles
        htf_candles={}, strategies_dir=str(tmp_path),
        schemes=[{"train_span": "10d", "folds": folds,
                  "min_train_trades": 0, "min_test_trades": 0}],
        axes=[{"kind": "range", "targets": ["param:fast"], "values": [3, 5, 8]}],
        objective={"metric": "net_pnl", "composite": None, "min_trades": 0,
                   "selection": "best"},
        schedule_meta={"mode": "rolling", "trainSpan": "10d", "testSpan": "3d"},
        epic="TEST", timeframe="HOUR",
        combos=[{"param:fast": 3}, {"param:fast": 5}, {"param:fast": 8}],
        on_complete=done_jobs.append,
    )
    _wait(job)
    assert job.error is None
    assert job.phase == "done"
    assert job.done == job.total == 3 + 3        # combos + winner tests
    res = job.result
    scheme = res["schemes"][0]
    assert len(scheme["folds"]) == 3
    for f in scheme["folds"]:
        assert f["combo"] is not None
        assert f["is_metrics"] is not None
    assert "robustness_score" in scheme["robustness"]
    assert scheme["stitched"]["equity"]
    # Streamed winner rows arrived (one per fold).
    assert len(job.fold_rows) == 3
    # Lazy fold tables retained.
    assert "s0/f0" in job.fold_tables
    assert done_jobs == [job]


class _BlockingPool(_SyncPool):
    """Futures resolve only when the test releases the gate, so a cancel can
    land while the grid phase is in flight."""
    gate = None  # threading.Event, set per test

    def submit(self, fn, *args):
        f = Future()

        def _later():
            _BlockingPool.gate.wait(10.0)
            try:
                f.set_result(fn(*args))
            except Exception as e:  # pragma: no cover
                f.set_exception(e)

        import threading
        threading.Thread(target=_later, daemon=True).start()
        return f


def test_cancel_mid_grid(tmp_path):
    import threading
    from tests.wfo_fixtures import make_req_dict, write_strategy, T0, H
    write_strategy(tmp_path)
    _BlockingPool.gate = threading.Event()
    day = 24 * H
    folds = [{"train_from": T0 + i * day, "train_to": T0 + (i + 10) * day,
              "test_from": T0 + (i + 10) * day, "test_to": T0 + (i + 13) * day}
             for i in (0, 3, 6)]
    mgr = wfo_jobs.WfoJobManager(pool_factory=_BlockingPool, grace_seconds=0.2)
    job = mgr.submit(
        req_dict=make_req_dict(19 * 24), htf_candles={},
        strategies_dir=str(tmp_path),
        schemes=[{"train_span": "10d", "folds": folds,
                  "min_train_trades": 0, "min_test_trades": 0}],
        axes=[{"kind": "range", "targets": ["param:fast"], "values": [3, 5, 8]}],
        objective={"metric": "net_pnl", "composite": None, "min_trades": 0,
                   "selection": "best"},
        schedule_meta={}, epic="TEST", timeframe="HOUR",
        combos=[{"param:fast": 3}, {"param:fast": 5}, {"param:fast": 8}],
    )
    time.sleep(0.1)                 # let the grid phase start
    assert mgr.cancel(job.job_id)
    _BlockingPool.gate.set()        # release in-flight combos
    _wait(job)
    assert job.cancelled and job.phase != "done" and job.result is None
```

If `wfo_jobs`'s cancel path uses `ProcessPoolExecutor`-private attrs in `_reap` (it does, copied from `sweep_jobs._reap`), guard with `getattr` exactly as `sweep_jobs.py:218` does so the fake pool passes. Also create `backend/tests/wfo_fixtures.py` in this step by moving `_req_dict`/`_candles_dto`/`STRAT` from `tests/test_wfo_worker.py` (renamed `make_req_dict`/`make_candles`/`write_strategy`; update that file's imports).

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_jobs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.api.wfo_jobs'`.

- [ ] **Step 3: Implement `backend/auto_trader/api/wfo_jobs.py`**

Structure (follow `sweep_jobs.py` for the gate/cancel/reap mechanics; key differences shown in full):

```python
"""Background walk-forward job manager: a meta-job over the sweep pool.
Phase 1 (grid): every combo runs ONCE over the full range; workers return
per-train-window sliced metrics. Phase 2 (test): each fold's selected winner
runs exactly over its test window. Phase 3 (aggregate): selection tables,
stitching, stability, robustness — pure arithmetic in this thread."""
from __future__ import annotations

import logging
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass, field

from auto_trader.api import wfo_worker
from auto_trader.api.sweep_jobs import SWEEP_WORKERS
from auto_trader.api.wfo_select import objective_values, plateau_breadth, select_fold
from auto_trader.api.wfo_stitch import aggregate, annualized_rate, fold_wfe, stitch
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.engine.stability import parameter_stability

logger = logging.getLogger(__name__)
_TTL_SECONDS = 3600.0


@dataclass
class WfoJob:
    job_id: str
    epic: str
    timeframe: str
    total: int
    done: int = 0
    phase: str = "grid"
    fold_rows: list[dict] = field(default_factory=list)
    result: dict | None = None
    fold_tables: dict[str, list[dict]] = field(default_factory=dict)
    running: bool = True
    cancelled: bool = False
    error: str | None = None
    eta_seconds: float | None = None
    created_at: float = 0.0
    finished_at: float = 0.0


class WfoJobManager:
    def __init__(self, pool_factory=ProcessPoolExecutor, grace_seconds: float = 10.0):
        self._pool_factory = pool_factory
        self._grace_seconds = grace_seconds
        self._jobs: dict[str, WfoJob] = {}
        self._store_lock = threading.Lock()
        self._gate = threading.Semaphore(1)

    # submit/get/cancel/list/_prune: same shapes as SweepJobManager; submit
    # stores kwargs and spawns the daemon thread on self._run.
```

The `_run` core (the part that is genuinely new):

```python
    def _run(self, job, kw) -> None:
        with self._gate:
            if job.cancelled:
                self._finish(job)
                return
            pool = None
            t0 = time.monotonic()
            try:
                schemes = kw["schemes"]
                # De-duplicated union of train windows across schemes; each
                # fold remembers its index into the union.
                union: list[list[int]] = []
                index: dict[tuple[int, int], int] = {}
                for sc in schemes:
                    for f in sc["folds"]:
                        key = (f["train_from"], f["train_to"])
                        if key not in index:
                            index[key] = len(union)
                            union.append([f["train_from"], f["train_to"]])
                        f["_w"] = index[key]

                pool = self._pool_factory(
                    max_workers=kw.get("workers") or SWEEP_WORKERS,
                    initializer=wfo_worker.worker_init,
                    initargs=(kw["req_dict"], kw["htf_candles"],
                              kw["strategies_dir"], union),
                )
                # --- phase 1: grid ---
                grid_rows = self._drain(
                    pool, [pool.submit(wfo_worker.run_grid_combo, c)
                           for c in kw["combos"]], job, t0)
                if job.cancelled:
                    return
                # --- phase 2: select + test ---
                job.phase = "test"
                objective = kw["objective"]
                res_s = resolution_seconds(kw["req_dict"]["resolution"])
                test_payloads = []
                selections: dict[str, dict] = {}
                for si, sc in enumerate(schemes):
                    for fi, f in enumerate(sc["folds"]):
                        rows = [
                            {"combo": r["combo"],
                             "metrics": (r["folds"][f["_w"]] if r["folds"] else None)}
                            for r in grid_rows
                        ]
                        obj = {**objective, "min_trades": sc["min_train_trades"]}
                        best_i, values, scores = select_fold(
                            rows, kw["axes"], obj, objective["selection"])
                        key = f"s{si}/f{fi}"
                        job.fold_tables[key] = [
                            {**rows[i], "objective": values[i],
                             "plateau_score": scores[i]}
                            for i in range(len(rows))
                        ]
                        sel = {"rows": rows, "values": values, "best_i": best_i,
                               "fold": f, "scheme": si}
                        selections[key] = sel
                        if best_i is not None:
                            test_payloads.append({
                                "key": key, "combo": rows[best_i]["combo"],
                                "test_from": f["test_from"], "test_to": f["test_to"],
                            })
                test_rows = self._drain(
                    pool, [pool.submit(wfo_worker.run_test, p)
                           for p in test_payloads], job, t0,
                    stream=lambda r: job.fold_rows.append(
                        {"key": r["key"], "combo": r["combo"],
                         "oos_metrics": r["metrics"], "error": r["error"]}))
                if job.cancelled:
                    return
                # --- phase 3: aggregate ---
                job.phase = "aggregate"
                job.result = self._aggregate(kw, schemes, selections,
                                             {r["key"]: r for r in test_rows if r})
                job.phase = "done"
                cb = kw.get("on_complete")
                if cb is not None and not job.cancelled:
                    cb(job)
            except Exception as e:  # noqa: BLE001
                job.error = str(e)
            finally:
                if pool is not None:
                    pool.shutdown(wait=False)
                logger.info("wfo job %s done in %.1fs (phase=%s)",
                            job.job_id, time.monotonic() - t0, job.phase)
                self._finish(job)
```

`_drain` is the sweep manager's bounded-wait loop factored as a method (records rows via a small `_record` identical to sweeps'; on cancel: `pool.shutdown(wait=False, cancel_futures=True)` + the `_reap` logic copied from `sweep_jobs.py`). `_aggregate` builds the result dict:

```python
    def _aggregate(self, kw, schemes, selections, tests_by_key) -> dict:
        res_s = resolution_seconds(kw["req_dict"]["resolution"])
        cash = kw["req_dict"]["costs"]["startingCash"]
        out_schemes = []
        for si, sc in enumerate(schemes):
            folds_out, fold_tests, chosen = [], [], []
            is_ret_total = oos_ret_total = 0.0
            is_secs = oos_secs = 0
            tables = []
            for fi, f in enumerate(sc["folds"]):
                key = f"s{si}/f{fi}"
                sel = selections[key]
                test = tests_by_key.get(key)
                entry = {
                    "train_from": f["train_from"], "train_to": f["train_to"],
                    "test_from": f["test_from"], "test_to": f["test_to"],
                    "combo": None, "is_metrics": None, "oos_metrics": None,
                    "wfe": None, "low_sample": False,
                    "error": test["error"] if test else None,
                }
                tables.append((
                    [r["combo"] for r in sel["rows"]], sel["values"]))
                if sel["best_i"] is not None:
                    row = sel["rows"][sel["best_i"]]
                    entry["combo"] = row["combo"]
                    entry["is_metrics"] = row["metrics"]
                if test and test["metrics"] is not None and entry["is_metrics"]:
                    entry["oos_metrics"] = test["metrics"]
                    tr_s = f["train_to"] - f["train_from"]
                    te_s = f["test_to"] - f["test_from"]
                    entry["wfe"] = fold_wfe(entry["is_metrics"], test["metrics"],
                                            tr_s, te_s)
                    entry["low_sample"] = (
                        (test["metrics"].get("n_trades") or 0) < sc["min_test_trades"])
                    if entry["is_metrics"].get("return_pct") is not None:
                        is_ret_total += entry["is_metrics"]["return_pct"]
                        is_secs += tr_s
                    if test["metrics"].get("return_pct") is not None:
                        oos_ret_total += test["metrics"]["return_pct"]
                        oos_secs += te_s
                    chosen.append(entry["combo"])
                    fold_tests.append({"fold": f, "trades": test["trades"],
                                       "equity": test["equity"]})
                folds_out.append(entry)
            stitched = stitch(fold_tests, cash, res_s) if fold_tests else {
                "equity": [], "equity_scaled": [], "trades": [], "metrics": {}}
            stab = parameter_stability(chosen, kw["axes"],
                                       [(c, v) for c, v in tables])
            # Median plateau breadth across fold tables.
            breadths = [plateau_breadth(v) for _, v in tables]
            breadths = [b for b in breadths if b is not None]
            breadth = sorted(breadths)[len(breadths) // 2] if breadths else None
            block = aggregate(folds_out, stitched["metrics"], stab, breadth,
                              oos_trades_total=len(stitched["trades"]))
            is_rate = annualized_rate(is_ret_total, is_secs) if is_secs else None
            oos_rate = annualized_rate(oos_ret_total, oos_secs) if oos_secs else None
            if is_rate and is_rate > 0 and oos_rate is not None:
                block["wfe_aggregate"] = round(oos_rate / is_rate, 4)
            out_schemes.append({
                "train_span": sc["train_span"], "folds": folds_out,
                "stitched": stitched, "stability": stab, "robustness": block,
            })
        return {"eval_mode": "sliced", "objective": kw["objective"],
                "schedule": kw["schedule_meta"], "axes": kw["axes"],
                "schemes": out_schemes}
```

`_finish(job)` sets `finished_at`/`running=False`. `total` at submit = `len(combos) + sum(len(sc["folds"]) for sc in schemes)` (winner tests assumed one per fold; folds with no eligible winner simply finish early, leaving `done < total` by that count; set `job.done = job.total` at the top of the aggregate phase so progress reads complete). Module singleton `WFO_JOBS = WfoJobManager()` at the bottom.

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_jobs.py tests/test_wfo_worker.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/wfo_jobs.py backend/tests/test_wfo_jobs.py backend/tests/wfo_fixtures.py backend/tests/test_wfo_worker.py
git commit -m "feat(wfo): walk-forward job orchestrator"
```

---

### Task 11: `core/wfo_store.py` persistence

**Files:**
- Create: `backend/auto_trader/core/wfo_store.py`
- Test: `backend/tests/test_wfo_store.py`

**Interfaces:**
- Produces: `WfoStore(db_path, cap=50)` mirroring `SweepStore` (WAL, fresh connection per op, prune on insert), table:

```sql
CREATE TABLE IF NOT EXISTS wfo (
  id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, timeframe TEXT,
  name TEXT, request_json TEXT, result_json TEXT, fold_tables_json TEXT)
```

  Methods: `async insert(rec)`, **`insert_sync(rec)`** (public, called from the job thread's `on_complete`), `async list(limit=50, epic=None)` returning summaries `{id, created_at, epic, timeframe, name, n_schemes, robustness_score (best scheme's), wfe_median}`, `async get(id)` (full record, fold tables excluded), `async get_fold_tables(id)` (just the tables dict), `async delete(id)`. Fold tables budget: on insert, if the serialized tables exceed 50000 total rows, keep per-fold top-200 by objective and stamp `rec["result"]["truncated_tables"] = True`.
- Module singleton `WFO_STORE = WfoStore(settings.wfo_db_path)` (import-at-bottom pattern like `sweep_store.py`).

- [ ] **Step 1: Write the failing test**

```python
"""WfoStore: insert (sync + async), summary listing, budgeted fold tables."""
import asyncio

from auto_trader.core.wfo_store import WfoStore


def _rec(i: int, score: float, n_table_rows: int = 3):
    tables = {"s0/f0": [{"combo": {"param:fast": j}, "objective": float(j)}
                        for j in range(n_table_rows)]}
    return {
        "id": f"id{i}", "created_at": 1000 + i, "epic": "TEST",
        "timeframe": "HOUR", "name": None,
        "request": {"walkforward": {"combos": []}},
        "result": {"schemes": [{"robustness": {"robustness_score": score,
                                               "wfe_median": 0.5}}]},
        "fold_tables": tables,
    }


def test_roundtrip_and_summary(tmp_path):
    store = WfoStore(str(tmp_path / "wfo.db"), cap=10)
    store.insert_sync(_rec(1, 72.5))
    rows = asyncio.run(store.list())
    assert rows[0]["id"] == "id1"
    assert rows[0]["robustness_score"] == 72.5
    full = asyncio.run(store.get("id1"))
    assert full["result"]["schemes"]
    assert "fold_tables" not in full
    tables = asyncio.run(store.get_fold_tables("id1"))
    assert "s0/f0" in tables


def test_cap_prunes_oldest(tmp_path):
    store = WfoStore(str(tmp_path / "wfo.db"), cap=2)
    for i in range(4):
        store.insert_sync(_rec(i, 50.0))
    rows = asyncio.run(store.list())
    assert [r["id"] for r in rows] == ["id3", "id2"]


def test_fold_table_budget(tmp_path):
    store = WfoStore(str(tmp_path / "wfo.db"), cap=5)
    rec = _rec(1, 50.0, n_table_rows=60_000)
    store.insert_sync(rec)
    tables = asyncio.run(store.get_fold_tables("id1"))
    assert len(tables["s0/f0"]) == 200
    # Highest objective rows kept.
    assert tables["s0/f0"][0]["objective"] >= 59_800.0
    full = asyncio.run(store.get("id1"))
    assert full["result"]["truncated_tables"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_wfo_store.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** following `sweep_store.py`'s structure exactly (WAL, `_connect` ensures schema, `asyncio.to_thread` wrappers, cap-prune on insert with rowid tiebreak, corrupt-row tolerance in `_list_sync`). The budget logic in `insert_sync` before serializing:

```python
_TABLE_ROW_BUDGET = 50_000
_TABLE_TOP_N = 200


def _budget_tables(rec: dict) -> None:
    tables = rec.get("fold_tables") or {}
    total = sum(len(v) for v in tables.values())
    if total <= _TABLE_ROW_BUDGET:
        return
    for key, rows in tables.items():
        rows.sort(key=lambda r: (r.get("objective") is not None,
                                 r.get("objective") or 0.0), reverse=True)
        tables[key] = rows[:_TABLE_TOP_N]
    rec.setdefault("result", {})["truncated_tables"] = True
```

Summary extraction in `_list_sync`: parse `result_json`, take `max(robustness_score over schemes)` and its `wfe_median`; tolerate missing keys (`None`).

Add to `config.py` if not already done in Task 8 (it was; verify).

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_wfo_store.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/wfo_store.py backend/tests/test_wfo_store.py
git commit -m "feat(wfo): walk-forward result store"
```

---

### Task 12: Router endpoints

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (new section after the sweep-jobs endpoints, ~line 773)
- Modify: `backend/auto_trader/api/routers/backtest.py:556` (`_validate_combo_targets` gains a `combos` parameter so both sweep and WFO submits share it)
- Test: `backend/tests/test_api_wfo.py`

**Interfaces:**
- Produces endpoints (all forwarding to the remote compute host verbatim when `target=remote`, exactly like the sweep endpoints):
  - `POST /api/backtest/walkforward/jobs?target=local|remote` -> `WfoJobSubmitResponse`
  - `GET /api/backtest/walkforward/jobs/{job_id}?cursor=N&target=` -> `WfoJobStatusResponse` (`foldRows` sliced from `cursor`; `result` only when `phase == "done"`)
  - `POST /api/backtest/walkforward/jobs/{job_id}/cancel?target=`
  - `GET /api/backtest/walkforward/jobs/{job_id}/fold/{key}?target=` -> `{"rows": [...]}` from the live job's `fold_tables` (`key` like `s0/f1`; use a path regex or query param `?key=` to avoid the slash: use query param `GET .../fold?key=s0/f1`)
  - `GET /api/backtest/walkforward/archive` / `GET /api/backtest/walkforward/archive/{id}` / `GET /api/backtest/walkforward/archive/{id}/tables` / `DELETE /api/backtest/walkforward/archive/{id}` backed by `WFO_STORE`.
- Submit validation order: `walkforward` present and non-empty combos; `evalMode == "exact"` -> 422 "exact eval mode is not yet supported"; parse spans + `plan()` per scheme (`WfoPlanError` -> 422 with its message); candle range must cover the earliest `train_from` (422 listing the infeasible scheme); reuse the sweep submit's rule/coded validation + `_validate_combo_targets(req, candles, coded, combos=req.walkforward.combos)`; coded HTF discovery probe like the sweep path (run `combos[0]` in-request via `_run_coded` to populate `htf_candles`; the probe result is discarded, WFO has no probe row). `on_complete` wires `WFO_STORE.insert_sync` with the record shape from Task 11 (request_json excludes candles/series/htfCandles, like `run_store`).

- [ ] **Step 1: Write the failing test**

Use FastAPI's TestClient the same way `tests/test_api_backtest_sweep.py` does (read it first and reuse its app/client fixtures and any monkeypatching of `JOBS`; monkeypatch `wfo_jobs.WFO_JOBS` with a manager built on the `_SyncPool` from `tests/test_wfo_jobs.py`, moved into `tests/wfo_fixtures.py`).

```python
"""Walk-forward API endpoints: submit validation, status, fold tables, archive."""
# Fixtures: build a coded BacktestRequest dict via tests/wfo_fixtures.make_req_dict
# with ~100 days of hourly candles, plus:
WFO = {
    "combos": [{"param:fast": 3}, {"param:fast": 5}, {"param:fast": 8}],
    "axes": [{"kind": "range", "targets": ["param:fast"], "values": [3, 5, 8]}],
    "schedule": {"trainSpan": "30d", "testSpan": "10d"},
}

def test_submit_requires_walkforward(client):
    r = client.post("/api/backtest/walkforward/jobs", json=make_req_dict(100 * 24))
    assert r.status_code == 422

def test_submit_rejects_infeasible_schedule(client):
    req = make_req_dict(20 * 24)  # 20 days cannot fit 30d train + 3 folds
    req["walkforward"] = WFO
    r = client.post("/api/backtest/walkforward/jobs", json=req)
    assert r.status_code == 422
    assert "fold" in r.json()["detail"]

def test_submit_rejects_exact_mode(client):
    req = make_req_dict(100 * 24)
    req["walkforward"] = {**WFO, "evalMode": "exact"}
    assert client.post("/api/backtest/walkforward/jobs", json=req).status_code == 422

def test_job_lifecycle_and_archive(client, sync_wfo_manager):
    req = make_req_dict(100 * 24)
    req["walkforward"] = WFO
    r = client.post("/api/backtest/walkforward/jobs", json=req)
    assert r.status_code == 200
    job_id = r.json()["jobId"]
    # Sync pool: job finishes promptly; poll until done.
    for _ in range(200):
        st = client.get(f"/api/backtest/walkforward/jobs/{job_id}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["phase"] == "done" and st["error"] is None
    assert st["result"]["schemes"][0]["robustness"]["robustness_score"] is not None
    # Fold table lazy endpoint.
    ft = client.get(f"/api/backtest/walkforward/jobs/{job_id}/fold", params={"key": "s0/f0"})
    assert ft.status_code == 200 and ft.json()["rows"]
    # Auto-persisted.
    arch = client.get("/api/backtest/walkforward/archive").json()
    assert any(a["id"] == job_id for a in arch)
    full = client.get(f"/api/backtest/walkforward/archive/{job_id}")
    assert full.status_code == 200
    assert client.delete(f"/api/backtest/walkforward/archive/{job_id}").status_code == 200
```

(Adapt fixture names to what `tests/test_api_backtest_sweep.py` actually provides; `sync_wfo_manager` monkeypatches the router's `WFO_JOBS` reference and points `WFO_STORE` at a tmp-path store.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_api_wfo.py -v`
Expected: FAIL (404s on the new routes).

- [ ] **Step 3: Implement**

1. Change `_validate_combo_targets(req, candles, coded)` to `_validate_combo_targets(req, candles, coded, combos=None)` with `combos = combos if combos is not None else req.sweep.combos`; update the one existing call site.
2. Add the WFO section. Submit handler outline:

```python
@router.post("/api/backtest/walkforward/jobs", response_model=WfoJobSubmitResponse)
async def submit_wfo_job(req: BacktestRequest, target: str = "local"):
    if target == "remote":
        if req.walkforward is not None and req.walkforward.combos and req.htfCandles is None:
            candles = [candle_from_dto(c) for c in req.candles]
            htf = await _prefetch_wfo_htf(req, candles)
            req = req.model_copy(update={"htfCandles": htf_to_dto(htf)})
        return await compute.forward(
            "POST", "/api/backtest/walkforward/jobs",
            json_body=req.model_dump(mode="json"))
    wf = req.walkforward
    if wf is None or not wf.combos:
        raise HTTPException(422, "walkforward.combos is required")
    if wf.evalMode == "exact":
        raise HTTPException(422, "exact eval mode is not yet supported")
    if not req.candles:
        raise HTTPException(422, "candles are required")
    res_s = resolution_seconds(req.resolution)
    range_from = req.tradeFromTime
    range_to = req.candles[-1].time
    spans = [wf.schedule.trainSpan, *wf.matrixTrainSpans]
    seen: set[str] = set()
    schemes = []
    try:
        test_s = parse_span(wf.schedule.testSpan, res_s)
        step_s = parse_span(wf.schedule.step, res_s) if wf.schedule.step else test_s
        for span in spans:
            if span in seen:
                continue
            seen.add(span)
            train_s = parse_span(span, res_s)
            folds = wfo_plan.plan(range_from, range_to, wf.schedule.mode,
                                  train_s, test_s, step_s)
            schemes.append({
                "train_span": span,
                "folds": [vars(f) | {} for f in folds],  # dataclass -> dict
                "min_train_trades": wf.schedule.minTrainTrades,
                "min_test_trades": wf.schedule.minTestTrades,
            })
    except WfoPlanError as e:
        raise HTTPException(422, str(e))
    candles = [candle_from_dto(c) for c in req.candles]
    coded = req.codedStrategy is not None
    # Same per-mode validation as the sweep submit (series presence for rule
    # mode; declared-param check + module load for coded), then:
    _validate_combo_targets(req, candles, coded, combos=wf.combos)
    # HTF acquisition mirrors submit_sweep_job: a shipped set wins; else rule
    # mode fetches the combo-invariant set once; coded mode runs combos[0]
    # in-request as a discovery probe (result discarded, WFO has no probe row).
    shipped_htf = htf_from_dto(req.htfCandles) if req.htfCandles is not None else None
    if coded:
        htf_candles: dict[str, list[Candle]] = shipped_htf if shipped_htf is not None else {}
        try:
            env, rest = split_env_combo(wf.combos[0])
            patched_req, combo_candles = apply_env_combo(req, candles, env)
            params_sent, long_risk, short_risk = apply_combo(patched_req, rest)
            resolved = resolve_params(module, params_sent)
            await _run_coded(
                patched_req, combo_candles, module, resolved,
                long_risk, short_risk, htf_candles,
            )
        except HTTPException:
            raise
        except SweepValidationError as e:
            raise HTTPException(e.status_code, e.detail)
        except Exception:  # noqa: BLE001  discovery is best-effort; workers re-raise per row
            pass
    else:
        htf_candles = shipped_htf if shipped_htf is not None else await _fetch_rule_htf(req)
    job = WFO_JOBS.submit(
        req_dict=req.model_dump(mode="json", exclude={"htfCandles"}),
        htf_candles=htf_candles,
        strategies_dir=str(loader.STRATEGIES_DIR) if coded else None,
        schemes=schemes,
        axes=axis_dicts(wf.axes),
        combos=wf.combos,
        objective={"metric": wf.objective.metric,
                   "composite": wf.objective.composite,
                   "selection": wf.objective.selection,
                   "min_trades": wf.schedule.minTrainTrades},
        schedule_meta=wf.schedule.model_dump(),
        epic=req.epic, timeframe=req.resolution,
        on_complete=_persist_wfo(req),
    )
    return WfoJobSubmitResponse(
        jobId=job.job_id, total=job.total,
        schemes=[{"trainSpan": s["train_span"],
                  "folds": [{k: f[k] for k in
                             ("train_from", "train_to", "test_from", "test_to")}
                            for f in s["folds"]]}
                 for s in schemes])
```

Use `dataclasses.asdict(f)` rather than `vars(f) | {}` for frozen dataclasses. `_persist_wfo(req)` returns a closure:

```python
def _persist_wfo(req: BacktestRequest):
    slim = req.model_dump(mode="json",
                          exclude={"candles", "series", "htfCandles"})
    def _cb(job) -> None:
        try:
            WFO_STORE.insert_sync({
                "id": job.job_id, "created_at": int(job.created_at),
                "epic": job.epic, "timeframe": job.timeframe, "name": None,
                "request": slim, "result": job.result,
                "fold_tables": job.fold_tables,
            })
        except Exception:  # noqa: BLE001  persistence must not kill the job thread
            logger.exception("wfo persist failed for %s", job.job_id)
    return _cb
```

The candle-range feasibility check: the earliest `train_from` across schemes must be >= the first candle's time (plan already guarantees `>= range_from = tradeFromTime`; additionally verify `req.candles[0].time <= earliest train_from`, else 422 "not enough history for the <span> scheme: needs data from <iso date>"). Status/cancel/fold/archive handlers are thin wrappers over `WFO_JOBS`/`WFO_STORE` with `target=remote` forwarding on job endpoints (`compute.forward`, mirroring sweeps; archive endpoints are local-only, the record persists on whichever host ran the job, matching sweep-archive behavior where the frontend owns the post; note the auto-persist difference is intentional and remote archives live on the remote host for now, surfaced in the follow-up UI plan).

- [ ] **Step 4: Run the API test and the neighboring suites**

Run: `python -m pytest tests/test_api_wfo.py tests/test_api_backtest_sweep.py tests/test_api_backtest_rule_sweep.py tests/test_api_sweep_archive.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `python -m pytest tests -x -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/tests/test_api_wfo.py
git commit -m "feat(wfo): walk-forward job and archive endpoints"
```

---

## Self-Review Notes

- **Spec coverage vs design doc build-order steps 1-3:** worker indicator cache (Task 1), `window_metrics` enrichment as `slice_window_metrics` (Task 2), plateau port (Task 3), fold planner (Task 4), stability + score (Task 5), selection incl. plateau default (Task 6), stitching + WFE (Task 7), DTOs incl. `axes` shipping (Task 8), sliced grid eval + exact OOS tests (Task 9), orchestrator with phases/streaming/cancel and matrix-mode shared grid runs via the train-window union (Task 10), auto-persist store with fold-table budget (Task 11), API + validation + remote forwarding (Task 12). Deliberately deferred to follow-up plans, per the design doc: exact/auto eval mode for the grid phase (422-guarded enum reserved), the auto-mode probe heuristic, PBO/analyzer hooks, and all UI.
- **Known simplifications the executor must keep:** month token = 30 days (documented in `parse_span`); `wfe_aggregate` uses summed return_pct over summed spans; stitched "compounded" curve is the scaled approximation (engine always runs at base cash).
- Where plan code references existing test fixtures by name (`tests/test_api_backtest_sweep.py`, `tests/test_sweep_jobs*.py`), the executor must read those files first and adapt fixture names; behavior assertions stand as written.
