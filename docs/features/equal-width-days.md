# Equal-width days

The Appearance menu's "Time gaps" switch, mirrored by the toolbar's "G"
beside A / L / I (`Settings.equalWidthDays`, off by default, global), draws
every broker day of an intraday chart the same width: one slot per chart
period from the earliest to the latest time into the day in the loaded
candles, each candle in its own slot, missing periods as gaps. Days and weeks
are the broker's own, never guessed: each chart loads its symbol's daily and
weekly bars (`fetchBrokerDayWeekStarts` in `lib/mtfCoordinator.ts`, the same
shared bar store pinned panes use) and the grid uses their open times. A
chart whose bars cannot be loaded, or that is still waiting for them, is
drawn normally. The chart is laid out by weeks: each week has one column per
weekday the broker has daily bars on, so a holiday shows as an empty day,
while weekends and weeks with no candles take no room. It is display-only:
the candle list is never changed, so indicators, rules, backtests and alerts
compute as before. `lib/equalWidthDays.ts` builds the grid
(`buildSlotGrid(times, anchors)`, null without day and week starts; cached
per data list by `slotGridFor`) and `setEqualWidthDays` installs the provider
`globalThis.__chartkarSlots(list, chart)`, which the klinecharts patch
(`patches/klinecharts+10.0.0.patch`, `StoreImp._slots`/`_posOf`/`_idxOf`)
reads for every index/x conversion, the visible range, zoom and appended
history; without it every position equals the index. ChartCore gives each
chart its loader with `setSlotSource(chart, load)` (a new symbol or broker
drops the old starts); the provider asks it for any range the loaded candles
need (a failed range is not asked again within a minute), and edge candles
count on in whole days until the answer lands. New starts go through
`setSlotAnchors` and `relayoutSlots` (store method `chartkarRelayoutSlots`),
which keeps the candle in the middle of the view in place. A Trendlines line
pinned to 1D or coarser gets whole-day spans from the step map
(`buildHtfStepMap(..., slots)`, `candlePos`/`toIndex`), whole weeks for a 1W
pin, so the Smooth look of a 1D or 1W pin is straight. Its newest bar stays
flat on purpose, and a 1D line changes its angle a little at a holiday
column, since daily bars skip holidays. Out of scope: monthly pins;
drawings, indicator lines, chart-timeframe trendlines and alert lines
follow the slots but stay straight in time across a gap. Specs:
docs/superpowers/specs/2026-11-12-equal-width-days-design.md,
docs/superpowers/specs/2026-11-12-time-gaps-broker-days-design.md and
docs/superpowers/specs/2026-11-13-time-gaps-broker-bars-design.md.
