# Time gaps: days and weeks from the broker's own bars

Replaces the "inferred from the candles" part of
`2026-11-12-time-gaps-broker-days-design.md`. Everything else there stands
(weekly layout, holidays as empty columns, straight 1D and 1W lines, newest
bar flat).

## Intent

Owner's rule: no guessing, nothing specific to one broker, and it must work
for brokers added later. If that is not possible for a chart, Time gaps is
skipped on that chart (the chart is drawn normally).

The inferred day start broke this: Capital GOLD has a quiet hour at 21:00, so
its days started at 21:00 while Capital's GOLD daily bars start at 00:00.

## How it works (decided)

- With Time gaps on, each chart loads its own symbol's daily (`DAY`) and
  weekly (`WEEK`) bars from its own broker, over the range of its loaded
  candles, through the same shared bar cache pinned panes use.
- Day starts are the daily bars' start times; week starts are the weekly
  bars' start times. A candle belongs to the last day start at or before it,
  and its day to the last week start at or before that day's start.
- Columns: the weekdays (calendar date of `dayStart + 12h`) that hold a daily
  bar. A weekday with no daily bar in some week is an empty column (holiday).
- Until the bars arrive, and on any chart whose bars cannot be loaded (failed
  request, broker without daily or weekly bars), the chart has no grid: it is
  drawn normally. When they arrive, the chart relays out keeping the candle in
  the middle of the view in place.
- Loaded history grows (scroll back) or a new day starts: the chart loads the
  missing bars. While that request is out, the edge candles count on in whole
  days from the nearest known start; they are corrected when the bars land.
  A failed or empty answer is not asked again for the same range within a
  minute.
- A symbol or broker change drops the chart's starts and loads anew.
- The candle-based inference ("quietest hour") is removed. Pinned panes no
  longer register starts: the chart's own load covers every case.

## Costs

Two extra requests per chart while Time gaps is on (shared with pinned panes
on the same symbol, so often free). A chart is drawn normally for the moment
before its bars arrive.

## Tests

- No anchors: no grid.
- Given day and week starts: positions as before for stock-like and FX-like
  data, a holiday is an empty column, FX's Sunday 22:00 start opens Monday.
- Candles past the last day start step on in whole days; candles before the
  first step back.
- The provider asks its chart's source for missing ranges once, and not again
  after a failure within a minute.
- Real chart: anchors arriving keep the centre candle in place.
