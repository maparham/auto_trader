# Market info popover — design

**Date:** 2026-07-03
**Status:** approved

## Problem

The instrument-details modal (`InstrumentDetailsModal.tsx`) renders the broker's raw
market-detail payload as an unstyled key/value dump: API-ish labels, raw numbers
(`-0.01096`, millisecond timestamps), UTC-only hours, no visual hierarchy. Compared
to Capital's own "Market info" sheet it reads as a debug view.

## Goal

Replace it with a styled, curated **popover** modeled on Capital's Market info sheet,
without losing the current guarantee that everything the broker sends is visible.

**Frontend only — no backend changes.** Same data as today: one
`fetchMarketDetail(epic, brokerId)` call on open returning
`{instrument, dealingRules, snapshot}`. Explicitly out of scope (decided): client
sentiment (separate broker endpoint, not fetched) and multi-period price range
(weekly/monthly — day range only, from the snapshot).

## Shell

- **Popover, not modal**: opens anchored next to the symbol name in the chart legend
  (at the click position), flips to stay inside the viewport. No backdrop dim, not
  draggable.
- Dismiss on outside click or Esc (app convention).
- Fixed width ≈300px; internal scroll when tall.
- Visual style per app conventions: light-first, white card, 1px border, **no
  shadows**, content-sized, plain copy. Matches the existing dropdown-menu look.

## Curated content (top → bottom; each block renders only when its source fields exist)

1. **Header** — instrument name (e.g. "Crude Oil Spot"), epic in muted small text,
   close ✕.
2. **Day range bar** — horizontal track from `snapshot.low` → `snapshot.high`,
   marker at current bid with a small price pill. "Low n" in red left, "High n" in
   blue right. Day only, no period dropdown.
3. **Trading hours** — `instrument.openingHours` converted from the broker zone
   (UTC) to the user's **local time**; consecutive days with identical windows
   grouped ("Mon–Thu 00:00 – 23:00"); "your local time" caption; closed days shown
   as "closed".
4. **Trading info** — label/value rows:
   - Currency — `instrument.currency`
   - Min size — `dealingRules.minDealSize`
   - Overnight funding — sub-block (Long / Short / Time): rates as signed
     percentages (`-0.01096` → `−0.011%`), charge time from the swap timestamp as
     local `HH:MM`
   - Margin — `marginFactor` + unit → `10.00%` (broker value shown verbatim)
   - Leverage — derived `1 ÷ marginFactor` → `10:1`, only when unit is PERCENTAGE
   - Spread — derived `offer − bid`, formatted to `decimalPlacesFactor`
   - Type — `instrument.type`
5. **▸ All details** — collapsed by default; expands to the existing generic
   renderer (Instrument / Dealing rules / Market snapshot, every non-empty raw
   field). Keeps the drift-proof guarantee: fields we don't curate — and any new
   fields Capital adds — still appear. Shows the full raw payload; duplication with
   the curated rows above is fine (it is the "raw truth" section).

## Code shape

- New `frontend/src/MarketInfoPopover.tsx` **replaces** `InstrumentDetailsModal.tsx`
  (deleted, no legacy shim). `ChartCore.tsx` passes the anchor point from the
  legend click.
- Pure formatters in `frontend/src/lib/marketInfoFormat.ts`: local-time hours
  conversion + day grouping, funding percent, leverage, spread, range-bar position.
  Unit-tested with vitest — midnight-wrap and day-grouping are the fiddly parts.
- The generic raw renderer (`humanize` / `formatValue` / `rowsFor` /
  `formatOpeningHours`) moves into the popover unchanged for the "All details"
  section.

## Testing

- **Vitest**: formatter module (hours zone-conversion incl. windows crossing
  midnight, day grouping, funding %, leverage derivation, spread rounding,
  range-bar percent clamping).
- **Playwright e2e**: stub `/api/market/*/details`, open popover from the legend,
  assert curated sections render formatted values; dismiss via outside click and
  via Esc.

## Error/edge handling

- Loading and error states inside the popover (same copy as today).
- Any missing/empty source field ⇒ its row/block is omitted (no dashes, no NaN).
- Snapshot is point-in-time (no polling) — unchanged from today.
