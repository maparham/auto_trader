# Equal-width days (display-only gap slots)

## Intent

A trendline pinned to the daily timeframe is straight in daily bars. On an
intraday chart it bends (Smooth) or steps (Steps), because days hold different
numbers of candles: early closes, late opens, halts, missing data. With this
setting on, every day on an intraday chart is drawn the same width: one slot per
chart period, each candle in its own time slot, and a slot with no candle left
as an empty gap. The pinned daily line then comes out straight.

It is display-only. The candle list is never changed, so indicators, rules,
backtests and alerts compute exactly as before.

Proven by the spike on `spike/gap-slots` (worktree `../auto_trader-gaps`):
`docs/superpowers/spike/` there holds the klinecharts diff and screenshots.

## Goals

- A global setting, off by default, that draws intraday charts with equal-width
  days.
- Candles at their time slot within the day; missing periods show as gaps.
- Scroll, zoom, crosshair, time axis, panes and loading more history keep
  working.
- A Trendlines line pinned to 1D is straight on an intraday chart in this mode.
- Off means today's chart, pixel for pixel.

## Non-goals (owner's call: "no need to touch drawings and indicators for now")

- Drawings, indicator lines, chart-timeframe trendlines, alert lines and
  picked-line clones get no changes. klinecharts places them through the same
  index-to-x mapping, so they follow the slots automatically, but a straight
  segment between two candles becomes straight in time. Across a gap, its
  pixels can then differ from the price its alert or rule computes from candle
  counts. Accepted for now.
- Weekly and monthly pins: weeks and months still differ in length, so those
  lines keep their kinks.
- Daily and coarser charts: the setting does nothing there.

## How it works (decided)

- **klinecharts patch** (added to `patches/klinecharts+10.0.0.patch`, ESM and
  CJS builds): the store gains an optional slot provider giving each candle a
  display position. `dataIndexToCoordinate`, `coordinateToFloatIndex`, the
  visible range, zoom anchoring and appended candles all work in positions;
  with no provider every position equals the index, as today. The spike's
  version is the starting point.
- **Slot grid** (app side): a day is a UTC calendar day (my call: Capital's
  daily bars open at 00:00 UTC; brokers whose day starts elsewhere, such as
  FX at 22:00 UTC, get UTC days too in this version). Slots run from the
  earliest to the latest time of day seen in the loaded candles, one chart
  period each, so a 7-hour stock session gets 7 slots, not 24. A DST shift
  adds one slot. Position = day number × slots per day + slot, where days are
  counted only when they hold candles (my call): weekends and holidays take no
  room, as the daily bars skip them too. A day that has a daily bar but no
  intraday candles (a data hole) also takes no room, so a pinned line kinks
  there; rare enough to accept for now.
- **Brokers whose day does not start at 00:00 UTC** (FX at 22:00 UTC,
  yfinance stocks at exchange midnight): the grid still uses UTC days, so
  pinned 1D lines there keep kinks where a UTC day and a daily bar disagree
  (my call). The acceptance test is a Capital chart. Anchoring the grid to the
  pin's own daily opens is a follow-up.
- **Where it applies** (my call): everywhere the chart is drawn from the
  user's settings, so the Telegram alert snapshot (which loads the mirrored
  settings) matches what the user sees. The public demo and the mobile view
  get it too if they read the same settings, and need no extra work.
- **Setting**: `equalWidthDays` in the global Settings (`theme.ts`), on the
  Chart section of the settings panel, labelled "Equal-width days" (my call),
  off by default. Toggling it relays out every open chart without a reload.
- **Pinned 1D Trendlines**: the step map's spans come from slot positions, so
  each day spans its full slot width and Smooth joins into one straight line.

## Left to the builder

- How the provider is wired: a global hook like the spike's
  `globalThis.__chartkarSlotBuilder`, or a per-chart setter on the store. A
  per-chart setter is preferred if it is cheap.
- Keeping the view steady when loading history widens the grid (the right
  edge and newest candle should not jump).
- What the newest, still-forming day draws to the right of the newest candle
  (empty slots until the day's end, or nothing).
- Tests: the slot grid as a pure function (sessions, holes, DST, a single day);
  the store mapping round trip (index to x to index) and visible range with a
  provider; the setting off leaving positions equal to indices.
- Performance: the grid is O(n) per data change and cached on the data list.
