# Backtest Phase 1: Honest Numbers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Phase 1 items from `docs/backtest-optimization-proposals.md`: risk-adjusted metrics (F0), cost sensitivity (R0), plateau scoring (F3), regime/edge-decay analysis (A1), holdout period (F1), refine + random search (O1), and the sweep archive (C4).

**Architecture:** Backend additions are pure functions in `engine/metrics.py` / `engine/analysis.py` plus small router/schema surface; frontend additions are new pure libs (`sweepPlateau.ts`, `sweepSearch.ts`, `holdout.ts`) consumed by `SweepResults.tsx` and `BacktestSettingsModal.tsx`. Nothing changes the engine's simulation semantics.

**Tech Stack:** FastAPI + pydantic v2 + stdlib sqlite (backend); React + vitest (frontend).

## Global Constraints

- Work directly on main (user rule: 1-person team, no branches unless asked). Commit per task.
- No em dashes in any end-user-exposed copy (UI labels, tooltips): rephrase with colon/comma/period.
- No legacy/back-compat code; no migrations (no old data to protect).
- Reuse shared components: `Tooltip` (`frontend/src/components/Tooltip.tsx`) and `InfoTip`, never native `title=`. `InfoTip` must stay inside a styled container (see memory: renders as a black box otherwise).
- Backend tests: `cd backend && uv run pytest tests/<file> -x -q`. Frontend tests: `cd frontend && npx vitest run <file>`. Frontend typecheck: `cd frontend && npx tsc -b`.
- New saveLocal flat persist keys MUST be added to `DEVICE_LOCAL_FLAT_KEYS` in `frontend/src/lib/persist/core.ts:117`.
- **Coordination:** the sweep-jobs plan (`docs/superpowers/plans/2026-07-16-parallel-sweep-jobs-remote-compute.md`) is being implemented concurrently and rewrites `frontend/src/lib/sweep.ts` (runSweep), `frontend/src/api.ts` (sweep client), `BacktestButton.tsx`, the modal's sweep footer, and `backend/auto_trader/api/routers/backtest.py` (sweep endpoint replaced by a job API; helpers move to `sweep_apply.py`). Tasks 1 to 5 avoid those surfaces or touch only stable parts (`_sweep_row` moves to `sweep_apply.py` as `sweep_row`; if it has already moved, apply the Task 2 edit there). Tasks 6 to 8 touch contested files: START THEM ONLY AFTER THE SWEEP-JOBS PLAN HAS MERGED.
- `SweepRowDTO` shape is frozen by the sweep-jobs plan except for keys INSIDE the `metrics` dict, which is `dict | None` (schemas.py:449) and therefore open; Task 2 only adds dict keys.
- Frontend line numbers cited below were verified on 2026-07-16 against main; re-verify with the given greps before editing (the concurrent work may shift them).

---

### Task 1: Risk-adjusted metrics in `engine/metrics.py`

Add Sharpe, Sortino, Calmar, CAGR, SQN, and exposure to `compute_metrics`. Pure function work; no schema change needed downstream (`BacktestResponse.metrics` is an open dict, and the run store persists `summary_json` as `{**summary, **metrics}`).

**Files:**
- Modify: `backend/auto_trader/engine/metrics.py`
- Test: `backend/tests/test_metrics_risk.py` (new)

**Interfaces:**
- Produces: `risk_metrics(trades, equity, starting_cash: float, res_seconds: int) -> dict` in `auto_trader.engine.metrics` with keys `sharpe`, `sortino`, `calmar`, `cagr_pct`, `sqn`, `exposure_pct` (each `float | None`). `compute_metrics(...)` (existing signature, metrics.py:85) returns its current dict merged with these six keys.
- Consumes: nothing new. `equity` items expose `.time` (datetime) and `.equity` (float); trades expose `.pnl`, `.bars_held` (may be None), `.entry_time`/`.exit_time` (already required by `leg_metrics`).

Definitions (deliberately simple and guarded; every guard returns None, never raises):

- Daily equity: bucket equity points by UTC calendar date of `.time`, keep the LAST point per day, prepend `starting_cash` as day zero if the first day's date differs from nothing (i.e. always seed the series with `starting_cash`). Daily returns `r_i = e_i / e_{i-1} - 1`; require every `e_{i-1} > 0` else None for the return-based stats.
- `sharpe`: `mean(r) / pstdev(r) * sqrt(252)`; None if fewer than 3 returns or `pstdev(r) == 0`.
- `sortino`: downside deviation `dd = sqrt(mean(min(r_i, 0)^2))`; `mean(r) / dd * sqrt(252)`; None if fewer than 3 returns or `dd == 0`.
- `cagr_pct`: `((final_equity / starting_cash) ** (31_557_600 / span_seconds) - 1) * 100` where `span_seconds` is last minus first equity timestamp and 31_557_600 is 365.25 days; None if `span_seconds <= 0`, `starting_cash <= 0`, or `final_equity <= 0`.
- `calmar`: `cagr_pct / max_dd_pct`; None if `cagr_pct` is None or `max_dd_pct == 0` (`max_dd_pct` is already computed inside `compute_metrics`; pass it in).
- `sqn`: `sqrt(n) * mean(pnls) / pstdev(pnls)` over trade pnls; None if `n < 2` or `pstdev == 0`.
- `exposure_pct`: `sum(t.bars_held or 0 for t in trades) / len(equity) * 100`; None if `equity` is empty. May exceed 100 with concurrent positions; that is correct, do not clamp.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_metrics_risk.py`:

```python
"""Risk-adjusted metrics: sharpe/sortino/calmar/cagr/sqn/exposure guards + values."""
import math
from datetime import datetime, timedelta, timezone
from statistics import mean, pstdev
from types import SimpleNamespace

from auto_trader.engine.metrics import compute_metrics, risk_metrics

UTC = timezone.utc
T0 = datetime(2026, 1, 1, tzinfo=UTC)


def eq(day: int, value: float):
    return SimpleNamespace(time=T0 + timedelta(days=day), equity=value)


def trade(pnl: float, bars: int = 4, day: int = 0):
    t = T0 + timedelta(days=day)
    return SimpleNamespace(pnl=pnl, bars_held=bars, entry_time=t,
                           exit_time=t + timedelta(hours=1))


def test_flat_equity_yields_none_ratios():
    equity = [eq(d, 1000.0) for d in range(5)]
    m = risk_metrics([], equity, 1000.0, 3600)
    assert m["sharpe"] is None and m["sortino"] is None
    assert m["sqn"] is None            # no trades
    assert m["cagr_pct"] == 0.0        # flat: (1)**x - 1 == 0
    assert m["exposure_pct"] == 0.0


def test_sharpe_matches_hand_formula():
    values = [1000.0, 1010.0, 1005.0, 1020.0, 1030.0]
    equity = [eq(d, v) for d, v in enumerate(values)]
    # seeded with starting_cash 1000 -> day-0 return is 0.0
    series = [1000.0] + values
    rets = [b / a - 1 for a, b in zip(series, series[1:])]
    expected = mean(rets) / pstdev(rets) * math.sqrt(252)
    m = risk_metrics([], equity, 1000.0, 3600)
    assert m["sharpe"] == round(expected, 4)
    assert m["sortino"] is not None and m["sortino"] > m["sharpe"]  # one small dip


def test_sqn_and_exposure():
    trades = [trade(10.0), trade(-5.0), trade(10.0), trade(5.0)]
    equity = [eq(d, 1000.0 + 5 * d) for d in range(10)]
    m = risk_metrics(trades, equity, 1000.0, 3600)
    pnls = [10.0, -5.0, 10.0, 5.0]
    assert m["sqn"] == round(math.sqrt(4) * mean(pnls) / pstdev(pnls), 4)
    assert m["exposure_pct"] == round(16 / 10 * 100, 2)


def test_compute_metrics_carries_risk_keys():
    values = [1000.0, 1010.0, 1005.0, 1020.0]
    equity = [eq(d, v) for d, v in enumerate(values)]
    trades = [trade(10.0), trade(-5.0), trade(15.0)]
    m = compute_metrics(trades, equity, 20.0, 1000.0, 3600)
    for key in ("sharpe", "sortino", "calmar", "cagr_pct", "sqn", "exposure_pct"):
        assert key in m
    assert m["cagr_pct"] is not None and m["cagr_pct"] > 0


