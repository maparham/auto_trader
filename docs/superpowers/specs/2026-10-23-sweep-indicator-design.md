# SWEEP (Stop Hunt) indicator

## Goal

Flag candles that carry the footprint of a stop run: price pokes through an
obvious level, then is rejected back through it on the same bar. One
indicator serves three uses:

1. Visual: highlight the candle and the swept level on the chart.
2. Backtests: fade the sweep (`SWEEP.bearSweep == 1` as a short entry).
3. Alerts and screens: the sweep and confirm outputs are events.

OHLC cannot prove manipulation. The indicator names what it measures (a
liquidity sweep with rejection), and the UI copy says "stop hunt", not
"manipulation".

## Non-goals

- Order-book spoofing or real footprint data (we have none).
- MTF pin (`@tf`). Chart timeframe only, like SPIKE.
- Auto-detecting whether a broker's volume is real.

## Shape

New instance type `SWEEP`, referenced as `SWEEP.<output>` (later instances
`SWEEP2.<output>`, ids minted by `mintInstanceId`), built like SPIKE: a
causal per-bar state machine in TS (`frontend/src/lib/indicators/sweep.ts`,
outputs and config parsing in `sweepOutputs.ts`) mirrored
operation-for-operation in Python (`backend/auto_trader/indicators/sweep.py`)
under the parity contract in `indicators/core.py`.

## Parameters (defaults)

| Param | Default | Meaning |
|---|---|---|
| `pivotLeft` / `pivotRight` | 5 / 5 | fractal pivot size for levels |
| `levelMaxAge` | 150 | bars a level stays live after its birth bar |
| `usePrevDay` | true | also treat the previous day's high/low as levels |
| `minWickPct` | 50 | swept-side wick as % of bar range for full wick credit |
| `atrLen` | 14 | ATR length for the range test |
| `minRangeAtr` | 1.5 | bar range in ATRs for full range credit |
| `useVolume` | false | add a volume z-score component |
| `volLen` / `volZ` | 20 / 2.0 | volume window and z for full credit |
| `minScore` | 70 | score at or above which the bar is flagged |
| `confirmBars` | 3 | bars without a close back through the level to confirm |
| `usePrevBar` | true | also flag an outside-bar reversal against the previous candle |
| `reversalsOnly` | false | flag only previous-candle reversals; no pivot or previous-day level is ever stored |

`tz` is read from `extendData.tz` with PREV_HL's `_zone` rules (both
parsers); SWEEP joins `TZ_STAMPED_TYPES` in
`frontend/src/lib/indicatorTimezone.ts` so the frontend stamps it.

## Levels (causal)

- A fractal pivot high at bar p (`pivotLeft` bars left, `pivotRight` right)
  is born at bar p + `pivotRight`, when it is confirmed. Never earlier. Its
  dashed segment starts at p.
- Previous-day high/low use PREV_HL's day-boundary logic in the pane tz. Each
  is born on the first bar of the new day, and its age and dashed segment
  start there. The source is blank when bar spacing exceeds one day, as in
  PREV_HL.
- A high level L dies on the first bar with `high > L`, whatever the close
  (a breakout kills it too). Every level crossed on that bar dies, and only
  the highest crossed level is a sweep candidate. Low levels mirror this
  with `low < L`.
- A level also dies once `i - born > levelMaxAge`.
- With `usePrevBar` on, the previous candle also contributes a one-bar level
  that is never stored: see "Previous-candle reversal" below.
- With `reversalsOnly` on, no level is ever born: pivot births and
  previous-day births are both skipped entirely, so the non-reversal sweep
  path can never fire. The previous-candle reversal is evaluated as if
  `usePrevBar` were on, whatever `usePrevBar` says. Everything else (score,
  confirmation, replacement, outputs, the "prev bar" label, the reversal
  border) is unchanged.

## Per-bar detection

Order within bar i: births, then expiry (a level is live while
`i - born <= levelMaxAge`), then crossings and scoring (the previous-candle
reversal level, when it applies, joins the crossing step here), then the
confirm check of the already-pending sweep, then recording this bar's flag.

