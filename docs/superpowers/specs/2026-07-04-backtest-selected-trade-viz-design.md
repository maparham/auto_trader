# Backtest selected-trade visualization (risk/reward zones) — design

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan
**Builds on:** the backtest trades panel (Overview + List + chart hover-sync).

## Problem

Selecting a trade in the results panel should show its stop and take-profit
against the entry — like a live position in draft mode — so you can see the
risk/reward at a glance. Today, hovering a row only draws a thin entry→exit line
(Phase C of the panel). This adds a richer, **read-only** selected-trade overlay
using **translucent risk/reward zones**, windowed to the trade.

Backtest only. No live/paper trading change. No dragging (it's historical).

## Non-goals

- No full-chart-width lines; the overlay is windowed to the trade.
- No editing/dragging of levels.
- No R/R for trades that lack a stop and/or a target (only draw what exists).

## Data (backend)

The chart needs each trade's stop and take-profit **levels**, which the engine
computes on the position but doesn't currently surface. Add three nullable fields
to `Trade` (and `TradeDTO`, and the frontend `Trade` type):

- `stop_initial` — the stop level as first set at entry (planned R:R), or `null`.
- `stop_final` — the stop level in force when the trade closed, after any
  trailing / break-even move (equals `stop_initial` when it never moved), or
  `null`.
- `target` — the take-profit level, or `null`.

Engine changes: `Position` gains `stop_initial`, recorded when the position opens
(the seeded stop). When a trade is booked in `_reduce`, it stamps `stop_initial`,
the position's current `stop` (→ `stop_final`), and `target` onto the `Trade`.
No behavior change; these are pass-through fields.

## Rendering (frontend)

When a trade is **selected**, draw a **windowed, read-only** overlay over its
time span (`entry_time` → `exit_time`, with a little padding), reusing the
chart's overlay machinery (`lib/backtest.ts`, like the existing transient line):

- **Green reward zone** — a translucent green rectangle from `entry_price` to
  `target`, spanning the trade window.
- **Red risk zone** — a translucent red rectangle from `entry_price` to
  `stop_initial`, spanning the trade window.
- **Entry** line (accent) between the zones. (Numeric price pills for the levels
  were considered but dropped — ratified 2026-07-04; the R:R + % labels plus the
  trades list already carry the numbers.)
- **R:R badge** (e.g. `1 : 2.05`) placed in the reward zone, and **risk % /
  reward %** labels (magnitude from entry, short-correct).
- **Final stop** as a faint line inside the risk zone — drawn only when
  `stop_final` differs from `stop_initial` (trailed / break-even).
- The actual **entry→exit segment** + entry & exit dots (the outcome).

Rules: no `stop_initial` → no risk zone; no `target` → no reward zone; the R:R
badge shows only when both exist. Entry and exit are always drawn. Everything is
locked / non-interactive (backtest artifact, not a user drawing).

## Selection behavior

- **Click a trades row = sticky-select:** draws the zone overlay and **scrolls
  the chart** to the trade; the row shows a selected state; it persists until
  another row is selected, it is cleared, or a new backtest runs. One selected
  trade at a time.
- **Hover stays the lighter preview** (the existing Phase-C entry→exit line), so
  scanning the list by hover doesn't disturb the pinned selection.
- A new run / `clearBacktest` removes the overlay and resets the selection.
- Multi-cell safe and leak-safe: the selection signal is gated on run-result
  identity and its subscription released on cell unmount, exactly like the
  existing highlight/focus signals.

## Build order

- **Phase 1 — backend:** `stop_initial` on `Position`; `stop_initial` /
  `stop_final` / `target` stamped on `Trade` in `_reduce`; on `TradeDTO`; on the
  frontend `Trade` type. Unit + api tests. No behavior change (regression-safe).
- **Phase 2 — frontend:** a `selectedTradeSignal` (sticky) + the panel's
  click→select wiring and selected-row state; the windowed risk/reward zone
  overlay in `lib/backtest.ts`, driven by the signal, with the same
  reset/identity/unmount discipline as the existing sync.

## Testing

- **Backend:** a trade booked from a position with a stop & target carries
  `stop_initial`, `stop_final`, `target`; a trailed stop makes `stop_final` differ
  from `stop_initial`; a no-risk trade carries `null`s; the api response exposes
  them. Existing backtest suites pass unchanged.
- **Frontend:** the panel emits `selectedTradeSignal` on row click and marks the
  selected row; the geometry helper computes correct risk %, reward %, and R:R
  from entry/stop/target (short-correct), and omits a zone when its level is null.