def test_zero_span_and_negative_equity_guards():
    m = risk_metrics([], [eq(0, 900.0)], 1000.0, 3600)
    assert m["cagr_pct"] is None      # single point: span 0
    m2 = risk_metrics([], [eq(0, 1000.0), eq(1, -50.0)], 1000.0, 3600)
    assert m2["cagr_pct"] is None     # negative final equity
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_metrics_risk.py -x -q`
Expected: FAIL with `ImportError: cannot import name 'risk_metrics'`.

- [ ] **Step 3: Implement**

In `backend/auto_trader/engine/metrics.py`, add near the top (`from statistics import mean as _smean, pstdev` is fine, but the module already has `_mean`; use it and add a local `_pstdev`):

```python
def _pstdev(xs: Sequence[float]) -> float:
    m = _mean(xs)
    return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5 if xs else 0.0


def risk_metrics(trades, equity, starting_cash, res_seconds, max_dd_pct: float | None = None) -> dict:
    """Volatility-adjusted stats from the equity curve (daily-resampled) and the
    trade list. Every ill-conditioned case (too few points, zero variance,
    non-positive equity) yields None for that stat rather than raising."""
    out = {"sharpe": None, "sortino": None, "calmar": None,
           "cagr_pct": None, "sqn": None, "exposure_pct": None}
    if equity:
        out["exposure_pct"] = round(
            sum((getattr(t, "bars_held", None) or 0) for t in trades) / len(equity) * 100, 2)

    # Daily resample: last equity point per UTC calendar day, seeded with cash.
    by_day: dict = {}
    for pt in equity:
        by_day[pt.time.date()] = pt.equity
    daily = [starting_cash] + [by_day[d] for d in sorted(by_day)]
    if all(e > 0 for e in daily[:-1]) and len(daily) >= 4:
        rets = [b / a - 1 for a, b in zip(daily, daily[1:])]
        sd = _pstdev(rets)
        if sd > 0:
            out["sharpe"] = round(_mean(rets) / sd * 252 ** 0.5, 4)
        downside = (sum(min(r, 0.0) ** 2 for r in rets) / len(rets)) ** 0.5
        if downside > 0:
            out["sortino"] = round(_mean(rets) / downside * 252 ** 0.5, 4)

    span = (equity[-1].time - equity[0].time).total_seconds() if len(equity) >= 2 else 0.0
    if span > 0 and starting_cash > 0 and equity[-1].equity > 0:
        out["cagr_pct"] = round(
            ((equity[-1].equity / starting_cash) ** (31_557_600 / span) - 1) * 100, 4)
    if out["cagr_pct"] is not None and max_dd_pct:
        out["calmar"] = round(out["cagr_pct"] / max_dd_pct, 4)

    pnls = [t.pnl for t in trades]
    sd_pnl = _pstdev(pnls)
    if len(pnls) >= 2 and sd_pnl > 0:
        out["sqn"] = round(len(pnls) ** 0.5 * _mean(pnls) / sd_pnl, 4)
    return out
```

Note the sortino-without-sharpe subtlety: sortino uses downside deviation over ALL returns (zeros included in the mean), so a series with variance only on the upside has `sharpe` set and `sortino` None; the tests above only exercise the common case. Adjust `test_flat_equity_yields_none_ratios` expectations if you change the seeding rule; do not change the rule silently.

Then merge into `compute_metrics` (metrics.py:99, inside the returned dict): compute `risk = risk_metrics(trades, equity, starting_cash, res_seconds, max_dd_pct=max_dd_pct)` after the drawdown loop and return `{ ...existing keys..., **risk }` (spell the merge as `return {` existing literal `} | risk`).

The test seeds `daily` with `starting_cash`, giving 4+ points for a 3+ day equity: verify the `len(daily) >= 4` guard against `test_sharpe_matches_hand_formula` (5 values + seed = 6 points, 5 returns) and `test_flat_equity_yields_none_ratios` (5 days flat: sd == 0 branch, not the length guard).

- [ ] **Step 4: Run the new tests, then the full backend suite**

Run: `cd backend && uv run pytest tests/test_metrics_risk.py -q && uv run pytest -q`
Expected: new tests PASS; full suite same count as before plus the new file (no existing test asserts an exact `compute_metrics` key set; if one does, update its expected keys).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/metrics.py backend/tests/test_metrics_risk.py
git commit -m "feat(metrics): sharpe, sortino, calmar, cagr, sqn and exposure"
```

---

