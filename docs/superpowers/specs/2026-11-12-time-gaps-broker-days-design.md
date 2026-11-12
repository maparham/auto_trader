# Time gaps: each broker's own day boundaries

## Intent

Time gaps (setting `equalWidthDays`, spec
`2026-11-12-equal-width-days-design.md`) draws every trading day the same
width so a Trendlines line pinned to 1D is straight on an intraday chart. A
"day" is a UTC calendar day today, which is right for Capital (daily bars open
at 00:00 UTC) but wrong for a broker whose daily bar starts elsewhere: FX at
22:00 UTC, yfinance stocks at exchange midnight, a future broker anywhere.
There the grid's days and the pin's daily bars disagree and the line kinks.

Owner's ask: no per-broker code; it must work for any broker added later.

## Goals

- A day on the chart is the broker's own day, found without knowing the
  broker.
- A Trendlines line pinned to 1D is straight under Time gaps for every
  broker whose daily bars the pin loads.
- Capital charts look exactly as they do today.
- Setting off: unchanged, pixel for pixel.

## Non-goals

- Weekly and monthly pins (still kink; a later step could give every week
  the same number of days).
- The newest day stays flat on purpose (it shows the level alerts judge);
  owner confirmed.
- Drawings, indicator lines, chart-timeframe lines: as in the first spec.

## How it works (decided)

Two sources for the day boundaries, in this order:

1. **The pin's daily bars.** When a Trendlines pane on the chart is pinned to
   1D, its stash already holds the daily bar starts (`mtf.htfStarts`). The
   grid uses them: candle c belongs to the day whose start is the last one at
   or before c's time, and its slot is counted from that day's start. Exact by
   construction, so the pinned line is straight for any broker.
2. **Inferred from the candles** (no 1D pin on the chart): the day starts at
   the recurring daily pause in the loaded candles (my call: the start of the
   time-of-day bin, one chart period wide, holding the fewest candles; ties
   go to the one closest to 00:00 UTC). FX lands on its 22:00 UTC break; a
   stock session that never crosses midnight ties on an empty bin and lands
   on 00:00 UTC.
   A market with no pause (crypto, 24/7) falls back to 00:00 UTC, where its
   daily bars start anyway. For Capital stocks this yields the same days as
   UTC midnight, so nothing moves.

Everything else is unchanged: slots per day still run from the earliest to the
latest offset seen (now measured from the day start), days without candles
take no room, positions are `dayNum * perDay + slot`.

## Left to the builder

- Wiring the pin's starts into the grid: the store calls the provider with
  the data list only. A registry keyed by data list (set where the Trendlines
  draw already has `dataList` and `mtf`) is one way; the store's slot cache
  must then also key on a version so a new registration relays out.
- When two 1D pins on one chart disagree (two brokers cannot, same chart):
  first wins.
- Turning a 1D pin on or off may move the grid from inferred to exact; the
  view should hold its centre candle (the store's `_viewAnchor` already does
  this for data changes; a relayout path may need it too).
- Tests: inference on FX-like (24h with a 22:00 to 23:00 pause), stock-like
  and 24/7 data; the pin path on an FX day; Capital-like data giving today's
  positions exactly; setting off unchanged.
