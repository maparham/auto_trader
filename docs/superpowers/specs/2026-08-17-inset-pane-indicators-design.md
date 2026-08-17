# Inset: pane indicators drawn inside the candle pane

**Date:** 2026-08-17
**Status:** Approved

## Summary

Add an **Inset** display mode for the pane indicators whose templates we own
(RSI, ATR, SLOPE). An inset indicator is created on `candle_pane` instead of
opening its own bottom sub-pane, and paints itself into a shared band across the
bottom of the candle pane in pure pixel space: normalized to its own value
domain, translucent over the candles, with its own reference lines and a
left-edge value readout. It contributes nothing to the price y-axis, so the
price scale keeps every tick it has today and the candles keep the full pane
height.

The mechanism is the one `lib/indicators/sessions.ts` and
`lib/indicators/proximityHeatmap.ts` already use: an indicator with
`figures: []` and a custom `draw` that reads `bounding` and returns `true`
(isCover), so klinecharts runs the template's `calc` but draws none of its own
figures. `ProximityHeatmap` already ships exactly this way on `candle_pane`
(`chart/useProximityHeatmap.ts:70`), which is the production proof that the
approach holds.

Inset is a per-instance property, persisted with the instance, toggled from the
legend row's TradingView-style context menu.

## Goals

- A pane indicator can be moved into the candle pane and back, per instance,
  without losing its params, styles, or visibility state.
- An inset indicator never widens, rescales, or re-precisions the price y-axis,
  under either state of the existing "Scale price chart only" toggle.
- Inset survives reload, tab sync, templates, snapshots, and the pane
  reorder/rebuild paths, because it rides the existing persisted instance shape
  through the single `applyIndicator` choke point.
- The value the missing axis would have shown is still readable: the existing
  legend row keeps working, plus a left-edge in-band label per inset instance.
- Several inset indicators at once share one band, overlaid, each normalized
  independently.

## Non-goals

- Inset for klinecharts' built-in pane indicators (MACD, VOL, KDJ, CCI, ...).
  klinecharts exports `getSupportedIndicators()` but no `getIndicatorClass`, so
  their templates cannot be read and wrapped; supporting them means a generic
  figure interpreter applied through `overrideIndicator`, which is a separate
  project.
- A draggable or configurable band height. The band is a constant fraction with
  clamps.
- Per-instance bands, stacked sub-bands, or a y-axis of any kind for the band.
- Any change to `collapseSubPanes`. That feature reclaims pane height by hiding
  the indicator; inset reclaims it while keeping the indicator visible. They are
  independent and both stay.
- Fixing `ProximityHeatmap`'s `precision: 0` (see "Precision" below). Flagged,
  not in scope.

## Architecture

### 1. Persistence: the `inset` flag

`IndicatorInstance` (`frontend/src/lib/persist/artifacts.ts:164`) gains an
optional field:

```ts
export interface IndicatorInstance {
  id: string;
  type: string;
  inset?: boolean;
}
```

`loadIndicators` currently normalizes each entry to `{ id: e.id, type: e.type }`,
which **strips any field it does not name**, so the flag must be added to that
mapper or it silently dies on reload:

```ts
typeof e === "string"
  ? { id: e, type: e }
  : { id: e.id, type: e.type, ...(e.inset ? { inset: true } : {}) }
```

Writing `inset: true` only when set keeps existing saved payloads
byte-identical, which matters because `lib/templateSignatures.ts` compares saved
shapes to decide whether a template needs re-merging. That comparison must be
checked against the new field before it ships.

Templates, snapshots, and default-layout payloads all reuse
`IndicatorInstance[]` verbatim (`lib/persist/snapshots.ts:19`,
`lib/persist/defaults.ts:329,367`), so they carry inset for free once load
preserves it.

### 2. Creation: `applyIndicator` routing

`applyIndicator` (`lib/indicators.ts:~481`) is the one creation choke point:
hydrate, fresh add, paste, reorder, templates and snapshots all pass through it.
It currently computes

```ts
const isOverlay = OVERLAY_INDICATORS.has(type);
const initialPaneId = opts?.paneId ?? (isOverlay ? "candle_pane" : undefined);
```

Inset joins that decision: an instance with `inset` resolves the same way an
overlay does (stack onto `candle_pane`, no `setPaneOptions`, no
`overrideYAxis`), and the create value is built from the inset template rather
than the base one. Nothing else in the function changes, so every path that
already round-trips an instance inherits inset placement.