### Task 2: Surface the new metrics (sweep rows + results table + run stats)

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py:712` (`_sweep_row`), or `backend/auto_trader/api/sweep_apply.py` (`sweep_row`) if the sweep-jobs refactor has landed; the function body is identical in both.
- Modify: `frontend/src/api.ts:385` (`SweepRow.metrics` type)
- Modify: `frontend/src/SweepResults.tsx` (MetricKey, METRIC_COLS, fmtMetric)
- Modify: the run-stats display component (locate: `grep -rn "max_drawdown_pct\|profit_factor" frontend/src/*.tsx | grep -iv sweep`; expected in the backtest stats/summary panel)
- Test: existing `backend/tests/test_api_backtest_sweep.py` (extend one assertion); `cd frontend && npx tsc -b`

**Interfaces:**
- Produces: sweep row `metrics` dict gains `"sharpe": float | None` and `"sqn": float | None`. `SweepRow["metrics"]` type gains `sharpe?: number | null; sqn?: number | null`. New table columns Sharpe and SQN.
- Consumes: Task 1's `compute_metrics` keys.

- [ ] **Step 1: Backend: add the two keys to the sweep row**

In `_sweep_row` (routers/backtest.py:719, the `row_metrics` literal), after `"return_pct": metrics.get("return_pct"),` add:

```python
        "sharpe": metrics.get("sharpe"),
        "sqn": metrics.get("sqn"),
```

Extend one existing success-row assertion in `backend/tests/test_api_backtest_sweep.py` (find a test that inspects `rows[0]["metrics"]`) with:

```python
    assert "sharpe" in rows[0]["metrics"] and "sqn" in rows[0]["metrics"]
```

Run: `cd backend && uv run pytest tests/test_api_backtest_sweep.py -q`. Expected: PASS.

- [ ] **Step 2: Frontend types**

In `frontend/src/api.ts` inside `SweepRow.metrics` (line ~385), after `return_pct: number;` add:

```ts
    sharpe?: number | null;
    sqn?: number | null;
```

- [ ] **Step 3: Columns in SweepResults**

In `frontend/src/SweepResults.tsx`:

1. Extend the `MetricKey` union (line 16) with `| "sharpe" | "sqn"`.
2. In `METRIC_COLS` (line 33), insert after the `profit_factor` entry:

```ts
  { key: "sharpe", label: "Sharpe", abbr: "Sh",
    info: "Annualized Sharpe ratio from daily equity returns. Treat with caution under 30 trades." },
  { key: "sqn", label: "SQN", abbr: "SQN",
    info: "System Quality Number: sqrt(trades) times expectancy over trade P&L deviation. Van Tharp's scale calls 2 good and 3 excellent." },
```

3. `fmtMetric` needs no change (default `v.toFixed(2)` branch covers both; `metricValue`'s `row.metrics?.[key] ?? null` already maps missing/null to the em-dash-free `"—"`... note: the `"—"` at SweepResults.tsx:58 is a typographic dash in a VALUE placeholder, pre-existing; leave it).

Run: `cd frontend && npx tsc -b`. Expected: clean.

- [ ] **Step 4: Run-stats panel**

Locate the run summary stat list with the grep above (the component rendering `metrics.profit_factor` / `max_drawdown_pct` for a single run). Following its existing stat-item markup verbatim (copy an adjacent row), add rows for Sharpe, Sortino, Calmar, CAGR %, SQN, Exposure %, each formatted `v == null ? "-" : v.toFixed(2)` (CAGR and exposure with a `%` suffix). Add the response `metrics` keys to whatever local type mirrors them if one exists (grep the component for a `metrics` prop type).

Run: `cd frontend && npx tsc -b && npx vitest run` for the touched component's test file if one exists.

- [ ] **Step 5: Commit**

```bash
git add backend frontend/src
git commit -m "feat(backtest): surface sharpe/sqn in sweep rows and run stats"
```

---

### Task 3: Cost sensitivity report (R0)

Re-run the engine at 0x/2x/3x costs on every single (non-sweep) backtest and report per-multiple net P&L plus the breakeven cost multiple.

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (request flag + response field)
- Modify: `backend/auto_trader/api/routers/backtest.py:257` (`backtest` handler)
- Create: `backend/auto_trader/engine/cost_sense.py` (pure helper)
- Modify: `frontend/src/api.ts` (request flag + response type), run-stats panel (one line)
- Test: `backend/tests/test_cost_sense.py` (new), `backend/tests/test_api_backtest.py` (one added test)

**Interfaces:**
- Produces:
  - `auto_trader.engine.cost_sense.breakeven_multiple(multiples: list[float], nets: list[float]) -> float | None`: linear-interpolated cost multiple where net P&L crosses zero, scanning ascending multiples; None if never crosses (all profitable) or the base run is already unprofitable at multiple 0.
  - `BacktestRequest.costSensitivity: bool = False`; `BacktestResponse.cost_sensitivity: dict | None = None` shaped `{"multiples": [0, 1, 2, 3], "net_pnl": [...], "breakeven_multiple": float | None}`.
- Consumes: `_run_rule(req, candles)` / `_run_coded(req, candles, module, resolved_params, long_risk, short_risk, htf_candles)` exactly as the handler already calls them (routers/backtest.py:296-307). If the sweep-jobs refactor has landed, the call shapes are unchanged (thin async wrappers remain).

- [ ] **Step 1: Write the failing pure-helper tests**

`backend/tests/test_cost_sense.py`:

```python
"""Breakeven cost multiple: interpolation + edge cases."""
from auto_trader.engine.cost_sense import breakeven_multiple


def test_interpolates_between_multiples():
    # net 100 at 1x, -50 at 2x -> crosses at 1 + 100/150
    assert breakeven_multiple([0, 1, 2, 3], [150, 100, -50, -200]) == round(1 + 100 / 150, 2)


def test_all_profitable_is_none():
    assert breakeven_multiple([0, 1, 2, 3], [90, 80, 70, 60]) is None


def test_unprofitable_at_zero_costs_is_zero():
    assert breakeven_multiple([0, 1, 2, 3], [-10, -20, -30, -40]) == 0.0


def test_exact_zero_counts_as_breakeven():
    assert breakeven_multiple([0, 1, 2], [50, 0, -50]) == 1.0
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && uv run pytest tests/test_cost_sense.py -q`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement the helper**

`backend/auto_trader/engine/cost_sense.py`:

```python
"""Cost-sensitivity summary: where does net P&L cross zero as slippage and
commission scale? Pure arithmetic; the router owns the re-runs."""
from __future__ import annotations


def breakeven_multiple(multiples: list[float], nets: list[float]) -> float | None:
    """First zero crossing of nets over ascending cost multiples, linearly
    interpolated. None when every multiple stays profitable. 0.0 when the
    zero-cost run is already unprofitable (there is nothing to break even
    from). An exact zero net at multiple m returns m."""
    if nets[0] <= 0:
        return 0.0 if nets[0] < 0 else round(multiples[0], 2)
    for (m0, n0), (m1, n1) in zip(zip(multiples, nets), zip(multiples[1:], nets[1:])):
        if n1 <= 0:
            return round(m1, 2) if n1 == 0 else round(m0 + n0 / (n0 - n1) * (m1 - m0), 2)
    return None
```

Run: `cd backend && uv run pytest tests/test_cost_sense.py -q`. Expected: PASS.

- [ ] **Step 4: Schemas + handler**

`schemas.py`: on `BacktestRequest` add `costSensitivity: bool = False` (next to `inspect`); on `BacktestResponse` (line ~168) add `cost_sensitivity: dict | None = None`.

`routers/backtest.py`, in `backtest()` after the main run and BEFORE the response is built (insert after the `enrich_trades_whatif` block around line 340, where `candles`, `module`/`resolved_params`, and `htf_candles` are all in scope):

```python
    cost_sensitivity = None
    if req.costSensitivity and req.sweep is None:
        multiples = [0.0, 1.0, 2.0, 3.0]
        nets: list[float] = []
        for m in multiples:
            if m == 1.0:
                nets.append(result.net_pnl)
                continue
            scaled = req.model_copy(update={"costs": req.costs.model_copy(update={
                "slippage": req.costs.slippage * m,
                "commissionPerSide": req.costs.commissionPerSide * m,
            })})
            if req.codedStrategy is not None:
                r, _ = await _run_coded(scaled, candles, module, resolved_params,
                                        req.longRisk, req.shortRisk, dict(htf_candles))
            else:
                r = await _run_rule(scaled, candles)
            nets.append(r.net_pnl)
        cost_sensitivity = {
            "multiples": multiples,
            "net_pnl": [round(n, 5) for n in nets],
            "breakeven_multiple": breakeven_multiple(multiples, nets),
        }
```

Add `from auto_trader.engine.cost_sense import breakeven_multiple` to the router imports and `cost_sensitivity=cost_sensitivity,` to the `BacktestResponse(...)` construction (line ~410). Check the actual field names on the costs DTO first: `grep -n "slippage\|commissionPerSide" backend/auto_trader/api/schemas.py | head` (the engine uses snake_case internally; the DTO is camelCase per line 372's `req.costs.commissionPerSide`).

Add to `backend/tests/test_api_backtest.py`, following its existing request-builder pattern (read the top of the file and reuse its fixture/helper for a minimal profitable run):

```python
def test_cost_sensitivity_block(client_or_fixture_per_file_convention):
    req = <existing helper>(costSensitivity=True)   # set the flag on the request dict
    resp = client.post("/api/backtest", json=req)
    assert resp.status_code == 200
    cs = resp.json()["cost_sensitivity"]
    assert cs["multiples"] == [0.0, 1.0, 2.0, 3.0]
    assert len(cs["net_pnl"]) == 4
    assert cs["net_pnl"][0] >= cs["net_pnl"][3]   # zero costs never nets less than 3x costs
```

(Adapt the helper call to the file's real convention; the assertion set is the contract.)

- [ ] **Step 5: Run the backend suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS.

- [ ] **Step 6: Frontend flag + stat line**

`frontend/src/api.ts`: find `runBacktest` (line ~311) and the `BacktestRequest`/response types near it; add `costSensitivity?: boolean` to the request type, set it `true` where the single-run request is assembled (grep: `grep -n "inspect" frontend/src/lib/backtest.ts frontend/src/api.ts` and set the flag alongside), and add to the response type:

```ts
  cost_sensitivity?: {
    multiples: number[];
    net_pnl: number[];
    breakeven_multiple: number | null;
  } | null;
```

In the run-stats panel (same component as Task 2 Step 4) add one line under the metrics rows, styled like an existing note row:

```tsx
{res.cost_sensitivity && (
  <div className="bt-cost-sense">
    {res.cost_sensitivity.breakeven_multiple === null
      ? "Costs: still profitable at 3x assumed costs"
      : `Costs: breakeven at ${res.cost_sensitivity.breakeven_multiple}x assumed costs`}
  </div>
)}
```

Run: `cd frontend && npx tsc -b`. Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend frontend/src
git commit -m "feat(backtest): cost sensitivity report with breakeven cost multiple"
```

---

### Task 4: Plateau scoring on sweep results (F3)

Neighborhood robustness over the already-loaded rows: a `plateau_score` injected into each row's metrics (so sorting, best-highlight and the heatmap color picker all work unmodified), a spike flag, and an "Apply plateau center" action.

**Files:**
- Create: `frontend/src/lib/sweepPlateau.ts`
- Test: `frontend/src/lib/sweepPlateau.test.ts` (new)
- Modify: `frontend/src/SweepResults.tsx`

**Interfaces:**
- Produces (in `frontend/src/lib/sweepPlateau.ts`):
  - `withPlateau(rows: SweepRow[], axes: SweepAxis[], metric?: "net_pnl"): { rows: SweepRow[]; spikes: boolean[] }`: returns NEW row objects whose `metrics` gain `plateau_score: number | null`, aligned `spikes` flags. Failed rows (metrics null) pass through untouched with `spikes[i] = false`.
  - `plateauCenter(rows: SweepRow[]): SweepRow | null`: the successful row with the highest `plateau_score` (ties: higher `net_pnl`); null when no row has a score.
- Consumes: `SweepRow` from `../api`, `SweepAxis` from `./sweep` (types only; no dependency on runSweep, so no conflict with the jobs rewrite).

Semantics:
- Coordinates: for each `range`-kind axis, the sorted unique numeric values of `combo[axis.target]` across all rows define an index grid (same approach as `axisTicks` in SweepResults.tsx:409).
- Two successful rows are neighbors when every list-axis patch value matches exactly AND every range-axis index distance is at most 1 (Chebyshev), and they are not the same combo.
- `plateau_score` = min(own value, median of `metric` over self plus neighbors). Rows with zero range axes get score null (no neighborhood exists).
- `spikes[i]` = own metric > 0 AND at least 2 neighbors AND median(neighbors only) <= 0.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/sweepPlateau.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SweepRow } from "../api";
import type { SweepAxis } from "./sweep";
import { plateauCenter, withPlateau } from "./sweepPlateau";

const axis = (target: string): SweepAxis =>
  ({ kind: "range", target, label: target, from: 1, to: 5, step: 1 });

const row = (combo: Record<string, number>, net: number | null): SweepRow => ({
  combo,
  metrics: net === null ? null : ({ net_pnl: net, n_trades: 5, win_rate: 0.5,
    max_drawdown: 1, profit_factor: null, avg_win_loss_ratio: null, return_pct: 0 } as never),
  windows: null,
  error: net === null ? "boom" : null,
});

describe("withPlateau", () => {
  // 1D grid p=[1..5], net [0, 10, 0, 5, 4]: the 10 is an isolated spike
  // (neighbor median 0); the 5 sits on a plateau with 0 and 4 around it.
  const axes = [axis("param:p")];
  const rows = [0, 10, 0, 5, 4].map((net, i) => row({ "param:p": i + 1 }, net));

  it("scores the plateau above the spike", () => {
    const { rows: scored, spikes } = withPlateau(rows, axes);
    const score = (i: number) => (scored[i].metrics as never as { plateau_score: number }).plateau_score;
    expect(score(1)).toBe(0);        // median(0, 10, 0)
    expect(score(3)).toBe(4);        // median(0, 5, 4)
    expect(spikes[1]).toBe(true);    // 10 > 0, neighbors median 0
    expect(spikes[3]).toBe(false);
  });

  it("plateauCenter picks the best-scored row", () => {
    const { rows: scored } = withPlateau(rows, axes);
    expect(plateauCenter(scored)?.combo).toEqual({ "param:p": 4 });
  });

  it("failed rows pass through unscored and unspiked", () => {
    const withFail = [...rows, row({ "param:p": 6 }, null)];
    const { rows: scored, spikes } = withPlateau(withFail, axes);
    expect(scored[5].metrics).toBeNull();
    expect(spikes[5]).toBe(false);
  });

  it("no range axes yields null scores", () => {
    const listAxes: SweepAxis[] = [{ kind: "list", target: "op:x", label: "op",
      options: [{ label: "a", patch: { "op:x": "gt" } }] }];
    const { rows: scored } = withPlateau([row({ "op:x": 1 }, 5)], listAxes);
    expect((scored[0].metrics as never as { plateau_score: number | null }).plateau_score).toBeNull();
  });

  it("2D: diagonal cells are neighbors (Chebyshev)", () => {
    const axes2 = [axis("param:a"), axis("param:b")];
    const grid: SweepRow[] = [];
    for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++)
      grid.push(row({ "param:a": a, "param:b": b }, a === 2 && b === 2 ? 9 : 1));
    const { rows: scored } = withPlateau(grid, axes2);
    const center = scored.find((r) => r.combo["param:a"] === 2 && r.combo["param:b"] === 2)!;
    // center's neighborhood is all 9 cells: median(1x8, 9) = 1
    expect((center.metrics as never as { plateau_score: number }).plateau_score).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd frontend && npx vitest run src/lib/sweepPlateau.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `sweepPlateau.ts`**

```ts
// Parameter-plateau scoring over an in-memory sweep result set. The best cell
// in a grid is, by selection, the luckiest cell; real edges live on plateaus.
// plateau_score = median of the cell and its grid neighbors, capped at the
// cell's own value, so a cell cannot borrow credit from a lucky neighbor.
// Neighbors differ by at most one step (Chebyshev distance 1) on every numeric
// range axis and match exactly on every list axis. Pure functions; no engine
// or transport dependency.

import type { SweepRow } from "../api";
import type { SweepAxis } from "./sweep";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function withPlateau(
  rows: SweepRow[],
  axes: SweepAxis[],
  metric: "net_pnl" = "net_pnl",
): { rows: SweepRow[]; spikes: boolean[] } {
  const rangeTargets = axes.filter((a) => a.kind === "range").map((a) => a.target);
  const listTargets = axes.filter((a) => a.kind === "list")
    .flatMap((a) => a.options.length ? Object.keys(a.options[0].patch) : []);

  // Index grid per range axis: sorted unique swept values -> ordinal position.
  const indexOf = new Map<string, Map<number, number>>();
  for (const t of rangeTargets) {
    const vals = [...new Set(rows.map((r) => r.combo[t]).filter((v): v is number => typeof v === "number"))]
      .sort((a, b) => a - b);
    indexOf.set(t, new Map(vals.map((v, i) => [v, i])));
  }

  const coord = (r: SweepRow): number[] | null => {
    const c: number[] = [];
    for (const t of rangeTargets) {
      const i = indexOf.get(t)!.get(r.combo[t] as number);
      if (i === undefined) return null;
      c.push(i);
    }
    return c;
  };
  const ok = rows.map((r) => r.metrics !== null);
  const coords = rows.map((r, i) => (ok[i] ? coord(r) : null));
  const val = (i: number): number => (rows[i].metrics as Record<string, number>)[metric] ?? 0;

  const scored: SweepRow[] = [];
  const spikes: boolean[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!ok[i] || rangeTargets.length === 0 || coords[i] === null) {
      scored.push(ok[i] && rows[i].metrics
        ? { ...rows[i], metrics: { ...rows[i].metrics!, plateau_score: null } as never }
        : rows[i]);
      spikes.push(false);
      continue;
    }
    const neighbors: number[] = [];
    for (let j = 0; j < rows.length; j++) {
      if (j === i || !ok[j] || coords[j] === null) continue;
      if (!listTargets.every((t) => rows[i].combo[t] === rows[j].combo[t])) continue;
      const cheb = Math.max(...coords[i]!.map((c, k) => Math.abs(c - coords[j]![k])));
      if (cheb === 1) neighbors.push(val(j));
    }
    const score = Math.min(val(i), median([val(i), ...neighbors]));
    scored.push({ ...rows[i], metrics: { ...rows[i].metrics!, plateau_score: score } as never });
    spikes.push(val(i) > 0 && neighbors.length >= 2 && median(neighbors) <= 0);
  }
  return { rows: scored, spikes };
}

export function plateauCenter(rows: SweepRow[]): SweepRow | null {
  let best: SweepRow | null = null;
  for (const r of rows) {
    const s = (r.metrics as Record<string, number | null> | null)?.plateau_score;
    if (s == null) continue;
    const bs = (best?.metrics as Record<string, number | null> | null)?.plateau_score;
    const bn = (best?.metrics as Record<string, number> | null)?.net_pnl ?? -Infinity;
    const rn = (r.metrics as Record<string, number>).net_pnl;
    if (best === null || s > (bs as number) || (s === bs && rn > bn)) best = r;
  }
  return best;
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/sweepPlateau.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into SweepResults**

In `frontend/src/SweepResults.tsx`:

1. `MetricKey` union: add `| "plateau_score"`.
2. `METRIC_COLS`: insert before the robust group:

```ts
  { key: "plateau_score", label: "Plateau", abbr: "Plt",
    info: "Median Net P&L of this cell and its grid neighbors (one step on each numeric axis). A high plateau beats a high lone peak: neighbors confirm the edge is not one lucky cell." },
```

3. At the top of the `SweepResults` component body (after props destructure):

```ts
  const { rows: scoredRows, spikes } = withPlateau(rows, axes);
```

Then use `scoredRows` everywhere the component currently uses `rows` (sorting, bestByCol, heatVals, heatmap `rows` prop) so the injected key flows through. Sorting/best/heatmap need no further change. Note `spikes` is aligned to the ORIGINAL `rows` order while the table renders `sortedRows`: carry the flag on the row object instead of by index (extend the map in `withPlateau` usage: `scoredRows[i] = { ...r, spike: spikes[i] }` is not typed on SweepRow; instead build `const spikeSet = new Set(scoredRows.filter((_, i) => spikes[i]))` and test membership by object identity, which survives `[...rows].sort`).
4. Spike badge: in the body cell loop for `baseCols`, when `c.key === "plateau_score" && spikeSet.has(row)` render the value wrapped with a warning glyph:

```tsx
<span className="sweep-spike" aria-label="isolated peak">▲ {fmtMetric(c.key, v)}</span>
```

with CSS in the sweep stylesheet (locate: `grep -rn "sweep-c-num" frontend/src/*.css frontend/src/**/*.css`): `.sweep-spike { color: #c98a00; }`.
5. "Apply plateau center" button beside the heatmap metric dropdown (inside `sweep-heat-metric` toolbar div, or above the table when no axes):

```tsx
{plateauCenter(scoredRows) && (
  <button type="button" className="sweep-plateau-apply"
          disabled={applyDisabled}
          onClick={() => applyOrNoop(plateauCenter(scoredRows)!.combo)}>
    Apply plateau center
  </button>
)}
```

Import `{ plateauCenter, withPlateau }` from `./lib/sweepPlateau`.

- [ ] **Step 6: Typecheck + full frontend tests**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: clean, all PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(sweep): plateau scoring, spike flags and apply-plateau-center"
```

---

### Task 5: Rolling expectancy + regime table polish (A1)

Backend: a rolling-expectancy series in `compute_analysis`. Frontend: an "Edge over time" sparkline section and a small-sample grey-out on the existing context-feature tables.

**Files:**
- Modify: `backend/auto_trader/engine/analysis.py`
- Test: `backend/tests/test_analysis_rolling.py` (new)
- Modify: `frontend/src/BacktestAnalysisPanel.tsx`

**Interfaces:**
- Produces: `compute_analysis(trades)` result gains `"rolling": {"window": int, "points": [{"t": int, "expectancy": float}, ...]} | None` (None when fewer than 12 trades). Points are ordered by entry time; `t` is the entry epoch-second of the window's last trade.
- Consumes: trade dicts already passed to `compute_analysis` (keys `pnl`, `entry_time`).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_analysis_rolling.py`:

```python
"""Rolling expectancy series in compute_analysis."""
from auto_trader.engine.analysis import compute_analysis, rolling_expectancy


def trades_with_pnls(pnls):
    return [{"pnl": p, "entry_time": 1000 + i * 60, "exit_time": 1000 + i * 60 + 30,
             "side": "buy", "leg": "long"} for i, p in enumerate(pnls)]


def test_too_few_trades_is_none():
    assert rolling_expectancy(trades_with_pnls([1.0] * 11)) is None


def test_window_and_values():
    # 20 trades: first 10 win +10, last 10 lose -10. window = max(10, 20//5) = 10.
    r = rolling_expectancy(trades_with_pnls([10.0] * 10 + [-10.0] * 10))
    assert r["window"] == 10
    assert len(r["points"]) == 11              # positions 10..20 inclusive of first full window
    assert r["points"][0]["expectancy"] == 10.0
    assert r["points"][-1]["expectancy"] == -10.0
    assert r["points"][5]["expectancy"] == 0.0  # half wins, half losses in window


def test_points_sorted_by_entry_time_even_if_input_is_not():
    ts = trades_with_pnls([1.0] * 15)
    r = rolling_expectancy(list(reversed(ts)))
    assert [p["t"] for p in r["points"]] == sorted(p["t"] for p in r["points"])


def test_compute_analysis_carries_rolling():
    a = compute_analysis(trades_with_pnls([5.0, -5.0] * 10))
    assert a["rolling"] is not None and a["rolling"]["window"] == 10
```

Note: check what `compute_analysis` requires of a trade dict first (`sed -n '278,296p' backend/auto_trader/engine/analysis.py`); if `_analysis_for` indexes keys the fixture lacks (e.g. `mae_r`), extend `trades_with_pnls` with those keys set to None rather than changing production code.

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && uv run pytest tests/test_analysis_rolling.py -q`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement**

In `backend/auto_trader/engine/analysis.py` add:

```python
def rolling_expectancy(trades: list[dict], min_trades: int = 12) -> dict | None:
    """Rolling mean P&L per trade over an adaptive window (max(10, n//5)),
    ordered by entry time. The first point lands once a full window exists, so
    the series answers "was the edge stable, seasonal, or fading" without the
    noisy warm-up prefix. None below min_trades."""
    seq = sorted((t for t in trades if t.get("entry_time") is not None),
                 key=lambda t: t["entry_time"])
    n = len(seq)
    if n < min_trades:
        return None
    window = max(10, n // 5)
    points = []
    for i in range(window - 1, n):
        chunk = seq[i - window + 1 : i + 1]
        points.append({
            "t": seq[i]["entry_time"],
            "expectancy": round(sum(t["pnl"] for t in chunk) / window, 5),
        })
    return {"window": window, "points": points}
```

And in `compute_analysis` (line 278), add `"rolling": rolling_expectancy(trades),` to the returned dict (read the function first; it returns a dict literal or builds one, follow its pattern).

Note the count check in `test_window_and_values`: 20 trades, window 10 gives points for i = 9..19, which is 11 points. The first point's window is the 10 winners (expectancy +10), the last is the 10 losers.

- [ ] **Step 4: Run backend tests**

Run: `cd backend && uv run pytest tests/test_analysis_rolling.py -q && uv run pytest -q`
Expected: PASS.

- [ ] **Step 5: Frontend section**

In `frontend/src/BacktestAnalysisPanel.tsx` (1030 lines; find the section-rendering pattern with `grep -n "section\|Section" frontend/src/BacktestAnalysisPanel.tsx | head -20` and copy an existing section wrapper):

1. Extend the panel's analysis type with `rolling?: { window: number; points: { t: number; expectancy: number }[] } | null` (grep for where `analysis` prop is typed; it may be loosely typed already).
2. Add an "Edge over time" section rendering an inline SVG sparkline (no chart library):

```tsx
function ExpectancySparkline({ points }: { points: { t: number; expectancy: number }[] }) {
  const w = 280, h = 48;
  const vals = points.map((p) => p.expectancy);
  const min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / Math.max(1e-9, max - min)) * h;
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.expectancy).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="an-sparkline" role="img"
         aria-label="Rolling expectancy over the run">
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} className="an-sparkline-zero" />
      <path d={d} fill="none" className="an-sparkline-line" />
    </svg>
  );
}
```

Section body: the sparkline plus a caption `Rolling expectancy over the last {rolling.window} trades. A steady line means a stable edge; a decaying line means the edge is fading within this period.` Render the section only when `analysis.rolling` is non-null. CSS follows the panel's existing classes (locate its stylesheet by grepping an existing `an-` class name; if the panel uses a different prefix, match it).
3. Small-sample grey-out on the context-feature tables: find the rows rendered from the per-feature stats (grep `CONTEXT_FEATURES` or the feature keys `vol_regime`/`session` in the panel) and add `className={count < 20 ? "an-lowsample" : ""}` to slice rows plus CSS `.an-lowsample { opacity: 0.55; }`, where `count` is the slice's trade count field (read the row shape from `_rows` at analysis.py:50 to get the exact key name).

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend frontend/src
git commit -m "feat(analysis): rolling expectancy series and small-sample grey-out"
```

