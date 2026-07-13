# What-if Analysis Suite (Backtest Analysis Tab) — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm), ready for implementation planning
**Builds on:** `docs/superpowers/specs/2026-07-13-strategy-analysis-design.md` (shipped)

## Goal

Answer per-trade counterfactual questions from a backtest run: would rule-exited
trades have won if left alone (A)? Does the target cap runners (B)? What would a
tighter stop cost or save (C)? Where should the target sit (D)? What does the
one-bar fill delay cost (E)? Would limit entries at the signal close beat market
entries (F)?

The existing sweep engine answers "change a setting and rerun" questions exactly
at the system level. This suite's niche is **per-trade attribution**: which
trades flip, and what each rule or level costs, trade by trade.

## Context for the implementing agent

The strategy-analysis feature this extends is live. Key facts:

- Engine: `backend/auto_trader/engine/backtest.py`. `Trade` (in
  `backend/auto_trader/core/models.py`) already carries `mae`, `mfe`, `mae_r`,
  `mfe_r` (R-multiples vs `stop_initial`) and `context: dict | None`.
- Post-run enrichment pattern to copy: `backend/auto_trader/engine/context_features.py`
  (`enrich_trades(trades, candles)` mutates a dict field on `Trade`).
- Aggregates pattern to copy: `backend/auto_trader/engine/analysis.py`
  (`compute_analysis(trade_dicts)` is pure over TradeDTO-shaped dicts so the
  same code serves the live response and run-store recompute).
- API wiring: `backend/auto_trader/api/routers/backtest.py` calls enrichment,
  builds `TradeDTO`s (`api/schemas.py`), computes `analysis`, persists runs via
  `RUN_STORE` (`core/run_store.py`; stores trades_json, NOT candles).
  `GET /api/backtest/runs/{id}` recomputes analysis from stored trade dicts.
- Frontend: `frontend/src/BacktestAnalysisPanel.tsx` renders `analysis` in the
  backtest dock; types in `frontend/src/api.ts` mirror the payload exactly.
- Engine intrabar exit semantics to mirror in the replay helper:
  `BacktestEngine._intrabar_exit` (pessimistic: open gaps resolve first, then
  stop-before-target on the same bar for longs via low/high checks).

Repo conventions that bind this work (violations were rejected in review before):

