# Backtest Long/Short Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show long and short results side by side, inline, in every statistical surface of the backtest dock (Analysis tab, What-if, headline leg table), with no toggle or tab.

**Architecture:** One backend grouping pattern: refactor `compute_analysis` to run over a trade subset and emit an all-trades payload plus a `by_leg: {long, short}` sibling of full payloads (whatif rides inside each). The frontend zips all/long/short at render time: bucketed tables split each bucket into color-coded Long/Short sub-rows, distributions split their counts, the one duration chart groups its bars by leg, and What-if renders per leg. The Overview leg table already exists; extend it with two metrics and make it survive reload.

**Tech Stack:** Python 3.11 + FastAPI + pytest (backend); React + TypeScript + Vitest + Testing Library (frontend).

## Global Constraints

- **No em dashes anywhere** (UI copy, comments, tests, commit messages). Use colon/comma/period. HARD RULE.
- **Long and short must be visible together in one view.** No lens, no toggle, no tab, no separate stacked tables. User hard constraint.
- **Partition on `leg`** (`"long"`/`"short"`), never `side`. A missing/empty `leg` defaults to `"long"` (matches `models.py` `Signal.leg`).
- **Preserve the existing all-trades payload shape.** `by_leg` is an added optional sibling; every existing analysis/metrics test must keep passing unchanged.
- **`return_pct` and `max_drawdown_pct` are account-level**: never split per leg. They stay ALL-only in the flat stat grid.
- Reuse the app's existing long/short color convention (the trades-table "Side" column / position lines). Do not introduce a new palette.
- Reuse the shared `Tooltip`/`InfoTip` components for any hover help (never native `title=`).

---

### Task 1: Add `expectancy` and `max_consec_wins` to `leg_metrics`

`leg_metrics` feeds the Overview `by_leg` leg table. The flat Overview grid shows Expectancy and Max consecutive wins but the leg table cannot, because they are not in `leg_metrics`. Add them so the leg table is the single per-side source.

**Files:**
- Modify: `backend/auto_trader/engine/metrics.py:28-65` (`leg_metrics`)
- Test: `backend/tests/test_metrics.py`

**Interfaces:**
- Produces: `leg_metrics(...)` dict now also has keys `expectancy: float` and `max_consec_wins: int`. `compute_metrics` is unchanged (it already exposes both under its own keys).

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_metrics.py`:

```python
def test_leg_metrics_has_expectancy_and_consec_wins():
    from auto_trader.engine.metrics import leg_metrics

    class T:
        def __init__(self, pnl, e, x):
            self.pnl, self.entry_time, self.exit_time = pnl, e, x

    from datetime import datetime, timedelta
    base = datetime(2024, 1, 1)
    trades = [
        T(10.0, base, base + timedelta(minutes=1)),
        T(20.0, base, base + timedelta(minutes=1)),
        T(-5.0, base, base + timedelta(minutes=1)),
    ]
    m = leg_metrics(trades, res_seconds=60, round_trip_cost=0.0)
    assert m["expectancy"] == (10.0 + 20.0 - 5.0) / 3
    assert m["max_consec_wins"] == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_metrics.py::test_leg_metrics_has_expectancy_and_consec_wins -v`
Expected: FAIL with `KeyError: 'expectancy'`.

- [ ] **Step 3: Add the two keys**

In `metrics.py`, inside `leg_metrics`, the return dict already computes `pnls`. Add these two entries to the returned dict (place `expectancy` after `net_pnl`, `max_consec_wins` next to `max_consec_losses`):

```python
        "net_pnl": sum(pnls),
        "expectancy": sum(pnls) / n if n else 0.0,
```

```python
        "max_consec_losses": _max_consec(pnls, positive=False),
        "max_consec_wins": _max_consec(pnls, positive=True),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_metrics.py -v`
Expected: PASS (new test + existing).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/metrics.py backend/tests/test_metrics.py
git commit -m "feat(metrics): expectancy and max_consec_wins in leg_metrics"
```

---

### Task 2: `compute_analysis` emits `by_leg` (long/short full payloads)

The Analysis tab and What-if both live inside the `analysis` payload (whatif is embedded at `analysis.whatif`). Splitting here delivers both, and because `get_run` recomputes `compute_analysis` from stored trades, the split survives reload for free.

**Files:**
- Modify: `backend/auto_trader/engine/analysis.py:196-256` (`compute_analysis`)
- Test: `backend/tests/test_analysis.py`

**Interfaces:**
- Consumes: each trade dict carries `leg` (`TradeDTO.leg`).
- Produces: `compute_analysis(trades)` returns the existing payload plus `by_leg: {"long": <payload>, "short": <payload>}`. The nested payloads have the identical shape as the top level but do NOT themselves carry `by_leg`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_analysis.py`:

```python
def test_compute_analysis_splits_by_leg():
    from auto_trader.engine.analysis import compute_analysis

    def trade(pnl, leg, reason):
        return {
            "pnl": pnl, "leg": leg, "reason": reason,
            "entry_price": 100.0, "exit_price": 100.0 + pnl,
            "stop_initial": 99.0, "target": None,
            "mae_r": None, "mfe_r": None, "mae": None, "mfe": None,
            "context": {}, "entry_time": None, "exit_time": None,
            "bars_held": None,
        }

    trades = [
        trade(5.0, "long", "target"),
        trade(-3.0, "long", "stop"),
        trade(7.0, "short", "target"),
    ]
    a = compute_analysis(trades)
    # Top-level unchanged: all trades.
    assert a["n_trades"] == 3
    # Split present and partitions correctly.
    assert a["by_leg"]["long"]["n_trades"] == 2
    assert a["by_leg"]["short"]["n_trades"] == 1
    # Nested payloads do not recurse.
    assert "by_leg" not in a["by_leg"]["long"]