---

### Task 6: Holdout period (F1) [AFTER sweep-jobs merge]

Reserve the tail of the configured range; normal runs and sweeps clamp to the training span; an explicit action evaluates on the holdout and counts every peek.

**Files:**
- Create: `frontend/src/lib/holdout.ts`
- Test: `frontend/src/lib/holdout.test.ts` (new)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (range controls + evaluate action; find the range/date controls with `grep -n "Pick range\|rangeFrom\|fromMs" frontend/src/BacktestSettingsModal.tsx | head`)
- Modify: `frontend/src/lib/persist/core.ts:117` (`DEVICE_LOCAL_FLAT_KEYS`)

**Interfaces:**
- Produces (in `frontend/src/lib/holdout.ts`):
  - `splitHoldout(fromMs: number, toMs: number, pct: number): { trainToMs: number; holdoutFromMs: number }` where `trainToMs === holdoutFromMs === fromMs + (toMs - fromMs) * (1 - pct / 100)` rounded to whole ms.
  - `loadHoldout(strategyKey: string): { pct: number; peeks: number } | null`, `saveHoldoutPct(strategyKey: string, pct: number | null): void`, `recordPeek(strategyKey: string): number` (returns the new count). Storage: one flat saveLocal key holding a `{ [strategyKey]: { pct, peeks } }` map, entry-capped at 100 with oldest-first eviction (mirror the existing pattern in `frontend/src/lib/sweepMemory.ts`; reuse its strategy-key derivation function, exported there, so holdout and sweep memory key identically).