- Backend owns business logic; frontend only formats.
- No backward-compat/migration code. No schema change to the runs table (see
  Persistence below for how that's avoided).
- Backend tests: `cd backend && .venv/bin/python -m pytest <paths> -q`.
  NO pytest-asyncio: test async handlers via `asyncio.run(...)` and assert
  `HTTPException` (mirror `backend/tests/test_api_backtest.py`).
  `backend/tests/conftest.py` already isolates `RUN_STORE` per test (autouse).
- Frontend tests: `cd frontend && npx vitest run <path>`; typecheck with
  `npx tsc -b` (NOT `--noEmit`, a no-op). 60 pre-existing errors exist in
  unrelated files; introduce none.
- UI copy: plain trading language, list-style presentation (bulleted sentences,
  small tables), NO bar charts, NEVER use "—"/"--" as punctuation in any text,
  shared `InfoTip` for explainers (must sit inside a styled ancestor; extend the
  grouped `.ind-info` selectors in `App.css` for any new container, or it
  renders as a black circle).
- Commit directly to main; do not push. Other sessions commit concurrently:
  `git add` specific files only.

## Scope

Six scenarios in two mechanisms:

| ID | Scenario | Mechanism | Needs candles? |
|----|----------|-----------|----------------|
| A | Exit-rule counterfactual | replay | yes (at run time) |
| B | Target counterfactual | replay | yes (at run time) |
| C | Stop-tightening curve | pure math over stored `mae_r` | no |
| D | Target-placement curve | pure math over stored `mfe_r` | no |
| E | Fill-delay cost | signal-bar lookup at run time | yes (at run time) |
| F | Pullback limit entry | replay from signal bar | yes (at run time) |

## Architecture

Everything computes in the backend **at backtest time**, when candles are in
hand. Per-trade counterfactual results are stamped onto each trade as a new
`whatif: dict | None` field (same pattern as `context`); aggregates are pure
functions over trade dicts. Consequence: the run store needs **no schema
change**, per-trade what-if data rides inside `trades_json`, and
`GET /api/backtest/runs/{id}` recomputes the aggregates for free.

Sweep child runs skip all of this (they already skip enrichment/persistence;
keep it that way for cost).

### New module: `backend/auto_trader/engine/whatif.py`

Two layers:

**1. Replay helper (pure):**

```python
def replay_bracket(
    candles: list[Candle],
    start: int,              # first bar index to evaluate (inclusive)
    leg: str,                # "long" | "short"
    stop: float | None,
    target: float | None,
    horizon: int = 500,      # max bars to walk; beyond -> undecided
) -> tuple[str, int | None]:
    """Walk bars forward with the engine's pessimistic intrabar rules and
    return (outcome, exit_bar_index): outcome in "target" | "stop" | "undecided".
    """
```

Bar evaluation order per bar (mirror `_intrabar_exit` exactly): for a long,
open >= target resolves as target at open; else low <= stop resolves as stop at
min(open, stop); else high >= target resolves as target. Short is symmetric.
`undecided` when the horizon or the candle array ends first, or when both stop
and target are None.

**2. Enrichment (`enrich_trades_whatif(trades, candles, quantity_r_ok=...)`)**
mutates `trade.whatif` (dict, JSON-safe scalars). Trades are located in the
candle array via a time->index map on `entry_time`/`exit_time` (entry fill bar =
signal bar + 1, same convention as context_features). Trades whose times are not
found, or that lack the inputs a scenario needs, get that scenario key set to
None (never fabricated).

## Scenario definitions

R units throughout: 1R = |entry_price − stop_initial|; every delta is in R.
Trades without `stop_initial` are excluded from R-based scenarios (fields None).

### A. Exit-rule counterfactual

- Trade set: `reason_out` NOT in {"stop", "trail", "target", "range end"}
  (i.e. rule exits and "session close").
- Replay from the trade's exit bar index (the exit fill happened at that bar's
  open; evaluation starts at that same bar, consistent with the engine
  tracking that bar's range for a still-open position) with
  `stop = stop_final` (post-trailing, no further trailing) and
  `target = target`.
- Per trade: `whatif["rule_exit"] = {"would_have": "won"|"lost"|"undecided",
  "delta_r": float | None}` where delta_r = counterfactual realized R minus
  actual realized R. Counterfactual realized R = signed move from entry to the
  hit level over risk: for a long, (target − entry_price)/risk on "won" and
  (stop_final − entry_price)/risk on "lost"; shorts sign-flip. None when
  undecided.
- Trades with neither stop_final nor target: excluded (key None).

### B. Target counterfactual

- Trade set: `reason_out == "target"`.
- Replay from the exit bar with `stop = stop_final`, `target = None`
  (hold until stop or undecided).
- Per trade: `whatif["no_target"] = {"would_have": "stopped"|"survived",
  "delta_r": float | None}`. With no target the replay can only end "stop"
  (map to "stopped") or "undecided" (map to "survived": the trade outlived the
  horizon or the data; we cannot know how far it would have run). For
  "stopped": delta_r = counterfactual realized R (move from entry to
  stop_final over risk, signed per leg) minus the actual +target R, i.e. what
  the target saved on this trade. For "survived": None.

### C. Stop-tightening curve (no replay)

- Grid: f in {0.1, 0.2, ..., 1.0} (fraction of the current stop distance).
- Per trade with `mae_r` and realized R available: outcome under candidate stop
  f = −f if `mae_r >= f` else realized R (unchanged).
- Aggregate per f: `winners_killed` (winners with mae_r >= f), `losers_cheapened`
  (losers with mae_r >= f), `net_delta_r` = sum(candidate outcome − actual R).
- Tightening only; f > 1 is not computable (loser paths truncate at the real
  stop). State this in the tooltip.

### D. Target-placement curve (no replay)

- Grid: t in {0.5, 1.0, 1.5, ..., 5.0} (R).
- Per trade with `mfe_r`: reached = `mfe_r >= t`.
- Aggregate per t: `n_reached`, `pct_reached`. Hit-rate ONLY, no net-R claim:
  target-exited trades' MFE is censored at their actual target (scenario B is
  the uncensored answer). Censoring note goes in the tooltip.

### E. Fill-delay cost

- Per trade: `whatif["fill_delay_r"]` = (entry_price − signal_bar.close) / risk
  for longs, (signal_bar.close − entry_price) / risk for shorts, where risk =
  |entry_price − stop_initial|. Positive = the delay cost money. Signal bar =
  entry fill bar − 1 (skip trades filling on bar 0 or with unknown entry time).
- Aggregate: mean per trade + run total.

### F. Pullback limit entry

- v1 constants (not user-tunable): limit level = signal bar close (offset 0),
  fill window = 3 bars starting at the actual fill bar, replay horizon 500.
- Fill check: within the window, a long limit at L fills on the first bar with
  low <= L (at L, or at open if open < L); short symmetric.
- If never filled: `whatif["limit_entry"] = {"filled": false,
  "foregone_r": <actual realized R>}` (what you'd have missed; can be negative,
  i.e. a dodged loser).
- If filled: re-anchor the trade's recorded stop/target DISTANCES from the new
  entry price, replay from the fill bar; `{"filled": true, "delta_r": float | None}`
  = counterfactual R minus actual R (undecided -> None).
- Aggregate: fill rate, net delta_r over filled, foregone net R over unfilled
  (split winners/losers), and one net verdict number: sum(delta_r over filled)
  − sum(foregone_r over unfilled).

## Aggregates: `compute_whatif(trade_dicts) -> dict`

