# Time-of-Day Context Table: Design

**Problem:** The Analysis → Context tab breaks trades down by Session (four FX sessions), day of week, trend, volatility, and candle pattern, but not by a finer time-of-day grouping. Traders want to see win rate / expectancy / net P&L for a few-hour block of the day, in their own timezone.

**Decision (user-approved):** Add one new "Time of day" table in the Context tab, styled exactly like the existing Session / Day-of-week tables. Six rows, 4 hours each, grouped by each trade's entry (signal-bar) hour, aligned to the viewer's local midnight.

## Semantics

Each trade already carries `context.hour_utc` (the signal-bar hour, UTC, set in `context_features.enrich_trades`) and `pnl`. Buckets are 4 hours wide, aligned to local midnight: `00:00-04:00`, `04:00-08:00`, `08:00-12:00`, `12:00-16:00`, `16:00-20:00`, `20:00-24:00` in the viewer's local timezone. Only buckets with at least one trade are shown, in chronological order.

Win rate uses the same definition as the other context rows (`_rows` in `analysis.py`): `pnl > 0` counts as a win (plain sign, not commission-aware). Expectancy is mean `pnl`, Net P&L is sum `pnl`, `low_sample` is `n < LOW_SAMPLE_N` (which is 5).

## Why the backend cannot do the final bucketing

Local-midnight alignment depends on the viewer's timezone, which the backend does not know. So the backend emits per-hour *sufficient statistics* and the frontend regroups them into local-aligned 4-hour windows. The frontend arithmetic is plain summation (`n`, `wins`, `sum_pnl` are additive); the win-rate/expectancy formulas and the `LOW_SAMPLE_N` threshold are mirrored on the frontend. This is a deliberate, minimal move of final aggregation to the client, forced by the timezone requirement; the business logic (per-trade grouping into sufficient statistics) stays on the backend.

## Backend

`compute_analysis` (`backend/auto_trader/engine/analysis.py`) gains a `hour_stats` key via a new helper:

```python
def _hour_stats(trades: list[dict]) -> list[dict]:
    groups: dict[int, list[float]] = {}
    for t in trades:
        h = (t.get("context") or {}).get("hour_utc")
        if h is None:
            continue
        groups.setdefault(int(h), []).append(t["pnl"])
    return [
        {"hour": h, "n": len(pnls),
         "wins": sum(1 for p in pnls if p > 0),
         "sum_pnl": round(sum(pnls), 5)}
        for h, pnls in sorted(groups.items())
    ]
```

- Added to the `compute_analysis` return dict as `"hour_stats": _hour_stats(trades)`.
- Trades with no `context` or no `hour_utc` are skipped. No eligible trades gives `[]`.
- Flows through the `analysis: dict | None` field of `BacktestResponse` untouched (no schema change), and appears retroactively for stored runs through the existing `compute_analysis(rec["trades"])` recompute path used by the run store. Runs whose stored trades predate `hour_utc` enrichment simply yield fewer or zero rows (graceful, same as other context features).

## Frontend

`frontend/src/api.ts`: `BacktestAnalysis` gains

```ts
hour_stats?: { hour: number; n: number; wins: number; sum_pnl: number }[];
```

(optional, since older cached local runs lack it).

`frontend/src/BacktestAnalysisPanel.tsx`: a `hourBucketRows(hourStats, offsetHours)` helper, where `offsetHours` defaults to `-new Date().getTimezoneOffset() / 60` but is a parameter for unit testing:

- For each stat, `localHour = ((hour + offsetHours) % 24 + 24) % 24`, `bucket = Math.floor(localHour / 4) % 6`.
- Accumulate `n`, `wins`, `sum_pnl` per bucket.
- Emit an `AnalysisRow` per non-empty bucket in ascending bucket order: `bucket` label `HH:00-HH:00` (start `= idx*4`, end `= idx*4+4`, end shown as `24:00` for the last), `win_rate = wins/n`, `expectancy = sum_pnl/n`, `net_pnl = sum_pnl`, `low_sample = n < 5`.

Rendered through the existing `RowsTable`. Wired into the Context tab immediately after the Session section, using the same branch mechanism `day_of_week` already uses: the context section list gains `["hour_bucket", "Time of day", "ctx-hour-bucket"]` positioned right after `session`, and the row-source branch becomes `key === "hour_bucket" ? hourBucketRows(analysis.hour_stats ?? []) : ...`. Collapsible section slug `ctx-hour-bucket`, persisted like the others.

## Accepted imprecision

Bucketing is at hour granularity. For the rare half-hour timezones (for example UTC+5:30), a single UTC hour that straddles a local 4-hour boundary is assigned whole to one bucket by its start. Whole-hour offsets (the overwhelming majority) are exact. Documented in a code comment on the helper.

## Testing

**Backend** (analysis test conventions, `tests/test_api_backtest_analysis.py` or a compute_analysis unit test): `compute_analysis` returns correct per-hour `n` / `wins` / `sum_pnl` for trades spread across several UTC hours; trades with `context` None or missing `hour_utc` are excluded; no eligible trades gives `hour_stats == []`.

**Frontend** (`BacktestAnalysisPanel.test.tsx`): `hourBucketRows` with `offsetHours = 0` produces UTC-aligned buckets with correct labels, sums, and derived win-rate/expectancy; with `offsetHours = 2` the same stats land in the shifted local buckets with correct labels; a stat set that is empty yields `[]` (and the table renders "No data"); `low_sample` flips at `n < 5`. Optionally: the Time-of-day section renders on the Context tab.

## Constraints

- No em dash and no "--" as punctuation anywhere in code, comments, copy, or tests.
- Reuse the shared `RowsTable`; do not build a new table.
- Win-rate / expectancy / low-sample semantics must match the backend `_rows` definitions exactly (`pnl > 0` win, mean pnl expectancy, `n < 5` low sample).
- Do not touch the unrelated in-flight files (`BacktestSettingsModal.tsx`, `backtestSchedule*`).
- Frontend typecheck via `npx tsc -b` (pre-existing errors only, zero new).
