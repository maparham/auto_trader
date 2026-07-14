# Monthly Results Table: Design

**Problem:** The Analysis → Context tab breaks trades down by Session, Time of day, day of week, trend, volatility, and candle pattern, but not by calendar month. On a run that spans many months, traders want to see how the strategy performed month to month (which months carried the run, which bled).

**Decision (user-approved):** Add one new "By month" table in the Context tab, styled exactly like the existing Session / Time-of-day tables (shared `RowsTable`). Each row is one calendar month. The section only appears when the run spans two or more distinct calendar months. No bar chart: the shared table already colors losing months red and dims low-sample months, which gives the visual signal.

## Semantics

Each trade carries `entry_time` (unix seconds, UTC). Trades are grouped by the calendar month of `entry_time`, keyed `YYYY-MM` in **UTC**. This matches how `day_of_week` is already derived (`bar.time.weekday()`, UTC, no local realignment), so the month view is consistent with the existing day-of-week table rather than the locally-realigned Time-of-day table.

Rows use the same definitions as every other context row (`_rows` in `analysis.py`): a win is `pnl > 0` (plain sign, not commission-aware), expectancy is mean `pnl`, net P&L is sum `pnl`, `low_sample` is `n < LOW_SAMPLE_N` (which is 5). Rows are sorted chronologically ascending (the `YYYY-MM` string sorts lexically, which is chronological).

## Threshold: "large enough"

The section renders only when trades span **two or more distinct calendar months**. A single-month run would be a one-row table that says nothing. The threshold lives on the backend: `_month_stats` returns `[]` when fewer than two distinct months are present, and the frontend hides the whole section when the array has fewer than two rows (no "No data." placeholder for this table).

## Backend

`compute_analysis` (`backend/auto_trader/engine/analysis.py`) gains a `month_stats` key via a new helper:

```python
from datetime import datetime, timezone

def _month_stats(trades: list[dict]) -> list[dict]:
    """Per-calendar-month rows (YYYY-MM, UTC) for the monthly breakdown.

    Same row shape and win/expectancy/low_sample definitions as _rows, but
    sorted chronologically rather than by count. Returns [] when trades span
    fewer than two distinct months, so a single-month run shows no table.
    Trades with no entry_time are skipped. Month is taken in UTC, matching how
    day_of_week is derived; a trade within hours of a month boundary could fall
    in an adjacent month under a distant timezone (accepted imprecision)."""
    groups: dict[str, list[dict]] = {}
    for t in trades:
        ts = t.get("entry_time")
        if ts is None:
            continue
        key = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")
        groups.setdefault(key, []).append(t)
    if len(groups) < 2:
        return []
    rows = []
    for month, ts in sorted(groups.items()):
        pnls = [t["pnl"] for t in ts]
        rows.append({
            "bucket": month,
            "n": len(ts),
            "win_rate": sum(1 for p in pnls if p > 0) / len(ts),
            "expectancy": sum(pnls) / len(ts),
            "net_pnl": sum(pnls),
            "low_sample": len(ts) < LOW_SAMPLE_N,
        })
    return rows
```

- Added to the `compute_analysis` return dict as `"month_stats": _month_stats(trades)`.
- Trades with no `entry_time` are skipped. Fewer than two distinct months gives `[]`.
- Flows through the `analysis: dict | None` field of `BacktestResponse` untouched (no schema change), and appears retroactively for stored runs through the existing `compute_analysis(rec["trades"])` recompute path used by the run store.

The row shape duplicates the `_rows` body deliberately: `_rows` sorts by descending `n`, and the monthly table needs chronological order plus the two-month threshold. Keeping `_month_stats` separate avoids overloading `_rows` with a sort-mode/threshold parameter for one caller. The win/expectancy/low_sample expressions are identical by intent (they must match the other tables exactly).

## Frontend

`frontend/src/api.ts`: `BacktestAnalysis` gains

```ts
month_stats?: AnalysisRow[];
```

(optional, since older cached local runs lack it). `AnalysisRow` is the existing type already used by the other context tables, so no new shape.

`frontend/src/BacktestAnalysisPanel.tsx`: the Context section list (the `as const` tuple array that is `.map`-ed into sections) gains a `["month", "By month", "ctx-month"]` entry positioned immediately after the `["hour_bucket", ...]` entry. Inside the `.map` callback, the row source resolves `key === "month"` to `analysis.month_stats ?? []` (a new branch alongside the existing `day_of_week` / `hour_bucket` branches). Because the map renders one `<section>` per entry, the month section is hidden by **returning `null` from the map callback when `key === "month"` and its rows have fewer than two entries** (React skips `null`), so the header and table are both omitted for short runs. All other keys render exactly as today. Rendered through the existing `RowsTable`. Collapsible section slug `ctx-month`, persisted like the others.

To avoid computing the month rows twice (once for the length guard, once for `RowsTable`), lift the row-source resolution to a small block at the top of the map callback: compute `const rows = key === "month" ? (analysis.month_stats ?? []) : key === "day_of_week" ? dayOfWeekRows(...) : key === "hour_bucket" ? hourBucketRows(...) : analysis.context[key] ?? [];` then `if (key === "month" && rows.length < 2) return null;`, and pass `rows` to `RowsTable`.

## Accepted imprecision

Month bucketing is in UTC. A trade within a few hours of a month boundary could be attributed to an adjacent month under a distant timezone. Whole-month spans (the overwhelming majority of trades) are unaffected. This is the same class of tradeoff already accepted for the UTC-derived day-of-week table, and is documented in a code comment on the helper.

## Testing

**Backend** (`tests/test_api_backtest_analysis.py` or a `compute_analysis` unit test): `compute_analysis` returns correct per-month `n` / `win_rate` / `expectancy` / `net_pnl` / `low_sample` for trades spread across several months; rows are in chronological order; trades spanning only one month give `month_stats == []`; trades with no `entry_time` are excluded; `low_sample` flips at `n < 5`.

**Frontend** (`BacktestAnalysisPanel.test.tsx`): the By-month section renders with its rows when `month_stats` has two or more rows; the section is absent (header not in the DOM) when `month_stats` is empty or has a single row.

## Constraints

- No em dash and no "--" as punctuation anywhere in code, comments, copy, or tests.
- Reuse the shared `RowsTable`; do not build a new table or a bar chart.
- Win-rate / expectancy / low-sample semantics must match the backend `_rows` definitions exactly (`pnl > 0` win, mean pnl expectancy, `n < 5` low sample).
- Do not touch the unrelated in-flight files (`BacktestSettingsModal.tsx`, `backtestSchedule*`).
- Frontend typecheck via `npx tsc -b` (pre-existing errors only, zero new).