- Consumes: `saveLocal`/`loadLocal` from the persist module (same imports `sweepMemory.ts` uses).

Behavior contract for the modal wiring (Step 5):
- When a holdout pct is set for the current strategy, every normal run and sweep replaces its `to` bound with `trainToMs`. The footer shows `Holdout: last {pct}% reserved ({date range})`.
- An `Evaluate on holdout` button runs a single backtest over `[holdoutFromMs, toMs]`, calls `recordPeek`, and shows `Holdout result viewed {n} times. Each look makes it less out-of-sample.` after the first peek.
- No backend change: the run simply gets different from/to.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/holdout.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { loadHoldout, recordPeek, saveHoldoutPct, splitHoldout } from "./holdout";

describe("splitHoldout", () => {
  it("splits at the (1 - pct) point", () => {
    const { trainToMs, holdoutFromMs } = splitHoldout(0, 1000, 20);
    expect(trainToMs).toBe(800);
    expect(holdoutFromMs).toBe(800);
  });
  it("rounds to whole ms", () => {
    expect(splitHoldout(0, 1001, 33).trainToMs).toBe(Math.round(1001 * 0.67));
  });
});

describe("holdout store", () => {
  beforeEach(() => localStorage.clear());

  it("roundtrips pct and counts peeks", () => {
    saveHoldoutPct("stratA", 20);
    expect(loadHoldout("stratA")).toEqual({ pct: 20, peeks: 0 });
    expect(recordPeek("stratA")).toBe(1);
    expect(recordPeek("stratA")).toBe(2);
    expect(loadHoldout("stratA")!.peeks).toBe(2);
  });

  it("null pct clears the entry", () => {
    saveHoldoutPct("stratA", 20);
    saveHoldoutPct("stratA", null);
    expect(loadHoldout("stratA")).toBeNull();
  });

  it("unknown strategy is null", () => {
    expect(loadHoldout("nope")).toBeNull();
  });
});
```

(If the persist module needs a jsdom/localStorage shim in tests, copy the setup from `frontend/src/lib/sweepMemory.test.ts`, which exercises the identical storage path.)

- [ ] **Step 2: Run to verify fail**

Run: `cd frontend && npx vitest run src/lib/holdout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `holdout.ts`**

