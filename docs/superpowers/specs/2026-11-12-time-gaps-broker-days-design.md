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
- A line pinned to 1W is straight too (owner's ask): every week the same
  width.
- Capital charts look as they do today, except that a holiday now shows as
  an empty day.
- Setting off: unchanged, pixel for pixel.

## Non-goals

- Monthly pins (months differ in weeks and days; still kink).
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

**Weeks (owner's call: the consistent option).** Under Time gaps the chart is
always laid out by weeks, pin or no pin:

- The day columns of a week are the weekdays that hold candles anywhere in
  the loaded data (stocks and FX: Mon to Fri, the FX Sunday-evening open
  belonging to Monday's broker day; crypto: all seven). Every week has the
  same number of columns, so a line pinned to 1W is straight.
- A holiday is an empty column: it shows as a one-day gap. A weekday no week
  ever trades (the weekend) takes no room. A week with no candles at all (a
  market closure) takes no room.
- Week boundaries: the 1W pin's own weekly starts when one is loaded;
  otherwise a week starts on the first day column (Monday for stocks, FX and
  crypto alike).
- Position = weekNum * columns * perDay + column * perDay + slot.
- Accepted cost: a 1D pin now kinks across a holiday column, because the
  daily bars skip holidays. Everywhere else it stays straight.

Everything else is unchanged: slots per day still run from the earliest to the
latest offset seen (now measured from the day start).

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
- Which weekly pin wins when two disagree: first, as for days.
- Tests: a Monday holiday as an empty first column; a 1W line straight; the
  1D line straight on a week without holidays; inference on FX-like (24h with a 22:00 to 23:00 pause), stock-like
  and 24/7 data; the pin path on an FX day; Capital-like data giving today's
  positions exactly; setting off unchanged.