Bear candidate: the highest live high level L with `high[i] > L`. It is a
sweep when `close[i] < L`. If the close is not below L it is a breakout: the
crossed levels die and nothing scores. Bull mirrors this on low levels with
`low[i] < L` and `close[i] > L`.

### Previous-candle reversal

With `usePrevBar` on (default), bar i >= 1 also tests an outside-bar
reversal against candle i-1, independent of any stored level:

- Bull reversal: candle i-1 is bearish (`close < open`, strictly),
  `low[i] < low[i-1]`, and `close[i] > high[i-1]`. Its level is `low[i-1]`.
- Bear reversal: candle i-1 is bullish (`close > open`, strictly),
  `high[i] > high[i-1]`, and `close[i] < low[i-1]`. Its level is
  `high[i-1]`.
- A doji previous candle (`close == open`) gives neither, and both are
  mutually exclusive on one bar.

When a reversal holds for a side, its level is a one-bar crossing candidate
(never stored, never expires) that joins that side's "most extreme crossed
level" contest: a stored level still wins if it is more extreme AND its own
close-back-inside test holds; the reversal level's close test always passes
by construction (the close is beyond the opposite extreme, which is further
than the level itself). An equal-price tie between a stored level and the
previous-candle level goes to the previous-candle level. A side with a
reversal flags regardless of its
score, the reported `score` output is still the computed sweep_score value,
and a reversal side beats a non-reversal flag on the other side even when
that side scored higher. Two non-reversal sides still resolve by score, with
an exact tie flagging neither.

Score (0 to 100) is a weighted mean of components clamped to [0, 1]. When
`range = high - low` is 0 the score is 0.

- wick (bear): `(high - max(open, close)) / range / (minWickPct / 100)`.
  Bull: `(min(open, close) - low) / range / (minWickPct / 100)`.
- close (bear): `(high - close) / range / (2/3)`, so a close in the bottom
  third gives 1. Bull: `(close - low) / range / (2/3)`.
- range: `range / (minRangeAtr * ATR[i-1])`. It uses the previous bar's ATR
  so the sweep bar cannot inflate its own denominator; 0 while ATR is in
  warmup.
- volume, only when `useVolume`: `z / volZ`, where z is
  `(vol[i] - mean) / stdev` over the `volLen` bars before i (population
  stdev, bar i excluded). Stdev 0 or warmup gives 0; negative z clamps to 0.

Weights: volume off gives wick 0.4, close 0.2, range 0.4. Volume on gives
wick 0.3, close 0.15, range 0.3, volume 0.25.

The bar is flagged when the unrounded score >= `minScore`, unless the side
holds a previous-candle reversal, which always flags. If a bar is a sweep
both ways (an outside bar), a reversal side beats a non-reversal side;
otherwise the side with the higher unrounded score wins and an exact tie
flags neither. Both sides' crossed levels die either way.

Confirmation: a flagged sweep becomes pending. A bear pending sweep confirms
at bar i + `confirmBars` if no close in (i, i + `confirmBars`] is above L;
a close above L drops it and nothing fires. Bull mirrors this. Any new flag,
on either side, replaces the pending sweep.

## Outputs (pane order)

| Output | Kind | Value |
|---|---|---|
| `bearSweep` | event | 1 on a flagged bear bar, else 0 |
| `bullSweep` | event | 1 on a flagged bull bar, else 0 |
| `bearConfirmed` | event | 1 on the bar a bear sweep confirms, else 0 |
| `bullConfirmed` | event | 1 on the bar a bull sweep confirms, else 0 |
| `score` | value | unrounded score of the last flagged sweep, forward-filled |
| `sweptLevel` | price | L of the last flagged sweep, forward-filled |
| `barsSince` | value | bars since the last flagged sweep (0 on the flag bar) |
| `bearReversal` | event | 1 on a previous-candle bear reversal bar, else 0 |
| `bullReversal` | event | 1 on a previous-candle bull reversal bar, else 0 |

