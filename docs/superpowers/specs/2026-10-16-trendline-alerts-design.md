# Trendline alerts

Status: designed 2026-10-16. Part of sub-project 2 of the alerts plan
(see 2026-10-10-indicator-value-alerts-design.md, "auto-trendline break").

## Goal

Alerts on the auto Trendlines indicator, two ways:

1. **This line.** Right-click one drawn trendline, "Add alert": price
   crosses / is above / is below that line.
2. **Nearest line.** "Add alert" on the Trendlines pane (legend bell or
   indicator menu): price crosses / is above / is below whichever line is
   nearest to price.

Both keep firing with no browser open, like every other alert, and both
allow "On bar close" and "Every tick".

## Non-goals

- Event alerts on Trendlines ("a new line formed", "a line broke and
  died"). The rest of sub-project 2 (FVG, SR, pivots, spikes) is separate.
- Drawing alerts (sub-project 3). The `line` kind below is built so trend
  line drawings can reuse it, but no drawing gets an "Add alert" here.
- Non-native timeframes: "Alerts on this timeframe are coming later", as for
  MA/RSI/ATR.
- Dragging a line alert on the chart. It is deleted or re-created, not moved.

## Shared idea: a straight line in bar space

Both alert types watch one straight line at a time, defined in BARS of the
alert's timeframe (the same space the indicator draws in, so weekends and
gaps match the chart):

```
level(j) = pRef + slope * (j - jRef)
```

`j` is a bar index in the server's candles for the alert's timeframe, `jRef`
the index of the reference bar `tRef`. Projecting to the forming bar is one
multiply, so "Every tick" costs nothing beyond what price alerts cost. The
only expensive step, recomputing the Trendlines indicator, happens once per
closed bar and only for nearest-line alerts.

## 1. This line (`kind: "line"`)

### Creating

- `useTrendlineMenu` gets an "Add alert" entry on a real line (not on a
  debug-layer `dbg:` line). The entry is disabled with a reason when the
  pane's alert timeframe (`alertTimeframeOf`, so a pinned pane uses its pin)
  is non-native; hidden on a seconds chart.
- The draft is built from the picked line's own TrendLine (its i1, p1, i2,
  p2 in the indicator's OWN series, which for a pinned pane is the pin's
  bars, not the chart's). From it:
  - `slope` = (p2 - p1) / (i2 - i1), price per bar of the alert timeframe.
  - `tRef`, `pRef`: the line projected to the newest CLOSED bar of that
    series. A recent reference keeps it inside every server seed.
  - `anchors`: {t1, p1, t2, p2} in timestamps, for display only.
- The dialog is the existing indicator alert dialog in price-target mode:
  condition, trigger (once / every), evalOn (close / intrabar), expiry.

### Params

```
{ kind: "line", timeframe, evalOn, condition, trigger,
  tRef, pRef, slope, anchors: {t1, p1, t2, p2},
  link: { scope, instanceId, lineKey } | null }
```

Validated server-side: finite numbers, native timeframe, `tRef` a bar
timestamp the server's candles contain (422 "line reference not found"
otherwise). The line is FROZEN: later Trendlines recomputes, settings edits
and the line dying do not move or delete the alert. Removing the Trendlines
pane offers to delete its line alerts, the same prompt as indicator alerts.

### Evaluating

- The hub serves the line as a series need (`IndicatorKey("LINE", (tRef,
  pRef, slope), ())`) so it reuses seeding, bar close and the forming bar.
  The level at the forming bar is the projection at `jRef + n`, no compute.
- Close mode: the pair is (last close, level at that bar) against (previous
  close, level at the previous bar), as for indicator alerts.
- Intrabar: (live price, level at the forming bar), baseline per tick.
- Rolling reference: when `tRef` is more than 500 bars behind the newest
  closed bar, the server re-anchors to that bar (new tRef, pRef) and
  persists it. Without this a 1m line would fall out of a 2000-bar seed in
  about 33 hours.

### On the chart

