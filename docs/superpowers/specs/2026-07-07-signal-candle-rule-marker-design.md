# Signal-candle "why this trade fired" marker

**Date:** 2026-07-07
**Status:** Approved design, pre-implementation

## Problem

When reviewing a backtest trade, it is not obvious *which* rule and *which
operand values* actually fired the entry, because the indicator lines drawn on
the chart may differ from the rule's operands. Concretely: a chart showed an
`EMA(56)` line on the **1D** timeframe (value ≈ 25059.8, above the candle open),
while the entry rule referenced `EMA(56)` on the **15m** base timeframe
(value ≈ 24989.6, below the open). The 15m rule genuinely passed, but the trade
*looked* wrong against the 1D line. The engine already knows the exact numbers it
compared; today it discards them, keeping only a names-only reason string like
`EMA_56 gt open`.

## Goal

On the **signal candle** (the bar before the fill, on the run's base
timeframe), show a subtle marker whose hover popover lists each **passing** rule
with the **authoritative operand values the engine used**, and every operand's
**timeframe/param inline**, so the timeframe distinction is unmissable.

Example popover:

```
Long entry — signal 11 Mar 15:30  (AND)
  EMA(56) @15m   24989.6   <   open    25002.5   ✓
  EMA(56) @15m   24989.6   >   low     24933.5   ✓
  close          25010.7   >   open    25002.5   ✓
```

## Decisions (agreed)

- **Interaction:** hover popover on a marker placed on the signal candle.
- **Content:** only the rules that *passed*, each with its numeric values.
- **Data source:** backend-authoritative — the response carries the exact values
  the engine compared (no frontend recompute, no drift; also covers operands
  with no chart line, e.g. `entryPrice`, counted exits, series/slope operands).
- **Glyph:** always drawn for every eligible fill, styled subtly (lighter than
  the `B+`/`SL` fill markers). Long ⇒ caret below the candle, short ⇒ above.
- **Eligibility:** rule-based fills only. Entries always qualify. Exits qualify
  only when the exit is rule-based ("close crosses…"); mechanical exits — stop /
  target / trail / session-close — fire intrabar with no rule signal bar and get
  **no** signal marker (their `SL`/`TP` fill marker already explains them).
- Hovering the signal glyph highlights the same trade (shares the fill marker's
  highlight group), so signal ↔ fill ↔ dock row all light up together.

## Backend

### Structured term capture (`strategy/rule.py`)

- Add a small frozen dataclass:
  ```python
  @dataclass(frozen=True, slots=True)
  class RuleTerm:
      left_label: str
      left_val: float | None
      op: str
      right_label: str
      right_val: float | None
  ```
- Eval currently returns `(passed, results: list[bool])` from `_eval_group`.
  Extend it (or add a sibling) to also return, **for each passing rule**, a
  `RuleTerm` built from the `lnow`/`rnow` already computed in `_base_true_at`.
  The label comes from the existing `_operand_name`, **extended to always append
  the timeframe** (base timeframe included, rendered as the run's TF, e.g.
  `EMA(56) @15m`) so base-vs-HTF operands are visually distinct. Human-friendly
  form (`EMA(56)`, `slope(EMA(9),3)`) rather than the raw series key.
- Attach the term tuple to the emitted `Signal`.

### Thread values to the fill (`core/models.py`, `engine/backtest.py`)

- `Signal` (frozen, `core/models.py:58`): add `terms: tuple[RuleTerm, ...] = ()`.
- `Fill` (`core/models.py:92`): add `signal_time: datetime | None = None` and
  `terms: tuple[RuleTerm, ...] = ()`.
- In the engine fill loop (`engine/backtest.py`, where `pending` from bar `i-1`
  is filled at bar `i`'s open, ~line 129): copy `sig.terms` onto the `Fill` and
  stamp `signal_time = candles[i-1].time`. (A fill at bar `i` came from the
  signal generated on bar `i-1`; the captured values are as-of `i-1`.)
- The existing `reason` string is untouched — the Trades-table column and all
  current behavior stay as-is.

### API serialization (`api/schemas.py`, `api/routers/backtest.py`)

- `MarkerDTO` (`schemas.py:50`): add `signal_time: int | None` (epoch-ms) and
  `terms: list[TermDTO]`, where `TermDTO = {left, lval, op, right, rval}`.
- Router (`backtest.py:108`): populate the new fields from the `Fill`. Markers
  whose fill is mechanical (no terms) simply carry an empty `terms` list and no
  signal marker is drawn frontend-side.

## Frontend

### Signal marker via the existing pipeline (`lib/backtest.ts`)

- The signal glyph is **just another marker**, keyed on `signal_time`, fed
  through the existing marker construction (`MARKER_OVERLAY`, ~line 254; marker
  creation ~853–906). This inherits cross-timeframe placement for free — native
  on the run TF, aggregate/hidden on coarser TFs per the existing `markerMode`
  machinery. No parallel placement system.
- Emit the signal glyph only for markers with a non-empty `terms` list.
- Marker `extendData` (`MarkerExtra`, ~line 259) gains `terms` and
  `signalTime`; a distinct `kind: "signal"` selects the lighter glyph style and
  the below/above placement by leg.

### Hover popover (`BacktestClusterPopover.tsx` pattern)

- Reuse the popover shell and hover-signal plumbing already used by aggregate
  clusters. On signal-glyph hover, open a popover rendering the header
  (`{Long|Short} {entry|exit} — signal {local time} ({AND|OR})`) and one row per
  term: `left  lval  op  right  rval  ✓`.
- Share the trade highlight group so signal-hover lights the trade lines + dock
  row, matching the fill marker's behavior.

## Out of scope / YAGNI

- No failing-rule rows (passing-only, per decision).
- No change to the Trades-table REASON column.
- No signal markers for mechanical exits.
- No new persisted state; the marker is derived from the run result like today's
  fill markers.

## Verification

- **pytest:** rule/engine tests — a rule-based entry produces a `Fill` with
  `signal_time == candles[i-1].time` and terms whose `lval/rval` equal the series
  values at `i-1`; a stop/target exit produces a `Fill` with empty terms.
- **API test:** `/api/backtest` response markers carry `signal_time` + `terms`.
- **vitest:** marker builder emits a signal glyph only when `terms` is non-empty;
  popover renders one row per term with the timeframe-tagged label.
- **Manual:** reproduce the US100 15m case — signal marker on 11 Mar 15:30, hover
  shows `EMA(56) @15m 24989.6 < open 25002.5 ✓` etc.
