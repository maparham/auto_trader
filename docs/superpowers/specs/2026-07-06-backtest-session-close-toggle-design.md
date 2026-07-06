# Backtest: "Close positions at session close" toggle

**Date:** 2026-07-06
**Status:** Design (approved, pending spec review)

## Problem

Today the backtest's **"Only trade during selected windows (force-flat outside)"**
checkbox does two coupled things:

1. Gates *entries* to the active trading windows (the `RecurrenceMask`), and
2. Force-flattens any open position on the first bar that falls **outside** a
   window — booking an exit with reason `"session close"`.

There is no way to get (1) without (2). A trade opened late in a session is
always closed at the session boundary, even if the user wants it to run to its
stop-loss or take-profit. In the current OIL_CRUDE example every trade exits
`"session close"` at the NYSE boundary rather than at its configured 1% stop /
4% target.

## Goal

Split the force-flat behavior into its own user-facing option, **off by
default**. When off, entries stay gated to windows but an open position runs
across session boundaries until its stop/target hits (or the backtest range
ends). When on, behavior matches today (force-flat at each session close).

## Decisions (from brainstorming)

- **Off behavior:** a position open at a window boundary **runs to its
  stop/target**, spanning inactive periods / multiple sessions, until stop,
  target, or range end. Only *entries* remain gated to windows.
- **Placement:** a **sub-toggle nested under the windows checkbox**, shown only
  when windows are enabled (a "session close" only has meaning when a
  window/session is defined).
- **End-of-range rows:** every still-open position at range end is booked as a
  proper Trade row (reason `"range end"`), so no position silently disappears
  from the Trades table (see "End-of-range" below).

## Current mechanism (reference)

- `is_active(mask, bar.time)` (`backend/auto_trader/engine/schedule.py:44-58`)
  returns `True` for every bar when `mask is None` or `mask.enabled is False`.
- Force-flat block `backend/auto_trader/engine/backtest.py:116-124`:
  ```python
  if not active and (longs or shorts):
      realized = self._close_all(longs, "long", ..., bar.open, bar.time, "session close")
      realized = self._close_all(shorts, "short", ..., bar.open, bar.time, "session close")
      last_long_open = None
      last_short_open = None
  ```
- Entry gating is separate: `backtest.py:141-142` (`if not active: continue`).
- The frontend checkbox writes `mask.enabled`; when off, the request omits
  `mask` entirely (`BacktestButton.tsx:162`).

## Design

### New flag: `flattenAtClose` on the mask (Approach A)

Add a boolean **`flattenAtClose`** (py `flatten_at_close`), **default `False`**,
to the `RecurrenceMask` object. Because the request only carries a `mask` when
windows are enabled, the flag naturally exists only when a window is defined —
matching the sub-toggle placement. (Rejected alternatives: a top-level request
field that does nothing without a window; turning `mask.enabled` into an enum.)

### Backend

1. `engine/schedule.py` — add `flatten_at_close: bool = False` to the
   `RecurrenceMask` dataclass.
2. `api/schemas.py` — add `flatten_at_close: bool = False` to
   `RecurrenceMaskDTO`; propagate it in `to_mask()`.
3. `engine/backtest.py:116` — gate the force-flat block on the flag:
   ```python
   if not active and (longs or shorts) and self.mask and self.mask.flatten_at_close:
   ```
   (`is_active` already guarantees `active` is only `False` when a mask is
   enabled, so the extra `self.mask` guard is belt-and-suspenders.)

### End-of-range: book "range end" trades

Replace the commission-free mark-to-market settle at
`backtest.py:192-197`:
```python
if candles:
    last = candles[-1].close
    realized += self._unrealized(longs, "long", last)
    realized += self._unrealized(shorts, "short", last)
```
with the normal exit path, so every still-open position produces a Trade row:
```python
if candles:
    last_bar = candles[-1]
    realized = self._close_all(longs, "long", result, realized, Side.SELL, last_bar.close, last_bar.time, "range end")
    realized = self._close_all(shorts, "short", result, realized, Side.BUY, last_bar.close, last_bar.time, "range end")
```
**Consequence (intended):** `_close_all` charges exit commission per position, so
`net_pnl` shifts by one commission per still-open position vs today's
commission-free settle. This makes range-end exits identical in treatment to
every other trade row (entry + exit commission, a booked Trade, an exit reason).
This affects *all* backtests that end with an open position — including unmasked
ones — not just the new toggle. Accepted as more correct and consistent.

`net_pnl` still equals the final equity point up to the newly-charged exit
commission; equity mark-to-market at the last close is unchanged.

### Frontend

1. `lib/backtestConfig.ts` — add `flattenAtClose?: boolean` to the
   `RecurrenceMask` type.
2. `lib/backtestSchedule.ts` — `resolveMask` passes `flattenAtClose` through to
   the resolved mask.
3. `BacktestButton.tsx` — include `flattenAtClose` in the assembled mask sent to
   the backend.
4. `BacktestSettingsModal.tsx`:
   - Relabel the main checkbox from
     **"Only trade during selected windows (force-flat outside)"** to
     **"Only trade during selected windows"**.
   - Add a nested checkbox **"Close open positions at session close"**
     (default off), rendered only when `cfg.range.mask?.enabled`, bound to
     `mask.flattenAtClose` via the existing `setMask` helper.
   - Add an `InfoTip` explaining: when off, a position opened inside a window
     runs past the session boundary to its stop/target; when on, open positions
     are flattened at each session close (the previous behavior).

## Testing

- `backend/tests/test_backtest_mask.py` — existing assertions that force-flat
  fires must set `flatten_at_close=True` explicitly (default is now off).
- New backend test: with `flatten_at_close=False` and an enabled window, a
  position opened inside the window survives past the boundary and exits on its
  stop/target (reason ≠ `"session close"`).
- New backend test: a position still open at the last bar produces a Trade row
  with reason `"range end"`, and `net_pnl` reflects the exit commission.
- `BacktestSettingsModal.test.tsx` — the nested checkbox renders only when
  windows are enabled and toggles `mask.flattenAtClose`.

## Out of scope

- A separate *market-session* concept distinct from the user's selected windows.
  "Session close" continues to mean the configured window boundary.
- Any change to how entries are gated to windows.
