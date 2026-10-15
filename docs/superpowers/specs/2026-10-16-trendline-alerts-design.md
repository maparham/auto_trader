# Trendline alerts

Status: designed 2026-10-16, revised after review the same day. Part of
sub-project 2 of the alerts plan (see
2026-10-10-indicator-value-alerts-design.md, "auto-trendline break").

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
alert's timeframe (the space the indicator draws in, so weekends and gaps
match the chart):

```
level(j) = pRef + slope * (j - jRef)
```

`j` is a position in the server's candle series for the alert's timeframe
and `jRef` the position of the bar whose open time is `tRef`. Positions are
found by open time each time the series is (re)seeded, never stored, so a
sliding seed cannot shift them. Projecting to the forming bar is one
multiply.

## 1. This line (`kind: "line"`)

### Where the line comes from

The right-click menu only holds a `TrendlineSegment` (pixels plus a lazy
`clone`). The draw in `lib/indicators/trendlines.ts` builds each segment
inside a closure that has the `TrendLine` itself, in the indicator's own
series index (the pin's bars when the pane is pinned), and that series'
timestamps. The segment gains a second lazy accessor beside `clone`:

```
alertLine: () => { slope, tRef, pRef, t1, p1, t2, p2 } | null
```

- `slope` = (p2 - p1) / (i2 - i1): price per bar of the indicator's series.
- `tRef`, `pRef`: the line at the newest CLOSED bar of that series.
- `t1, p1, t2, p2`: the anchors as timestamps, for display only.
- null when the series has no closed bar at or after i2, or the anchors
  do not map to timestamps; the menu then disables "Add alert" with "This
  line can't take an alert yet".

A debug-layer (`dbg:`) line has no `alertLine` and no entry. The entry is
disabled with "Alerts on this timeframe are coming later" when the pane's
alert timeframe (`alertTimeframeOf`, so a pinned pane uses its pin) is
non-native, and hidden on a seconds chart.

The dialog is the existing indicator alert dialog in price-target mode:
condition, trigger (once / every), evalOn (close / intrabar), expiry.

### Params

```
{ kind: "line", timeframe, evalOn, condition, trigger,
  tRef, pRef, slope, anchors: {t1, p1, t2, p2},
  link: { scope, instanceId, lineKey } }
```

- `link` is REQUIRED for this kind (`lineKey` is the segment key, 1 to 64
  chars), so removing the Trendlines pane finds and offers to delete its
  line alerts through the existing scope + instanceId match.
- All numbers finite; timeframe native.

### Creating: the server checks the reference

The chart's newest closed bar is not guaranteed to be the server's (offset
grids, one bar of lag either way). On create the server loads the alert's
series and accepts `tRef` when it is the open time of any bar in it, closed
or forming. Otherwise it 422s with "Chart and server bars disagree; reload
the chart". A mismatch is reported, never guessed around.

### Evaluating

The hub serves the line as a real, cheap series need, so it gets bar close,
the forming bar and the `closed` signal like any indicator:

- Need key: `IndicatorKey("LINE", (tRef, pRef, slope), ())`. The hub's
  `warmup`, `compute`, `ready` and `volume_weighted` gain explicit LINE
  branches; nothing falls through to the MA/RSI/ATR code.
  - warmup: bars from `tRef` to now, plus 2.
  - compute: the projection at every position from `jRef` on (None before),
    O(n) multiplies, no indicator maths. Intrabar's once-a-second recompute
    with the forming bar is therefore cheap too.
  - ready: the newest closed position has a value.
- Close mode: (last close, level at that bar) against (previous close,
  level at the previous bar), exactly as indicator alerts do today. The
  series lands in `closed` because the hub refreshed it.
- Intrabar: (live price, level at the forming bar), baseline per tick.

### Rolling the reference forward

`tRef` has to stay inside the seed (2000 bars; on 1m that is about 33
hours). When the newest closed bar is more than 1000 bars past `tRef`, the
engine rebases: `pRef' = pRef + slope * (j' - jRef)`, `tRef'` = that bar's
open time.

- One multiply per rebase, at most once per 1000 bars, so float error stays
  around 1e-12 relative. Tests compare with a relative tolerance of 1e-9.
- Written through a new store method that patches `tRef`/`pRef` only, then
  the engine's in-memory row and its hub need are swapped in place.
- `LineKind.sig` covers `slope`, `anchors`, `timeframe`, `evalOn`,
  `condition` and `trigger`, NOT `tRef`/`pRef`. A rebase therefore keeps the
  baseline and `last_fired_bar`. A real edit (new condition, say) still
  resets them, as today.

### On the chart

A dashed alert line along the frozen line on the linked cell, while it
shows the alert's broker and epic and its pane's alert timeframe equals the
alert's (the same rule as the pinned MA work). It is drawn from `anchors`
through the chart's own bars. A bell sits where it meets the right axis.
The alerts panel lists it as "Trendline (4H)".

The line is FROZEN: later recomputes, settings edits and the line dying do
not move or delete the alert. `syncAlertsAfterEdit` skips `line` alerts.

## 2. Nearest line (`kind: "indicator"`, `indicator: "TRENDLINES"`)

### Identity

- `ALERTABLE["TRENDLINES"]`: one line `value` (the nearest line),
  `priceTarget` only, no value target.
- `calcParams` is the CANONICAL full array: the frontend resolves its
  saved params through `parseTrendlinesConfig` (legacy `declutter`,
  near-price and merge migrations included) and sends every slot. `config`
  is `{}`. The server re-parses with an empty extendData and 422s when the
  result differs from what it was sent. The pin is not identity; it is the
  alert's `timeframe` (`alertTimeframeOf`). Line marks, colours and other
  display fields are not identity.
- `validate_indicator` gains a TRENDLINES branch (parser instead of int
  ranges). `warmup` returns `MAX_WARMUP` so the server loads all the
  history it can. `ready` for TRENDLINES only requires `value` (the
  `tl_k` outputs are sparse by design).
- Frontend: `AlertIndicator` gains `"TRENDLINES"`; `MAIN_LINE_KEY.TRENDLINES`
  is `tl_nearest` (the result key, as `ma`/`val`/`atr` are for the others);
  `checkAlertable` gets a TRENDLINES branch; `IndicatorIdentity` equality
  compares the canonical arrays, so `syncAlertsAfterEdit` re-points or
  prompts on a settings change as for MAs.

### Tracking the nearest line

The TRENDLINES compute returns three per-bar series:

- `value`: the nearest line's level at bar i (`tl_nearest`).
- `held`: the line that was nearest at bar i-1, projected to bar i.
- `held_sig`: that line's anchors, as one number-stable signature.

It also leaves the hub a HELD line (slope, reference bar, price) for the
newest closed bar.

- **Close mode.** A new kind hook, `resolve_close(params, last, before,
  vals, pvals)`, defaults to today's two `resolve` calls. TRENDLINES
  overrides it: cur = (last close, `vals.held`), prev = (previous close,
  `pvals.value`). Both are the SAME line, at bars i and i-1, so a cross is
  always judged against one line. Plain floats suffice; no line object
  crosses the hub boundary.
- **Intrabar.** The hub's intrabar path, for TRENDLINES, does NOT recompute.
  It projects the held line to the forming bar (one multiply) and returns
  that as `value`. The full compute runs once per closed bar only.
- **Baseline reset.** The hub exposes the held line's signature. When it
  changes at a close, the engine drops that alert's intrabar baseline, so
  a switch to a different line is never read as a cross.
- No line drawn (empty pane) means no level: the alert waits.

### Known limits

- History: the server sees up to 2000 bars and the chart sees what it has
  loaded, so the two can find different lines. This covers Lookback off
  (an old line the server never saw) and lines near the start of either
  history (`has_back_clearance` rejects a window that reaches before the
  first bar). The dialog notes "Uses the last 2000 bars".
- Hidden lines: a line the user hid (line marks) is still a candidate on the
  server, since marks are display-only. Accepted for v1.
- Cost: one full Trendlines compute per closed bar per distinct config. The
  plan measures the Python compute on 2000 bars first; if it is too slow
  for 1m, nearest-line alerts refuse 1m.

## Engine and hub changes (summary)

- `core/alert_kinds.py`: `LineKind` (validate, sig, resolve, label);
  `resolve_close` on the protocol with a default; the link validator allows
  `lineKey` and requires a link for `line`.
- `core/alert_engine.py`: close mode calls `resolve_close`; the rebase step
  for `line`; the baseline reset on a held-line signature change.
- `core/alert_indicators.py`: LINE and TRENDLINES branches in `ready`; the
  held-line cache and the projection-only intrabar path for TRENDLINES.
- `indicators/alertable.py`: LINE and TRENDLINES in `warmup`, `compute`,
  `volume_weighted`, `validate_indicator` and `indicator_label`.
- Alert store: a narrow patch for `tRef`/`pRef`.

## Frontend changes

- `lib/indicators/trendlines.ts` + `trendlineMarks.ts`: `alertLine` on the
  segment.
- `chart/useTrendlineMenu.tsx`: "Add alert" entry and its draft.
- `lib/alertableIndicators.ts`: TRENDLINES registry branch, canonical
  params, labels.
- `lib/alertsApi.ts`: the `line` kind in the alert union, list and panel;
  `syncAlertsAfterEdit` skips it.
- `lib/overlays`: the dashed sloped line and its bell for `line` alerts.

## Testing

- `line`: the projection matches the chart's across a weekend gap; a
  rebase keeps the level (relative 1e-9) and keeps `last_fired_bar`;
  crosses / above / below on a sloped line in both eval modes; close mode
  actually fires (the series reaches `closed`); a `tRef` outside the
  server's bars 422s.
- Nearest: a held-line switch with no price cross does not fire, in close
  and intrabar mode; a real cross of the held line does; an empty pane
  never fires and `ready` stays true when only a few lines are drawn; the
  intrabar path makes no full compute (counted).
- Parity: a fixture pinning `value`, `held` and `held_sig` per bar, TS
  against Python, beside the existing `indicator_parity` fixtures.
- Validation: canonical TRENDLINES arrays accepted, a non-canonical one
  refused; a `line` without a link refused.
- Frontend: `alertLine` for a plain and a pinned pane (pin-bar slope, not
  chart-bar slope); the menu entry is absent on a debug line and disabled
  on a non-native pin.

## Build order

1. `line` kind end to end (segment accessor, server kind and hub branch,
   rebase, menu entry, chart line, panel row).
2. Nearest line (canonical identity, held-line compute and cache,
   `resolve_close`, parity fixture, bell).
