# Backtest panel: overlay + auto-hide (with pin-to-dock)

**Date:** 2026-08-06
**Status:** Approved

## Problem

The backtest config panel (`.bt-cfg-panel`) docks right as a flex sibling of the
chart, at 720px default / 560px minimum width (the floor comes from rule rows
needing two 3-control operand pills + operator + remove on one line). On a
~1280px laptop the chart shrinks to ~500px — and to ~200px when the
side-by-side results column (`.bt-results-col`, min 360px) is docked too. The
chart must stay fully interactive while the panel is open (pan/zoom, Pick
Range, inspecting trades), so a modal is not an option.

## Decision

The panel **overlays** the chart instead of shrinking it, and **auto-hides on
chart interaction**. A **pin** button restores today's docked layout for users
(or screens) where shrinking the chart is fine.

## Design

### Positioning

- Unpinned (new default): `.bt-cfg-panel` — and, in side-by-side mode,
  `.bt-results-col` — render absolutely positioned over the chart's right edge
  inside `.workspace`, instead of as flex siblings. The chart no longer
  shrinks; its canvas never resizes when the panel opens/closes/hides.
- In side-by-side mode both columns form **one sliding surface** (results left
  of config, as today) that hides/reveals as a unit.
- The existing left-edge width drag handle and persisted width keep working
  unchanged, including the `clampWidth` floor/ceiling.
- Show/hide animates with a short transform transition (slide right). The
  component stays mounted while hidden — config state, streaming results, and
  scroll positions are fully preserved.
- The alerts sidebar and trade sidebar are untouched.

### Hide / reveal (unpinned mode)

- **Hide:** any `mousedown` on the chart area slides the panel off-screen.
  Only chart mousedown hides — nothing hover-based, so dropdowns/popovers
  portaled outside the panel bounds can never trigger an accidental hide.
- **Reveal:** a slim peek tab on the right edge of the chart ("◂ Backtest")
  slides it back. The toolbar Backtest button re-reveals a hidden panel rather
  than re-opening from scratch.
- **Close:** the header ✕ still closes the panel entirely, exactly as today.

### Pin (mode toggle)

An icon button in the panel header toggles between the two layouts:

- **Unpinned (default):** overlay + auto-hide as above.
- **Pinned:** exactly today's behaviour — the panel re-enters the flex row as
  a docked sibling, the chart shrinks beside it, no auto-hide, no peek tab, no
  offset compensation. Side-by-side results dock as today.

The choice persists per device (same storage pattern as the panel width), so
wide-monitor users pin once and never see the overlay.

### Chart offset compensation (unpinned, visible)

While the overlay is visible, the focused chart cell's right offset
(klinecharts `offsetRightDistance`) increases by the panel's total overlay
width so the newest candles slide left into view instead of hiding under the
panel. Restored on hide/close. Live-updated during width drags and when the
results column docks/undocks beside the config panel.

### Interaction carve-outs (unpinned only)

- **Pick Range:** arming it hides the panel automatically (it is a chart drag
  by definition); once the range is picked, the panel returns.
- **Run in flight:** while a backtest/sweep is streaming, chart mousedown does
  not hide the panel — you are watching results land. Hide-on-click resumes
  when the run completes.

### Out of scope

- Compact/wrapping rule-row mode to let the panel go narrower than 560px —
  worth doing later (a narrower overlay covers less chart), but the overlay
  stands alone without it.
- Any change to the Live trading panel or alerts sidebar layout.

## Testing

Component tests (existing BacktestSettingsModal test setup):

- Chart mousedown hides the overlay; peek tab reveals it; config state and
  results survive the round trip.
- Pinned mode: panel is a flex sibling (chart shrinks), chart clicks do not
  hide it; pin state persists.
- Pick Range arms → panel hides; range picked → panel returns.
- Run in flight suppresses hide-on-chart-click; suppression lifts on
  completion.
- Right offset applied on reveal, updated on width drag, restored on
  hide/close.
