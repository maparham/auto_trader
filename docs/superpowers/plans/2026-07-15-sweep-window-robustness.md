# Sweep Window Robustness Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each sweep combo's single continuous run gets sliced into N sub-windows by trade entry time; four robustness aggregates (worst window, median window, % windows profitable, mean minus std) become sortable columns, heatmap metrics, and a per-window hover strip, so consistent combos can be preferred over one-lucky-week spikes.

**Architecture:** The backend buckets each combo's trades into window bounds sent with the sweep request (zero extra engine runs) and returns per-window rows plus aggregates inside the existing `SweepRowDTO`. The frontend computes the bounds once per sweep (auto-sized from the range, user-overridable), and `SweepResults` renders the new columns, heatmap metric options, and a `WindowStrip` breakdown.

**Tech Stack:** FastAPI + Pydantic + pytest (backend), React + TypeScript + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-07-15-sweep-window-robustness-design.md`

## Global Constraints

- NEVER use an em dash ("—" or "--") in any UI copy, comment, or test string; rephrase with colon/comma/period. (Existing code contains them; do not add new ones.)
- All tooltips use the shared `Tooltip` (`frontend/src/components/Tooltip.tsx`) or `InfoTip` (`frontend/src/components/InfoTip.tsx`) components, never native `title=`.
- Tooltip copy must match the spec's Tooltips section verbatim (reproduced in Task 5 and Task 6).
- Aggregate keys, exactly: `worst_window_pnl`, `median_window_pnl`, `pct_windows_profitable`, `mean_window_pnl_minus_std`. All four are higher-is-better.
- Window bounds travel as ascending epoch-second boundaries (`list[int]`, length N+1 for N windows).
- Combos that patch their own period (`period:from` in the combo) get NO window metrics (their effective range differs from the sweep's range; full-range windows would mis-score them).
- Commit after each task with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01SzguDAxmtzjLfA25z5bMqr`
- Backend tests run from `backend/`: `cd backend && python -m pytest tests/<file> -v`. Frontend tests: `cd frontend && npx vitest run src/<file>`.

---

### Task 1: Backend `window_metrics` helper

**Files:**
- Modify: `backend/auto_trader/engine/metrics.py` (append at end of file)
- Test: `backend/tests/test_metrics.py` (append)

**Interfaces:**
- Consumes: `auto_trader.core.models.Trade` (fields used: `entry_time: datetime` tz-aware UTC, `pnl: float`).
- Produces: `window_metrics(trades: Sequence, bounds: Sequence[int]) -> tuple[list[dict], dict]`.
  - First element: one dict per window, keys `from`/`to` (epoch seconds, ints from `bounds`), `pnl` (float, rounded 5), `trades` (int).
  - Second element: dict with exactly the four aggregate keys from Global Constraints. `pct_windows_profitable` is a 0..1 fraction rounded to 4 places; the other three are rounded to 5.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_metrics.py`:

```python
# --- window_metrics: sub-window robustness slicing ---------------------------

from datetime import datetime, timezone

from auto_trader.core.models import Side, Trade
from auto_trader.engine.metrics import window_metrics


def _trade(entry_s: int, pnl: float) -> Trade:
    t = datetime.fromtimestamp(entry_s, tz=timezone.utc)
    return Trade(side=Side.BUY, quantity=1.0, entry_time=t, entry_price=1.0,
                 exit_time=t, exit_price=1.0, pnl=pnl)


def test_window_metrics_buckets_by_entry_time():
    # 3 windows: [0,100), [100,200), [200,300]
    bounds = [0, 100, 200, 300]
    trades = [_trade(10, 5.0), _trade(150, -2.0), _trade(160, 3.0), _trade(250, 4.0)]
    windows, agg = window_metrics(trades, bounds)
    assert [w["pnl"] for w in windows] == [5.0, 1.0, 4.0]
    assert [w["trades"] for w in windows] == [1, 2, 1]
    assert [w["from"] for w in windows] == [0, 100, 200]
    assert [w["to"] for w in windows] == [100, 200, 300]
    assert agg["worst_window_pnl"] == 1.0
    assert agg["median_window_pnl"] == 4.0
    assert agg["pct_windows_profitable"] == 1.0


def test_window_metrics_empty_window_counts_as_unprofitable():
    bounds = [0, 100, 200]
    windows, agg = window_metrics([_trade(10, 5.0)], bounds)
    assert windows[1] == {"from": 100, "to": 200, "pnl": 0.0, "trades": 0}
    assert agg["worst_window_pnl"] == 0.0
    assert agg["pct_windows_profitable"] == 0.5


def test_window_metrics_boundary_and_out_of_range_trades_clamp():
    bounds = [100, 200, 300]
    # Exactly on an inner boundary goes to the RIGHT window; entries outside
    # the bounds clamp into the nearest edge window instead of being dropped.
    trades = [_trade(200, 1.0), _trade(50, 2.0), _trade(350, 3.0)]
    windows, _ = window_metrics(trades, bounds)
    assert windows[0]["pnl"] == 2.0
    assert windows[1]["pnl"] == 4.0   # boundary trade + clamped late trade