def test_compute_analysis_missing_leg_defaults_long():
    from auto_trader.engine.analysis import compute_analysis
    t = {
        "pnl": 1.0, "reason": "target",
        "entry_price": 100.0, "exit_price": 101.0, "stop_initial": 99.0,
        "target": None, "mae_r": None, "mfe_r": None, "mae": None, "mfe": None,
        "context": {}, "entry_time": None, "exit_time": None, "bars_held": None,
    }  # no "leg" key
    a = compute_analysis([t])
    assert a["by_leg"]["long"]["n_trades"] == 1
    assert a["by_leg"]["short"]["n_trades"] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_analysis.py::test_compute_analysis_splits_by_leg tests/test_analysis.py::test_compute_analysis_missing_leg_defaults_long -v`
Expected: FAIL with `KeyError: 'by_leg'`.

- [ ] **Step 3: Refactor the body into `_analysis_for` and add `by_leg`**

In `analysis.py`, rename the current `def compute_analysis(trades: list[dict]) -> dict:` body to a private helper, then add the public wrapper. Concretely:

1. Rename line 196 `def compute_analysis(trades: list[dict]) -> dict:` to `def _analysis_for(trades: list[dict]) -> dict:` (leave the entire body 197-256 intact).

2. Append the new public function and a partition helper at the end of the file:

```python
def _partition_by_leg(trades: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split trades on `leg`; a missing or empty leg counts as long, matching
    the engine default (Signal.leg)."""
    longs = [t for t in trades if (t.get("leg") or "long") == "long"]
    shorts = [t for t in trades if (t.get("leg") or "long") == "short"]
    return longs, shorts


def compute_analysis(trades: list[dict]) -> dict:
    """All-trades analysis payload plus a per-direction split. `by_leg.long` and
    `by_leg.short` are full analysis payloads (whatif included) over that side's
    trades only; they do not nest a further by_leg. Sequence-derived numbers
    (streaks, consecutive counts) are per-leg subsequences by construction."""
    longs, shorts = _partition_by_leg(trades)
    payload = _analysis_for(trades)
    payload["by_leg"] = {"long": _analysis_for(longs), "short": _analysis_for(shorts)}
    return payload
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_analysis.py tests/test_api_backtest_analysis.py -v`
Expected: PASS (new tests + all existing analysis tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/analysis.py backend/tests/test_analysis.py
git commit -m "feat(analysis): per-leg by_leg split in compute_analysis"
```

---

### Task 3: Recompute the Overview leg table on reload (fix the wart)

The response `by_leg` (Overview leg table) is built only on a fresh run from `result.trades`; `get_run` never recomputes it, so a reloaded run shows a zeroed leg table. Recompute it from the stored trade dicts.

**Files:**
- Modify: `backend/auto_trader/engine/metrics.py` (add dict-based `leg_metrics_from_dicts`)
- Modify: `backend/auto_trader/api/routers/backtest.py:443-450` (`get_run`)
- Test: `backend/tests/test_api_backtest_analysis.py`

**Interfaces:**
- Consumes: stored `rec["trades"]` (list of TradeDTO dicts, each with `leg`, `pnl`, `entry_time`/`exit_time` as epoch seconds or None), `rec["timeframe"]`, `rec["request"]["costs"]["commissionPerSide"]`.
- Produces: `leg_metrics_from_dicts(trade_dicts, res_seconds, round_trip_cost) -> dict` with the same keys as `leg_metrics`. `get_run` result gains `rec["by_leg"] = {"long": ..., "short": ...}`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_api_backtest_analysis.py` (import style matches the file's existing tests; adapt the client fixture name if the file uses one):

```python
def test_leg_metrics_from_dicts_matches_keys():
    from auto_trader.engine.metrics import leg_metrics, leg_metrics_from_dicts
    dicts = [
        {"pnl": 5.0, "leg": "long", "entry_time": 0, "exit_time": 60},
        {"pnl": -2.0, "leg": "long", "entry_time": 0, "exit_time": 120},
    ]
    d = leg_metrics_from_dicts(dicts, res_seconds=60, round_trip_cost=0.0)
    # Same key set as the object-based helper.
    class T:
        def __init__(s, pnl, e, x):
            s.pnl, s.entry_time, s.exit_time = pnl, e, x
    from datetime import datetime, timedelta
    b = datetime(2024, 1, 1)
    o = leg_metrics([T(5.0, b, b + timedelta(minutes=1)),
                     T(-2.0, b, b + timedelta(minutes=2))],
                    res_seconds=60, round_trip_cost=0.0)
    assert set(d.keys()) == set(o.keys())
    assert d["n_trades"] == 2 and d["net_pnl"] == 3.0
    assert d["avg_duration_bars"] == 1.5  # (60/60 + 120/60) / 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest_analysis.py::test_leg_metrics_from_dicts_matches_keys -v`
Expected: FAIL with `ImportError: cannot import name 'leg_metrics_from_dicts'`.

- [ ] **Step 3: Add `leg_metrics_from_dicts` sharing a math core**

In `metrics.py`, extract the pure math so the object and dict helpers cannot drift. Add near `leg_metrics`:

```python
def _leg_metrics_core(pnls: list[float], durations: list[float], round_trip_cost: float) -> dict:
    """Trade-list metrics from raw pnls and per-trade durations (in bars). Shared
    by leg_metrics (engine Trade objects) and leg_metrics_from_dicts (stored
    dicts) so ALL / LONG / SHORT never drift."""
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_loss = -sum(losses)
    profit_factor = (sum(wins) / gross_loss) if gross_loss > 0 else None
    avg_win = _mean(wins)
    avg_loss = _mean(losses)
    avg_win_loss_ratio = (avg_win / -avg_loss) if avg_loss < 0 else None
    n = len(pnls)
    n_wins = sum(1 for p in pnls if p > round_trip_cost)
    return {
        "n_trades": n,
        "win_rate": n_wins / n if n else 0.0,
        "net_pnl": sum(pnls),
        "expectancy": sum(pnls) / n if n else 0.0,
        "profit_factor": profit_factor,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_win_loss_ratio": avg_win_loss_ratio,
        "largest_win": max(wins) if wins else 0.0,
        "largest_loss": min(losses) if losses else 0.0,
        "max_consec_losses": _max_consec(pnls, positive=False),
        "max_consec_wins": _max_consec(pnls, positive=True),
        "avg_duration_bars": _mean(durations),
    }


def leg_metrics_from_dicts(trades: list[dict], res_seconds, round_trip_cost) -> dict:
    """leg_metrics over stored TradeDTO dicts. entry_time/exit_time are epoch
    seconds (or None); duration is their difference over the bar length."""
    pnls = [t["pnl"] for t in trades]
    durations = [
        (t["exit_time"] - t["entry_time"]) / res_seconds
        for t in trades
        if res_seconds and t.get("entry_time") is not None and t.get("exit_time") is not None
    ]
    return _leg_metrics_core(pnls, durations, round_trip_cost)
```

Then rewrite `leg_metrics`' return to delegate to the core (this replaces its current inline return dict; keep its docstring):

```python
def leg_metrics(trades, res_seconds, round_trip_cost) -> dict:
    """..."""  # keep existing docstring
    pnls = [t.pnl for t in trades]
    durations = [
        (t.exit_time - t.entry_time).total_seconds() / res_seconds for t in trades
    ] if res_seconds else []
    return _leg_metrics_core(pnls, durations, round_trip_cost)
```

- [ ] **Step 4: Wire `get_run` to recompute `by_leg`**

In `backtest.py`, add the import near the top with the other engine imports:

```python
from auto_trader.engine.metrics import leg_metrics_from_dicts
```

(If `resolution_seconds` is not already imported in this module, it is: it is used in the fresh-run handler. Reuse it.)

Replace the body of `get_run` (lines 446-450) with:

```python
    rec = await RUN_STORE.get(run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="run not found")
    rec["analysis"] = compute_analysis(rec["trades"])
    res_seconds = resolution_seconds(rec["timeframe"])
    commission = (rec.get("request") or {}).get("costs", {}).get("commissionPerSide", 0.0)
    rec["by_leg"] = {
        leg: leg_metrics_from_dicts(
            [t for t in rec["trades"] if (t.get("leg") or "long") == leg],
            res_seconds, 2 * commission,
        )
        for leg in ("long", "short")
    }
    return rec
```

- [ ] **Step 5: Write the reload regression test**

Add to `backend/tests/test_api_backtest_analysis.py` a test that runs a backtest through the API (follow the existing test in this file that posts to `/api/backtest` and reads `run_id`), then GETs `/api/backtest/runs/{run_id}` and asserts:

```python
    body = get_resp.json()
    assert "by_leg" in body
    assert set(body["by_leg"]) == {"long", "short"}
    assert "by_leg" in body["analysis"]
    # Long + short trade counts reconcile to the all-trades analysis.
    total = body["analysis"]["n_trades"]
    assert (body["analysis"]["by_leg"]["long"]["n_trades"]
            + body["analysis"]["by_leg"]["short"]["n_trades"]) == total
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_metrics.py tests/test_api_backtest_analysis.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/engine/metrics.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_analysis.py
git commit -m "fix(backtest): recompute leg table on run reload; shared leg-metrics core"
```

---

### Task 4: Frontend types + extend the Overview leg table columns

Type the new `by_leg` payload and add the two new metrics to the leg table so the Overview per-side table is complete.

**Files:**
- Modify: `frontend/src/api.ts:108-232` (`LegMetrics`, `BacktestAnalysis`)
- Modify: `frontend/src/lib/backtestPanelData.ts` (`ZERO_LEG`, `allLeg`, `LEG_COLUMNS`)
- Test: `frontend/src/lib/backtestPanelData.test.ts` (create if absent)

**Interfaces:**
- Produces: `LegAnalysis` type (BacktestAnalysis without `by_leg`); `BacktestAnalysis.by_leg?: { long: LegAnalysis; short: LegAnalysis }`; `LegMetrics` gains `expectancy: number` and `max_consec_wins: number`; `LEG_COLUMNS` gains an Expectancy and a Max-consec-wins column.

- [ ] **Step 1: Extend `LegMetrics` and split `BacktestAnalysis`**

In `api.ts`, add to `LegMetrics` (after `net_pnl`, and near `max_consec_losses`):

```typescript
  expectancy: number;
  max_consec_wins: number;
```

Refactor `BacktestAnalysis`: rename the current `export interface BacktestAnalysis {...}` to `export interface LegAnalysis {...}` (keep every field EXCEPT add nothing), then add:

```typescript
export interface BacktestAnalysis extends LegAnalysis {
  by_leg?: { long: LegAnalysis; short: LegAnalysis };
}
```

Move the `whatif?` field so it stays on `LegAnalysis` (per-leg whatif rides inside each leg payload).

- [ ] **Step 2: Write the failing test for the leg table**

Create `frontend/src/lib/backtestPanelData.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { legTable } from "./backtestPanelData";
import type { BacktestResult } from "../api";

function fakeResult(): BacktestResult {
  return {
    epic: "X", resolution: "1m", candles: [], markers: [], trades: [], equity: [],
    summary: { net_pnl: 10, n_trades: 3, win_rate: 0.66, max_drawdown: 0 },
    metrics: {
      return_pct: 1, profit_factor: 2, expectancy: 3.33, avg_win: 6, avg_loss: -2,
      avg_win_loss_ratio: 3, largest_win: 7, largest_loss: -3, max_drawdown_pct: 0,
      avg_duration_bars: 1, max_consec_wins: 2, max_consec_losses: 1,
    },
    by_leg: {
      long: { n_trades: 2, win_rate: 0.5, net_pnl: 3, expectancy: 1.5, profit_factor: 1,
        avg_win: 5, avg_loss: -2, avg_win_loss_ratio: 2.5, largest_win: 5, largest_loss: -2,
        max_consec_losses: 1, max_consec_wins: 1, avg_duration_bars: 1 },
      short: { n_trades: 1, win_rate: 1, net_pnl: 7, expectancy: 7, profit_factor: null,
        avg_win: 7, avg_loss: 0, avg_win_loss_ratio: null, largest_win: 7, largest_loss: 0,
        max_consec_losses: 0, max_consec_wins: 1, avg_duration_bars: 1 },
    },
  } as unknown as BacktestResult;
}

describe("legTable", () => {
  it("includes Expectancy and Max consec wins columns", () => {
    const t = legTable(fakeResult());
    const labels = t.columns.map((c) => c.label);
    expect(labels).toContain("Expectancy");
    expect(labels).toContain("Win streak");
    expect(t.rows.map((r) => r.leg)).toEqual(["ALL", "LONG", "SHORT"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestPanelData.test.ts`
Expected: FAIL (columns missing).

- [ ] **Step 4: Update `ZERO_LEG`, `allLeg`, and `LEG_COLUMNS`**

In `backtestPanelData.ts`:

Add the two keys to `ZERO_LEG`:

```typescript
const ZERO_LEG: LegMetrics = {
  n_trades: 0, win_rate: 0, net_pnl: 0, expectancy: 0, profit_factor: null,
  avg_win: 0, avg_loss: 0, avg_win_loss_ratio: null,
  largest_win: 0, largest_loss: 0, max_consec_losses: 0, max_consec_wins: 0,
  avg_duration_bars: 0,
};
```

Add them to `allLeg`'s returned object:

```typescript
    net_pnl: res.summary.net_pnl,
    expectancy: res.metrics.expectancy,
```
```typescript
    max_consec_losses: res.metrics.max_consec_losses,
    max_consec_wins: res.metrics.max_consec_wins,
```

Add two columns to `LEG_COLUMNS` (Expectancy after Net P&L, Win streak next to Loss streak):

```typescript
  { label: "Expectancy", info: "Average profit per trade, winners and losers together.",
    cell: (m) => ({ value: m.expectancy.toFixed(2), tone: getTone(m.expectancy) }) },
```
```typescript
  { label: "Win streak", info: "Longest run of consecutive winning trades. LONG and SHORT count only their own side, so one side's streak can exceed ALL.",
    cell: (m) => ({ value: String(m.max_consec_wins), tone: "" }) },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestPanelData.test.ts && npx tsc --noEmit`
Expected: PASS and no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/backtestPanelData.ts frontend/src/lib/backtestPanelData.test.ts
git commit -m "feat(backtest): type by_leg analysis; expectancy + win-streak leg columns"
```

---

### Task 5: Long/Short sub-rows in the bucketed tables (`RowsTable`)

Exit reasons and all seven context/time tables render through `RowsTable`. Split each bucket into an ALL header row plus color-coded Long and Short sub-rows, zipped from `analysis.by_leg`.

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx:381-413` (`RowsTable`) and its call sites
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `analysis.by_leg?.long` / `.short` (each a `LegAnalysis`); the same bucket key exists across all/long/short row arrays.
- Produces: `RowsTable` accepts `rows`, `longRows`, `shortRows` (the last two optional). Absent -> renders exactly as today.

- [ ] **Step 1: Write the failing test**

Add to `BacktestAnalysisPanel.test.tsx` (match the file's existing render/import setup):

```typescript
it("renders long and short sub-rows for exit reasons", () => {
  const analysis = makeAnalysis({
    exit_reasons: [{ bucket: "target", n: 3, win_rate: 1, expectancy: 5, net_pnl: 15, low_sample: false }],
    by_leg: {
      long: { exit_reasons: [{ bucket: "target", n: 2, win_rate: 1, expectancy: 4, net_pnl: 8, low_sample: false }] },
      short: { exit_reasons: [{ bucket: "target", n: 1, win_rate: 1, expectancy: 7, net_pnl: 7, low_sample: false }] },
    },
  });
  render(<BacktestAnalysisPanel analysis={analysis} />);
  fireEvent.click(screen.getByText("Breakdowns"));
  expect(screen.getByText("Long")).toBeInTheDocument();
  expect(screen.getByText("Short")).toBeInTheDocument();
});
```

`makeAnalysis` is the existing test helper in this file; extend it to accept a partial `by_leg`. If no such helper exists, build a minimal `BacktestAnalysis` inline with the required fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "sub-rows for exit reasons"`
Expected: FAIL (no "Long"/"Short" text).

- [ ] **Step 3: Add a bucket-lookup helper and rewrite `RowsTable`**

Add near the top of `BacktestAnalysisPanel.tsx` (after the imports/format helpers):

```tsx
// Find the row for a bucket in a per-leg row list, or zeros if that leg never
// traded this bucket. Keeps sub-rows aligned to the ALL row's bucket order.
function legRow(rows: AnalysisRow[] | undefined, bucket: string): AnalysisRow {
  return (
    rows?.find((r) => r.bucket === bucket) ?? {
      bucket, n: 0, win_rate: 0, expectancy: 0, net_pnl: 0, low_sample: false,
    }
  );
}
```

Replace `RowsTable` with a version that renders sub-rows when leg data is present:

```tsx
function LegSubRow({ label, r }: { label: "Long" | "Short"; r: AnalysisRow }) {
  return (
    <tr className={`bt-analysis-subrow bt-leg-${label.toLowerCase()}`}>
      <td className="bt-analysis-subrow-label">{label}</td>
      <td>{r.n}</td>
      <td>{fmtPct(r.win_rate)}</td>
      <td>{r.expectancy.toFixed(2)}</td>
      <td>{r.net_pnl.toFixed(2)}</td>
    </tr>
  );
}

function RowsTable({
  rows,
  longRows,
  shortRows,
}: {
  rows: AnalysisRow[];
  longRows?: AnalysisRow[];
  shortRows?: AnalysisRow[];
}) {
  if (!rows.length) return <div className="bt-analysis-empty">No data.</div>;
  const split = longRows != null && shortRows != null;
  return (
    <table className="bt-analysis-table">
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Trades</th>
          <th>Win rate</th>
          <th>Expectancy</th>
          <th>Net P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Fragment key={r.bucket}>
            <tr
              className={
                (r.low_sample ? "bt-analysis-low " : "") +
                (r.net_pnl < 0 ? "bt-analysis-under" : "")
              }
            >
              <td>{r.bucket}</td>
              <td>{r.n}</td>
              <td>{fmtPct(r.win_rate)}</td>
              <td>{r.expectancy.toFixed(2)}</td>
              <td>{r.net_pnl.toFixed(2)}</td>
            </tr>
            {split && <LegSubRow label="Long" r={legRow(longRows, r.bucket)} />}
            {split && <LegSubRow label="Short" r={legRow(shortRows, r.bucket)} />}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
```

Add `Fragment` to the React import at line 1: `import { Fragment, useState, type ReactNode } from "react";`

- [ ] **Step 4: Thread leg rows into every `RowsTable` call site**

Exit reasons (line ~784):

```tsx
        {!collapsed.has("exit-reasons") && (
          <RowsTable
            rows={analysis.exit_reasons}
            longRows={analysis.by_leg?.long.exit_reasons}
            shortRows={analysis.by_leg?.short.exit_reasons}
          />
        )}
```

The mapped context/time tables (line ~798-818): compute the leg rows with the same key logic used for `rows`, then pass them. Replace the `rows` computation and the `<RowsTable rows={rows} />` with:

```tsx
        const pickRows = (a: LegAnalysis | undefined): AnalysisRow[] => {
          if (!a) return [];
          return key === "month"
            ? a.month_stats ?? []
            : key === "day_of_week"
              ? dayOfWeekRows(a.context[key] ?? [])
              : key === "hour_bucket"
                ? hourBucketRows(a.hour_stats ?? [])
                : a.context[key] ?? [];
        };
        const rows = pickRows(analysis);
        if (key === "month" && rows.length < 2) return null;
        return (
          <section key={key} className="bt-analysis-section">
            <SectionH4 slug={slug} open={!collapsed.has(slug)} onToggle={toggleSection}>
              {label}
            </SectionH4>
            {!collapsed.has(slug) && (
              <RowsTable
                rows={rows}
                longRows={analysis.by_leg && pickRows(analysis.by_leg.long)}
                shortRows={analysis.by_leg && pickRows(analysis.by_leg.short)}
              />
            )}
          </section>
        );
```

Import `LegAnalysis` and `AnalysisRow` types at the top: add `LegAnalysis` to the existing `import type { ... } from "./api"` block.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): long/short sub-rows in bucketed breakdown tables"
```

---

### Task 6: Split distribution counts by leg (`Dist`)

The MAE/MFE/R distribution lists render one `<li>` per non-empty bucket. Show the long and short share inline on each line.

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx:140-211` (`Dist`) and its three call sites
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: the matching histogram from `analysis.by_leg?.long`/`.short` (`sl.winners_mae_hist`, `sl.losers_mae_hist`, or `r_hist`). Histograms share identical `edges`, so bucket index `i` aligns across all/long/short.
- Produces: `Dist` accepts optional `longHist` and `shortHist`; when present each list item appends " (N long, M short)".

- [ ] **Step 1: Write the failing test**

```typescript
it("shows long/short split on R distribution lines", () => {
  const analysis = makeAnalysis({
    r_hist: { edges: [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5], counts: [0, 0, 1, 0, 2, 0, 0] },
    by_leg: {
      long: { r_hist: { edges: [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5], counts: [0, 0, 1, 0, 1, 0, 0] } },
      short: { r_hist: { edges: [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5], counts: [0, 0, 0, 0, 1, 0, 0] } },
    },
  });
  render(<BacktestAnalysisPanel analysis={analysis} />);
  expect(screen.getByText(/1 long, 1 short/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "long/short split on R distribution"`
Expected: FAIL.

- [ ] **Step 3: Extend `Dist` to carry per-leg counts**

Add `longHist?: AnalysisHist; shortHist?: AnalysisHist;` to `Dist`'s props. Change the `items` build to keep the bucket index so leg counts can be looked up:

```tsx
  const items = hist.counts
    .map((c, i) => ({ c, i, name: names[i] }))
    .filter((r) => r.c > 0);
  if (!items.length) return null;
  const split = longHist != null && shortHist != null;
```

In the `<li>` render, append the split when present:

```tsx
          {items.map(({ c, i, name }) => (
            <li key={i} className="bt-analysis-dist-item">
              {c} {c === 1 ? "trade" : "trades"} {pctOfStop ? "reached" : "closed at"}{" "}
              {name}
              {split && (
                <span className="bt-analysis-dist-split">
                  {" "}(<span className="bt-leg-long">{longHist!.counts[i]} long</span>,{" "}
                  <span className="bt-leg-short">{shortHist!.counts[i]} short</span>)
                </span>
              )}
            </li>
          ))}
```

- [ ] **Step 4: Thread per-leg histograms into the three `Dist` call sites**

Winners MAE (line ~709):

```tsx
          <Dist
            hist={sl.winners_mae_hist}
            longHist={analysis.by_leg?.long.sl.winners_mae_hist}
            shortHist={analysis.by_leg?.short.sl.winners_mae_hist}
            label="Winners: worst drawdown before profit"
            slug="dist-winners-mae"
            collapsed={collapsed.has("dist-winners-mae")}
            onToggle={toggleSection}
            tip="..."
            pctOfStop
          />
```

Apply the same `longHist`/`shortHist` pair to the Losers MAE `Dist` (`sl.losers_mae_hist`) and the Result-distribution `Dist` (`analysis.r_hist` -> `analysis.by_leg?.long.r_hist` / `.short.r_hist`). Keep every other prop identical to what is there now.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): long/short counts inline on distribution lists"
```

---

### Task 7: Group the duration histogram by leg (`DurationHistogram`)

Keep one chart. When leg data is present, draw a Long group and a Short group per bucket, each keeping the win (green) / loss (red) pair. Fall back to today's single win/loss pair when leg data is absent.

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx:326-379` (`DurationHistogram`) and its call site (~751)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `analysis.by_leg?.long.duration_hist` / `.short.duration_hist`. Each has the same `bar_width` semantics; index by bucket `i`. A leg's array may be shorter (fewer buckets); treat missing indices as 0.
- Produces: `DurationHistogram` accepts optional `longHist` and `shortHist` (`{ bar_width; winners; losers } | null`).

- [ ] **Step 1: Write the failing test**

```typescript
it("labels long and short groups in the duration histogram", () => {
  const dh = { bar_width: 1, winners: [1, 0], losers: [0, 1] };
  const analysis = makeAnalysis({
    bar_dynamics: { n_winners: 1, n_losers: 1, n_total: 2, winners: {}, losers: {}, total: {} },
    duration_hist: dh,
    by_leg: {
      long: { duration_hist: { bar_width: 1, winners: [1, 0], losers: [0, 0] } },
      short: { duration_hist: { bar_width: 1, winners: [0, 0], losers: [0, 1] } },
    },
  });
  render(<BacktestAnalysisPanel analysis={analysis} />);
  fireEvent.click(screen.getByText("Bar dynamics"));
  expect(screen.getAllByText("L").length).toBeGreaterThan(0);
  expect(screen.getAllByText("S").length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "long and short groups in the duration"`
Expected: FAIL.

- [ ] **Step 3: Rewrite `DurationHistogram` to group by leg when split**

Replace the bar-rendering body so that, when `longHist`/`shortHist` are present, each bucket renders two labeled leg groups (each a win bar + loss bar); otherwise render the existing single pair. Full component:

```tsx
function DurationHistogram({
  hist,
  longHist,
  shortHist,
  barSeconds,
}: {
  hist: { bar_width: number; winners: number[]; losers: number[] };
  longHist?: { bar_width: number; winners: number[]; losers: number[] } | null;
  shortHist?: { bar_width: number; winners: number[]; losers: number[] } | null;
  barSeconds: number;
}) {
  const { bar_width: width, winners, losers } = hist;
  const split = longHist != null && shortHist != null;
  const at = (arr: number[] | undefined, i: number) => arr?.[i] ?? 0;
  const buckets = winners
    .map((w, i) => ({
      i,
      w,
      l: losers[i],
      label: `${fmtDuration(i * width, barSeconds)} to ${fmtDuration((i + 1) * width, barSeconds)}`,
    }))
    .filter((b) => b.w > 0 || b.l > 0);
  if (!buckets.length) return null;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.w, b.l)));
  const barPx = (c: number) => (c > 0 ? Math.max(2, (c / max) * DUR_HIST_MAX_PX) : 0);
  const pair = (w: number, l: number, label: string) => (
    <div className="bt-dur-hist-pair">
      <Tooltip content={`${label}: ${w} ${w === 1 ? "winner" : "winners"}`}>
        <div className="bt-dur-bar-slot">
          {w > 0 && <span className="bt-dur-bar-count">{w}</span>}
          <div className="bt-dur-bar bt-dur-bar-win" style={{ height: barPx(w) }} />
        </div>
      </Tooltip>
      <Tooltip content={`${label}: ${l} ${l === 1 ? "loser" : "losers"}`}>
        <div className="bt-dur-bar-slot">
          {l > 0 && <span className="bt-dur-bar-count">{l}</span>}
          <div className="bt-dur-bar bt-dur-bar-loss" style={{ height: barPx(l) }} />
        </div>
      </Tooltip>
    </div>
  );
  return (
    <div className="bt-dur-hist-block">
      <div className="bt-dur-hist-title">
        Trades by hold duration
        <InfoTip
          title="Trades by hold duration"
          text="How many winning (green) and losing (red) trades were held for each span of time. When both directions traded, each span shows a long (L) and short (S) group. Bucket width is set automatically from the longest hold."
        />
      </div>
      <div className="bt-dur-hist-plot" style={{ height: DUR_HIST_MAX_PX + 18 }}>
        {buckets.map(({ i, w, l, label }) => (
          <div key={i} className="bt-dur-hist-col">
            {split ? (
              <div className="bt-dur-hist-legs">
                <div className="bt-dur-hist-leggroup">
                  {pair(at(longHist!.winners, i), at(longHist!.losers, i), `${label} long`)}
                  <div className="bt-dur-hist-leglabel bt-leg-long">L</div>
                </div>
                <div className="bt-dur-hist-leggroup">
                  {pair(at(shortHist!.winners, i), at(shortHist!.losers, i), `${label} short`)}
                  <div className="bt-dur-hist-leglabel bt-leg-short">S</div>
                </div>
              </div>
            ) : (
              pair(w, l, label)
            )}
            <div className="bt-dur-hist-xlabel">{fmtDuration((i + 1) * width, barSeconds)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Pass leg hists at the call site (~751)**

```tsx
              {analysis.duration_hist && (
                <DurationHistogram
                  hist={analysis.duration_hist}
                  longHist={analysis.by_leg?.long.duration_hist}
                  shortHist={analysis.by_leg?.short.duration_hist}
                  barSeconds={barSeconds}
                />
              )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): group duration histogram by long/short"
```

---

### Task 8: Long/Short sub-rows in the bar-dynamics table (`BarDynamicsTable`)

Each metric row keeps its Winners / Losers / Total columns and splits into a Long and a Short sub-row.

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx:261-314` (`BarDynamicsTable`) and its call site (~754)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `analysis.by_leg?.long.bar_dynamics` / `.short.bar_dynamics` (each the `{ winners, losers, total }` triple).
- Produces: `BarDynamicsTable` accepts optional `long` and `short` (each `{ winners; losers; total }`). Absent -> renders as today.

- [ ] **Step 1: Write the failing test**

```typescript
it("renders long/short sub-rows in bar dynamics", () => {
  const bd = (v: number) => ({
    n_winners: 1, n_losers: 1, n_total: 2,
    winners: { bars_held: v, bars_in_profit: null, bars_in_loss: null, body_through: null,
      wick_from_profit: null, wick_from_loss: null, longest_profit_streak: null,
      longest_loss_streak: null, bars_to_mfe: null, bars_to_mae: null, entry_crossings: null },
    losers: {}, total: {},
  });
  const analysis = makeAnalysis({
    bar_dynamics: bd(10),
    duration_hist: null,
    by_leg: { long: { bar_dynamics: bd(8) }, short: { bar_dynamics: bd(4) } },
  });
  render(<BacktestAnalysisPanel analysis={analysis} />);
  fireEvent.click(screen.getByText("Bar dynamics"));
  expect(screen.getAllByText("Long").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Short").length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "sub-rows in bar dynamics"`
Expected: FAIL.

- [ ] **Step 3: Add leg sub-rows to `BarDynamicsTable`**

Add optional props and, per metric row, emit Long/Short sub-rows after the existing row. Change the signature:

```tsx
function BarDynamicsTable({
  winners,
  losers,
  total,
  long,
  short,
  barSeconds,
}: {
  winners: BarDynamicsMetrics;
  losers: BarDynamicsMetrics;
  total: BarDynamicsMetrics;
  long?: { winners: BarDynamicsMetrics; losers: BarDynamicsMetrics; total: BarDynamicsMetrics };
  short?: { winners: BarDynamicsMetrics; losers: BarDynamicsMetrics; total: BarDynamicsMetrics };
  barSeconds: number;
}) {
  const split = long != null && short != null;
```

Wrap each metric's `<tr>` in a `Fragment` and, when `split`, add two sub-rows that reuse `fmtBarMetric`:

```tsx
      <tbody>
        {BAR_DYNAMICS_METRICS.map(({ key, label, kind, tip }) => (
          <Fragment key={key}>
            <tr>
              <td>
                <span className="bt-bardyn-metric">
                  {label}
                  <InfoTip title={label} text={tip} />
                </span>
              </td>
              <td>{fmtBarMetric(winners, key, kind, barSeconds)}</td>
              <td>{fmtBarMetric(losers, key, kind, barSeconds)}</td>
              <td>{fmtBarMetric(total, key, kind, barSeconds)}</td>
            </tr>
            {split && (
              <tr className="bt-analysis-subrow bt-leg-long">
                <td className="bt-analysis-subrow-label">Long</td>
                <td>{fmtBarMetric(long!.winners, key, kind, barSeconds)}</td>
                <td>{fmtBarMetric(long!.losers, key, kind, barSeconds)}</td>
                <td>{fmtBarMetric(long!.total, key, kind, barSeconds)}</td>
              </tr>
            )}
            {split && (
              <tr className="bt-analysis-subrow bt-leg-short">
                <td className="bt-analysis-subrow-label">Short</td>
                <td>{fmtBarMetric(short!.winners, key, kind, barSeconds)}</td>
                <td>{fmtBarMetric(short!.losers, key, kind, barSeconds)}</td>
                <td>{fmtBarMetric(short!.total, key, kind, barSeconds)}</td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
```

- [ ] **Step 4: Pass leg dynamics at the call site (~754)**

```tsx
              <BarDynamicsTable
                winners={analysis.bar_dynamics.winners}
                losers={analysis.bar_dynamics.losers}
                total={analysis.bar_dynamics.total}
                long={analysis.by_leg?.long.bar_dynamics}
                short={analysis.by_leg?.short.bar_dynamics}
                barSeconds={barSeconds}
              />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): long/short sub-rows in bar-dynamics table"
```

---

### Task 9: Per-leg What-if (curve tables + readout label)

The What-if curve tables (`stop_curve`, `target_curve`, `breakeven_curve`) split each trigger row into Long/Short sub-rows, sourced from the per-leg whatif that already rides inside `analysis.by_leg.*.whatif`. The prose bullets stay all-trades (per-leg prose would triple an already-long list); add a one-line note that the tables below carry the split.

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx:432-585` (`WhatIfSection`) and its call site (~765)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `longWhatif` / `shortWhatif` (`BacktestWhatif | null | undefined`), passed from `analysis.by_leg?.long.whatif` / `.short.whatif`.
- Produces: `WhatIfSection` accepts optional `longWhatif` and `shortWhatif`. Curve tables gain Long/Short sub-rows keyed by `frac`/`target_r`.

- [ ] **Step 1: Write the failing test**

```typescript
it("splits the tighter-stop curve by leg", () => {
  const sc = [{ frac: 0.5, winners_killed: 1, losers_cheapened: 2, net_delta_r: 0.5 }];
  const analysis = makeAnalysis({
    whatif: { rule_exit: null, no_target: null, stop_curve: sc, target_curve: null,
      fill_delay: null, limit_entry: null, breakeven_curve: null },
    by_leg: {
      long: { whatif: { stop_curve: [{ frac: 0.5, winners_killed: 1, losers_cheapened: 1, net_delta_r: 0.3 }] } },
      short: { whatif: { stop_curve: [{ frac: 0.5, winners_killed: 0, losers_cheapened: 1, net_delta_r: 0.2 }] } },
    },
  });
  render(<BacktestAnalysisPanel analysis={analysis} />);
  fireEvent.click(screen.getByText("What-if"));
  expect(screen.getAllByText("Long").length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "tighter-stop curve by leg"`
Expected: FAIL.

- [ ] **Step 3: Add a generic curve sub-row helper and thread leg whatif**

Add `longWhatif?: BacktestWhatif | null; shortWhatif?: BacktestWhatif | null;` to `WhatIfSection`'s props and destructure them. Add a helper that renders two sub-rows for a curve row given the matching per-leg rows found by a key field:

```tsx
// Two color-coded sub-rows (long, short) for a curve table, aligned to the ALL
// row by a key field (frac or target_r). Cells is a render fn over the matched
// per-leg row (or null when that leg has no entry for this key).
function CurveLegRows<T extends Record<string, number>>({
  keyField,
  keyVal,
  longRows,
  shortRows,
  cells,
  cols,
}: {
  keyField: keyof T;
  keyVal: number;
  longRows: T[] | null | undefined;
  shortRows: T[] | null | undefined;
  cells: (r: T | null) => ReactNode;
  cols: number;
}) {
  if (longRows == null || shortRows == null) return null;
  const find = (rows: T[]) => rows.find((r) => r[keyField] === keyVal) ?? null;
  return (
    <>
      <tr className="bt-analysis-subrow bt-leg-long">
        <td className="bt-analysis-subrow-label">Long</td>
        {cells(find(longRows))}
      </tr>
      <tr className="bt-analysis-subrow bt-leg-short">
        <td className="bt-analysis-subrow-label">Short</td>
        {cells(find(shortRows))}
      </tr>
    </>
  );
}
```

For the `stop_curve` table, wrap each row in a `Fragment` and add the sub-rows (repeat the analogous change for `target_curve` and `breakeven_curve`, matching their columns):

```tsx
                {stop_curve.map((r) => (
                  <Fragment key={r.frac}>
                    <tr>
                      <td>{Math.round(r.frac * 100)}%</td>
                      <td>{r.winners_killed}</td>
                      <td>{r.losers_cheapened}</td>
                      <td className={r.net_delta_r < 0 ? "bt-analysis-neg" : ""}>{r.net_delta_r.toFixed(2)}</td>
                    </tr>
                    <CurveLegRows
                      keyField="frac"
                      keyVal={r.frac}
                      longRows={longWhatif?.stop_curve}
                      shortRows={shortWhatif?.stop_curve}
                      cols={3}
                      cells={(lr) => (
                        <>
                          <td>{lr ? lr.winners_killed : 0}</td>
                          <td>{lr ? lr.losers_cheapened : 0}</td>
                          <td>{lr ? lr.net_delta_r.toFixed(2) : "0.00"}</td>
                        </>
                      )}
                    />
                  </Fragment>
                ))}
```

For `target_curve` use `keyField="target_r"`, `keyVal={r.target_r}`, and cells rendering `n_reached` + `pct_reached` (`fmtPct`). For `breakeven_curve` use `keyField="frac"` and cells rendering `losers_rescued`, `winners_cut`, `net_delta_r`.

Add a note under the What-if heading, shown only when leg whatif is present:

```tsx
      {!collapsed && (longWhatif || shortWhatif) && (
        <p className="bt-analysis-note">The curve tables below split each row into long and short.</p>
      )}
```

- [ ] **Step 4: Pass leg whatif at the call site (~765)**

```tsx
      {active === "whatif" && (
        <WhatIfSection
          whatif={analysis.whatif}
          longWhatif={analysis.by_leg?.long.whatif}
          shortWhatif={analysis.by_leg?.short.whatif}
          collapsed={collapsed.has("whatif")}
          onToggle={toggleSection}
        />
      )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): long/short sub-rows in what-if curve tables"
```

---

### Task 10: Styling for sub-rows and leg tints

Give the Long/Short sub-rows their indent and the app's long/short colors so the two directions read at a glance without any control.

**Files:**
- Modify: `frontend/src/App.css` (append a backtest-analysis leg block near the existing `.bt-analysis-*` rules)
- Verify: reuse the existing long/short color tokens. Find them first.

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Find the existing long/short color values**

Run: `cd frontend && grep -rn "leg-long\|leg-short\|--long\|--short\|side-long\|side-short\|long.*color\|#.*short" src/App.css | head -30`
Use whatever long/short hues the trades table / position lines already use. If a CSS variable exists (e.g. `--leg-long`), reference it; otherwise copy the exact hex values those elements use.

- [ ] **Step 2: Append the sub-row styles**

Add to `App.css` (substitute the real long/short colors found in Step 1 for `LONG_COLOR` / `SHORT_COLOR`):

```css
/* Long/Short breakdown sub-rows in the backtest analysis tables. Both
   directions are always visible: sub-rows sit indented under their ALL row,
   tinted with the app's long/short colors. */
.bt-analysis-subrow > td {
  font-size: 0.92em;
  opacity: 0.9;
}
.bt-analysis-subrow-label {
  padding-left: 1.25em;
  font-variant: small-caps;
}
.bt-leg-long .bt-analysis-subrow-label,
.bt-leg-long.bt-analysis-dist-split,
span.bt-leg-long { color: LONG_COLOR; }
.bt-leg-short .bt-analysis-subrow-label,
.bt-leg-short.bt-analysis-dist-split,
span.bt-leg-short { color: SHORT_COLOR; }
.bt-dur-hist-legs { display: flex; gap: 6px; align-items: flex-end; }
.bt-dur-hist-leggroup { display: flex; flex-direction: column; align-items: center; }
.bt-dur-hist-leglabel { font-size: 0.7em; font-weight: 600; }
.bt-leg-long.bt-dur-hist-leglabel { color: LONG_COLOR; }
.bt-leg-short.bt-dur-hist-leglabel { color: SHORT_COLOR; }
.bt-analysis-note { margin: 2px 0 6px; font-size: 0.9em; opacity: 0.75; }
```

- [ ] **Step 3: Visual check in the browser**

Start (or reuse) the dev server, run a backtest with both long and short trades, open Results -> Analysis, and confirm: every bucketed table shows indented Long/Short sub-rows in the correct colors; the R/MAE/MFE lines show "(N long, M short)"; the duration chart shows L and S groups; What-if curve tables show Long/Short sub-rows. Confirm light theme first (canonical).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.css
git commit -m "style(analysis): indent and tint long/short sub-rows"
```

---

## Self-Review

**Spec coverage:**
- Analysis-tab split (bucketed tables, distributions, duration chart, bar dynamics): Tasks 5-8. Covered.
- What-if split: Task 9. Covered.
- Headline metrics per side: already exists via `LegBreakdownTable`; extended with Expectancy + Win streak (Tasks 1, 4); account-level return/drawdown stay ALL-only (not added). Covered.
- Reload wart fix: analysis payload rides `get_run`'s recompute (Task 2); leg table recomputed in `get_run` (Task 3). Covered.
- Missing-`leg` defaults to long: Tasks 2 (`_partition_by_leg`) and 3 (`get_run` filter). Covered.
- Sequence metrics are per-leg-subsequence: documented in `compute_analysis` docstring (Task 2) and existing `leg_metrics` docstring; leg-table column tooltips note it (Task 4). Covered.
- One-view / no-toggle constraint: every task renders both legs inline; no toggle/tab/lens introduced. Covered.
- Colors reuse existing tokens: Task 10 Step 1. Covered.

**Type consistency:** `LegAnalysis` / `BacktestAnalysis.by_leg` (Task 4) is consumed as `analysis.by_leg?.long.<field>` in Tasks 5-9. `LegMetrics.expectancy` / `max_consec_wins` (Task 4) match the backend keys added in Task 1. `leg_metrics_from_dicts` (Task 3) returns the same key set as `leg_metrics` (asserted by test). `RowsTable` props (`rows`/`longRows`/`shortRows`), `Dist` props (`longHist`/`shortHist`), `DurationHistogram` (`longHist`/`shortHist`), `BarDynamicsTable` (`long`/`short`), `WhatIfSection` (`longWhatif`/`shortWhatif`) are each defined and used consistently within their task.

**Placeholder scan:** No TBD/TODO; every code step shows full code. Tooltip `tip="..."` in Task 6 Step 4 refers to keeping the existing verbatim tip strings already in the file (do not shorten them).