Mirror `sweepMemory.ts` exactly for storage plumbing (read it first; reuse its exported key-derivation and its save/load helpers if exported, otherwise its private pattern):

```ts
// Holdout ("lockbox") config per strategy: reserve the last pct% of the
// configured range. Training runs and sweeps clamp to the front span; the
// holdout is only touched by the explicit Evaluate action, and every look is
// counted, because a holdout that gets peeked at repeatedly quietly becomes
// training data.

import { loadLocal, saveLocal } from "./persist/core";   // match sweepMemory's actual imports

const KEY = "at.holdout";        // add to DEVICE_LOCAL_FLAT_KEYS (persist/core.ts:117)
const CAP = 100;

type Entry = { pct: number; peeks: number; at: number };

export function splitHoldout(fromMs: number, toMs: number, pct: number) {
  const cut = Math.round(fromMs + (toMs - fromMs) * (1 - pct / 100));
  return { trainToMs: cut, holdoutFromMs: cut };
}

function loadAll(): Record<string, Entry> {
  return (loadLocal(KEY) as Record<string, Entry> | null) ?? {};
}

function saveAll(map: Record<string, Entry>): void {
  const keys = Object.keys(map);
  if (keys.length > CAP) {
    for (const k of keys.sort((a, b) => map[a].at - map[b].at).slice(0, keys.length - CAP)) delete map[k];
  }
  saveLocal(KEY, map);
}

export function loadHoldout(strategyKey: string): { pct: number; peeks: number } | null {
  const e = loadAll()[strategyKey];
  return e ? { pct: e.pct, peeks: e.peeks } : null;
}

export function saveHoldoutPct(strategyKey: string, pct: number | null): void {
  const map = loadAll();
  if (pct === null) delete map[strategyKey];
  else map[strategyKey] = { pct, peeks: map[strategyKey]?.peeks ?? 0, at: Date.now() };
  saveAll(map);
}

export function recordPeek(strategyKey: string): number {
  const map = loadAll();
  const e = map[strategyKey];
  if (!e) return 0;
  e.peeks += 1;
  e.at = Date.now();
  saveAll(map);
  return e.peeks;
}
```

Adjust the import names to whatever `sweepMemory.ts` really uses (`grep -n "import" frontend/src/lib/sweepMemory.ts`), and add `"at.holdout"` (with whatever PREFIX convention the file uses) to `DEVICE_LOCAL_FLAT_KEYS`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/holdout.test.ts`
Expected: PASS.

- [ ] **Step 5: Modal wiring**

In `BacktestSettingsModal.tsx`, next to the existing date-range controls:

1. A `Holdout` select with options `None / 10% / 20% / 30%` bound to `loadHoldout(strategyKey)?.pct ?? null`, writing through `saveHoldoutPct`. Derive `strategyKey` with the same function sweepMemory uses for axis memory (it is already computed in this modal; grep its call site).
2. Where the run/sweep request's from/to are assembled (the same place `materializePeriodAxes(axes, fromMs, toMs)` gets its bounds), clamp: `const effToMs = holdoutPct ? splitHoldout(fromMs, toMs, holdoutPct).trainToMs : toMs;` and use `effToMs` for run, sweep, and window bounds alike.
3. An `Evaluate on holdout` button (visible only when a pct is set, disabled while a run/sweep is in flight) that triggers the modal's normal single-run path with `from = holdoutFromMs, to = toMs`, then `recordPeek(strategyKey)` and renders the count line: `Holdout result viewed {n} times. Each look makes it less out-of-sample.` styled like the existing `al-note` hint class.
4. Footer badge while a holdout is active: `Holdout: last {pct}% reserved`.

This step is in a 3279-line file: copy adjacent control markup exactly, change nothing structural, and re-run the modal's existing test file afterward (`npx vitest run src/BacktestSettingsModal.test.tsx` if present).

- [ ] **Step 6: Typecheck + tests**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(backtest): holdout period with peek counter and evaluate action"
```

---

### Task 7: Refine-around-best + random search (O1) [AFTER sweep-jobs merge]

**Files:**
- Create: `frontend/src/lib/sweepSearch.ts`
- Test: `frontend/src/lib/sweepSearch.test.ts` (new)
- Modify: `frontend/src/lib/sweep.ts` (post-jobs `runSweep`: accept a combo override)
- Modify: `frontend/src/SweepResults.tsx` (Refine action), `frontend/src/BacktestSettingsModal.tsx` (mode toggle + N; pass `onRefine`)

**Interfaces:**
- Produces (in `frontend/src/lib/sweepSearch.ts`):
  - `refineAxesAround(axes: SweepAxis[], combo: SweepCombo): SweepAxis[]`: each range axis re-centers on the combo's value: `from = max(loBound, v - step)`, `to = min(hiBound, v + step)`, `step = step / 2`, where loBound/hiBound are the ORIGINAL axis endpoints normalized (`min(a.from, a.to)` / `max(...)`), all values passed through `Number(x.toPrecision(12))`. List axes collapse to the single matching option (via `axisOptionFor`); a list axis with no matching option and period axes pass through unchanged.
  - `sampleCombos(axes: SweepAxis[], n: number, seed: number): SweepCombo[]`: up to `n` UNIQUE combos sampled uniformly per axis (range axes sample a random grid value from `axisValues`, list axes a random option patch) using a seeded mulberry32 PRNG; deterministic for a given seed; gives up after `20 * n` attempts if the grid has fewer than n unique cells.
