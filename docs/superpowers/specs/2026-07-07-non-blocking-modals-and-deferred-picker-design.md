# Non-blocking chart-context modals + deferred-add operand picker

Date: 2026-07-07

## Motivation

Two related friction points in the rule-building flow:

1. **The "Add from chart" operand picker commits on the first click.** Clicking a
   row immediately picks that operand and closes the picker. There's no chance to
   deliberate — select, look at the on-chart emphasis (the sticky highlight we just
   built), compare, and only then commit. Users want to **select an item, keep the
   picker open, and add on an explicit "Add" button**.

2. **Chart-context modals block the chart.** The picker (and the indicator/drawing/
   alert settings modals) render over a full-screen backdrop that captures all
   pointer events, so you can't pan/zoom/hover the chart while a modal is open. This
   defeats the whole point of the on-chart emphasis and of tweaking settings while
   watching the chart. Users want these modals to **float without blocking normal
   chart interaction**.

## Scope

Two independent, composable pieces of work:

- **A — Deferred-add picker:** single-select + confirm in `ChartOperandPicker`.
- **B — Non-blocking floating-modal shell:** a shared `FloatingModal` component, and
  migrating the chart-context modals onto it.

In scope for B (become non-blocking): `ChartOperandPicker`, `IndicatorSettings`,
`DrawingSettings`, `AlertModal`.

Explicitly **out of scope / unchanged:**
- `ConfirmDialog` and any yes/no destructive prompt — **stays blocking** (its whole
  job is to force a choice; a full backdrop is correct).
- `MarketInfoPopover` — **already non-blocking** (no backdrop, chart interactive, Esc,
  anchored positioning). Left as-is.
