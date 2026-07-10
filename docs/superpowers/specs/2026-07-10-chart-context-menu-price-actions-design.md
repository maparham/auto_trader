# Chart context-menu price actions

**Date:** 2026-07-10
**Status:** Approved design

## Problem

To place a buy/sell limit at a specific price, the user must eyeball a confluence
of drawings and indicators somewhere in the middle of the chart, then travel the
cursor all the way to the right-hand axis **+** button to open its menu. The **+**
menu reads the price from `plusPriceRef`, which tracks the cursor's y — so by the
time the cursor reaches the axis, the price is wherever the **+** button sits, not
the level the user picked. The chosen confluence level is lost.

The chart's own right-click context menu (empty-space right-click) currently
offers only **Paste** and **Settings** (`ChartCore.tsx:4204`), so it is no help.

## Goal

Let the user right-click directly at the confluence point and place a buy/sell
limit (or alert / horizontal line) at that exact cursor price — no trip to the
axis, no lost level.

## Decisions

- **Price source:** raw price under the cursor at right-click, quantized to
  instrument precision. **No snapping** to nearby lines.
- **Items:** all four price actions that the **+** menu offers — Buy limit,
  Sell limit, Add alert, Draw line — added above the existing Paste / Settings.
- **Item order:** Buy limit, Sell limit, Add alert, Draw line (matches the **+**
  menu order).
- **Axis right-click menu:** unchanged (still just "Scale price chart only").
  Out of scope.

## Design

### 1. Capture the price at right-click

In the existing `onContextMenu` handler (`ChartCore.tsx:1505-1506`), for the
empty-chart branch (cursor not over the price axis), compute the price fresh from
the event's y — independent of mouse-move state, so it is robust and honours the
"raw cursor price" decision (it deliberately skips the alert/trade snapping that
`plusPriceRef` applies in `onMove`):

```ts
const rect = el.getBoundingClientRect();
const y = e.clientY - rect.top;
const pt = first(c.convertFromPixel([{ y }], { paneId: "candle_pane", absolute: true }));
const price = typeof pt.value === "number" ? pt.value : null;
e.preventDefault();
setChartMenu({ x: e.clientX, y: e.clientY, price });
```

Extend the `chartMenu` state type (`ChartCore.tsx:939`) from `{ x, y }` to
`{ x, y, price: number | null }`.

`price` is `null` when `convertFromPixel` yields no value — e.g. the right-click
lands vertically over a sub-pane (RSI/MACD/Volume) rather than the candle pane.
In that case the menu shows only Paste / Settings (see step 3).

### 2. Extract shared price-action items

The four handlers already exist inline in the **+** menu (`ChartCore.tsx:4605-4649`).
Factor them into one helper so both menus call a single source of truth instead of
duplicating logic:

```ts
function priceActionItems(price: number): MenuItem[] {
  const label = price.toFixed(precision);
  return [
    {
      label: `Buy limit at ${label}`,
      icon: MenuIcons.chevronUp,
      onClick: () =>
        stageChartOrder({ epic: symbol.epic, side: "buy", price: Number(price.toFixed(precision)) }),
    },
    {
      label: `Sell limit at ${label}`,
      icon: MenuIcons.chevronDown,
      onClick: () =>
        stageChartOrder({ epic: symbol.epic, side: "sell", price: Number(price.toFixed(precision)) }),
    },
    {
      label: `Add alert at ${label}`,
      icon: MenuIcons.bell,
      onClick: () => {
        const ad = loadSettings().alertDefaults;
        overlays.addAlert(price, {
          condition: ad.condition,
          trigger: ad.trigger,
          message: "",
          expiresAt: resolveExpiry(ad.expiry, Date.now()),
          notify: ad.notify,
        });
      },
    },
    {
      label: `Draw line at ${label}`,
      icon: MenuIcons.horizontalLine,
      onClick: () => overlays.addDrawing("horizontalStraightLine", [{ value: price }]),
    },
  ];
}
```

Note the **+** menu currently orders the items alert → draw → buy → sell. The
shared helper standardises on the approved order (buy → sell → alert → draw); the
**+** menu adopts the same order when it switches to the helper. This is a
cosmetic reordering of the existing **+** menu, acceptable as part of the change.

Both call sites become:

- **+ menu** (`ChartCore.tsx:4605`): `items={priceActionItems(plusMenu.price)}`
- **chart menu** (`ChartCore.tsx:4208`):
  ```tsx
  items={[
    ...(chartMenu.price != null && !isSynthetic(symbol.epic)
      ? priceActionItems(chartMenu.price)
      : []),
    { label: "Paste", icon: MenuIcons.paste, onClick: /* unchanged */ },
    { label: "Settings", icon: MenuIcons.settings, onClick: () => openSettings() },
  ]}
  ```

A divider between the price actions and Paste/Settings, if `ContextMenu` supports
one; otherwise the grouping is visual-only (price actions first). Implementation
detail — match whatever separator affordance `ContextMenu` already has.

### 3. Gating (parity with the + button)

The **+** button is hidden for synthetic epics (`!isSynthetic(symbol.epic)`,
`ChartCore.tsx:4567`), so synthetic charts have no price-action affordance today.
The context menu matches this: when `isSynthetic(symbol.epic)` is true, the four
items are omitted and the menu shows only Paste / Settings (unchanged behaviour).

No other gating: buy/sell limit availability, tradeable-epic checks, and broker
readiness are all handled downstream by `stageChartOrder` / the trade panel,
identically to the **+** menu — this change adds no new entry point logic.

## Data flow

1. User right-clicks empty chart space at a confluence level.
2. `onContextMenu` converts `clientY` → candle-pane price, stores it on `chartMenu`.
3. Menu renders Buy/Sell limit + Add alert + Draw line (price in each label),
   then Paste / Settings.
4. User picks Buy/Sell limit → `stageChartOrder({ epic, side, price })` stages a
   `DraftOrder` (`signals.ts:349`) and opens the trade panel pre-filled.
   Or Add alert / Draw line → creates the overlay immediately at that price.

## Scope boundaries

- No snapping / magnet behaviour (explicitly declined).
- Price-axis right-click menu unchanged.
- No change to `stageChartOrder`, the trade panel, or alert/drawing creation —
  only new call sites for existing behaviour.

## Testing

- Right-click mid-chart → menu shows all four price actions with the cursor's
  price in each label; Paste / Settings still present below.
- Buy limit / Sell limit → trade panel opens with correct epic, side, and the
  clicked price (matches the label, quantized to precision).
- Add alert / Draw line → overlay appears at the clicked price.
- Right-click over a sub-pane axis region (price `null`) → only Paste / Settings.
- Synthetic chart → only Paste / Settings (no price actions), matching the
  hidden **+** button.
- **+** menu still works and now lists items in the buy → sell → alert → draw
  order.
