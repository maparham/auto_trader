# Baseline Comparison (Excess-over-Baseline) — Design

**Date:** 2026-08-13
**Status:** Approved design, pending spec review

## Problem

A long-only strategy on a rising index earns most of its P&L from market drift
(beta), not from its entry signal. A manual experiment made this concrete:
replacing every long entry rule with `1==1` (always-in) over 1 Jan 2024 –
12 Aug 2026 on US100 produced **more** net P&L (+11,967) than the walk-forward-
selected combo (+9,810), with identical profit factor (1.11). The signal's only
demonstrable contribution was risk-shaping (max DD 47% vs 61%).

Nothing in the app surfaces this. Sweeps and walk-forwards rank combos against
*each other*, so a family of combos sharing one giant common factor (long
exposure) can all look good while none beats "no signal at all". Every future
run should answer the null-hypothesis question automatically.

This is sub-project 1 of the edge-finding rig. Sub-project 2 (the experiment
ledger) is a separate spec and depends on the result schema defined here.

## Goal

Every backtest and walk-forward run automatically computes baseline runs and
reports the strategy's **excess over baseline**, display-only:

1. **Null baseline** ("same-structure null"): entry rules replaced by `1==1`
   per enabled side; *everything else identical* — stop/TP, sizing/risk,
   scaling, session mask, costs, exits. Isolates what the entry signal adds.
2. **Hold baseline** ("buy & hold"): one position per enabled side, entered at
   window start, closed at window end; no brackets, no session mask, no exit
   rules. Measures the raw market through the same cost model.

Out of scope (later builds): using excess as a sweep/WFO **objective**, the
robustness-score formula, per-combo baselines in the sweep grid (the baseline
is per *window*, shared by all combos), and the experiment ledger.

## Approach (chosen)

**Backend-native.** The backtest request and the WFO job grow an opt-in
`baselines` field; the backend synthesizes the variant payloads and embeds
baseline metrics in the result. Rejected alternative: frontend fires two extra
requests and merges — impossible for per-fold WFO numbers (folds run inside the
job), duplicates candle uploads, and splits the synthesis logic across layers.

## Baseline synthesis (backend)

New module `backend/auto_trader/api/baselines.py`:

```python
def null_payload(payload: dict) -> dict: ...
def hold_payload(payload: dict) -> dict: ...
```

Both take a validated expr-backtest payload dict and return a deep-copied
variant:

- `null_payload`: for each **enabled** side, `<side>Entry` becomes
  `[{"expr": "1==1", "enabled": True}]` (combine mode irrelevant with one
  row). Exit rules, risk, scaling, mask, costs, sides untouched. Sweep/WFO
  sub-objects stripped.
- `hold_payload`: for each enabled side, entry becomes `1==1`, exit rules
  become `[]`, risk becomes `None` (no SL/TP), scaling `None`, mask `None`.
  With no exit and no mask, the engine's existing "open position holds until
  the trading window ends" behavior produces enter-once-hold-to-end without
  engine changes. Costs untouched.

Verification step (first implementation task): confirm `1==1` parses in the
expression engine and produces an entry on the first tradeable bar with no
indicator warmup delay; confirm a no-exit no-risk run holds a single position
per side to window end rather than re-entering. If `1==1` misbehaves, the
fallback is a dedicated `always` literal in the engine — that would upgrade
this spec.

Structured (non-expr) requests: **out of scope.** The structured
`BacktestRequest` carries no entry expressions (entries live inside coded
strategy files), so a same-structure null cannot be synthesized for it.
Baselines apply to `/api/expr/backtest` and `/api/expr/walkforward/jobs`
only; structured/coded runs ignore the field.

## Excess semantics

Primary comparator is the **Null** baseline:

- `excess_return_pct = strategy.return_pct − null.return_pct`

(Return-based only; a net-P&L excess adds no information the UI would show.)