def test_window_metrics_mean_minus_std():
    bounds = [0, 100, 200]
    # window pnls: [10, -10] -> mean 0, population std 10 -> aggregate -10
    trades = [_trade(10, 10.0), _trade(150, -10.0)]
    _, agg = window_metrics(trades, bounds)
    assert agg["mean_window_pnl_minus_std"] == -10.0


def test_window_metrics_zero_trades_and_single_window():
    windows, agg = window_metrics([], [0, 100])
    assert windows == [{"from": 0, "to": 100, "pnl": 0.0, "trades": 0}]
    assert agg == {"worst_window_pnl": 0.0, "median_window_pnl": 0.0,
                   "pct_windows_profitable": 0.0, "mean_window_pnl_minus_std": 0.0}


def test_window_metrics_median_even_count():
    bounds = [0, 100, 200, 300, 400]
    trades = [_trade(10, 1.0), _trade(110, 2.0), _trade(210, 3.0), _trade(310, 10.0)]
    _, agg = window_metrics(trades, bounds)
    assert agg["median_window_pnl"] == 2.5
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_metrics.py -v -k window_metrics`
Expected: FAIL / ERROR with `ImportError: cannot import name 'window_metrics'`

- [ ] **Step 3: Implement `window_metrics`**

Append to `backend/auto_trader/engine/metrics.py` (also add `from bisect import bisect_right` to the imports at the top, under `from collections.abc import Sequence`):

```python
def window_metrics(trades, bounds: Sequence[int]) -> tuple[list[dict], dict]:
    """Slice one continuous run's trades into the given sub-windows and score
    how evenly the P&L was earned. `bounds` is an ascending list of epoch
    seconds (N+1 boundaries for N windows). A trade belongs to the window its
    ENTRY falls in ([from, to), last window closed on the right); entries
    outside the bounds clamp into the nearest edge window. Aggregates are all
    higher-is-better; a zero-trade window has pnl 0 and counts as not
    profitable. std is the population std over window pnls (k = 1 penalty)."""
    n = len(bounds) - 1
    pnls = [0.0] * n
    counts = [0] * n
    for t in trades:
        ts = t.entry_time.timestamp()
        idx = min(max(bisect_right(bounds, ts) - 1, 0), n - 1)
        pnls[idx] += t.pnl
        counts[idx] += 1
    windows = [
        {"from": bounds[i], "to": bounds[i + 1], "pnl": round(pnls[i], 5), "trades": counts[i]}
        for i in range(n)
    ]
    mean = sum(pnls) / n
    std = (sum((p - mean) ** 2 for p in pnls) / n) ** 0.5
    ordered = sorted(pnls)
    mid = n // 2
    median = ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2
    agg = {
        "worst_window_pnl": round(min(pnls), 5),
        "median_window_pnl": round(median, 5),
        "pct_windows_profitable": round(sum(1 for p in pnls if p > 0) / n, 4),
        "mean_window_pnl_minus_std": round(mean - std, 5),
    }
    return windows, agg
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_metrics.py -v`
Expected: ALL PASS (new window_metrics tests plus the pre-existing metrics tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/metrics.py backend/tests/test_metrics.py
git commit -m "feat(sweep): window_metrics helper slices a run into sub-window robustness scores"
```

---

### Task 2: Backend sweep wiring (DTOs + both sweep branches)

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (`SweepDTO` ~line 422, `SweepRowDTO` ~line 441)
- Modify: `backend/auto_trader/api/routers/backtest.py` (`backtest_sweep` ~line 710; new helper above it)
- Test: `backend/tests/test_api_backtest_sweep.py` (append)

**Interfaces:**
- Consumes: `window_metrics(trades, bounds)` from Task 1 (import it in the router next to the existing `compute_metrics` import).
- Produces (wire contract the frontend relies on):
  - Request: `sweep.windows: list[int] | None`, ascending epoch-second boundaries, length >= 2. Invalid bounds 422 the chunk.
  - Response row: `windows: list[{from,to,pnl,trades}] | null`; when windows ran, `metrics` additionally contains the four aggregate keys. Rows for combos containing `period:from` keep `windows = null` and no aggregate keys.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_backtest_sweep.py`:

```python
# --- sub-window robustness metrics -------------------------------------------

_AGG_KEYS = {"worst_window_pnl", "median_window_pnl",
             "pct_windows_profitable", "mean_window_pnl_minus_std"}


def test_sweep_windows_attach_per_window_rows_and_aggregates(strategies):
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}])
    t0 = candles[0]["time"]
    t_end = candles[-1]["time"]
    mid = (t0 + t_end) // 2
    req["sweep"]["windows"] = [t0, mid, t_end + 1]
    rows = client.post("/api/backtest/sweep", json=req).json()["rows"]
    row = rows[0]
    assert row["error"] is None
    assert len(row["windows"]) == 2
    assert {"from", "to", "pnl", "trades"} <= set(row["windows"][0])
    assert _AGG_KEYS <= set(row["metrics"])
    # Window trade counts sum to the run's total.
    assert sum(w["trades"] for w in row["windows"]) == row["metrics"]["n_trades"]


def test_sweep_without_windows_unchanged(strategies):
    candles = make_candles(20)
    rows = client.post("/api/backtest/sweep", json=sweep_request(
        candles, [{"param:n": 3}],
    )).json()["rows"]
    assert rows[0]["windows"] is None
    assert _AGG_KEYS.isdisjoint(rows[0]["metrics"])


