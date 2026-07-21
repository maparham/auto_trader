# Rule Proximity Heatmap — design

**Goal:** A chart overlay that colors every bar by how close the current entry
rule group is to firing on that bar. The rule is evaluated on one fixed
timeframe (the rule's authored resolution) and the coloring remains visible when
the chart is viewed on any higher timeframe.

The rule engine only ever answers a boolean (does the entry fire on this bar).
This feature derives a continuous `closeness` value in `[0, 1]` from that same
rule, where `1` means the rule fires on this bar and lower values mean it is
progressively further from firing. That per-bar value drives the coloring.

## What the user sees

- A toggle on the chart turns the heatmap on.
- When on, each candle sits over a full-height translucent background column
  spanning the whole price area. Cool = far from firing, hot = about to fire,
  fully saturated hot = fires on this bar.
- A small control panel exposes: which side (Long or Short), the normalization
  basis and its sensitivity, and the higher-timeframe aggregation mode.
- The rule read is the **currently loaded backtest panel config**. Editing a
  rule updates the heatmap live (refetch + repaint).
- On timeframes below the rule's authored resolution, the heatmap is hidden.

## The closeness metric

A rule group is a list of rows combined by the group's `combine` operator
(`AND` or `OR`). Each row is a single comparison (`Compare`) or a cross
(`Cross`). The metric produces one closeness value per bar in three stages:
per-row closeness, then the fold across rows, evaluated on the base timeframe.

### Per-row closeness (comparison rows)

For a comparison `left OP right`, evaluate both operands to per-bar series
(reusing the existing `series_of`), then per bar:

1. **Signed gap, oriented toward firing:**
   - `OP` is `>` or `>=` → `g = left - right`
   - `OP` is `<` or `<=` → `g = right - left`

   `g >= 0` means the row fires; `-g` is how far short it is.

2. **Normalize and ramp:**
   ```
   d = relu(-g) / scale                 # 0 if firing, else fraction of a scale short
   closeness = clamp(1 - d, 0, 1)
   ```
   - Firing (`g >= 0`) → `closeness = 1`.
   - One full `scale` short → `0`. Beyond that → clamped to `0`.

   The ramp is linear. `scale` is defined by the normalization basis below.

**Worked example** — `close > EMA_9`, volatility basis, `width = 2`, where the
gap `close - EMA_9` has averaged `0.9` in absolute size over the recent window,
and this bar's `close = 99.5`, `EMA_9 = 100`:
```
g     = 99.5 - 100 = -0.5
scale = width * avgAbsGap = 2 * 0.9 = 1.8
d     = 0.5 / 1.8 = 0.28
closeness = 1 - 0.28 = 0.72
```

### Cross rows

`crossAbove(a, b)` / `crossBelow(a, b)` fire only on the single bar the lines
pierce. Treating that as `1`/`0` would leave any group containing a cross dark on
nearly every bar. Instead, measure how near the two lines are to touching,
symmetric in the gap:
```
d = abs(a - b) / scale
closeness = clamp(1 - d, 0, 1)
```
The lines heat as they converge, peak at ~1 when they touch (the cross bar),
and cool as they separate on either side. Direction is not distinguished: a
cross row's closeness is line-proximity, so it resets cleanly after the cross.
The `scale` comes from the same basis as a comparison row, computed on the
`a - b` gap series. Crosses are inherently approximate at the boundary (the
actual crossing happens between bars), unlike comparison rows which hit exactly
`1` on the firing bar.

### Normalization basis (`scale`)

User-selectable per heatmap. Two bases; `width` is a single global sensitivity
knob shared by all rows.

1. **Volatility of the gap (default).** Each row builds its own gap series
   `g[i]` over the window, and `scale = width * avgAbsGap`, where `avgAbsGap` is
   the average of `|g|` over a rolling window of `N` bars on that row's own gap
   series. Each row is auto-calibrated to how it normally moves, so the shared
   `width` ("N typical gaps out = cold") is meaningful across mixed operands
   (price, RSI, volume). Average absolute gap is used rather than standard
   deviation: simpler to explain and more robust to a single outlier bar.

   The scale is centered on **size, never on center**: the signed mean of the
   gap sits near zero for mean-reverting comparisons and must not be used.

2. **ATR.** `scale = width * ATR` (Wilder ATR, base timeframe). Clean for
   price-vs-level comparisons and unitless across instruments. Only meaningful
   when the gap is in price units.

Percent-of-reference was considered and rejected: a single `width%` means very
different things for price vs RSI vs volume, so it does not travel across a
group of mixed rows.

### Undefined and edge handling

- Any operand `None`/NaN on a bar (warm-up bars, data gaps) → that row's
  closeness is undefined → the bar's folded closeness is undefined → the bar is
  not painted.
- A rolling window with fewer than `N` valid gaps yet (early bars) → the row is
  undefined until the window fills → those bars unpainted.
- The per-row `count` ("Nth time") modifier is a firing-sequence gate, not a
  magnitude, so it does not change closeness. The row heats on its underlying
  comparison as normal.

### Fold (rows → one value per bar)

Combine the per-row closenesses by the group's operator, strict fuzzy logic:
```
AND group → min(rows)      # bar is as warm as its coldest row
OR  group → max(rows)      # bar is as warm as its hottest row
```
`min` reaches `1` iff every row fires; `max` reaches `1` iff any row fires. So
`closeness = 1` on exactly the bars the rule actually triggers, at the boundary
with no approximation.

Strict min/max is deliberate over softer aggregates (mean, RMS): a warm bar must
mean the whole rule almost fired, not that it was "generally close" while one
condition sat far off.

## Multi-timeframe behavior

- Closeness is computed once on the rule's **authored resolution** (the fixed
  base timeframe), using `series_of` so any `@TF` operands inside rows already
  align to the base bars.