`isSubPaneIndicator(type)` (`lib/indicators.ts:85`) is type-keyed and drives the
auto-expand-on-add behavior. It gains an instance-aware sibling
(`isSubPaneInstance(inst)`) so adding an inset RSI does not expand collapsed
sub-panes to show a pane that was never created. Every current caller of the
type-keyed form is reviewed and moved over where it has an instance in hand.

### 3. The inset template: `lib/indicators/inset.ts` (new)

```ts
export const INSET_CAPABLE = new Set(["RSI", "ATR", "SLOPE"]);
```

Only indicators whose templates we own can be inset. `SLOPE_ACCEL` is not
listed: it is derived state owned by its parent (`syncAccelCompanion`).

**Amended during implementation.** An earlier draft of this paragraph said the
companion inherits the parent's inset flag and draws into the same band as a
second line. That is not what shipped, because the companion is created by
`chart.createIndicator` INSIDE `syncAccelCompanion` rather than through
`applyIndicator`, so inheriting inset is not a flag: it would need its own
registered inset template, creation on `candle_pane`, and a rework of the
"companion sits directly below its parent" pane-ordering logic. What ships is
the parent going inset while the companion stays a sub-pane, and
`syncAccelCompanion` / `mirrorAccelCompanion` explicitly strip the marker off
the companion's inherited `extendData` (a `withoutInset` helper) so it never
draws band geometry inside a sub-pane. Consequence to know: an inset SLOPE with
Show Accel enabled still shows one sub-pane, and that pane always takes the
recreate branch rather than the in-place-update branch on every settings edit.

`insetTemplate(base, type)` returns a clone of a `BASE_TEMPLATES` entry with:

| field | value | why |
|---|---|---|
| `figures` | `[]` | keeps the instance out of the pane's y-range math |
| `regenerateFigures` | `null` (dropped) | klinecharts calls it on every calcParams change and would refill `figures`, defeating the line above (SLOPE has one) |
| `precision` | `INSET_PRECISION = 8` | high enough that the pane's `Math.min` is always the price precision |
| `extendData.inset` | `true` | the one marker; everything else derives from it |
| `draw` | `drawInset(base, spec)` | pixel-space band paint, returns `true` |

**No figure or precision copies in `extendData`.** The legend and the draw both
need the base template's figure list and precision, but neither is stored: both
derive at read time from `BASE_TEMPLATES[indTypeOf(ind)]`, which is in-process and
always current. That matters for SLOPE, whose figure list is a function of
`calcParams` via `regenerateFigures`: a stored copy would go stale the moment the
user edits the length in the settings modal (which calls `overrideIndicator`, not
`applyIndicator`, so nothing re-registers the template). Deriving means there is
no stale copy to go wrong, and `extendData` grows by exactly one boolean.

`applyIndicator` writes that boolean the way it already writes `indType`: set when
`inst.inset` is true, **deleted** otherwise. Deriving it from the instance rather
than trusting the saved snapshot is what stops a stale `inset: true` in a saved
config, template, or pasted payload from resurrecting the mode after the user
turned it off. Deleting rather than writing `false` keeps every existing non-inset
payload byte-identical, which is what `lib/templateSignatures.ts` compares.

**Why `figures: []` rather than relying on `isCover` alone.** The pane's y-range
is computed from `indicator.figures[].key` values over the visible range
(`node_modules/klinecharts/dist/index.esm.js:11123`), independent of whether
`draw` covers the figure loop. The existing `scalePriceOnly` override
(`chart/priceOnlyRange.ts`, default on) would mask that while it is on, by
fitting the axis to candle highs and lows alone, but the user can turn it off,
and then an inset RSI's 0-100 range would flatten the candles to a line. Empty
figures make inset correct under either setting.

**Precision.** `index.esm.js:11074` min-reduces the pane's tick precision across
every indicator on the pane's default y-axis. An RSI with `precision: 2` on
`candle_pane` would therefore round a 5-decimal FX price axis to two places, so
the inset instance carries a deliberately high `precision` and the real value
moves to `extendData.insetPrecision`. Corroboration that this path is real:
`ProximityHeatmap` ships `precision: 0` on `candle_pane` today
(`lib/indicators/proximityHeatmap.ts:61`), which should be forcing integer price
ticks whenever the rule heatmap is on. That looks like a live bug; it is out of
scope here but worth a follow-up.

### 4. Band geometry and normalization (pure, unit-tested)

```ts
export const INSET_BAND_FRACTION = 0.28;
export const INSET_BAND_MIN_PX = 56;
export const INSET_BAND_MAX_FRACTION = 0.4;

// Band rect in pane-local pixels, from the pane's bounding box.
export function insetBandRect(bounding: { width: number; height: number }):
  { top: number; height: number };
```

