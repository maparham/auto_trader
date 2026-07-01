# Magnet Mode — Design Spec

**Date:** 2026-07-01
**Status:** Approved, ready for implementation plan

## Goal

Add a TradingView-style **Magnet mode** to the chart. When enabled, drawing
points placed or dragged near a price bar snap to the closest OHLC value of that
bar. Two strengths (Weak/Strong), a global toggle, and a hold-to-invert keyboard
modifier — matching TV behavior.

## Key finding

klinecharts (9.8.12, vendored in `frontend/node_modules/klinecharts`) already
implements the OHLC snapping natively. Overlays carry a `mode` property
(`OverlayMode.Normal | WeakMagnet | StrongMagnet`) plus `modeSensitivity`. The
snap logic lives in `OverlayView.prototype._coordinateToPoint`
(index.esm.js:8630): when `mode !== Normal` on the candle pane, the pixel-derived
value is snapped to the bar's `open/high/low/close`, using `modeSensitivity`
(default 8px) as the proximity threshold for WeakMagnet. StrongMagnet always
snaps to the nearest OHLC. This runs for **both** initial point placement and
drags of existing points.

**Consequence:** we write no snapping math. The work is (1) plumbing a `mode`
value into overlay creation, (2) a global persisted setting, (3) a toolbar
control, and (4) a keyboard modifier that momentarily inverts the effective mode.

## Decisions (locked)

- **Strengths:** Both — Weak and Strong, chosen from a dropdown. Clicking the
  button toggles on/off; on = last-used strength (default Weak).
- **Scope:** Global. One setting applies to every chart tab/cell (like TV).
- **Persistence:** Persist across sessions (restore last state on load).
- **Keyboard:** Only a momentary hold-to-invert on Ctrl (Cmd on Mac). No
  persistent toggle hotkey.
- **Alerts excluded:** Magnet applies to **drawing** overlays only, never to
  alert price lines (they should not snap to OHLC).

## Architecture

### 1. Global state — `frontend/src/lib/magnet.ts` (new)

A single module-level, persisted signal representing the magnet state:

- Value: `MagnetSetting = { on: boolean; strength: "weak" | "strong" }`.
  - Persisted via the existing `lib/persist.ts` pattern; default
    `{ on: false, strength: "weak" }`; restored on load.
- Derived helper `magnetMode(setting): OverlayMode` →
  `on ? (strength === "strong" ? StrongMagnet : WeakMagnet) : Normal`.
- Also exports the current effective mode as a subscribable signal so
  `OverlayManager` instances and the Toolbar can read/react.
- `modeSensitivity`: use the klinecharts default (8px); expose as a constant so
  it is easy to tune later. Not user-configurable in this iteration.

Storing strength separately from `on` lets the button remember the last strength
when toggled off and back on.

### 2. Applying to new drawings — `OverlayManager.create()` (overlays.ts:590–612)

Inject `mode` + `modeSensitivity` into the `chart.createOverlay({...})` object
(overlays.ts:600), reading the current global mode from `lib/magnet.ts`.

- **Only for drawing overlays**, not alert overlays. `create()` is shared by
  both kinds via its `kind` argument — gate the `mode` injection on the drawing
  kind so alert lines always get `Normal`.
- New drawings therefore pick up whatever magnet state is active at creation.

### 3. Keeping existing drawings in sync

Each `OverlayManager` subscribes to the global magnet signal (set up alongside
`setScope`, overlays.ts:255; torn down on dispose). On change, it calls
`chart.overrideOverlay({ id, mode })` for each of its existing **drawing**
overlays.

- This does **not** move already-placed drawings — `mode` only affects the
  coordinate→point conversion during live interaction. It just means that after
  enabling magnet, dragging a previously-drawn line will snap. Matches TV.
- Because every cell's `OverlayManager` subscribes, a single global change
  propagates to all cells with no cross-cell registry needed.

### 4. Keyboard modifier — momentary invert (Ctrl/Cmd)

While a drawing point is actively being **placed or dragged**, holding
Ctrl (Cmd on Mac) flips the effective mode to the *opposite* of the current
global state, and reverts on release:

- Global Off + modifier held → snaps (using last-used strength).
- Global On + modifier held → stops snapping (`Normal`).

Implementation shape (details for the plan):

- A keydown/keyup listener tracks whether the invert modifier is held.
- The **effective mode** = `held ? invert(globalMode) : globalMode`, where
  `invert(Normal) = magnetMode({on:true, strength})` and
  `invert(WeakMagnet|StrongMagnet) = Normal`.
- On modifier state change, push the effective mode to the overlay(s) that can
  be actively interacted with — the in-progress overlay being drawn and/or the
  selected overlay being dragged — via `overrideOverlay`, then restore to the
  global mode on release. The plan must verify how `mode` reaches an
  in-progress (not-yet-finished) overlay in klinecharts'
  `progressOverlayStore`; if `overrideOverlay` does not reach it, set the mode
  on the overlay at `addDrawing`/draw-start time and update through the same
  seam used for pressed-move.
- Scope the listener so it does not interfere with `Cmd+C/V/S` (those require a
  second key) or fire while typing in inputs.

This is the **only** keyboard behavior. There is no persistent toggle hotkey.

### 5. Toolbar UI — `Toolbar.tsx` (drawing-tools block ~569–595)

A 🧲 magnet button placed next to the ✎ Draw button, before the `tb-div`
divider, with a small dropdown arrow — following the existing A/L price-scale
toggle-button pattern (Toolbar.tsx:627–643, `className={on ? "on" : ""}`).

- **Click the icon** → toggle `on` (on = last-used `strength`).
- **Dropdown arrow** → menu with **Weak Magnet** / **Strong Magnet**; selecting
  one sets `strength` and turns magnet on. A check/highlight marks the active
  strength.
- Button shows `.on` styling when magnet is on.
- Reads/writes the global signal from `lib/magnet.ts`; because state is global,
  the button reflects the same value regardless of focused cell.

## Data flow

```
Toolbar button / dropdown ──▶ lib/magnet.ts signal (persisted)
                                     │
   Ctrl/Cmd hold (momentary) ─ invert ┤ effective mode
                                     ▼
           OverlayManager (per cell) subscribes
                    │                         │
     new drawing: create() injects mode   existing drawings: overrideOverlay(mode)
                    │                         │
                    ▼                         ▼
        klinecharts _coordinateToPoint snaps to OHLC (candle pane only)
```

## Testing

- **Unit (`lib/magnet.ts`):** `magnetMode` mapping for off/weak/strong;
  `invert` for each state; persistence round-trip (save → reload → restore);
  default is off/weak.
- **OverlayManager:** creating a drawing while magnet is on passes the expected
  `mode`; creating an **alert** always passes `Normal`; toggling the signal
  calls `overrideOverlay` on existing drawings but not alerts.
- **E2E (Playwright, per existing chart e2e patterns):**
  - Enable Weak magnet, draw a segment with a click near a candle high → the
    stored point value equals that candle's high.
  - With magnet off, hold Cmd while placing a point near a bar → it snaps;
    release → no snap.
  - With magnet on, hold Cmd while placing → it does **not** snap.
  - Toggle persists across reload.
  - Strong magnet snaps even when the cursor is well away from the exact OHLC
    pixel (beyond the weak sensitivity threshold).

## Out of scope

- Custom/hand-written snapping logic (native `mode` handles it).
- Snapping alert lines.
- Per-cell magnet state (global only).
- A persistent toggle hotkey (only the Ctrl/Cmd momentary invert).
- User-configurable `modeSensitivity` (fixed at the klinecharts default this
  iteration).

## Files touched

- `frontend/src/lib/magnet.ts` — **new**: global persisted signal + helpers.
- `frontend/src/lib/overlays.ts` — inject `mode` in `create()` (drawings only);
  subscribe + `overrideOverlay` sync; teardown.
- `frontend/src/Toolbar.tsx` — 🧲 button + Weak/Strong dropdown.
- Keyboard-modifier listener — location TBD in the plan (likely `ChartCore.tsx`
  near the existing `onKeyDown`, or a shared hook), covering keydown/keyup for
  the invert modifier during active draw/drag.
- Tests: `lib/magnet.test.ts`, overlays test additions, chart e2e additions.