Hold is reported as context (its own metrics; no excess columns). Baselines
report their full metric dicts (Sharpe, max DD, trades, …) so risk-shaping
value stays visible. No annualization: both sides of a subtraction cover the
same window.

## API surface

`ExprBacktestRequest` (and the structured DTO) gains:

```python
baselines: list[Literal["null", "hold"]] | None = None  # None = off
```

Backtest response gains:

```python
class BaselineBlockDTO(BaseModel):
    null: MetricsDTO | None
    hold: MetricsDTO | None
result.baselines: BaselineBlockDTO | None
```

WFO: `WalkForwardDTO` gains the same `baselines` field. Per fold, the test
phase runs the baseline payloads over the fold's test window (flat-start, like
the winner's `run_test`) and `WfoFold` gains:

```python
null_metrics: dict | None
hold_metrics: dict | None
excess_return_pct: float | None   # oos_return − null_return, None if either missing
```

Scheme-level `robustness` block gains (computed in `wfo_stitch.aggregate`):

- `median_fold_excess_pct` — median of per-fold `excess_return_pct`
- `pct_folds_beating_null` — share of folds with `excess_return_pct > 0`
  (folds where either side has no trades count toward the denominator only if
  both strategy and null metrics exist)

The robustness **score** formula is unchanged.

## Execution & cost

- Plain backtest: 2 extra sims per run, executed after the main run in the
  same request handler (sequential; they're cheap relative to the main run).
- WFO: 2 extra sims per fold in the `test` phase, using the job's already-
  fetched candles. ~2×N_folds extra runs — negligible next to the grid phase.
  Baseline results ride the existing fold-result plumbing.
- The frontend always requests `baselines: ["null", "hold"]` for expr
  backtests and WFO runs (per product decision: both, always-on). The field
  stays optional in the API so scripts/old clients are unaffected.

## Frontend

- **Backtest overview** (`BacktestPanel` overview tab): new "Baselines"
  section under Performance. Two rows (Null signal, Buy & hold): Net P&L,
  Return %, Sharpe, Max DD, plus the strategy's delta vs that baseline
  (Δ net P&L, Δ return) colored by sign. Tooltips (shared `Tooltip`
  component) explain each baseline in one sentence; copy follows the
  no-em-dash and no-"how"/"which" phrasing conventions.
- **WFO results** (`WfoResults.tsx`): fold table gains an "Excess %" column
  (sortable, tooltip: "Fold return minus the null baseline's return over the
  same test window; positive means the signal beat no-signal."). Scorecard
  gains two tiles: "Median excess" and "Folds > null". Both render "–" when
  the run has no baseline data.
- **WFO archive**: `wfo_store` persists the new fold/robustness fields with a
  schema-version bump; archived runs from before the feature render "–"
  (no backfill).

## Testing

Backend (pytest):
- `null_payload` / `hold_payload` synthesis: enabled-side handling (long-only,
  short-only, both), risk/mask preserved vs stripped, sweep/WFO stripped,
  original payload unmutated.
- `1==1` engine behavior: entry on first bar, hold-to-end without exits,
  deterministic single position per side (the verification step, kept as a
  regression test).
- Excess math: normal fold, missing null metrics (None), zero-trade fold.
- Aggregate: `median_fold_excess_pct` / `pct_folds_beating_null` including
  None folds.
- Route: `baselines` absent → response field None (backward compat).

Frontend (vitest):
- Overview renders the Baselines section when `result.baselines` present,
  hides it when absent.
- WFO fold table shows Excess % with correct sign coloring; archive reopen
  without baseline fields renders "–".
- Sort on the new column.

TDD throughout; frontend baseline of 5-7 known-failing tests on main is not to
be "fixed" in passing.

## Risks

- `1==1` warmup/parse behavior is unverified (mitigation: first task; fallback
  named above).
- Hold baseline on session-masked strategies ignores the mask by definition;
  the overview copy must say so or the comparison will look unfair.
- WFO archive schema bump must keep old rows readable (version-gated reader,
  as done for prior bumps).