- When the chart is viewed on a higher timeframe, each visible bar spans many
  base bars. The visible bar's color aggregates the base closeness values it
  covers. Aggregation mode is user-selectable: **max / avg / last**, default
  **max**. Aggregation reuses the existing HTF-to-base alignment machinery,
  applied in reverse (base values grouped into each display bar).
- Below the base timeframe the heatmap is hidden (there is no finer signal to
  show).

## Architecture

Backend owns the computation (business logic on the backend; the browser
renders). New endpoint `POST /api/expr/closeness`, extending the existing
`/api/expr/series` pattern.

**Request:**
- `broker`, `epic`, `priceSide`
- `rows`: the active side's rule rows (`expr` strings) plus the group `combine`
- `baseResolution`: the rule's authored resolution
- `displayResolution`: the chart's current resolution
- `fromTime`, `toTime`: the visible window
- `norm`: `{ basis: "volatility" | "atr", width: number, window: number, atrLength: number }`
  (`window` applies to the volatility basis; `atrLength` to the ATR basis)
- `agg`: `"max" | "avg" | "last"`

**Behavior:**
1. Parse and validate each row (`parse` + `validate`), reject malformed with the
   existing 422 shape.
2. Fetch base candles over the window (plus warm-up), and fetch HTF candles for
   any timeframes referenced by `@TF` operands (mirroring the backtest path).
3. For each row, compute `left`/`right` series via `series_of`, form the gap
   series, compute the rolling scale (volatility) or ATR scale, ramp to per-row
   closeness.
4. Fold per bar by `combine`.
5. Aggregate base closeness into display bars by `agg`, aligned to the display
   candle times.

**Response:**
```json
{ "times": [<display bar epoch seconds>],
  "values": [<closeness 0..1 or null per display bar>],
  "warmup": <int> }
```

## Frontend

- Reads the current backtest panel config's active side (Long or Short entry
  group), the app's current epic/broker/priceSide, and the chart window.
- Refetches on: config edit, side toggle, norm/agg change, window pan/zoom,
  resolution change.
- Renders a klinecharts background-column overlay: one full-height translucent
  rectangle per visible bar, color mapped from `closeness` on a cool-to-hot
  gradient. Null values render nothing.
- Hidden when the chart resolution is below `baseResolution`.

## Control surface and copy

A compact popover on the chart (reuse the shared `Tooltip`/`InfoTip` components
for any info affordances). Controls and copy (direct statements, no "how
much/far" framing, no em dashes):

- **Side**: Long | Short. Default Long.
- **Scale**: Volatility | ATR. Default Volatility.
  - InfoTip (Volatility): "Each condition is measured against how far it
    normally sits from its trigger."
  - InfoTip (ATR): "Each condition is measured in ATR units."
- **Sensitivity** (`width`): default `2`. InfoTip: "Higher values light up the
  chart from further away."
- **On higher timeframes** (`agg`): Max | Average | Last close. Default Max.
  InfoTip: "How each higher-timeframe bar combines the base bars it covers."

## Defaults

- Side: Long
- Basis: Volatility, `width = 2`, rolling `window = 50` bars
- ATR basis (when selected): Wilder length `14`, `width = 2`
- HTF aggregation: Max
- Base timeframe: the rule's authored resolution

## Testing

- Backend unit tests (pytest): per-row ramp (below/at/above trigger, clamp),
  gap orientation for each operator, volatility scale from a known gap series,
  ATR scale, cross-row approach and reset, undefined poisoning, min vs max fold,
  HTF aggregation for each mode.
- Golden-fixture parity where a row's closeness at the trigger boundary equals
  `1` exactly on the same bars the existing boolean evaluation fires (min/max
  boundary check).
- Frontend tests (vitest): request assembly from config + controls, gradient
  mapping (0 → cool, 1 → hot, null → unpainted), hidden below base resolution,
  refetch triggers.

## Non-goals

- No new persisted strategy fields. The heatmap reads the live backtest config;
  its own controls (side, basis, width, agg) are view state, not saved.
- No blending of Long and Short into one map. One side at a time.
- No percent-of-reference basis (rejected above).
- No softer fold (mean/RMS). Strict min/max only.
- No heatmap below the base timeframe.
