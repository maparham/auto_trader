# Long/Short breakdown across backtest analysis

**Date:** 2026-07-14
**Status:** Design approved, pending spec review

## Problem

Backtest statistics are almost entirely direction-blind. Every number in the
Analysis tab, the What-if section, and the headline summary is computed over all
trades combined. The single exception is the leg-breakdown table in the Results
tab (`by_leg` -> `LegBreakdownTable`), which shows ALL / LONG / SHORT rows for a
short list of trade-list metrics. A strategy whose long side is profitable and
short side is not (or vice versa) looks mediocre-but-fine in aggregate, and there
is no way to see the split without exporting trades and slicing them by hand.

Every trade already carries a `leg` field (`"long"` / `"short"`), so the raw
material for a full split exists everywhere; the aggregators just never group on
it.

## Goal

Show long and short results side by side, inline, in every statistical surface of
the backtest dock. **Hard UX constraint from the user: long and short data must
be visible together in one view everywhere. No lens, no toggle, no tab, no
stacked-and-labeled separate tables.** A reader must be able to compare the two
directions without changing any control.

Scope (all approved):
- Analysis tab (Stops & targets, Bar dynamics, Breakdowns sub-tabs)
- What-if section
- Headline metrics summary

## Non-goals

- Sweep results per-leg (out of scope; sweeps stay all-trades).
- Live-trading panel changes.
- Any new metric definitions. This is partitioning existing metrics by `leg`,
  nothing more.

## Direction key

Partition on **`leg`** (`"long"` / `"short"`), never `side` (`"buy"`/`"sell"`;
a SELL can close a long or open a short, so it is not a direction proxy).

Old stored runs may carry trades without a reliable `leg`. Default a missing or
empty `leg` to `"long"`, matching `models.py` `Signal.leg`'s default, so the
split degrades gracefully instead of erroring.

## Architecture

One grouping pattern, applied to all three backend aggregators. Each is
refactored to compute over an arbitrary trade subset, then called three times
(all / long / short). The frontend receives the all-trades payload it gets today
plus a `by_leg` sibling, and zips the three together at render time.

### Backend

A shared partition helper:

```python
def partition_by_leg(trades):
    longs  = [t for t in trades if (t.leg or "long") == "long"]
    shorts = [t for t in trades if (t.leg or "long") == "short"]
    return longs, shorts
```

**`engine/analysis.py` — `compute_analysis(trades)`**
Extract the current body into `_analysis_for(trades, ...)` returning the existing
payload shape (unchanged). The public `compute_analysis` returns:

```
{ ...<all-trades payload, exactly as today>,
  by_leg: { long: <same payload for longs>, short: <same payload for shorts> } }
```

`by_leg.long` / `by_leg.short` are full analysis payloads and do NOT nest their
own `by_leg`.

**`engine/metrics.py` — `leg_metrics(trades, ...)`**
The response already carries `by_leg: {long, short}` built from `leg_metrics()`,
and the Overview `LegBreakdownTable` already renders ALL/LONG/SHORT from it. Two
metrics shown in the flat Overview grid are missing from `leg_metrics`:
**`expectancy`** (mean pnl) and **`max_consec_wins`**. Add both to `leg_metrics`
so the leg table can show them per side. Both split cleanly.

Caveat, stated explicitly: `return_pct` and `max_drawdown_pct` are account-level
(derived from the combined equity curve), not trade-list metrics. There is no
single per-leg equity curve. **They stay ALL-only in the flat stat grid and are
not added to the leg table.**

**`engine/whatif.py` — `compute_whatif(trades)`**
Same pattern: `whatif` (all) plus `by_leg: { long, short }`, each a full whatif
payload.

**`api/routers/backtest.py`**
- Fresh run: `compute_analysis` / `compute_whatif` now emit `by_leg` for free;
  add `metrics_by_leg` alongside `metrics`.
- `get_run` (reload): already recomputes `analysis` from the stored trades, so it
  picks up `by_leg` automatically. Also recompute `metrics_by_leg` and the
  Results `by_leg` leg table from the stored trades here. **This fixes the
  reload wart** (previously the leg table appeared only on a fresh run). Nothing
  new is persisted; the split is derived on read from the trades already stored.

**`api/schemas.py`**
Add optional `by_leg` to the analysis and whatif payload schemas, and
`metrics_by_leg` to the run/response schema. Optional so old callers/tests keep
passing.

### Frontend

**Types (`frontend/src/api.ts`)**
Define a `LegAnalysis` = the current `BacktestAnalysis` shape without `by_leg`;
`BacktestAnalysis = LegAnalysis & { by_leg?: { long: LegAnalysis; short:
LegAnalysis } }`. Same treatment for the whatif type. Add `metrics_by_leg?` to
the result type.

`by_leg` optional: when absent (old stored run), every section renders exactly as
today (all-trades only, no sub-rows). This is graceful degradation of existing
data, not backward-compat scaffolding.

**Long/short colors:** reuse the app's existing long/short color convention (the
same one the trades-table "Side" column and position lines use). Do not
introduce a new palette. Long and short sub-rows / series are tinted with these.

Per-section rendering (`BacktestAnalysisPanel.tsx`, `BacktestPanel.tsx`,
`lib/backtestPanelData.ts`):

