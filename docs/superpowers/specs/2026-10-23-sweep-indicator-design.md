# SWEEP (Stop Hunt) indicator

## Goal

Flag candles that carry the footprint of a stop run: price pokes through an
obvious level, then is rejected back through it on the same bar. One
indicator serves three uses:

1. Visual: highlight the candle and the swept level on the chart.
2. Backtests: fade the sweep (`SWEEP.bearSweep == 1` as a short entry).
3. Alerts and screens: `bearSweep`, `bullSweep` and `confirmed` are events.

OHLC cannot prove manipulation. The indicator names what it measures (a
liquidity sweep with rejection), and the UI copy says "stop hunt", not
"manipulation".

## Non-goals

- Order-book spoofing or real footprint data (we have none).
- MTF pin (`@tf`). Chart timeframe only, like SPIKE.
- Auto-detecting whether a broker's volume is real.

## Shape

New instance type `SWEEP`, referenced as `SWEEP#id.<output>`, built like
SPIKE: a causal per-bar state machine in TS (`frontend/src/lib/indicators/sweep.ts`,
outputs and config parsing in `sweepOutputs.ts`) mirrored
operation-for-operation in Python (`backend/auto_trader/indicators/sweep.py`)
under the parity contract in `indicators/core.py`.

## Parameters (defaults)

| Param | Default | Meaning |
|---|---|---|
| `pivotLeft` / `pivotRight` | 3 / 3 | fractal pivot size for levels |
| `levelMaxAge` | 150 | bars a level stays live after its pivot bar |
| `usePrevDay` | true | also treat the previous day's high/low as levels |
| `minWickPct` | 50 | swept-side wick as % of bar range for full wick credit |
| `atrLen` | 14 | ATR length for the range test |
| `minRangeAtr` | 1.5 | bar range in ATRs for full range credit |
| `useVolume` | false | add a volume z-score component |
| `volLen` / `volZ` | 20 / 2.0 | volume window and z for full credit |
| `minScore` | 60 | score at or above which the bar is flagged |
| `confirmBars` | 3 | bars without a close back through the level to confirm |

## Levels (causal)

- A fractal pivot high at bar p becomes a live level only at bar
  p + `pivotRight`, when it is confirmed. Never earlier.
- Previous-day high/low come from the same day-boundary logic PREV_HL uses
  (pane tz), live from the first bar of the new day.
- A level dies when it is swept (whether or not the bar scores high enough
  to flag) or when it is older than `levelMaxAge` bars.

## Per-bar detection

Bear sweep at bar i: some live high level L with `high[i] > L` and
`close[i] < L`. When several qualify, the highest L wins (the most
significant run). Bull is the mirror image on live low levels. A bar that
qualifies both ways takes the side with the higher score; ties take neither.

Score (0 to 100) is a weighted mean of components clamped to [0, 1]:

- wick: swept-side wick / range, divided by `minWickPct`/100 (weight 0.4)
- close: how deep the close sits inside the bar away from the sweep,
  `(L - close) / range` for bears, scaled so a close in the far third gives 1
  (weight 0.2)
- range: `range / (minRangeAtr * ATR)` (weight 0.4)
- volume, only when `useVolume`: `z / volZ` (weight 0.25, the other weights
  rescale to keep the sum at 1)

The bar is flagged when score >= `minScore`. ATR or volume still in warmup
gives that component 0.

Confirmation: a flagged bear sweep confirms at bar i + `confirmBars` if no
close in (i, i + `confirmBars`] is above L. A later flag before confirmation
replaces the pending one.

## Outputs (pane order)

| Output | Kind | Value |
|---|---|---|
| `bearSweep` | event | 1 on a flagged bear bar, else 0 |
| `bullSweep` | event | 1 on a flagged bull bar, else 0 |
| `confirmed` | event | 1 on the bar the pending sweep confirms, else 0 |
| `score` | value | score of the last flagged sweep, forward-filled |
| `sweptLevel` | price | L of the last flagged sweep, forward-filled |
| `barsSince` | value | bars since the last flagged sweep |

The forward-filled outputs are None before the first flag. The click token
emits `bearSweep` (outputs[0]) so a picked pane is usable at once.

## Rendering

- Flagged candle: translucent box over its high/low range, red for bear,
  green for bull, alpha scaled by score.
- Swept level: dashed segment from the pivot bar to the sweep bar.
- Confirmed: small tick marker above or below the sweep candle.
- Tooltip on the flagged bar: lines listing the level source (pivot or
  previous day), wick %, range in ATRs, volume z when on, score.
- Draw culls to the visible range and clips strokes (chart draw perf rules).

## Registration

Same touch points as SPIKE:

- backend: `indicators/registry.py` (series spec), `indicators/alert_specs.py`
  (events `bearSweep`, `bullSweep`, `confirmed` alertable; others not)
- frontend: `customIndicators.ts` (template), `indicatorMeta.ts` (params,
  InfoTip text), `exprInstances.ts` (instance type, warmup floor),
  `exprChartToken.ts` (token)

Warmup floor: `max(atrLen, volLen if useVolume, pivotLeft + pivotRight + 1)`.

## Volume caveat

Dukascopy and Capital CFD volume is not traded volume. `useVolume` is off by
default; its InfoTip says it is only meaningful on brokers with real volume
(Yahoo stocks and ETFs).

## Testing

- Python unit tests on hand-built candles: no level before pivot
  confirmation, highest level wins, level consumed after a sweep, both-sides
  tie, age expiry, confirmation and replacement, volume weights rescale.
- Parity test TS vs Python on a fixture series, joining
  `test_indicator_parity.py`.
- TS unit test for compute and config parsing.
- Only the affected test files run, never the full frontend suite.