- Consumes: `axisValues` must be exported from `frontend/src/lib/sweep.ts` (it is module-private today at sweep.ts:94; add `export` to it, a one-word diff that survives the jobs rewrite), plus `axisOptionFor`, types.
- Post-jobs `runSweep` (per the jobs plan Task 6 it has signature `runSweep(baseReq, axes, opts)` and calls `enumerateCombos(axes)` internally): add `opts.combosOverride?: SweepCombo[]` used INSTEAD of `enumerateCombos` when present. One-line diff at the enumeration site.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/sweepSearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SweepAxis } from "./sweep";
import { refineAxesAround, sampleCombos } from "./sweepSearch";

const range = (target: string, from: number, to: number, step: number): SweepAxis =>
  ({ kind: "range", target, label: target, from, to, step });

describe("refineAxesAround", () => {
  it("halves the step and re-centers within the original bounds", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 5)], { "param:p": 20 });
    expect(a).toMatchObject({ kind: "range", from: 15, to: 25, step: 2.5 });
  });
  it("clamps at the original endpoints", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 5)], { "param:p": 5 });
    expect(a).toMatchObject({ from: 5, to: 10 });
  });
  it("collapses a list axis to the selected option", () => {
    const list: SweepAxis = { kind: "list", target: "op:x", label: "op", options: [
      { label: "gt", patch: { "op:x": "gt" } }, { label: "lt", patch: { "op:x": "lt" } }] };
    const [a] = refineAxesAround([list], { "op:x": "lt" });
    expect(a.kind === "list" && a.options).toEqual([{ label: "lt", patch: { "op:x": "lt" } }]);
  });
});

