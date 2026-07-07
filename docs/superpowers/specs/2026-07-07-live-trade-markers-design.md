# Live trade markers — design

## Goal

Put an on-candle marker at the point a live/paper trade entered, and at the point
a trade exited (SL/TP fill), so the chart shows *where* trades happened — the same
visual language the backtest already uses for its fills, but driven by the live
trading book instead of a backtest result.

## Convention

Placement is keyed to the **position's direction**, applied to both entry and exit
markers:

- **Long → marker below** the candle
- **Short → marker above** the candle

So a long's entry and exit markers both hang below; a short's both sit above.

## Data sources

Two independent sources feed one overlay type. A trade is in exactly one of them
at a time (open → position book; closed → journal), so entry and exit markers
never double up and there is no missing-data guesswork.

### Entry markers — open positions
- Source: `tradesSignal` (`frontend/src/lib/trading.ts`), filtered to
  `kind === "position"` and the cell's `epic`.
- Anchor bar: the bar containing `openedAt` (epoch ms).
- Anchor price: `priceLevel` (the fill/open level).
- Pill: neutral (blue) — `win: null`. Label e.g. `Long 0.5 @ 70.15`
  (word from `tradeLabel(kind, side)`, quantity, price at cell precision).
- Placement: `side === "buy"` → `below`, `side === "sell"` → `above`.

### Exit markers — journaled closes
- Source: `journalSignal` (`frontend/src/lib/liveJournal.ts`), filtered to the
  cell's `epic`.
- Anchor bar: the bar containing `ts` (close time, **unix seconds** — convert to
  ms before anchoring).
- Anchor price: `exit`.
- Pill: win/loss inferred from P&L — `win = pnl >= 0` → green (TP-style) /
  red (SL-style). Label e.g. `+12.40` / `-8.10` (realized pnl, 2 dp).
- Placement: `leg === "long"` → `below`, `leg === "short"` → `above`.

The journal has **no exit reason** (SL vs TP vs manual) and **no entry time**, so:
- exit markers are P&L-inferred (winner = TP-style, loser = SL-style), per the
  agreed scope;
- a *closed* trade gets only an **exit** marker (no entry time to re-place an entry
  marker), a *open* position gets only an **entry** marker.
- the journal only records **live-engine (armed strategy)** closes, so **manual
  paper closes are not marked** — accepted for v1.

## Rendering

New per-cell drawer `frontend/src/lib/tradeMarkers.ts`, `class TradeMarkers`,
mirroring `PositionLines` (`frontend/src/lib/positionLines.ts`):

- Bound to one chart, filtered to one `epic`, given the cell's `precision`.
- Takes a flat list of marker specs and reconciles by a stable `key`
  (`entry:<tradeId>` / `exit:<journalKey>`) so an update only adds/moves/removes
  what changed — no redraw-all flicker.
- **Reuses the existing `backtestMarker` overlay** from `frontend/src/lib/backtest.ts`
  rather than defining a new glyph. That overlay already supports exactly what we
  need: `extendData = { label, win: boolean|null, placement: "above"|"below" }`,
  anchored by a point `{ timestamp, value }`.

To reuse it, export from `backtest.ts` (currently module-private):
- the overlay name constant (`MARKER_OVERLAY` = `"backtestMarker"`),
- `ensureMarkerOverlayRegistered()`,
- the "bar containing timestamp" anchor helper (last-bar-≤-ts; the same one
  `aggregateTradesByBar` uses — **not** `floor(t/sec)`, since daily/weekly/derived
  bars don't align to epoch multiples).

If a clean export seam isn't already there, factor the anchor helper into a tiny
shared function used by both. No behavioural change to the backtest path.

### Approach: real overlays, not DOM-over-canvas

Use real klinecharts timestamp-anchored overlays (like the native backtest fill
arrows), **not** the DOM-over-canvas pattern the aggregate cluster pills use.
Timestamp-anchored overlays reproject automatically on pan/zoom, so there is no
per-frame projection loop to maintain. (The aggregate pills went DOM-over-canvas
only because their tiny locked hit-target had unreliable klinecharts events — we
need no hit-testing here.)

## Wiring (ChartCore)

`ChartCore` owns one `TradeMarkers` per cell, created on chart (re)init alongside
`PositionLines`, and redraws it when either `tradesSignal` or `journalSignal`
changes (subscribe to both; rebuild the spec list and call `render(specs)`).
Cleared/rebuilt on epic switch and chart teardown, same lifecycle as
`PositionLines`.

## Scope boundaries (v1)

- **Off-window cull**: a marker whose anchor bar is older than the oldest loaded
  bar is skipped (reusing the backtest off-window cull), so markers never pile on
  the left edge. **Paging history back** to reach an old entry bar is deferred.
- **No coarse-TF aggregation**: native per-marker only; two markers on one bar can
  overlap (rare on a live book). Deferred.
- **Manual paper closes**: unmarked (not journaled). Accepted.

## Testing

- Unit-test the pure spec builder (`tradeMarkerSpecs` or equivalent): open long →
  one entry spec, placement `below`, `win: null`; open short → `above`; journal
  winner → exit spec `win: true`; loser → `win: false`; epic filtering; unix-sec →
  ms conversion for journal `ts`; off-window cull given an oldest-loaded bound.
- Follow the existing `positionLines` / `backtest` test style.
- Browser check: open a paper position (marker appears at the entry bar on the
  correct side), let/force a close into the journal (exit marker appears, colored
  by P&L).

## Files

- `frontend/src/lib/tradeMarkers.ts` — new drawer + pure spec builder.
- `frontend/src/lib/backtest.ts` — export overlay name, register fn, anchor helper.
- `frontend/src/ChartCore.tsx` (where `PositionLines` is wired) — own + drive a
  `TradeMarkers` per cell.
- `frontend/src/lib/tradeMarkers.test.ts` — spec-builder unit tests.
