# Move-Stop-to-Breakeven What-if Scenario: Design

**Problem:** The what-if suite answers "what if I held / had no target / tightened the stop / entered on a limit / scaled out", but not the classic trade-management move: what if, once a trade got some distance into profit, the stop had been pulled up to breakeven to protect it?

**Decision (user-approved):** Add one new what-if curve that sweeps the profit trigger with the stop always moving to exact breakeven. Unlike the stop/target curves, this is path-dependent, so it is computed in the per-trade replay path (`enrich_trades_whatif`), not purely from stored `mae_r`/`mfe_r`.

## Semantics

For each trade, keep the real trade exactly as it happened, then overlay a breakeven stop:

- Once price first reaches a profit trigger `f` (in R) during the trade's actual lifespan, the stop moves to the entry price. That trade is "armed" at level `f`.
- If, on a later bar still within the trade's real lifespan, price retraces to the entry price, the whole position exits at breakeven (0R) instead of its real exit. That trade "fired" at level `f`.
- Otherwise the trade is unchanged.

Because a fired trade always ends at exactly 0R, its delta versus reality is `-realized_r`:

- A real loser that fired is **rescued** (delta positive): its loss becomes 0.
- A real winner that fired is **cut short** (delta negative): its gain becomes 0.
- A trade that armed but ran away without retracing to entry is unaffected (delta 0).

Levels swept: `BE_TRIGGER_RS = [0.5, 1.0, 1.5, 2.0, 3.0]`.

Arming and firing are per-trigger: an early dip to entry after a 0.5R peak fires the 0.5 row but not the 1.5 row (which arms later, after the dip). This is exactly why the scenario needs the candle path and cannot be derived from a single stored `mfe_r` scalar.

Same caveats as the rest of the suite: per-trade attribution, knock-on effects on later trades ignored, the breakeven exit assumed to fill at entry with no slippage.

### Why replay (and the retroactive tradeoff)

Arming alone (`mfe_r >= f`) is knowable from stored data, but whether price returned to entry *after* arming and *before* the real exit is path-dependent and differs per trigger. So the fire facts are computed in `enrich_trades_whatif`, which has the candles, like the rule-exit and limit-entry scenarios.

Consequence: the breakeven curve appears on live runs from this point forward. It does **not** appear retroactively on runs stored before this ships (those trades have no `breakeven_stop` stamp); the section renders as absent for them, the same as any other replay scenario.

## Backend

### Replay helper

A helper walks candles from `entry_i` to `exit_i` (inclusive) for one trigger level:

- Trigger price: `entry + f * risk` (long) or `entry - f * risk` (short), `risk = abs(entry_price - stop_initial)`.
- Arm: the first bar `i` in `[entry_i, exit_i]` whose favorable extreme touches the trigger (long: `bar.high >= trigger`; short: `bar.low <= trigger`).
- Fire: if armed at bar `i`, the first bar `j` in `(i, exit_i]` whose adverse extreme touches the entry price (long: `bar.low <= entry`; short: `bar.high >= entry`).

Firing strictly after the arming bar avoids same-bar lookahead. Bar high/low touches match the touch-detection style already used across the suite.

### Per-trade enrichment

`enrich_trades_whatif` stamps a new key:

```python
trade.whatif["breakeven_stop"]  # list[{"frac": f, "armed": bool, "fired": bool}] or None
```

- `None` when the trade is ineligible: no `stop_initial` (no R basis, `risk <= 0`), or no locatable `entry_time`/`exit_time`. This matches the existing "missing what a scenario needs -> that key None" rule; the whole-trade-ineligible branch (`risk <= 0`) adds `"breakeven_stop": None` alongside the other keys.
- Otherwise one entry per level in `BE_TRIGGER_RS`, in order.

### Aggregation

`compute_whatif` gains a new section (following the C/D curve pattern) producing `breakeven_curve`:

- Eligible trades: those with `whatif["breakeven_stop"]` not `None` and `_realized_r(t)` not `None`.
- For each level `f` (by position in `BE_TRIGGER_RS`):