describe("sampleCombos", () => {
  const axes = [range("param:a", 1, 100, 1), range("param:b", 1, 100, 1)];

  it("is deterministic for a seed and unique", () => {
    const s1 = sampleCombos(axes, 50, 42);
    const s2 = sampleCombos(axes, 50, 42);
    expect(s1).toEqual(s2);
    expect(new Set(s1.map((c) => JSON.stringify(c))).size).toBe(50);
  });

  it("draws only grid values", () => {
    for (const c of sampleCombos(axes, 20, 7)) {
      expect(Number.isInteger(c["param:a"])).toBe(true);
      expect(c["param:a"]).toBeGreaterThanOrEqual(1);
      expect(c["param:a"]).toBeLessThanOrEqual(100);
    }
  });

  it("caps at the grid size when n exceeds it", () => {
    const tiny = [range("param:a", 1, 3, 1)];
    expect(sampleCombos(tiny, 10, 1).length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd frontend && npx vitest run src/lib/sweepSearch.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `sweepSearch.ts`**

```ts
// Sweep search strategies beyond the exhaustive grid: refine-around-a-result
// (halve steps, re-center, clamp to the original bounds) and seeded uniform
// random sampling for high-dimensional spaces. Pure functions over axes; the
// transport layer (runSweep) stays untouched.

import { axisOptionFor, axisValues, type SweepAxis, type SweepCombo } from "./sweep";

const prec = (x: number) => Number(x.toPrecision(12));

export function refineAxesAround(axes: SweepAxis[], combo: SweepCombo): SweepAxis[] {
  return axes.map((a) => {
    if (a.kind === "range") {
      const v = combo[a.target];
      if (typeof v !== "number") return a;
      const lo = Math.min(a.from, a.to), hi = Math.max(a.from, a.to);
      return { ...a, from: prec(Math.max(lo, v - a.step)),
               to: prec(Math.min(hi, v + a.step)), step: prec(a.step / 2) };
    }
    if (a.kind === "list") {
      const opt = axisOptionFor(a, combo);
      return opt ? { ...a, options: [opt] } : a;
    }
    return a;
  });
}

// mulberry32: tiny seeded PRNG, plenty for sampling grid cells.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleCombos(axes: SweepAxis[], n: number, seed: number): SweepCombo[] {
  const rnd = mulberry32(seed);
  const seen = new Set<string>();
  const out: SweepCombo[] = [];
  for (let attempts = 0; out.length < n && attempts < 20 * n; attempts++) {
    const combo: SweepCombo = {};
    for (const a of axes) {
      if (a.kind === "range") {
        const vals = axisValues(a);
        if (!vals.length) return out;
        combo[a.target] = vals[Math.floor(rnd() * vals.length)];
      } else if (a.kind === "list") {
        if (!a.options.length) return out;
        Object.assign(combo, a.options[Math.floor(rnd() * a.options.length)].patch);
      } else {
        throw new Error("period axis must be materialized before sampling");
      }
    }
    const key = JSON.stringify(combo);
    if (!seen.has(key)) { seen.add(key); out.push(combo); }
  }
  return out;
}
```

And in `sweep.ts`: change `function axisValues` (line 94) to `export function axisValues`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/sweepSearch.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the UI**

1. `runSweep` (post-jobs shape): add `combosOverride?: SweepCombo[]` to its `opts` and use it at the single enumeration call site: `const combos = opts.combosOverride ?? enumerateCombos(axes);`. Extend `frontend/src/lib/sweep.test.ts` with one case: an override list is submitted verbatim (spy on the submit function and assert the combos argument).
2. `SweepResults`: new optional prop `onRefine?: (combo: SweepRow["combo"]) => void`; when present render a small `Refine` button in the hovered-cell detail toolbar and as a per-row action cell after the robust columns:

```tsx
{onRefine && (
  <td className="sweep-c-act">
    <button type="button" disabled={applyDisabled}
            onClick={(e) => { e.stopPropagation(); onRefine(row.combo); }}>
      Refine
    </button>
  </td>
)}
```

(add the matching empty `<th />` in the header row so columns align).
3. `BacktestSettingsModal`: pass `onRefine={(combo) => setSweepAxes(refineAxesAround(mirroredOrCurrentAxes, combo))}` using whatever state setter holds the sweep axes (grep `sweepAxes` in the modal; the sweep-memory save effect keyed on `[sweepAxes]` will persist the refined ranges automatically per the sweepMemory design). Add next to the sweep controls a `Search: Grid | Random` segmented control plus an `N` input (default 200, min 10) shown only for Random; when Random, compute `combosOverride = sampleCombos(materializePeriodAxes(mirrorRiskAxes(axes), fromMs, toMs), n, 1)` and pass it through to `runSweep`. Seed is fixed at 1: reproducibility beats novelty here; note it in the control's InfoTip: `Random search samples N combos from the ranges. Same ranges and N always draw the same sample.`
4. Heatmap with sparse random rows already renders: cells with no matching row show empty; acceptable.

- [ ] **Step 6: Typecheck + tests**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(sweep): refine-around-result and seeded random search"
```

---

### Task 8: Sweep archive (C4) [AFTER sweep-jobs merge]

Persist completed sweeps server-side (axes + rows), list and reopen them. The frontend posts the finished result set explicitly, so this works identically for local and remote jobs and needs nothing from the job manager's internals.

**Files:**
- Create: `backend/auto_trader/core/sweep_store.py`
- Modify: `backend/auto_trader/config.py` (add `sweeps_db_path`, mirroring `runs_db_path`; verify with `grep -n "runs_db_path" backend/auto_trader/config.py`)
- Modify: `backend/auto_trader/api/routers/backtest.py` (four endpoints)
- Test: `backend/tests/test_api_sweep_archive.py` (new)
- Modify: `frontend/src/api.ts` (client functions), `frontend/src/BacktestSettingsModal.tsx` (auto-save on completion + reopen picker)

**Interfaces:**
- Produces:
  - `auto_trader.core.sweep_store.SweepStore(db_path, cap=50)` with async `insert(rec) / list(limit=50, epic=None) / get(id) / delete(id)`, module singleton `SWEEP_STORE`. Record: `{id, created_at, epic, timeframe, name, axes, rows, windows}` where `axes` is the frontend `SweepAxis[]` JSON verbatim (labels included, so reopening needs no re-derivation), `rows` the `SweepRow[]`, `windows` the bounds list or None.
  - HTTP: `POST /api/backtest/sweeps` body `{epic, timeframe, name, axes, rows, windows}` returns `{"id": str}`; `GET /api/backtest/sweeps?epic=` returns summaries `[{id, created_at, epic, timeframe, name, n_rows, best_net_pnl}]`; `GET /api/backtest/sweeps/{id}` returns the full record; `DELETE /api/backtest/sweeps/{id}` returns `{"ok": true}`. Declare the literal `/sweeps` route BEFORE `/sweeps/{id}` (same shadowing rule as the runs routes, backtest.py:456).
  - Frontend `frontend/src/api.ts`: `saveSweepArchive(rec): Promise<{id: string}>`, `listSweepArchives(epic?): Promise<SweepArchiveSummary[]>`, `getSweepArchive(id): Promise<SweepArchive>`, `deleteSweepArchive(id): Promise<void>` with the matching TS types.
- Consumes: `SweepRow`, `SweepAxis` (types), the modal's sweep-completion site.

- [ ] **Step 1: Write the failing API tests**

`backend/tests/test_api_sweep_archive.py`:

```python
"""Sweep archive endpoints: roundtrip, summaries, cap, delete."""
from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def rec(name="s1", net=100.0):
    return {
        "epic": "EURUSD", "timeframe": "MINUTE_15", "name": name,
        "axes": [{"kind": "range", "target": "param:p", "label": "p",
                  "from": 1, "to": 5, "step": 1}],
        "rows": [{"combo": {"param:p": 1}, "metrics": {"net_pnl": net, "n_trades": 3},
                  "windows": None, "error": None}],
        "windows": None,
    }


def test_roundtrip_and_summary(tmp_path, monkeypatch):
    import auto_trader.api.routers.backtest as bt
    from auto_trader.core.sweep_store import SweepStore
    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(str(tmp_path / "s.db")))

    rid = client.post("/api/backtest/sweeps", json=rec()).json()["id"]
    listed = client.get("/api/backtest/sweeps").json()
    assert listed[0]["id"] == rid
    assert listed[0]["n_rows"] == 1 and listed[0]["best_net_pnl"] == 100.0

    full = client.get(f"/api/backtest/sweeps/{rid}").json()
    assert full["axes"][0]["target"] == "param:p"
    assert full["rows"][0]["metrics"]["net_pnl"] == 100.0

    assert client.delete(f"/api/backtest/sweeps/{rid}").json() == {"ok": True}
    assert client.get(f"/api/backtest/sweeps/{rid}").status_code == 404


def test_cap_prunes_oldest(tmp_path, monkeypatch):
    import auto_trader.api.routers.backtest as bt
    from auto_trader.core.sweep_store import SweepStore
    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(str(tmp_path / "s.db"), cap=2))
    ids = [client.post("/api/backtest/sweeps", json=rec(name=f"s{i}")).json()["id"]
           for i in range(3)]
    listed = client.get("/api/backtest/sweeps").json()
    assert len(listed) == 2 and ids[0] not in [r["id"] for r in listed]
```

(If `created_at` second-resolution ties break the prune ordering, mirror RunStore's `ORDER BY created_at DESC, id DESC` tiebreak and make ids sortable by insertion via uuid: the store test may need a monotonic counter; follow whatever `test_` file covers RunStore if one exists: `ls backend/tests | grep -i run`.)

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && uv run pytest tests/test_api_sweep_archive.py -q`
Expected: FAIL (import/404).

- [ ] **Step 3: Implement store + endpoints**

`backend/auto_trader/core/sweep_store.py`: copy `run_store.py`'s structure verbatim (WAL, schema-on-connect, fresh connection per op, `asyncio.to_thread`), with table:

```sql
CREATE TABLE IF NOT EXISTS sweeps (
  id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, timeframe TEXT,
  name TEXT, axes_json TEXT, rows_json TEXT, windows_json TEXT)
```

`list` returns summaries computed at read time from `rows_json`:

```python
rows = json.loads(r[6])
n_rows = len(rows)
nets = [row["metrics"]["net_pnl"] for row in rows
        if row.get("metrics") and row["metrics"].get("net_pnl") is not None]
best = max(nets) if nets else None
```

(50 records of ~1000 rows parse fine; if it ever drags, denormalize the two summary columns then.) Singleton at the bottom mirroring run_store.py:130: `SWEEP_STORE = SweepStore(settings.sweeps_db_path)` after adding `sweeps_db_path` to config with the same directory convention as `runs_db_path`.

Router: four thin handlers next to the runs routes using pydantic body model `SweepArchiveIn(BaseModel): epic: str; timeframe: str; name: str | None = None; axes: list[dict]; rows: list[dict]; windows: list[int] | None = None`, generating `id = uuid.uuid4().hex`, `created_at = int(time.time())`.

- [ ] **Step 4: Run backend tests**

Run: `cd backend && uv run pytest tests/test_api_sweep_archive.py -q && uv run pytest -q`
Expected: PASS.

- [ ] **Step 5: Frontend client + wiring**

`api.ts`: the four fetch wrappers following the file's existing fetch/error pattern (copy `runSweepChunk`'s successor's shape). Types:

```ts
export interface SweepArchiveSummary {
  id: string; created_at: number; epic: string; timeframe: string;
  name: string | null; n_rows: number; best_net_pnl: number | null;
}
export interface SweepArchive extends Omit<SweepArchiveSummary, "n_rows" | "best_net_pnl"> {
  axes: SweepAxis[]; rows: SweepRow[]; windows: number[] | null;
}
```

(import `SweepAxis` type into api.ts or type `axes` as `unknown[]` and cast at the call site if that import direction is circular; check how api.ts currently references sweep types.)

Modal wiring:
1. On sweep completion (the site that marks the sweep state finished; post-jobs this is where `runSweep` resolves), fire-and-forget `saveSweepArchive({epic, timeframe, name: null, axes, rows, windows})` wrapped in try/catch with a console.warn on failure. Auto-name: leave null; the list renders a fallback `"{axes.length} axes, {n_rows} combos"`.
2. A `Past sweeps` select near the sweep controls: options from `listSweepArchives(epic)` (fetched when the sweep section opens), labeled `{date} · {name or fallback} · best {best_net_pnl}`; choosing one calls `getSweepArchive(id)` and loads `axes` into the sweep-axes state and `rows` into the sweep results state (grep how `sweepStateSignal`/local results state is set after a run and set the same state), with the progress cleared so apply is enabled. A small delete button beside the select calls `deleteSweepArchive`.

- [ ] **Step 6: Typecheck + full suites**

Run: `cd frontend && npx tsc -b && npx vitest run && cd ../backend && uv run pytest -q`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add backend frontend/src
git commit -m "feat(sweep): server-side sweep archive with reopen"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Full suites**

Run: `cd backend && uv run pytest -q && cd ../frontend && npx vitest run && npx tsc -b`
Expected: all green.

- [ ] **Step 2: Live verification (verify skill applies)**

With the user's dev servers running: run a single backtest and confirm Sharpe/Sortino/Calmar/CAGR/SQN/Exposure appear in the stats and the cost line reads sensibly; run a 2-axis sweep and confirm the Plateau column sorts, a spike (if any) shows the amber badge, "Apply plateau center" applies a combo, Refine tightens the axes, Random mode with N=50 streams 50 rows; set a 20% holdout, confirm runs clamp and Evaluate-on-holdout runs the tail and counts peeks; confirm the finished sweep appears under Past sweeps and reopens with intact heatmap; open the Analysis tab and confirm the Edge-over-time sparkline renders and thin regime slices are greyed.

---

## Self-review notes

- Ordering rationale: Tasks 1 to 5 are conflict-free with the concurrent sweep-jobs work (metrics.py, analysis.py, new libs, SweepResults internals, one dict literal in `_sweep_row` that moves verbatim into `sweep_apply.py`); Tasks 6 to 8 edit `sweep.ts`/modal/router surfaces the jobs plan rewrites and are gated on its merge.
- Deliberate scope cuts vs the proposals doc: F0's per-column small-sample greying is reduced to tooltip caveats (Task 2) with the real grey-out only in the Analysis regime tables (Task 5); F3's heatmap halo is dropped in favor of the sortable Plateau column plus heatmap-colorable `plateau_score`; F1 adds no chart shading (the evaluate run's existing period shading covers it).
- Judgment calls flagged inline for implementers: run-stats component location (Task 2/3 grep), costs DTO field names (Task 3), `compute_analysis` trade-dict requirements and `_rows` count key (Task 5), sweepMemory import/key conventions (Task 6), post-jobs `runSweep` internals (Task 7), api.ts type-import direction and RunStore test conventions (Task 8).
- Type consistency check done: `risk_metrics` keys match Task 2's surfaced names; `plateau_score` naming consistent across sweepPlateau.ts and SweepResults; `SweepCombo`/`SweepAxis` imports consistent; archive record fields match between store, endpoints, and TS types.
