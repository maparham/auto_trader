# Partial-Close What-if Scenarios: Design

**Problem:** The what-if suite answers "what if I held / had no target / entered on a limit", but not the classic position-management question: what if half the position had been closed part-way to the target, or part-way to the stop?

**Decision (user-approved):** Add two new what-if curves, computed purely in `compute_whatif` from each trade's stored `mae_r` / `mfe_r` and realized R. No candle replay, no per-trade enrichment changes, so both curves also appear retroactively for stored runs through the run-store recompute path.

## Semantics

Both scenarios close HALF the position at a level and let the remaining half keep the trade's real exit (user chose this over a breakeven-stop variant). All deltas are in R of the full position. Ordering is sound by construction: MFE/MAE happen during the trade, so a touch of the level always precedes the real exit.

Levels: `PARTIAL_FRACS = [0.25, 0.5, 0.75]`.

**Scale out toward target.** Eligible trades have a target, `mfe_r`, and a realized R (`_realized_r`). With `target_r = abs(target - entry_price) / risk` (risk = initial stop distance):

- A trade participates at level `f` iff `mfe_r >= f * target_r`.
- Its delta vs reality is `0.5 * (f * target_r - realized_r)`; non-participating trades contribute 0.

**Cut toward stop.** Eligible trades have `mae_r` and a realized R (same set as the existing stop curve). Level `f` is a fraction of the stop distance:

- A trade participates at level `f` iff `mae_r >= f`.
- Its delta is `0.5 * (-f - realized_r)`.

Same caveat as the rest of the suite (per-trade attribution, knock-on effects ignored, partials assumed to fill at the level with no slippage).

## Backend payload

Two new keys in the whatif dict (and `BacktestWhatif` DTO), each `None` when no eligible trades, otherwise a list of rows:

```python
{"frac": f, "n_reached": int, "helped": int, "hurt": int, "net_delta_r": float}
```

- `scale_out_curve`: `frac` is the fraction of the way to the target.
- `cut_loss_curve`: `frac` is the fraction of the way to the stop.
- `helped` / `hurt` count participating trades with positive / negative delta (zero-delta trades count in neither).
- `net_delta_r` is the sum of participating trades' deltas, rounded via `_round4`.

`compute_whatif` gains sections G and H following the existing C/D pattern. `enrich_trades_whatif` is untouched.

## Frontend

Inside the existing What-if section (same placement and styling as the Tighter stop / Target placement tables):

- Table "Scale out half (toward target)" with columns: Bank at (percent of target), Reached, Helped, Hurt, Net R.
- Table "Cut half (toward stop)" with columns: Cut at (percent of stop), Reached, Helped, Hurt, Net R.
- Each table label gets an InfoTip explaining the semantics (half closed at the level, rest keeps its real exit, R of full position).
- One readout bullet each for the 50% row, e.g. "Taking half off halfway to the target would have cost 12.4R net (208 trades got that far)." and "Cutting half halfway to the stop would have saved 3.1R net (410 trades drew down that far)." Sign-branch the verb (cost/added, saved/cost) on `net_delta_r`. Skip a bullet when its 50% row has `n_reached` 0.
- `whatifHasContent` (What-if tab visibility) and the `BacktestWhatif` TS type extend to the two new keys.

## Testing

- Backend (`test_whatif.py` conventions): hand-built trade dicts where the arithmetic is checkable by eye; cases for participation cutoffs (mfe just below / at the level), a trade with no target excluded from scale-out but present in cut-loss, all-ineligible giving `None`, and helped/hurt counting.
- Frontend (`BacktestAnalysisPanel.test.tsx`): both tables render on the What-if tab with fixture rows; the 50% bullets render with correct sign wording; absent curves render nothing and don't affect the tab's visibility logic.

## Constraints

- `analysis.py` and `BacktestAnalysisPanel.tsx` had uncommitted centeredR edits from a concurrent session at design time; implementation must start from a clean tree or rebase around them.
- No em dash or "--" as punctuation in copy or comments.
- Typecheck via `npx tsc -b` (pre-existing errors only, zero new).