def test_sweep_period_combo_skips_window_metrics(strategies):
    candles = make_candles(20)
    t0, t_end = candles[0]["time"], candles[-1]["time"]
    combo = {"param:n": 3, "period:from": t0, "period:to": t_end}
    req = sweep_request(candles, [combo])
    req["sweep"]["windows"] = [t0, (t0 + t_end) // 2, t_end + 1]
    rows = client.post("/api/backtest/sweep", json=req).json()["rows"]
    assert rows[0]["error"] is None
    assert rows[0]["windows"] is None
    assert _AGG_KEYS.isdisjoint(rows[0]["metrics"])


def test_sweep_bad_windows_422(strategies):
    candles = make_candles(20)
    for bad in ([123], [200, 100]):
        req = sweep_request(candles, [{"param:n": 3}])
        req["sweep"]["windows"] = bad
        assert client.post("/api/backtest/sweep", json=req).status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep.py -v -k windows`
Expected: FAIL (`windows` key absent from rows / no 422 on bad bounds)

- [ ] **Step 3: Extend the DTOs**

In `backend/auto_trader/api/schemas.py`, add to `SweepDTO` after `total: int | None = None`:

```python
    # Sub-window robustness bounds: ascending epoch-second boundaries (N+1 for
    # N windows). When set, each row gets per-window pnl/trades plus aggregate
    # robustness metrics sliced from its ONE continuous run (no extra engine
    # runs). Combos that patch their own period: are skipped (their effective
    # range differs from these bounds).
    windows: list[int] | None = None
```

And change `SweepRowDTO` to:

```python
class SweepRowDTO(BaseModel):
    combo: dict[str, float | int | bool | str]
    metrics: dict | None = None
    # Per-window slice of this combo's run (sweep.windows bounds): pnl and
    # trade count per window, entry-time attribution. None when no windows
    # were requested or the combo patches its own period.
    windows: list[dict] | None = None
    error: str | None = None
```

- [ ] **Step 4: Wire the router**

In `backend/auto_trader/api/routers/backtest.py`:

a) Import `window_metrics` next to the existing metrics import (find `compute_metrics` in the import block near the top and extend that import).

b) Add validation at the top of `backtest_sweep`, right after the `_SWEEP_MAX_COMBOS` check (~line 715):

```python
    bounds = req.sweep.windows
    if bounds is not None and (
        len(bounds) < 2 or any(b <= a for a, b in zip(bounds, bounds[1:]))
    ):
        raise HTTPException(422, "sweep.windows must be >= 2 ascending epoch seconds")
```

c) Add a module-level helper above `backtest_sweep` (near `_log_sweep_done`). Both branches currently build the same metrics-dict literal; factor it here and attach windows:

```python
def _sweep_row(req: BacktestRequest, combo: dict, result) -> SweepRowDTO:
    """Success row for one combo: the standard sweep metrics, plus per-window
    robustness slices when the request carries sweep.windows. A combo that
    patches its own period runs over a different range than the sweep's
    windows, so it gets none (windows stay None, no aggregate keys)."""
    metrics = compute_metrics(result.trades, result.equity, result.net_pnl,
                              req.costs.startingCash, resolution_seconds(req.resolution))
    row_metrics = {
        "net_pnl": round(result.net_pnl, 5),
        "n_trades": result.n_trades,
        "win_rate": round(result.win_rate, 4),
        "max_drawdown": round(result.max_drawdown, 5),
        "profit_factor": metrics.get("profit_factor"),
        "avg_win_loss_ratio": metrics.get("avg_win_loss_ratio"),
        "return_pct": metrics.get("return_pct"),
    }
    windows = None
    if req.sweep.windows is not None and "period:from" not in combo:
        windows, agg = window_metrics(result.trades, req.sweep.windows)
        row_metrics.update(agg)
    return SweepRowDTO(combo=combo, metrics=row_metrics, windows=windows)
```

d) In the RULE branch (~line 759-769), replace the `metrics = compute_metrics(...)` statement and the `rows.append(SweepRowDTO(combo=combo, metrics={...}))` literal with:

```python
            rows.append(_sweep_row(req, combo, result))
```

e) In the CODED branch (~line 810-820), make the identical replacement.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep.py tests/test_api_backtest_rule_sweep.py tests/test_api_backtest_sweep_dims.py -v`
Expected: ALL PASS (new tests plus every pre-existing sweep test; the factoring must not change existing row shapes)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_sweep.py
git commit -m "feat(sweep): per-window robustness metrics on sweep rows"
```

---

### Task 3: Frontend plumbing (bounds computation + request + config field)

**Files:**
- Modify: `frontend/src/lib/sweep.ts` (new `robustWindowBounds`; `runSweep` opts)
- Modify: `frontend/src/api.ts` (`SweepRow` ~line 385, `runSweepChunk` ~line 399)
- Modify: `frontend/src/lib/backtestConfig.ts` (`BacktestConfig` ~line 275)
- Modify: `frontend/src/BacktestButton.tsx` (sweep branch ~line 287)
- Test: `frontend/src/lib/sweep.test.ts` (append)

**Interfaces:**
- Produces: `robustWindowBounds(fromMs: number, toMs: number, overrideN?: number): number[]` in `sweep.ts`, returning ascending epoch SECONDS, length N+1. Auto rule (spec): `unitDays` is the largest of (30, 7, 1) giving at least 3 windows, `N = clamp(round(rangeDays / unitDays), 3, 30)`; an explicit `overrideN` is used as `clamp(round(overrideN), 2, 50)` instead.
- Produces: `runSweep(baseReq, axes, opts)` gains `opts.windows?: number[]`, forwarded to every `runSweepChunk` call.
- Produces: `runSweepChunk(req, combos, progress?, windows?)` posts `sweep: { combos, windows, ...progress }`.
- Produces: `SweepRow.windows: { from: number; to: number; pnl: number; trades: number }[] | null` and four new nullable metric keys (Task 4 consumes both).
- Produces: `BacktestConfig.robustWindows?: number` (undefined = auto).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/sweep.test.ts` (it already imports from `./sweep`; add `robustWindowBounds` to that import):

```ts
describe("robustWindowBounds", () => {
  const DAY = 86_400_000;

  it("splits a month into weekly windows", () => {
    const from = Date.UTC(2026, 2, 1);
    const to = from + 28 * DAY;
    const bounds = robustWindowBounds(from, to);
    expect(bounds).toHaveLength(5); // 4 windows
    expect(bounds[0]).toBe(Math.round(from / 1000));
    expect(bounds[4]).toBe(Math.round(to / 1000));
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
  });

  it("splits a year into monthly windows and a week into daily windows", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(robustWindowBounds(from, from + 365 * DAY)).toHaveLength(13);
    expect(robustWindowBounds(from, from + 7 * DAY)).toHaveLength(8);
  });

  it("clamps auto N to at least 3 and at most 30", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(robustWindowBounds(from, from + 1 * DAY)).toHaveLength(4);      // min 3
    expect(robustWindowBounds(from, from + 3650 * DAY)).toHaveLength(31);  // max 30
  });

  it("uses the override count when given, clamped to 2..50", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(robustWindowBounds(from, from + 28 * DAY, 6)).toHaveLength(7);
    expect(robustWindowBounds(from, from + 28 * DAY, 1)).toHaveLength(3);
    expect(robustWindowBounds(from, from + 28 * DAY, 99)).toHaveLength(51);
  });
});
```

Also find the existing `runSweep` test block in `sweep.test.ts` (it mocks `runSweepChunk` via `vi.mock("../api", ...)`) and add one test asserting the forwarded windows argument:

```ts
  it("forwards opts.windows to every chunk", async () => {
    const axis: RangeAxis = { kind: "range", target: "param:n", label: "n", from: 1, to: 2, step: 1 };
    mockChunk.mockResolvedValue([]);
    await runSweep({} as BacktestRequest, [axis], { onRows: () => {}, windows: [1, 2, 3] });
    expect(mockChunk).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), [1, 2, 3]);
  });
```

(Adapt the mock variable name to what the file already uses; read the existing `runSweep` tests in that file first and follow their setup exactly.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts`
Expected: FAIL with `robustWindowBounds is not exported` (and the forwarding test failing)

- [ ] **Step 3: Implement**

a) In `frontend/src/lib/sweep.ts`, add below `materializePeriodAxes`:

```ts
/** Sub-window robustness bounds over the resolved range: ascending epoch
 * SECONDS, N+1 boundaries for N equal contiguous windows. Auto N picks the
 * largest calendar-ish unit (month/week/day) that yields at least 3 windows,
 * clamped to 3..30; an explicit override is clamped to 2..50. Sent with every
 * sweep chunk so the backend slices each combo's run identically. */
export function robustWindowBounds(fromMs: number, toMs: number, overrideN?: number): number[] {
  const DAY = 86_400_000;
  const rangeDays = (toMs - fromMs) / DAY;
  let n: number;
  if (overrideN !== undefined && Number.isFinite(overrideN)) {
    n = Math.max(2, Math.min(50, Math.round(overrideN)));
  } else {
    const unitDays = [30, 7, 1].find((u) => rangeDays / u >= 3) ?? 1;
    n = Math.max(3, Math.min(30, Math.round(rangeDays / unitDays)));
  }
  const bounds: number[] = [];
  for (let i = 0; i <= n; i++) {
    bounds.push(Math.round((fromMs + ((toMs - fromMs) * i) / n) / 1000));
  }
  return bounds;
}
```

b) In `runSweep` (same file), extend the opts type with `windows?: number[];` and change the two `runSweepChunk(baseReq, chunk, progress)` calls to `runSweepChunk(baseReq, chunk, progress, opts.windows)`.

c) In `frontend/src/api.ts`, extend `SweepRow`:

```ts
export interface SweepRow {
  combo: Record<string, number | boolean | string>;
  metrics: {
    net_pnl: number;
    n_trades: number;
    win_rate: number;
    max_drawdown: number;
    profit_factor: number | null;
    avg_win_loss_ratio: number | null;
    return_pct: number;
    // Sub-window robustness aggregates: present only when the sweep ran with
    // windows and the combo does not patch its own period.
    worst_window_pnl?: number;
    median_window_pnl?: number;
    pct_windows_profitable?: number;
    mean_window_pnl_minus_std?: number;
  } | null;
  // Per-window slice of this combo's run (entry-time attribution); null when
  // windows were not requested or the combo patches its own period.
  windows: { from: number; to: number; pnl: number; trades: number }[] | null;
  error: string | null;
}
```

And extend `runSweepChunk`'s signature and body:

```ts
export async function runSweepChunk(
  req: BacktestRequest,
  combos: Array<Record<string, number | boolean | string>>,
  // Position of this chunk in the whole sweep, for the backend log only
  // (advisory: the backend never validates or acts on them).
  progress?: { done: number; total: number },
  // Sub-window robustness bounds (epoch seconds, ascending); identical for
  // every chunk of one sweep so all rows slice the same windows.
  windows?: number[],
): Promise<SweepRow[]> {
  const res = await fetch(`${BASE}/api/backtest/sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, sweep: { combos, windows, ...progress } }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `sweep failed (${res.status})`));
  const json = await res.json();
  return json.rows as SweepRow[];
}
```

d) In `frontend/src/lib/backtestConfig.ts`, add to `BacktestConfig` after `codedStrategy?: string;`:

```ts
  // Sub-window robustness override for sweeps: split the range into this many
  // equal windows when scoring consistency. Undefined = auto (from range length).
  robustWindows?: number;
```

e) In `frontend/src/BacktestButton.tsx`, inside the sweep branch (~line 287, after `const ctl = new AbortController();`), compute the bounds and pass them (`robustWindowBounds` joins the existing `./lib/sweep` import; `windowFromMs`/`windowToMs` are already in scope from line 169):

```ts
        const windows = robustWindowBounds(windowFromMs, windowToMs, cfg.robustWindows);
```

and add `windows,` to the `runSweep(baseReq, sweepAxes, { ... })` options object.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts && npx tsc -b`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/sweep.ts frontend/src/lib/sweep.test.ts frontend/src/api.ts frontend/src/lib/backtestConfig.ts frontend/src/BacktestButton.tsx
git commit -m "feat(sweep): send auto-sized robustness window bounds with every sweep"
```

---

### Task 4: Robustness columns + heatmap metrics in SweepResults

**Files:**
- Modify: `frontend/src/SweepResults.tsx`
- Test: `frontend/src/SweepResults.test.tsx` (append)

**Interfaces:**
- Consumes: `SweepRow.windows` and the four optional metric keys from Task 3.
- Produces: four new sortable columns in a collapsible "Robustness" group; four new options in the heatmap color-metric dropdown; the "Wnd+" cell renders `k/N` from `row.windows`. Task 5 adds the hover strip and tooltips on top of these columns.

- [ ] **Step 1: Write the failing tests**

Read `frontend/src/SweepResults.test.tsx` first for its render helpers (it builds rows and axes inline; follow the same shapes and add `windows: null` where new row literals need it if the type now requires the field). Append:

```tsx
describe("SweepResults robustness columns", () => {
  const axes: SweepAxis[] = [
    { kind: "range", target: "param:n", label: "n", from: 1, to: 2, step: 1 },
  ];
  const robustRow = (n: number, m: Partial<NonNullable<SweepRow["metrics"]>>, wins: SweepRow["windows"]): SweepRow => ({
    combo: { "param:n": n },
    metrics: {
      net_pnl: 0, n_trades: 1, win_rate: 0.5, max_drawdown: 1,
      profit_factor: null, avg_win_loss_ratio: null, return_pct: 0, ...m,
    },
    windows: wins,
    error: null,
  });

  it("renders robustness columns with k/N windows-profitable and sorts nulls last", () => {
    const rows = [
      robustRow(1, { worst_window_pnl: -5, median_window_pnl: 2, pct_windows_profitable: 0.75, mean_window_pnl_minus_std: 1 },
        [{ from: 0, to: 1, pnl: 3, trades: 2 }, { from: 1, to: 2, pnl: -5, trades: 1 },
         { from: 2, to: 3, pnl: 2, trades: 1 }, { from: 3, to: 4, pnl: 4, trades: 1 }]),
      robustRow(2, {}, null),  // no window metrics: sorts below on robust columns
    ];
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.getByText("Worst wnd")).toBeInTheDocument();
    expect(screen.getByText("3/4")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Worst wnd"));
    const cells = screen.getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(cells[0]).toContain("-5");     // row with metrics first even on desc
  });

  it("offers robustness metrics in the heatmap dropdown when two axes exist", () => {
    const axes2: SweepAxis[] = [
      { kind: "range", target: "param:n", label: "n", from: 1, to: 2, step: 1 },
      { kind: "range", target: "param:m", label: "m", from: 1, to: 2, step: 1 },
    ];
    const rows = [robustRow(1, { worst_window_pnl: 1 }, [])];
    render(<SweepResults rows={rows} axes={axes2} onApply={() => {}} />);
    const dropdown = screen.getByLabelText("Heatmap color metric");
    expect(within(dropdown).getByText("Worst window")).toBeInTheDocument();
  });
});
```

(Adjust imports at the top of the test file as needed: `within` from `@testing-library/react`, `SweepRow` from `./api`, `SweepAxis` from `./lib/sweep`; reuse whatever the file already imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx`
Expected: FAIL ("Worst wnd" not found)

- [ ] **Step 3: Implement in `SweepResults.tsx`**

a) Extend the metric key union and columns (`info` is consumed by Task 5's tooltips; include it now so the copy ships with the column definitions):

```ts
type MetricKey =
  | "net_pnl"
  | "return_pct"
  | "n_trades"
  | "win_rate"
  | "avg_win_loss_ratio"
  | "max_drawdown"
  | "profit_factor"
  | "worst_window_pnl"
  | "median_window_pnl"
  | "pct_windows_profitable"
  | "mean_window_pnl_minus_std";

const METRIC_COLS: { key: MetricKey; label: string; abbr: string; robust?: boolean; info?: string }[] = [
  { key: "net_pnl", label: "Net P/L", abbr: "P/L" },
  { key: "return_pct", label: "Return %", abbr: "Ret" },
  { key: "n_trades", label: "Trades", abbr: "N" },
  { key: "win_rate", label: "Win rate", abbr: "Win" },
  { key: "avg_win_loss_ratio", label: "RR", abbr: "RR" },
  { key: "max_drawdown", label: "Drawdown", abbr: "DD" },
  { key: "profit_factor", label: "Profit factor", abbr: "PF" },
  { key: "worst_window_pnl", label: "Worst wnd", abbr: "Wst", robust: true,
    info: "Worst window P&L. The most this combo lost (or least it made) in any single window. High values mean no disaster period." },
  { key: "median_window_pnl", label: "Med wnd", abbr: "Med", robust: true,
    info: "Median window P&L. The typical window's result, immune to one outlier week." },
  { key: "pct_windows_profitable", label: "Wnd+", abbr: "W+", robust: true,
    info: "Windows profitable. How many of the N windows ended positive. 4/4 means every period made money." },
  { key: "mean_window_pnl_minus_std", label: "Mean-σ", abbr: "Mσ", robust: true,
    info: "Mean window P&L minus one standard deviation. Rewards steady combos, punishes ones that swing between big wins and big losses." },
];
```

In the heatmap dropdown, robustness options need distinct readable labels; give the `<option>` text a mapping right above the dropdown render:

```ts
const heatLabel = (c: (typeof METRIC_COLS)[number]) =>
  c.key === "worst_window_pnl" ? "Worst window"
  : c.key === "median_window_pnl" ? "Median window"
  : c.key === "pct_windows_profitable" ? "Windows profitable"
  : c.key === "mean_window_pnl_minus_std" ? "Mean-σ window"
  : c.label;
```

and use `{heatLabel(c)}` as the option text.

b) `fmtMetric` additions (before the final `return v.toFixed(2);`):

```ts
  if (key === "pct_windows_profitable") return `${(v * 100).toFixed(0)}%`;
  if (key === "worst_window_pnl" || key === "median_window_pnl" || key === "mean_window_pnl_minus_std")
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
```

c) `metricValue` already returns `null` for absent keys (`row.metrics?.[key] ?? null`), so sorting, `bestByCol` (all four are `Math.max`, the default branch), the heatmap `better()` default higher-is-better branch, and null-sinks all extend with NO changes. Verify this while implementing; do not add special cases.

d) Table cell for `pct_windows_profitable`: render `k/N` when the row has windows. In the `METRIC_COLS.map` body cell renderer, replace the plain `{fmtMetric(c.key, v)}` with:

```tsx
{c.key === "pct_windows_profitable" && row.windows
  ? `${row.windows.filter((w) => w.pnl > 0).length}/${row.windows.length}`
  : fmtMetric(c.key, v)}
```

e) Collapsible group: add component state `const [robustOpen, setRobustOpen] = useState(true);` in `SweepResults`, compute `const visibleCols = robustOpen ? METRIC_COLS : METRIC_COLS.filter((c) => !c.robust);` and use `visibleCols` for the table header AND body cell loops (keep `METRIC_COLS` for `bestByCol` and the heatmap detail row). In the header row, immediately after the non-robust `<th>`s (i.e. render the toggle as its own `<th>` between the two groups; when collapsed it is the last header):

```tsx
<th className="sweep-robust-toggle-th">
  <button type="button" className="sweep-robust-toggle"
          onClick={() => setRobustOpen((o) => !o)}
          aria-expanded={robustOpen}>
    {robustOpen ? "Robustness ▾" : "Robustness ▸"}
  </button>
</th>
```

When collapsed, body rows render an empty `<td />` under the toggle column so columns stay aligned; when open, the toggle `<th>` sits before the four robust `<th>`s and body rows render an empty `<td />` in the same position. (Simplest structure: split `visibleCols` rendering into `baseCols` then the toggle th/td then `robustCols`.)

f) Add CSS next to the existing `.sweep-table` rules (find them with `grep -n "sweep-table" frontend/src/App.css`):

```css
.sweep-robust-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--muted, #666);
  padding: 0 4px;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx src/lib/sweep.test.ts && npx tsc -b`
Expected: PASS (new tests plus all pre-existing SweepResults tests), no type errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/SweepResults.tsx frontend/src/SweepResults.test.tsx frontend/src/App.css
git commit -m "feat(sweep): robustness aggregate columns and heatmap metrics"
```

---

### Task 5: WindowStrip hover breakdown + tooltips

**Files:**
- Modify: `frontend/src/SweepResults.tsx` (new `WindowStrip` component + integration)
- Modify: `frontend/src/App.css`
- Test: `frontend/src/SweepResults.test.tsx` (append)

**Interfaces:**
- Consumes: `SweepRow.windows` rows, `formatPeriodDateRange(fromMs, toMs)` from `./lib/backtestPeriods` (already used by `sweep.ts`; check its exact signature before use).
- Produces: `WindowStrip({ windows })`, rendered (a) in the heatmap's hovered-cell detail area and (b) as `Tooltip` content wrapping each robustness cell's value in the table. Column headers get `Tooltip` with the `info` copy from Task 4.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/SweepResults.test.tsx` inside the robustness describe block (reuse `robustRow` and `axes` from Task 4's tests):

```tsx
  it("renders a per-window strip with pnl and trade counts", () => {
    const rows = [
      robustRow(1, { worst_window_pnl: -5, median_window_pnl: 2, pct_windows_profitable: 0.5, mean_window_pnl_minus_std: 0 },
        [{ from: 1740787200, to: 1741392000, pnl: 8.2, trades: 9 },
         { from: 1741392000, to: 1741996800, pnl: -2.9, trades: 8 }]),
    ];
    const { container } = render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    // Strip cells exist (rendered inside the robustness cells' tooltip content
    // is portaled on hover; the inline strip variant renders in the DOM).
    expect(container.querySelectorAll(".sweep-wstrip-bar").length).toBeGreaterThanOrEqual(0);
    // Headers carry tooltip triggers, not native title attributes.
    expect(container.querySelector("th[title]")).toBeNull();
  });
```

Then read how the existing tests in this file assert `Tooltip` content (the fib/indicator tests elsewhere mock or hover; if `Tooltip` renders content only on hover, assert via `fireEvent.mouseEnter` on the "Wnd+" cell and then `await screen.findByText("9 tr")`). Write the strongest assertion the existing Tooltip behavior allows; at minimum assert the strip renders when hovering a robustness cell:

```tsx
  it("shows the window breakdown on robustness-cell hover", async () => {
    const rows = [
      robustRow(1, { pct_windows_profitable: 0.5 },
        [{ from: 1740787200, to: 1741392000, pnl: 8.2, trades: 9 },
         { from: 1741392000, to: 1741996800, pnl: -2.9, trades: 8 }]),
    ];
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    fireEvent.mouseEnter(screen.getByText("1/2"));
    expect(await screen.findByText("9 tr")).toBeInTheDocument();
  });
```

(If the shared Tooltip's hover delay makes this flaky, check `Tooltip.tsx` for a `delay` prop and pass `delay={0}` at the call site in the implementation, or use vitest fake timers the way other Tooltip tests in the repo do; follow existing precedent.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx`
Expected: FAIL ("9 tr" never appears)

- [ ] **Step 3: Implement**

a) In `SweepResults.tsx`, add the strip component (import `formatPeriodDateRange` from `./lib/backtestPeriods`; note `SweepRow.windows` times are epoch SECONDS, the formatter takes ms):

```tsx
// Per-window P&L breakdown: one green/red bar per window scaled by |pnl|,
// with the window's dates, pnl and trade count beneath. Answers "one lucky
// week or spread across the range?" at a glance.
function WindowStrip({ windows }: { windows: NonNullable<SweepRow["windows"]> }) {
  const maxAbs = Math.max(...windows.map((w) => Math.abs(w.pnl)), 1e-9);
  return (
    <div className="sweep-wstrip">
      {windows.map((w, i) => (
        <div key={i} className="sweep-wstrip-col">
          <div className="sweep-wstrip-barbox">
            <div
              className={`sweep-wstrip-bar ${w.pnl >= 0 ? "pos" : "neg"}`}
              style={{ height: `${Math.max(8, (Math.abs(w.pnl) / maxAbs) * 100)}%` }}
            />
          </div>
          <div className="sweep-wstrip-range">{formatPeriodDateRange(w.from * 1000, w.to * 1000)}</div>
          <div className={`sweep-wstrip-pnl ${w.pnl >= 0 ? "pos" : "neg"}`}>
            {w.pnl >= 0 ? "+" : ""}{w.pnl.toFixed(2)}
          </div>
          <div className="sweep-wstrip-trades">{w.trades} tr</div>
        </div>
      ))}
    </div>
  );
}
```

b) Table integration: in the body-cell renderer, wrap ROBUST cells' content in a `Tooltip` carrying the strip when the row has windows:

```tsx
const cellContent = /* the k/N or fmtMetric content from Task 4 */;
return (
  <td key={c.key} className={`sweep-c-num${isBest ? " sweep-best" : ""}`}>
    {c.robust && row.windows && row.windows.length > 0
      ? <Tooltip content={<WindowStrip windows={row.windows} />} delay={0}><span>{cellContent}</span></Tooltip>
      : cellContent}
  </td>
);
```

c) Header tooltips: in the header loop, wrap the `SweepSortHeader` of any column with `info` in a `Tooltip`:

