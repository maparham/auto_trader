# Unified `<Tooltip>` Component — Design

Date: 2026-07-04

## Problem

Tooltips are implemented inconsistently across the frontend:

- **~194 native `title=` attributes** (icon-button labels like "Close book", plus
  explanatory text on table headers and stat cells, some threaded through wrapper
  props like `SortHeader`'s `title`). The browser's native tooltip is **slow to
  appear** and **visually crude** — it can't be styled and its show-delay is long.
- **Two near-duplicate `InfoTip` components** — `src/InfoTip.tsx` and
  `src/components/InfoTip.tsx` — implementing the trailing-ⓘ info pattern. Both
  portal a `.ind-tooltip` bubble to `<body>`, anchored to the right of the icon.
  These are the "fast" tooltips that already feel good, but they are copy-pasted
  and hard-coded to a single anchor side.

There is no single primitive. We want **one `<Tooltip>` component used everywhere**
that is fast, styled to match the app, accessible, and collision-aware.

## Goals

- One reusable `<Tooltip>` component that replaces both the native `title=` hints
  and the hand-rolled `.ind-tooltip` portal.
- Fast, deliberate show behavior (no native lag) with a clean flat look.
- Supports plain string hints (the common case) and richer title + multi-paragraph
  content (the ⓘ case) through the same API.
- The ⓘ `InfoTip` becomes a thin composition over `<Tooltip>`, not a parallel
  implementation. Both existing `InfoTip` files collapse into one.

## Non-goals

- No tooltip library dependency (floating-ui, tippy, radix, etc.) — the app has
  none today and the behavior we need is small. We hand-roll positioning.
- Not building a general popover/menu system — this is hover/focus hints only.
- Not a click-to-open info panel — the market-info popover stays as it is.

## API

```tsx
<Tooltip content="Close book">{trigger}</Tooltip>                    // plain hint
<Tooltip title="Margin" content={["line 1", "line 2"]}>MARGIN</Tooltip>  // rich
<Tooltip content="…" placement="right">{trigger}</Tooltip>           // override side
```

Props:

| Prop         | Type                                       | Default   | Meaning |
|--------------|--------------------------------------------|-----------|---------|
| `content`    | `string \| string[] \| ReactNode`          | —         | A string renders one line; an array renders one dim `.tooltip-desc` paragraph per item; a ReactNode renders as-is for custom cases. |
| `title`      | `string`                                   | —         | Optional bold heading line above the content. |
| `placement`  | `"top" \| "bottom" \| "left" \| "right"`   | `"top"`   | *Preferred* side. Auto-flips/shifts if there is no room (collision-aware). |
| `delay`      | `number` (ms)                              | `100`     | First-hover show delay (see grace group below). Hide is immediate. Callers can pass `0` for always-instant or a larger value for a slow-reveal hint. |
| `disabled`   | `boolean`                                  | `false`   | When true the trigger renders bare with no tooltip behavior. |
| `children`   | `ReactNode`                                | —         | The trigger element. |

`content` being empty/undefined ⇒ behaves as `disabled` (renders children bare).

## Structure & behavior

- **Trigger wrapper.** `<Tooltip>` wraps `children` in a thin
  `<span className="tooltip-trigger">` that carries the hover/focus handlers and a
  ref. This makes no assumptions about the child (works for a `<button>`, text, an
  icon, anything) and avoids `cloneElement` fragility. The span is `inline-flex`
  (content-sized, no extra spacing) — it must have a real box so its
  `getBoundingClientRect()` is the anchor for positioning. (`display: contents` is
  explicitly *not* used: it produces no box and would measure as a zero rect.)

- **Single portal layer.** The bubble is portaled to `document.body` with
  `position: fixed`, so it escapes modal clipping and stacking contexts — the same
  proven approach as today's `.ind-tooltip` (which sits at `z-index: 2500`, above
  the 2000 modal layer). We keep a comparable z-index.

- **Positioning.** On show, read the trigger's `getBoundingClientRect()` and place
  the bubble on the preferred `placement`. Then run a simple collision check
  against the viewport: if the bubble would overflow, flip to the opposite side;
  if it still overflows along the cross-axis, shift it inward to stay on screen. A
  small gap (~8px) separates bubble and trigger. No sub-pixel animation of
  position — one measured placement per show.

- **Triggers.** Show on `mouseenter` **and** keyboard `focus` (accessibility);
  hide on `mouseleave`, `blur`, `Escape`, `scroll` (capture, so nested scrollers
  count), and window `resize`. Hide is immediate.