Height is `min(max(height * FRACTION, MIN_PX), height * MAX_FRACTION)`, anchored
to the pane's bottom edge. The `MAX_FRACTION` cap is applied last and always, so
a pane shorter than `MIN_PX` yields a proportionally short band rather than a
band taller than its pane; a zero-height pane yields a zero-height band, which
the draw treats as "nothing to paint".

Every inset instance draws into the **same** rect. Normalization is per instance,
and the only thing that varies by type is the domain:

```ts
interface InsetSpec {
  domain: [number, number] | "auto"; // fixed, or visible min/max
  pad: number;                       // fraction of the domain, auto domains only
}
```

- RSI: `domain: [0, 100]`. Fixed, so the 30/70 levels sit at a stable height
  instead of breathing with the data.
- ATR: `domain: "auto"`, `pad: 0.08` (mirrors the `gap` the sub-pane path already
  applies via `overrideYAxis`).
- SLOPE: `domain: "auto"`, `pad: 0.08`.

No `refLines` and no `keys` list: both are already expressed in the base template
and its own `draw` (see §5), so restating them here would be a second source of
truth.

`resolveDomain(indicator, spec, visibleRange)` returns the concrete `[lo, hi]`,
reading every line-figure key of the base template over the visible range for
`"auto"`. SLOPE's title-less `thHi` / `thLo` figures exist precisely to pull the
sub-pane's auto-scale out to the threshold, and because they are ordinary line
figures they widen the inset domain for free.

