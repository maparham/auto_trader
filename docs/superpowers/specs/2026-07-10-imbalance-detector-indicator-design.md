# Imbalance Detector Indicator — Design

Port of LuxAlgo's "Imbalance Detector" TradingView (Pine v5) indicator into our
klinecharts-based chart, as a native custom indicator.

## Scope

**In:** All three detections drawn as boxes on the candle pane — Fair Value Gaps
(FVG), Opening Gaps (OG), Volume Imbalances (VI) — with per-type colors, a
min-width filter, and a width mode. Filled boxes hidden once fully traversed.

**Out (deliberate, YAGNI):**
- Dashboard table (frequency / filled %)
- Alerts (the 6 `alertcondition`s)
- A "keep filled boxes" toggle (user chose hide-once-filled)

## Architecture

New indicator type `IMBALANCE`, modeled on `TIME_HIGHLIGHT`:

- `frontend/src/lib/indicators/imbalanceDetector.ts` — `calc` (detect zones over
  full history) + `draw` (canvas render). `series: IndicatorSeries.Price`,
  `figures: []`, `precision` from instrument. Config read from
  `ind.extendData` as `ImbalanceExtend`.
- Register in `frontend/src/lib/customIndicators.ts` (`BASE_TEMPLATES`).
- Inputs schema + friendly title/desc in `frontend/src/lib/indicatorMeta.ts`.
- Dedicated settings panel `frontend/src/indicatorSettings/ImbalancePanels.tsx`
  wired into `IndicatorSettings.tsx`.
- Fixture test `frontend/src/lib/indicators/imbalanceDetector.test.ts`.

Unlike `TIME_HIGHLIGHT` (full-pane-height bands, per-bar data), zones are
**price-bounded** (use `yAxis.convertToPixel(top/btm)` for vertical edges) and
**sparse** (each zone stored at its origin bar's `result[]` index; `draw`
collects them across the array).

## Data model

```ts
type ImbalanceKind = "fvg" | "og" | "vi";

interface ImbalanceZone {
  kind: ImbalanceKind;
  dir: "bull" | "bear";
  originIndex: number; // left edge bar index (n-1 for VI/OG, n-2 for FVG)
  top: number;         // higher price bound
  btm: number;         // lower price bound
  mid?: number;        // FVG mid-line only
  fillIndex: number | null; // first bar that fully traverses; null = active
}

// calc returns an array aligned to dataList; result[i].zones holds zones whose
// origin is bar i (usually empty). draw flattens all result[*].zones.
```

## Detection (ported verbatim; verified against source)

`n` = current bar index. Bounds reused by VI and OG:
`gap_top_bull = min(close, open)`, `gap_btm_bull = max(close[1], open[1])`;
bear mirrors with `max(close[1],open[1])` / `min(close,open)` swapped per source.

- **VI bull:** `open>close[1] & high[1]>low & close>close[1] & open>open[1] &
  high[1]<gap_top_bull` → zone `[gap_btm_bull, gap_top_bull]`, origin `n-1`.
  Bear symmetric.
- **OG bull:** `low>high[1]` → same bounds as VI bull, origin `n-1`. Bear:
  `high<low[1]`.
- **FVG bull:** `low>high[2] & close[1]>high[2] & not(og_bull@n or og_bull@n-1)`
  → zone `[high[2], low]`, `mid=avg(low,high[2])`, origin `n-2`. Bear:
  `high<low[2] & close[1]<low[2] & not(og_bear@n or og_bear@n-1)` → zone
  `[high, low[2]]`, `mid=avg(low[2],high)`.

**Ordering rules (from advisor review):**
1. Compute OG before FVG each bar.
2. FVG **always** subtracts OG regardless of OG's *display* toggle — detection
   is decoupled from display. (Diverges intentionally from the Pine, where
   `show_og=false` resurrects suppressed FVGs. Documented divergence.)

## Fill = full traversal (not touch)

A **bull** zone's `fillIndex` = first later bar with `low < btm`; a **bear**
zone's = first later bar with `high > top`. Price clearing the far side, not
merely entering. Matches the Pine `bull_filled`/`bear_filled`. VI preserves the
source's one-bar offset on the fill check (uses previous-bar values); not
"fixed" into uniformity.

Because the user chose **hide-once-filled**, `draw` renders only zones with
`fillIndex === null`.

## Min-width filter (per type)

`usewidth` on/off, `width` value, `method`:
- `Points`  → `dist > width`
- `%`       → `dist / btm * 100 > width`  (relative to bottom, per source)
- `ATR`     → `dist > atr200 * width`

`dist = top - btm`. `atr200` = Wilder ATR(200) over the history; reuse an
existing util if present, else a small local helper in this module. Filter is
applied at detection time (a zone failing min-width is never created).

## Rendering — three distinct looks

Canvas alpha = `(100 - pineTransp) / 100` (Pine transparency is inverted).

- **VI** → dotted border (bull/bear color), **no fill**.
- **OG** → fill at alpha `0.5`, no border, "OG" text label centered.
- **FVG** → fill at alpha `0.2` (lighter) + horizontal mid-line at `mid` in the
  bull/bear color.

Colors: `bull`/`bear` per type. Defaults match LuxAlgo — bull `#2157f3`, bear
`#ff1100`.

Horizontal extent by **width mode** (global):
- `Fixed` (default): right edge = `n + extendBars` where `extendBars` is
  per-type (FVG 0, OG 0, VI 5), matching the source `*_extend` inputs.
- `Extend to current bar`: right edge = latest bar index; active boxes stretch
  rightward and vanish the moment they fill.

Left edge = `originIndex`. Vertical edges via `yAxis.convertToPixel`.

## Settings UI (`ImbalancePanels.tsx`)

Three groups (FVG / OG / VI), each: show toggle, bull color, bear color,
Min-Width (on/off + value + method select). Plus a global Width-Mode select
(Fixed / Extend to current bar).

**Tooltips (per CLAUDE.md):** every non-trivial control gets an `InfoTip`
(shared `Tooltip` wrapper) — what each imbalance type is, what Min-Width does,
what Points/%/ATR each mean, and Fixed vs Extend-to-current-bar. No native
`title=`.

Config stored on `extendData`; persisted via existing `saveIndicatorConfig`.

## Testing

**Fixture test first (TDD).** Hand-craft short OHLC sequences each containing one
known bull and one bear FVG, OG, and VI. Run `calc`; assert exact zones (kind,
dir, top, btm, originIndex, fillIndex) and that min-width filtering and the
OG→FVG exclusion behave. This is the correctness gate; a subtle top/btm
inversion or misread condition produces plausible-but-wrong boxes that visual QA
won't catch.

Then verify visually in the browser on a real symbol (claude-in-chrome).

## Open divergences from source (documented, intentional)

1. FVG exclusion of OG is independent of OG display toggle.
2. Filled boxes are hidden (source keeps them; we dropped the dashboard that
   relied on them).
3. Width mode adds an "extend to current bar" option not in the source (default
   stays faithful/fixed).