A dashed alert line along the frozen line, drawn on the linked cell while
it shows the alert's broker and epic, at any chart timeframe on which the
line's bar projection is the pane's own (the pinned rule from the MA work).
A bell sits where the line meets the right axis. The alerts panel lists it
as "Trendline (4H)".

## 2. Nearest line (`kind: "indicator"`, `indicator: "TRENDLINES"`)

### Identity

- `ALERTABLE["TRENDLINES"]`: one line `value` (the `tl_nearest` output),
  `priceTarget` only (no value target).
- `calcParams` is the full Trendlines array; `config` is the subset of
  extendData that `parse_trendlines_config` reads, normalised to strings so
  `IndicatorKey` stays hashable. Validation runs the parser rather than the
  int ranges the other indicators use. Display-only extendData (line marks,
  colours) is not part of the identity.
- Frontend `checkAlertable` mirrors this; `MAIN_LINE_KEY.TRENDLINES` is
  `tl_nearest`. `syncAlertsAfterEdit` already handles settings edits.

### Tracking the nearest line

At each bar close the hub recomputes the Trendlines indicator on its candles
(up to 2000 bars) and keeps the line nearest to that close as the HELD line
(slope, reference bar, price). Between closes nothing is recomputed.

- Intrabar: (live price, held line projected to the forming bar). Each tick
  is a projection, so every-tick evaluation is cheap.
- Close mode: (this close, previous bar's held line projected to this bar)
  against (previous close, that same line at the previous bar). The cross
  is always judged against ONE line.
- When the held line changes at a close, the intrabar baseline resets, so a
  switch to a different line is never read as a cross.
- No line drawn (empty pane) means no level: the alert waits.

### Known limits

- History: the server sees up to 2000 bars. With Lookback off the chart can
  draw a line from older history, so the server's nearest line can differ
  from the one on screen. The dialog notes "Uses the last 2000 bars".
- Hidden lines: a line the user hid (line marks) is still a candidate on the
  server, since marks are display-only. Accepted for v1; listed here so it
  is a decision, not a surprise.
- Cost: one full Trendlines compute per closed bar per distinct config. The
  plan measures the Python compute on 2000 bars before wiring; if it is too
  slow for 1m, the 1m timeframe is refused for nearest-line alerts.

## Engine changes

- `core/alert_kinds.py`: new `LineKind`; `IndicatorKind` gains the
  TRENDLINES branch. A kind can resolve the close-mode pair from both bars
  at once (the held-line rule needs the previous bar's line for the current
  pair), so close mode calls a `resolve_close(params, last, before, vals,
  pvals)` that defaults to today's two `resolve` calls.
- `core/alert_indicators.py`: a series need can be a cheap projector (LINE,
  and TRENDLINES between closes) instead of a full recompute per tick.
- `indicators/alertable.py`: the TRENDLINES entry, parser-based validation,
  and `compute` returning the held line per bar.
- The intrabar baseline reset hooks on a held-line signature change.

## Frontend changes

- `useTrendlineMenu.tsx`: "Add alert" entry, draft from the picked line.
- `lib/alertableIndicators.ts`: TRENDLINES in the registry, labels.
- `lib/alertsApi.ts`: the `line` kind in the alert union, list and panel.
- `lib/overlays`: the dashed sloped line and its bell for `line` alerts.

## Testing

- Backend: the projection matches the chart's across a weekend gap; the
  rolling reference keeps the level unchanged; crosses / above / below on a
  sloped line in both eval modes.
- Backend: a nearest-line switch with no price cross does not fire, in
  close and intrabar mode; a real cross of the held line does.
- Parity: a fixture pinning the held line and `tl_nearest` per bar, TS
  against Python, beside the existing `indicator_parity` fixtures.
- Validation: TRENDLINES configs accepted and refused; a `line` with an
  unknown `tRef` is refused.
- Frontend: the menu entry builds the right draft for a plain and a pinned
  pane, and is absent on a debug line.

## Build order

1. `line` kind end to end (backend kind, hub projector, menu entry, chart
   line, panel row).
2. Nearest line (registry, held-line tracking, parity fixture, bell).