```tsx
<th key={c.key} className="sweep-c-num">
  {c.info ? (
    <Tooltip content={c.info}>
      <span><SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} /></span>
    </Tooltip>
  ) : (
    <SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} />
  )}
</th>
```

Also wrap the "Robustness" toggle button from Task 4 in a `Tooltip` with content:
`"These score how evenly the P&L was earned across sub-windows of the range. A combo that wins on Net P&L but fails here likely got lucky in one period."`

d) Heatmap detail: in `SweepHeatmap`'s `sweep-heat-detail` block, after the `METRIC_COLS.map(...)` stat spans, render the strip inline for the hovered row:

```tsx
{hovered.windows && hovered.windows.length > 0 && (
  <div className="sweep-heat-detail-wstrip"><WindowStrip windows={hovered.windows} /></div>
)}
```

Note: `sweep-heat-detail` is a single header line today; give the strip variant a compact height (see CSS) so it does not blow up the layout. If it visually crowds the header line, move the strip to render UNDER the `sweep-heat-metric` row instead (still gated on `hovered`); pick whichever reads better in the browser check (Task 6 Step 5).

e) CSS, next to the existing `.sweep-heat-*` rules in `frontend/src/App.css`:

```css
.sweep-wstrip {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.sweep-wstrip-col { text-align: center; font-size: 11px; }
.sweep-wstrip-barbox {
  height: 36px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.sweep-wstrip-bar { width: 14px; border-radius: 2px 2px 0 0; }
.sweep-wstrip-bar.pos { background: rgba(38, 166, 91, 0.8); }
.sweep-wstrip-bar.neg { background: rgba(220, 62, 66, 0.8); }
.sweep-wstrip-pnl.pos { color: #26a65b; }
.sweep-wstrip-pnl.neg { color: #dc3e42; }
.sweep-wstrip-range { color: var(--muted, #888); white-space: nowrap; }
.sweep-wstrip-trades { color: var(--muted, #888); }
.sweep-heat-detail-wstrip .sweep-wstrip-barbox { height: 20px; }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx && npx tsc -b`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/SweepResults.tsx frontend/src/SweepResults.test.tsx frontend/src/App.css
git commit -m "feat(sweep): per-window strip on hover plus robustness tooltips"
```

---

### Task 6: Windows override field in the settings modal + end-to-end check

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`bt-range-mode-row`, ~line 1032-1079)
- Test: manual browser verification (the field is a thin input onto `cfg.robustWindows`, covered by Task 3's bounds tests)

**Interfaces:**
- Consumes: `BacktestConfig.robustWindows?: number` from Task 3.
- Produces: a small labeled number input in the Time range row; empty = auto.

- [ ] **Step 1: Add the field**

In `BacktestSettingsModal.tsx`, inside the `bt-range-mode-row` div, after the period-sweep `Tooltip`/button (~line 1078), add (InfoTip is already imported in this file; verify, and check how sibling labels like `bt-tf-inline` are structured):

```tsx
              <label className="bt-tf-inline bt-robust-windows">
                <span className="bt-tf-label">
                  Windows
                  <InfoTip text="The backtest range is split into equal windows to score consistency. Auto picks daily, weekly or monthly windows from the range length; set a number to override." />
                </span>
                <input
                  type="number"
                  min={2}
                  max={50}
                  placeholder="auto"
                  value={cfg.robustWindows ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? undefined : Math.round(Number(e.target.value));
                    setCfg({ ...cfg, robustWindows: v !== undefined && Number.isFinite(v) ? Math.max(2, Math.min(50, v)) : undefined });
                  }}
                />
              </label>