- **Multi-select** in the picker — deferred. The picker fills a single operand slot;
  single-select + confirm is the shape. (Revisit if group-level "add many rules at
  once" is wanted later.)

## Current state (as mapped)

- **No shared modal wrapper exists.** Each modal reimplements `.modal-backdrop`
  (`position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.5)`) + `.modal`
  inline.
- Shared hooks already exist and are reused as-is:
  - `lib/useCloseOnEscape.ts` — window keydown → Escape → callback.
  - `lib/useDraggable.ts` — drag by a handle via `transform: translate(...)`, skips
    clicks on `button, input, select, a`.
- `IndicatorSettings`, `DrawingSettings`, `AlertModal` are **already draggable** (via
  `useDraggable` on `.modal-head`) and dismiss on backdrop `onMouseDown` + Esc + ✕.
- `ChartOperandPicker` today: a `.chart-operand-picker-backdrop` (z 60, rgba .15) with
  `onClick={onClose}`; `onPick(op)` commits immediately and closes. No Esc handler.
- The chart grid container is `.chart-cells` (holds every `.chart-cell`); chart canvas
  + DOM overlays live at z 49, below modals.

## A — Deferred-add picker (single-select + confirm)

`ChartOperandPicker` becomes stateful: it tracks a **selected output** rather than
firing `onPick` on click.

- **Selection model:** a selected `{ sourceId, lineIndex }` (the exact output row).
  Single-output rows select the row; multi-output indicators (LR/PREV_HL) expand on
  parent click and select a specific sub-output.
- **Click a row → select it** (does not close). Selected row gets a sticky highlight
  (`aria-selected`/`.selected` class). The on-chart emphasis becomes **sticky on the
  selected item** (see interaction with B's `onHoverSource` below); hover still
  previews other rows transiently.
- **Footer:** `[Cancel] [Add]`. **Add is disabled until something is selected.**
  Add → calls `onPick(selectedOperand)` then closes (parent clears `pickerFor`).
- **Cancel / ✕ / Esc / empty-space click** → close without adding.
- **Disabled rows** remain unselectable (greyed with reason tooltip), as today.

**Emphasis interaction:** the picker already emits `onHoverSource(target | null)` for
row hover. Selection extends this: the *effective* emphasis target = hovered row, else
selected row. So the selected item stays emphasized on the chart when the pointer
leaves the list, and hovering another row previews it without losing the selection.
Implemented in the picker by folding a `selected` ref into the existing
hovered/focused precedence (`hovered ?? focused ?? selected`).

## B — `FloatingModal` shell

New component `src/components/FloatingModal.tsx`. A non-blocking, draggable panel.

```tsx
<FloatingModal
  title={ReactNode}            // header label
  onClose={() => void}         // Esc / ✕ / empty-space click
  footer={ReactNode}           // optional action row (e.g. Cancel/Add)
  width={number}               // px; default per modal
  initialPlacement={"center" | "right"}  // default "center"
  className={string}           // per-modal extra (e.g. "ind-settings")
>
  {body}
</FloatingModal>
```

Behavior:
- **No backdrop.** Renders via `createPortal` to `<body>` as a single fixed-position
  panel. The chart behind is fully interactive everywhere outside the panel footprint.
- **Header** = `title` + drag handle (`useDraggable` on the header; the whole header is
  the handle, skipping its buttons) + shared `CloseButton` (✕ → `onClose`).
- **Esc** closes via `useCloseOnEscape(onClose)`.
- **Draggable** via `useDraggable` — initial fixed placement (`center`: `left:50%` +
  `translateX(-50%)`, a sensible top; `right`: offset toward the right edge so the
  chart stays visible), drag offset composes on top via `transform`.
- **Positioning** is `position: fixed` (from CSS/props) + drag `transform`; these
  compose (position via top/left, drag via transform).
- z-index: a floating tier above chart overlays (z 49) and the `.mi-popover` (z 60),
  but these no longer trap the whole screen. Concrete value chosen during
  implementation (e.g. ~1500), below `ConfirmDialog`'s blocking 2000 so a confirm can
  still cover a floating modal when one is raised.

### The dismiss rule (chart-aware click-away)

`FloatingModal` installs a **capture-phase** `document` `mousedown` listener:

```
onDocMouseDown(e):
  if panelRef contains e.target: return           // click inside the modal → keep open
  if e.target.closest('.chart-cells'): return      // chart interaction → keep open
  onClose()                                         // empty chrome / toolbar / panel → close
```

So: clicking the chart (pan/zoom/select a curve/drawing) never closes the modal;
clicking blank app chrome does. Accepted trade-off: clicking the toolbar or another
panel also closes it (treated as "empty space"). This deliberately overrides the app's
usual dismiss-on-outside-click convention for these non-blocking modals (the chart is
"outside" but must not dismiss).

## Migration

- **ChartOperandPicker** → render inside `FloatingModal` (drop
  `.chart-operand-picker-backdrop`); add the deferred-add footer + selection.
  `initialPlacement="right"` (opened from the right-side backtest panel — keep the
  chart visible on the left). Keeps its list/swatch/hover/emphasis intact.
- **IndicatorSettings / DrawingSettings / AlertModal** → drop `.modal-backdrop`; wrap
  body in `FloatingModal` (the shell provides drag + Esc + ✕ + click-away, replacing
  their hand-rolled backdrop-dismiss and `useDraggable`/`useCloseOnEscape` wiring).
  Keep their existing Save/Cancel footers and body. `initialPlacement="center"`.
  - Note: these currently dismiss on backdrop `onMouseDown` (commit-on-click-away). The
    dismiss becomes Esc/✕/Cancel/empty-space-click; verify their internal
    "apply/cancel" semantics still behave (e.g. cancel = revert) with the new dismiss
    paths.
- **ConfirmDialog** → unchanged (blocking).
- **MarketInfoPopover** → unchanged (already compliant).

CSS: a `.floating-modal` base class (surface, border, radius, shadow, flex column,
`max-height: 80vh`) reusing the existing `.modal` look; per-modal width via prop/class.
Remove the now-unused `.chart-operand-picker-backdrop` rule; the settings modals keep
`.modal`-derived inner styling but lose the backdrop wrapper.

## Testing

- **`FloatingModal` unit tests:** Esc → onClose; ✕ → onClose; footer button renders;
  click inside → stays open; document click on a `.chart-cells` node → stays open;
  document click on unrelated chrome → onClose; drag handle applies transform.
- **Picker tests:** Add disabled until a row is selected; selecting a row then Add
  fires `onPick` with that operand and closes; selecting a different row moves the
  effective emphasis target; Esc/Cancel close without `onPick`; disabled rows not
  selectable; multi-output sub-item selection.
- **Migration smoke (per modal):** opens, its primary action still works (indicator
  restyle applies, drawing settings apply, alert create), Esc/✕ close, and a simulated
  `.chart-cells` click does NOT close it.
- Full `tsc` + `vitest` green; manual verify in-browser that the chart pans/zooms with
  a modal open.

## Risks / notes

- **Behavior change** for the three settings modals: they no longer block, and
  click-away semantics change. Called out; matches the explicit request.
- **Focus/scroll:** non-blocking modals don't trap focus. Acceptable for these
  editing panels; keyboard Esc still closes.
- **Multiple floating modals** could technically coexist (no backdrop). Not a target
  workflow; one-at-a-time in practice. No stacking manager built.
- Keep `ConfirmDialog` blocking so destructive prompts still force a choice even if a
  floating modal is open beneath.