New pure function in `engine/whatif.py` (or `analysis.py` if the implementer
prefers one aggregates module; either is acceptable, keep dict-based purity).
Consumes TradeDTO-shaped dicts (now carrying `whatif`), returns:

```python
{
  "rule_exit": {
    "by_reason": [
      {"reason": str, "n": int, "would_have_won": int, "would_have_lost": int,
       "undecided": int, "net_delta_r": float}
    ],
    "totals": {...same fields minus reason...},
  } | None,               # None when no eligible trades
  "no_target": {"n": int, "would_have_stopped": int, "survived": int,
                 "net_saved_r": float} | None,
  "stop_curve": [{"frac": float, "winners_killed": int, "losers_cheapened": int,
                   "net_delta_r": float}] | None,
  "target_curve": [{"target_r": float, "n_reached": int, "pct_reached": float}] | None,
  "fill_delay": {"n": int, "avg_r": float, "total_r": float} | None,
  "limit_entry": {"n": int, "fill_rate": float, "filled_net_delta_r": float,
                   "unfilled_foregone_r": float, "unfilled_winners": int,
                   "net_verdict_r": float, "undecided": int} | None,
}
```

Wired as `analysis["whatif"]` inside the existing analysis payload (both the
live response and the `GET /runs/{id}` recompute path pick it up automatically
because both call the same aggregate function over trade dicts).

## API / persistence changes

- `TradeDTO` gains `whatif: dict | None = None`; conversion copies `t.whatif`.
- `BacktestResponse` unchanged in shape (`analysis` just gains the `whatif` key).
- Run store: untouched. `trades_json` now contains `whatif` per trade;
  `GET /runs/{id}`'s recompute calls the aggregates over those dicts.
- Ordering in the handler: run engine -> `enrich_trades` (context) ->
  `enrich_trades_whatif(result.trades, candles)` -> build DTOs -> aggregates ->
  persist. Sweep path stays untouched (no enrichment, no persistence).

## UI: "What-if" section in the Analysis tab

One new section in `BacktestAnalysisPanel.tsx` after "Stop & target placement
check", following the established style (bulleted sentences, small flat tables,
InfoTip explainers, no bars, no dash punctuation):

- **Exit rules** bullets, one per reason with eligible trades: e.g.
  "11 of 30 trades closed by 'Sell to Close' would have gone on to hit the
  target; keeping them cost 14.2R net." Plus an undecided count when nonzero.
- **Target** bullet: "6 of 22 target exits would have later hit the stop; the
  target saved 9.1R net." Or the inverse phrasing when net is negative.
- **Fill delay** bullet: "The one-bar fill delay costs 0.07R per trade
  (22R over this run)."
- **Limit entries** bullets: fill rate, saved vs missed, and the net verdict
  sentence.
- **Stop curve** small table (columns: Stop at, Winners lost, Losers cheapened,
  Net R) and **Target curve** small table (columns: Target, Reached, Share).
  Reuse the `.bt-analysis-table` styling.
- Every subsection carries an InfoTip stating the attribution caveat: replays
  ignore knock-on effects on later trades (single-position netting), so confirm
  any promising finding with a rerun or sweep.
- Sections with no eligible trades render nothing (no empty placeholders).

Types added to `frontend/src/api.ts` mirroring `compute_whatif` exactly.

## Error handling

- Every scenario degrades to None per trade (missing times, missing bracket,
  missing R basis) and to None per aggregate (no eligible trades); the UI skips
  None sections.
- Replay horizon 500 bars caps cost; hitting it yields "undecided", counted and
  displayed, never silently dropped.
- What-if enrichment failures must never fail the backtest response: wrap the
  whole enrichment call best-effort (log warning, leave `whatif` None), same
  policy as the run-store write.

## Testing

- `replay_bracket` unit tests: target-after-exit, stop-after-exit, gap-through
  cases (open beyond target/stop), undecided at horizon and at array end, both
  legs, stop-and-target-same-bar pessimistic ordering (matches `_intrabar_exit`).
- Per-scenario enrichment tests on hand-built candle+trade fixtures, including
  each None/exclusion path (no stop_initial, unknown entry_time, fill on bar 0,
  limit never fills, dodged-loser unfilled case).
- `compute_whatif` aggregate tests over dicts, including all-None -> all-None.
- API test extension (repo convention, asyncio.run style): response
  `analysis["whatif"]` present, trades carry `whatif`, stored run round-trips it.
- Frontend: extend `BacktestAnalysisPanel.test.tsx` fixture with a `whatif`
  payload; assert bullets and both tables render, and None sections don't.

## Out of scope (explicitly)

- User-tunable F parameters (offset, window), widened-stop curves, trailing
  re-simulation in replays, entry-timing shifts beyond E, session/day removal
  what-ifs (context tables and sweeps cover those), and any UI to launch
  confirmation sweeps from a what-if finding (Claude drives sweeps in sessions).
- No changes to the live engine path; this is backtest-analysis only.