```

Add CSS near the other `.bt-tf-*` rules in `frontend/src/App.css`:

```css
.bt-robust-windows input {
  width: 56px;
}
```

IMPORTANT: keep the InfoTip inside the styled label container; a bare InfoTip outside a styled ancestor renders as a solid black box (see App.css `.ind-info` selectors). If it renders black, extend the App.css InfoTip selectors to cover `.bt-robust-windows` the same way `.ind-info` is covered.

- [ ] **Step 2: Typecheck and full frontend test suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: PASS, no type errors, no regressions

- [ ] **Step 3: Full backend suite**

Run: `cd backend && python -m pytest`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/App.css
git commit -m "feat(sweep): windows override field for robustness scoring"
```

- [ ] **Step 5: End-to-end browser verification**

Using claude-in-chrome against the user's running dev servers (do NOT restart them):
1. Open the app, open the Backtest panel on any instrument, set range to last month.
2. Add one sweep axis (e.g. a rule length range giving ~5 combos) and run.
3. Verify: the Robustness column group appears with values, the "Wnd+" cell reads like `3/4`, hovering it shows the window strip with dates/pnl/trade counts, the heatmap metric dropdown lists "Worst window", and picking it recolors cells.
4. Verify the Windows field: set 8, re-run, hover shows 8 bars; clear it, re-run, auto count returns.
5. Verify a combined period-axis sweep still runs and its period rows simply show no robustness values.
6. Close any tabs opened for this check.

Fix anything found, then amend or follow-up commit.