```python
{"frac": f,
 "n_armed": int,           # eligible trades armed at f
 "n_fired": int,           # armed trades that then fired
 "losers_rescued": int,    # fired trades with realized_r < 0
 "winners_cut": int,       # fired trades with realized_r > 0
 "net_delta_r": float}     # _round4(sum(-realized_r for fired trades))
```

- `breakeven_curve` is `None` when there are no eligible trades, never an empty placeholder.
- Zero-realized fired trades count in neither `losers_rescued` nor `winners_cut` but contribute 0 to `net_delta_r`.

The `BacktestWhatif` DTO (`core/models.py`) and the API schema (`api/schemas.py`) gain the `breakeven_curve` key. `enrich_trades_whatif`'s other keys and all existing aggregates are untouched.

### Section-letter coordination

The open, still-unimplemented partial-close spec (`2026-07-14-partial-close-whatif-design.md`) plans sections G (`scale_out_curve`) and H (`cut_loss_curve`). Whichever lands first takes the earlier letters; the breakeven section takes the next free letter. The comment letter is cosmetic: the contract is the dict key `breakeven_curve`, which does not collide.

## Frontend

Inside the existing What-if section (same placement and styling as the Tighter stop / Target placement tables):

- Table "Move stop to breakeven" with columns: Trigger (in profit), Armed, Rescued, Cut, Net R.
  - Trigger renders as the R level (e.g. "1R").
  - Rescued = `losers_rescued`, Cut = `winners_cut`, Net R = `net_delta_r`.
- The table label gets an `InfoTip` explaining the semantics: whole position exits at entry once the trade armed at the trigger and later retraced to entry; the rest of the trade is unchanged; deltas are R of the full position; the scenario is live-run-only.
- One readout bullet for the 1R row, sign-branched on `net_delta_r`:
  - positive: "Moving the stop to breakeven once a trade was 1R in profit would have saved {net}R net across {n_fired} trades that came back to entry."
  - negative: "...would have cost {abs(net)}R net across {n_fired} trades..."
  - Skip the bullet when the 1R row's `n_fired` is 0 (or the curve is absent).
- `whatifHasContent` (What-if tab visibility) and the `BacktestWhatif` TS type extend to the `breakeven_curve` key.

## Testing

**Backend** (`test_whatif_replay.py` / `test_whatif_aggregate.py` conventions): hand-built candles where the path is checkable by eye.

- Never arms (`mfe` below the trigger) -> `armed` False, not counted.
- Arms then returns to entry -> `fired` True; aggregate `net_delta_r == -realized_r` for that trade.
- Arms and runs to target without retracing -> `armed` True, `fired` False, unaffected.
- Short-side mirror of the arm-then-return case.
- Per-trigger divergence: an early dip to entry after a 0.5R peak fires the 0.5 row but not a higher row that arms after the dip.
- Ineligible trade (no `stop_initial`) -> `breakeven_stop` None.
- All-ineligible -> `breakeven_curve` None.
- Rescued/cut counting: a real loser and a real winner both firing at the same level land in the right columns with the right net.

**Frontend** (`BacktestAnalysisPanel.test.tsx`): the table renders on the What-if tab with fixture rows; the 1R bullet renders with correct rescue-vs-cost wording for both signs; an absent `breakeven_curve` renders nothing and does not flip the tab's visibility logic.

## Constraints

- Working tree has unrelated uncommitted edits (`BacktestSettingsModal.tsx`, `backtestSchedule*`); implementation touches `engine/whatif.py` (replay helper, `enrich_trades_whatif`, `compute_whatif`), `core/models.py`, `api/schemas.py`, and `BacktestAnalysisPanel.tsx` + its test, and must not disturb the unrelated files above.
- No em dash or "--" as punctuation in copy or comments.
- Reuse the shared `Tooltip`/`InfoTip` components, never a native `title=`.
- Typecheck via `npx tsc -b` (pre-existing errors only, zero new).