The reversal outputs are 0 throughout while `usePrevBar` is off. A reversal
always flags its side, so each implies the matching sweep output, even when
a more extreme stored level wins the swept level.

Events are 0 from bar 0, including warmup. `score`, `sweptLevel` and
`barsSince` are None before the first flag. Only `sweptLevel` is a figure,
so a legend click gives `sweptLevel` or `bearSweep`, and other outputs are
typed by hand.

## Rendering

- Flagged candle: translucent box over its high/low range, red for bear,
  green for bull, alpha scaled by score.
- Swept level: dashed segment from the level's start bar to the sweep bar.
- Previous-candle reversal: the flagged box also gets a solid border.
- The chart redraws SWEEP on a chart-timezone change, as it does PREV_HL
  (ChartCore's zone effect), and resyncs linked alerts.
- Confirmed: small tick marker above or below the sweep candle.
- Readout: chart instances share the app legend (`legendTooltipSource`).
  Only `sweptLevel` is a figure (0/1 events or counts as overlay figures
  would crush the price axis autoscale, SPIKE's rule), so the legend shows
  the swept level and the "why" is a small chip over each flagged candle when bars are at least 5 px
  wide, reading the rounded score and the level source ("72 pivot",
  "81 prev day", "65 prev bar"). A `showLabels` extend toggle (default on)
  hides the chips.
- Draw culls to the visible range and clips strokes (chart draw perf rules).

## Registration

Backend:

- `indicators/registry.py`: series spec.
- `indicators/alert_specs.py`: a custom `AlertSpec`, not `_fixed`, since it
  needs `needs_volume=lambda cfg: cfg.use_volume`. It sets `heavy=True` and
  `sparse=True`. The four sweep and confirm outputs are EVENT, `sweptLevel`
  is PRICE, and `score` and `barsSince` are LEVEL. All seven are alertable.

Frontend:

- `customIndicators.ts`: type union, template map and type list.
- `indicatorMeta.ts`: params and InfoTip text.
- `exprInstances.ts`: the instance type list, the fixed-name `calcParams`
  types, the warmup floor and the `detail` string.
- `exprChartToken.ts`: the token, honouring `figureKey`.
- `indicatorTimezone.ts`: `TZ_STAMPED_TYPES`.

Warmup floor:
`max(atrLen + 1, useVolume ? volLen + 1 : 0, levelMaxAge + pivotLeft + pivotRight + confirmBars)`.
Confirm outputs lag their flag by confirmBars. Previous-day levels add a
calendar dependency that no bar count bounds; the warmup note says so, as
`prev_hl_warmup` does. With `reversalsOnly` on (both sides, other outputs):
`max(atrLen + 1, useVolume ? volLen + 1 : 0, 1 + confirmBars)`; the
level-life term drops since no level is ever stored. The reversal outputs
(`bearReversal` / `bullReversal`) stay 1 either way.

## Volume caveat

Dukascopy and Capital CFD volume is not traded volume. `useVolume` is off by
default; its InfoTip says it is only meaningful on brokers with real volume
(Yahoo stocks and ETFs).

## Testing

- Python unit tests on hand-built candles (spike tests style):
  - no level before pivot confirmation;
  - the highest crossed level wins, and every crossed level dies;
  - a breakout kills the level, and a later close back below it is not a
    sweep;
  - the outside-bar tie;
  - age expiry;
  - confirm, drop on a close back through, and replacement by a new flag;
  - volume weights rescale;
  - range 0 scores 0;
  - one case per default showing that a wick and close without range credit
    stays under `minScore`;
  - previous-candle reversal: bull and bear flags, the wrong-coloured
    previous candle, the close not beyond the opposite extreme (no level at
    all), always-flags under a high `minScore`/`minRangeAtr`, the toggle
    off, and a reversal beating a normal opposite-side flag on the same bar.
- Parity: SWEEP gets its own golden fixture, written by a TS test in the
  style of `indicatorParityGolden.test.ts` and asserted by `test_sweep.py`.
  `test_indicator_parity.py` is left alone.
- TS unit test for compute and config parsing.
- Only the affected test files run, never the full frontend suite.