- **Timing — delay + grace group.** The `delay` prop (default `100ms`) applies to
  the *first* tooltip shown. A single module-level "grace window" tracks when the
  last tooltip hid: if another tooltip's trigger is entered within `~400ms` of that,
  it shows **instantly** (delay skipped). This is what makes sweeping across a
  toolbar feel snappy — you wait once, not on every icon. Keyboard `focus` always
  shows instantly (no delay). `delay={0}` opts a trigger into always-instant.

- **Animation — quick fade + slide (locked with user).** On show, the bubble fades
  in over `~120ms` and slides `8px` toward the anchor into place (settles downward
  when placed on `top`, upward when flipped to `bottom`, etc. — the bubble starts
  further from the trigger and slides closer). On hide it fades out. Runs
  on CSS `transition` (opacity + transform); the transform direction is set from the
  resolved placement so the motion always originates *away* from the trigger. This
  is animation option "A" from the demo. Motion respects
  `@media (prefers-reduced-motion: reduce)` → fade only, no slide.

- **Non-interactive bubble.** `pointer-events: none` on the bubble so it never
  eats clicks or creates hover loops. Content is display-only.

- **Accessibility.** Bubble gets `role="tooltip"` and a generated `id`; the trigger
  wrapper gets `aria-describedby` pointing at it while shown.

## The ⓘ InfoTip becomes composition

Both `src/InfoTip.tsx` and `src/components/InfoTip.tsx` are replaced by a single
small component built on `<Tooltip>`:

```tsx
export default function InfoTip({ title, text, children, className }: InfoTipProps) {
  return (
    <Tooltip title={title} content={text}>
      <button
        type="button"
        className={className ?? "ind-info"}
        aria-label={title ? `About ${title}` : "More info"}
        tabIndex={-1}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        {children ?? <InfoGlyph />}
      </button>
    </Tooltip>
  );
}
```

This preserves the existing callers' API (`text: string | string[]`, `title?`,
custom `children` trigger, `className` override) so ⓘ usages keep working, while
the tooltip mechanics live in one place. The old right-anchor default becomes the
shared collision-aware placement (still overridable per call if a specific ⓘ needs
`placement="right"`).

## Styling

Reuse today's tooltip visual tokens, renamed from `.ind-tooltip*` to `.tooltip*`
(keeping `.ind-tooltip` as-is is fine short-term, but the canonical names move to
`.tooltip`):

```css
.tooltip {
  position: fixed; z-index: 2500;
  max-width: 260px; padding: 8px 10px;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px;
  pointer-events: none;
  /* no box-shadow — flat, border-only, per the app's no-shadows convention */

  /* animation A: quick fade + slide toward the anchor */
  opacity: 0;
  transition: opacity .12s ease, transform .12s cubic-bezier(.2,.7,.3,1);
}
/* pre-show offset is set inline per placement (translateY(±8px) / translateX(±8px));
   the .show state resets it to 0 so the bubble slides into place. */
.tooltip.show { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  .tooltip { transition: opacity .12s ease; transform: none !important; }
}

.tooltip-title { font-weight: 600; font-size: 12px; margin-bottom: 3px; }
.tooltip-desc  { font-size: 12px; color: var(--text-dim); line-height: 1.45; }
.tooltip-desc + .tooltip-desc { margin-top: 6px; }
```

Decisions locked with the user:
- **Flat, border only** — no drop shadow.
- **Default placement: top**, flipping to bottom / shifting inward on collision.
- **Animation A** — ~120ms fade + 8px slide toward the anchor (fade-only under
  reduced-motion).
- **Timing** — 100ms first-hover delay with an instant grace group; `delay` is an
  optional prop (`0` = always instant).

## Files

- **New:** `src/components/Tooltip.tsx` — the component.
- **Rewritten:** `src/components/InfoTip.tsx` — thin composition over `Tooltip`;
  `src/InfoTip.tsx` deleted, its importers repointed to the single component.
- **CSS:** add `.tooltip*` rules in `App.css` (alongside / replacing the current
  `.ind-tooltip*` block).

## Migration (follow-up, not part of the core component work)

The 194 native `title=` sites migrate incrementally to `<Tooltip>` afterward. This
is out of scope for the component's initial build — the component ships first, then
call sites move over. Threaded-prop cases (e.g. `SortHeader title=…`) will pass the
hint down and render a `<Tooltip>` around the header label at the leaf.

## Testing

- Unit/interaction test for `<Tooltip>`: shows on hover after the delay, shows on
  focus, hides on blur / Escape / mouseleave, respects `disabled`, renders string
  vs array vs title+content correctly.
- Placement test: mock a trigger rect near a viewport edge and assert it flips /
  shifts instead of overflowing.
- InfoTip: existing ⓘ interaction still works (hover shows title + desc).
```