`valueToBandY(value, domain, height)` is pure and returns a **band-local** y (0 at
the band's top edge). Out-of-domain values clamp to the band edges, and a
degenerate domain (`lo === hi`) centres the value.

### 5. Drawing

One **generic** wrapper serves all three types, rather than a hand-written inset
draw per type. This is possible because every value-to-pixel conversion in our
pane-indicator draws goes through exactly one method: `yAxis.convertToPixel`
(verified across `rsi.ts`, `slope.ts`, `atr.ts`; nothing calls
`convertFromPixel`, `getRange`, or `getTicks`). Give the base draw a substitute
converter and a relocated coordinate frame, and it cannot tell it is no longer in
its own pane.

`drawInset(base, spec)` returns an `IndicatorDrawCallback` that:

1. Resolves the band rect from `bounding` and the domain from the visible range.
2. `ctx.save()`, `ctx.translate(0, rect.top)`, and clips to
   `(0, 0, bounding.width, rect.height)`. From here on, y = 0 is the band's top
   edge, so every downstream paint is automatically inside the band.
3. Paints the band chrome: a faint fill and a hairline along the top edge, so the
   region reads as a band rather than as stray curves. Painted once per frame by
   the first instance in inset order; hidden instances are excluded from that
   order, so hiding the topmost inset does not take the chrome with it.
4. Calls `base.draw?.(...)` with `yAxis` replaced by a shim whose
   `convertToPixel(v)` is `valueToBandY(v, domain, rect.height)` and `bounding`
   replaced by one of band height. **This is what makes inset faithful rather than
   approximate:** RSI's overbought/oversold band, its zone fills, its smoothing
   line and its divergence segments, and SLOPE's zero line and threshold lines,
   all render in the band with no per-type code, because they were already written
   against `yAxis.convertToPixel` and `bounding.height`. The base's return value
   is discarded.
5. Strokes each line figure of the base template as a polyline over the visible
   range, using the same shim, colored from `ind.styles.lines[i].color` (so a
   recolor in the settings modal carries into inset with no extra wiring) at
   reduced alpha via `hexToRgba`. This step exists because `figures: []` plus the
   isCover return means klinecharts draws no figures itself.
6. Paints the left-edge label: `RSI 14  57.2` in the plot color, from the **last
   visible bar**, formatted with the base template's precision. Hover readout is
   the legend row's job, which already fills per-figure values on the crosshair
   path, so the draw needs no crosshair state plumbed into it.
7. `ctx.restore()` and returns `true`.

**Known limitation, accepted:** nothing in the base draws reads `bounding.top` or
`bounding.bottom` today (verified across `src/`), which is what makes the
translated frame safe. A future pane-indicator draw that does read them would
need to go through the shim too.

**Inset order.** Labels stack one line per instance and the chrome is painted
once, so each `draw` needs its own index. It is derived, not stored:
`insetOrder(chart)` filters `chart.getIndicators({ paneId: "candle_pane" })` to
inset instances that are visible and returns their names in order; the draw finds
itself by `indicator.name`. Stateless, so it cannot drift from what is actually
on the pane.

**Z-order.** Candle-pane indicators paint after the candle bars, so inset lands
over them; translucency is what keeps the candles readable. `zLevel` on the
indicator is available if the empirical check says the ordering needs nudging.

### 6. Legend

An inset instance appears in the **candle-pane** legend rows, which is correct:
it is a candle-pane indicator. Two lookups need a fallback, because both read
`ind.figures` directly:

- `ChartLegend.tsx:258` (the imperative crosshair/tick value fill)
- `ChartLegend.tsx:752` (`buildLegendRows`)

Both move onto helpers exported from `lib/indicators/inset.ts`:

```ts
export function isInsetInstance(ind: Indicator): boolean;             // extendData.inset === true
export function legendFiguresOf(ind: Indicator): IndicatorFigure[];   // inset ? base template's figures : ind.figures
export function legendPrecisionOf(ind: Indicator): number | undefined; // inset ? base template's precision : ind.precision
```

so the component keeps one expression per site and the inset knowledge stays in
one module. Both gate on the explicit `inset` marker, **not** on
`ind.figures.length === 0`: `ProximityHeatmap` is a figure-less candle-pane
indicator that is not inset, and an emptiness check would drag it into this path.

### 7. The toggle

`indicatorMenuItems` (`chart/useIndicatorCommands.ts:416`) builds the shared
TradingView-style menu used by both the legend row's ⋯ button and a
right-click on the curve. It gains one item beside Move up / Move down, shown
only when `INSET_CAPABLE.has(indTypeOf(name))`.

**Amended during implementation:** for an INSET instance only the legend row's ⋯
button reaches this menu, not the right-click-on-curve path. `buildLineCache`
(`chart/chartGeometry.ts`) iterates `ind.figures`, which is empty by
construction for an inset instance, so an inset curve has no hit-test geometry:
no curve right-click, no curve-click selection, no selection handles, and no
curve labels. Routing that through `legendFiguresOf` would not fix it, because
the cached pixels come from the pane's price axis while the band has its own
mapping; band hit-testing needs its own math. Out of scope here.

The item is:

- label: `Show as inset` when the instance is in a sub-pane, `Show in own pane`
  when it is inset
- a new icon in `lib/menuIcons.tsx`

The item calls a new `setIndicatorInset(paneId, name, on)` command in the same
hook:

```ts
chart.removeIndicator({ paneId, name });            // NOT removeIndicatorById
const next = controller.indicators.value.map((i) =>
  i.id === name ? { ...i, ...(on ? { inset: true } : {}) } : i);
controller.indicators.set(next);
saveIndicators(scope, next);
applyIndicator(chart, scope, epic, instOf(next, name), { rehydrate: true });
handle.redrawRef.current();
```

`chart.removeIndicator` directly, **not** `removeIndicatorById`: the latter also
calls `deleteIndicatorConfig` (`lib/indicators.ts:992`), which would throw away
the instance's saved params and styles on every toggle. Tear-down-then-recreate
with `rehydrate: true` is the same idiom `reorderSubPanes` already uses
(`lib/indicators.ts:305-323`) precisely because it preserves the saved config.

Turning inset off recreates the instance in a fresh sub-pane appended at the
bottom, at the default `SUBPANE_HEIGHT`. Its previous pane position is not
restored; there is nowhere to have kept it, and reorder is one drag away.

### 8. Visibility: one asymmetry to close

This is the one item that does change behavior, so it is called out rather than
listed as a non-change.

There are two Hide/Show paths with different persistence rules today:

- the legend **eye** (`useIndicatorCommands.ts:86`) persists pane-agnostically,
  deliberately, so sub-pane indicators keep their hidden state across reloads;
- the **context menu** (`useIndicatorCommands.ts:312`) persists only when
  `paneId === "candle_pane"`.

`applyIndicator` reads that persisted flag for **any** pane
(`lib/indicators.ts:507,520`: `cfg?.visible === false` seeds `visible: false` and
`extendData.userVisible`). Two consequences:

1. Hiding an inset instance and then turning inset off recreates it hidden in the
   fresh sub-pane. This is consistent with what the eye already does across a
   reload, so it is intended: hidden stays hidden through the transition.
2. The context menu's guard means Hide would persist for an instance while inset
   and silently not persist for the same instance in a sub-pane. That asymmetry
   pre-dates this work but inset makes it reachable on one indicator in one
   session, which is where it becomes a bug report.

Decision: drop the `paneId === "candle_pane"` guard at
`useIndicatorCommands.ts:312` so `toggleVisibleOn` persists the way the eye path
already does. One line, in scope, and it makes the two paths agree before inset
starts moving instances between panes. A test asserts both paths persist for a
sub-pane instance and for an inset one.

### 9. What needs no change

- `subPaneOrder` and `reorderablePanes` (`lib/indicators.ts:243,278`) already
  skip `candle_pane`, so inset instances drop out of pane reordering, and the
  legend's card index stays in agreement because it filters on the same
  predicate.
- `collapseSubPanes` / `expandSubPanes` iterate reorderable panes, so they leave
  inset instances visible. That is the behavioral difference between the two
  features and gets a comment at the collapse site.

### 10. Small panes

`ChartGrid` can put four cells on screen, and a cell's candle pane can be a
couple of hundred pixels tall. A 56px minimum band over a 200px pane is 28% of
it, which is the designed fraction, so the clamp only bites below ~200px. Below
that the band would dominate the cell, so `insetBandRect` returns a band capped
at `INSET_BAND_MAX_FRACTION` (40%) and inset simply reads as cramped rather than
degrading to a special mode. Explicitly not doing: auto-disabling inset on small
panes, or a second breakpoint. If cramped turns out to be unusable in a 2x2
layout, the constants are the only thing that changes.

## Testing

Unit tests, in the existing `lib/indicators/*.test.ts` and `lib/*.test.ts`
idiom (vitest, pure helpers, `lib/testFakeChart.ts` for chart-shaped calls):

- `insetBandRect`: normal case, the `MIN_PX` clamp, the `MAX_FRACTION` clamp, and
  a pane shorter than `MIN_PX`.
- `valueToBandY`: fixed domain endpoints and midpoint, auto domain with padding,
  out-of-domain clamping, and a degenerate flat domain (min === max).
- `insetOrder`: index resolution with one, two and zero inset instances, and
  that non-inset candle-pane overlays (EMA) are excluded.
- `legendFiguresOf` / `legendPrecisionOf`: an inset instance derives from the base
  template, a normal instance reads its own fields, a figure-less non-inset
  instance (`ProximityHeatmap`) stays empty, and neither throws on a missing
  `extendData`.
- `drawInset`: the base draw receives a `yAxis` shim that maps the domain onto the
  band, the canvas is translated and clipped to the band, `SLOPE`'s dynamic figure
  list is derived from live `calcParams` (not a stored copy), and the callback
  returns `true`.
- `loadIndicators` / `saveIndicators`: `inset` round-trips; a legacy `string[]`
  entry and a legacy `{id,type}` entry both load without it; the saved payload
  for a non-inset instance is unchanged.
- `applyIndicator`: an inset instance lands on `candle_pane` and gets no
  `setPaneOptions` call; the same instance without the flag opens a fresh pane
  at `SUBPANE_HEIGHT`.
- `setIndicatorInset`: config survives the toggle (assert
  `deleteIndicatorConfig` is not reached), the persisted list is rewritten once,
  and a SLOPE's accel companion follows its parent.
- `toggleVisibleOn` persists for a sub-pane instance as well as an inset one
  (the §8 guard removal), and a hidden instance recreates hidden across an inset
  toggle in both directions.

Verified in the running app rather than reasoned about:

- The inset band paints over the candles legibly, RSI's overbought/oversold zones
  and divergence segments land inside the band (the shim's real test), and the
  legend row still fills values on hover.
- Price axis ticks are byte-identical with and without an inset RSI on a
  5-decimal symbol, with "Scale price chart only" **off** (the precision guard
  and the empty-figures guard, together). The rule proximity heatmap must be
  **off** for this check: its `precision: 0` already forces integer ticks, so
  with it on the guard would appear to work whether or not `INSET_PRECISION` is
  doing anything.
- Toggling inset on and off preserves the indicator's params and colors.

The frontend test baseline is not green on `main` (5 to 7 known failures,
several order-sensitive). Those stay untouched.

## Open risks

- **Z-order:** candle-pane indicators are expected to paint over the bars, but
  the exact layering against candle body/wick draw order is an empirical
  question, checked in the app before the band styling is finalized.
- **Template signature comparison:** `lib/templateSignatures.ts` compares saved
  instance shapes; the new optional field must not make every existing template
  read as changed. Checked before shipping.
- **Band crowding:** three insets in one shared band is the design's stress
  case. The left-edge label stack is the mitigation; if it reads badly in
  practice, per-instance sub-bands are the follow-up, and `insetBandRect`
  already isolates the geometry that would change.