1. **Headline metrics (`BacktestPanel.tsx` / `backtestPanelData.ts`)** — the
   Overview tab ALREADY renders an ALL / LONG / SHORT `LegBreakdownTable`
   (`legTable()`), covering Trades, Win rate, Net P&L, Profit factor, Avg
   win/loss, Avg win/loss ratio, Largest win/loss, Loss streak, Avg duration.
   The headline-per-side requirement is therefore mostly already met. Remaining
   work: (a) add the two splittable metrics that are missing from `LEG_COLUMNS`
   but present in the flat grid, **Expectancy** and **Max consecutive wins**, so
   the table is the single per-side source; (b) leave the account-level
   `return_pct` and `max_drawdown_pct` as ALL-only in the flat stat grid (no
   per-leg definition from the combined equity curve, per the caveat above) and
   do NOT duplicate the leg table's metrics into the flat grid. This avoids two
   side-by-side renderings of the same numbers.

2. **Bucketed tables (`RowsTable`: exit reasons, trend, vol_regime, session,
   hour_bucket, month, candle_pattern, day_of_week)** — each bucket becomes a
   group: a bucket header row carrying the ALL totals, then two color-coded
   **Long and Short sub-rows** beneath it. Columns stay Trades / Win rate /
   Expectancy / Net P&L. Zip: for each bucket in the all payload, look up the
   same bucket key in `by_leg.long` / `by_leg.short` (absent -> zeros).

3. **SL/TP readouts (the 4 prose bullets)** — replaced by a compact
   ALL / LONG / SHORT **column** mini-table over the four readout metrics
   (winners near stop %, avg winner MFE vs realized, median left on table,
   % non-target exits that reached target). Prose triplicated three ways is
   unreadable; a small 3-column table says the same thing in one view.

4. **Distributions (`Dist`, the `<ul>` R / MAE / MFE lists)** — each list item
   splits its count into long and short, color-coded, in one line
   (e.g. "+2R: 5 long, 3 short"). Buckets with zero in both legs stay hidden as
   today.

5. **Duration histogram (`DurationHistogram`)** — currently two series per
   bucket (winner green / loser red). Extend to show **both legs in one chart**:
   grouped bars per bucket, a Long group and a Short group, each keeping the
   win/loss coloring. Bucket count is small (chosen server-side from the longest
   hold), so the extra bars stay legible. When `by_leg` is absent, fall back to
   today's single win/loss pair.

6. **Bar dynamics table (`BarDynamicsTable`)** — currently metric rows x
   Winners/Losers/Total columns. Split each metric row into **Long and Short
   sub-rows** (same pattern as the bucketed tables), keeping the
   Winners/Losers/Total columns.

7. **What-if section (`WhatIfSection`)** —
   - Prose bullets: render a Long line and a Short line per applicable bullet
     (labeled), or fold the two legs into one sentence where it reads naturally.
   - Curve tables (`stop_curve`, `target_curve`, `breakeven_curve`): each
     trigger/target/frac row splits into **Long and Short sub-rows**, consistent
     with the rest of the panel.

**`lib/backtestPanelData.ts`** — extend `legTable()` / metric-row builders to
surface the per-leg headline columns; the existing Results `LegBreakdownTable`
stays as-is (it already does ALL/LONG/SHORT).

## Intended-but-notable behaviors

1. **Sequence-dependent metrics become per-leg-subsequence when split.** Max
   consecutive losses, streaks, and (for the leg table) any run-length metric are
   computed within that leg's trade list, ignoring interleaved trades of the
   other direction. `leg_metrics`' docstring already states this. The per-leg
   number is a real but different quantity from the all-trades number. Intended.

2. **Per-leg drawdown / return are not shown** (dash in LONG/SHORT columns), see
   the metrics caveat. Account-level curve metrics have no per-leg definition
   here; we do not fabricate one.

3. **Sub-rows triple visible row count** in the bucketed and bar-dynamics tables.
   Accepted: the user's explicit requirement is that both directions are visible
   without any control. Section collapse (existing chevrons) still lets a reader
   fold away sections they do not need.

## Files to change

Backend:
- `backend/auto_trader/engine/analysis.py` — extract `_analysis_for`, add
  `partition_by_leg`, nest `by_leg`.
- `backend/auto_trader/engine/metrics.py` — add `metrics_by_leg` builder over
  leg subsets (reuses `leg_metrics`).
- `backend/auto_trader/engine/whatif.py` — extract per-subset body, nest
  `by_leg`.
- `backend/auto_trader/api/routers/backtest.py` — fresh run passthrough +
  `get_run` recompute of `metrics_by_leg` and the Results leg table (reload fix).
- `backend/auto_trader/api/schemas.py` — optional `by_leg` / `metrics_by_leg`
  fields.

Frontend:
- `frontend/src/api.ts` — `LegAnalysis` split + optional `by_leg` /
  `metrics_by_leg` types.
- `frontend/src/BacktestAnalysisPanel.tsx` — sub-rows in `RowsTable` and
  `BarDynamicsTable`, split counts in `Dist`, grouped-by-leg
  `DurationHistogram`, per-leg `WhatIfSection`, readouts -> 3-column mini-table.
- `frontend/src/BacktestPanel.tsx` — headline metrics ALL/LONG/SHORT columns.
- `frontend/src/lib/backtestPanelData.ts` — per-leg headline metric rows.
- `frontend/src/App.css` (or the relevant stylesheet) — sub-row indentation and
  long/short tinting, reusing existing long/short color tokens.

## Testing

- Backend unit: a fixture run with known long and short trades; assert
  `by_leg.long` + `by_leg.short` counts reconcile to the all-trades payload for
  each section (n_trades, exit-reason counts, r_hist bucket sums). Assert a
  missing-`leg` trade lands in the long bucket.
- Backend: `get_run` on a stored run returns `metrics_by_leg` and the leg table
  (reload-fix regression).
- Frontend: `BacktestAnalysisPanel` renders long/short sub-rows given a `by_leg`
  payload, and renders unchanged (all-only) when `by_leg` is absent.
- Existing analysis/metrics tests keep passing unchanged (all-trades payload
  shape is preserved).
