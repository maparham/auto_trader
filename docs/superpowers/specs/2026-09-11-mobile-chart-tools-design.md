# Mobile chart tools and view modes

Date: 2026-09-11

## Context

The mobile shell (`frontend/src/mobile/`) covers markets, periods,
indicators, drawings, alerts, positions and order entry. Four chart tools
from the desktop toolbar have no mobile route at all: Template, Measure,
Backtest and Replay. Snapshot, Patterns and Heatmap stay out of scope by
decision.

Replay's absence is deliberate today.
`2026-09-07-mobile-companion-design.md` section 2 lists the replay pills,
ticket and start panel among the chrome that compact mode suppresses, and
`chart/compactChrome.ts` implements that. This document supersedes that one
decision. The rest of section 2 stands.

There is also no orientation or full-screen handling anywhere in the
frontend today.

## Decisions already taken

- Tools reach the phone through one new "Tools" chip in the chart top bar,
  opening a bottom sheet. Not a fifth tab, not the long-press menu.
- Landscape is a single toggle that both rotates and hides our chrome.
- Chart-only mode also exists in portrait, as its own control.
- Full screen is requested opportunistically and its refusal is ignored.
- Rotation uses the Screen Orientation API after entering full screen, not a
  CSS transform. See "Why not CSS rotation" below.

## Surface 1: the Tools sheet

A `Tools` chip joins the existing chips in `MobileChartView`'s top bar
(broker, symbol, period, Indicators). It opens `MobileToolsSheet`, built on
the shared `Sheet` component like `MobileIndicatorsSheet` and
`MobileBrokerSheet`.

Rows, in order: Template, Measure, Backtest, Replay. Each row is enabled or
disabled from live state, and a disabled row states why in one line rather
than vanishing, so the tool's absence is never a mystery.

The sheet needs no new plumbing. `mobileChartState.mobileChartCtx` already
carries the live `ChartController`, and the controller already exposes
`replayEntry` (`{available, active, enter}`) and `measureArmed`. The sheet
reads those with `useSyncExternalStore` and calls them directly.

## Surface 2: view modes

Two orthogonal pieces of state, owned by a new `mobileViewMode` signal in
its own module. Only `chromeHidden` persists. `landscape` is session state,
because full screen cannot be re-entered on load without a user gesture and
a restored `landscape` flag would describe a state the device is not in:

- `chromeHidden: boolean`. Hides the top bar and the tab bar, leaving the
  chart full-bleed plus one floating control to restore them.
- `landscape: boolean`. Implies `chromeHidden`.

**Portrait chart-only.** A control in the top bar sets `chromeHidden`. The
chart gains about 94px of 764, roughly 12%.

**Landscape.** Sets both. On activation, in order:

1. `document.documentElement.requestFullscreen()`. On success this reclaims
   about 101 CSS px of browser omnibox and status bar, which is more than
   all of our own chrome combined.
2. `screen.orientation.lock("landscape")`. Android Chrome requires full
   screen first, which step 1 has just established.

Every step is best-effort. A rejection is caught and ignored, and the mode
still applies whatever it achieved: on iOS Safari that means chart-only in
whatever orientation the phone is held. Nothing in the layout may depend on
either call succeeding.

Exiting reverses it: `screen.orientation.unlock()`, then
`document.exitFullscreen()`, then clear the flags. A user-initiated full
screen exit (the Android back gesture, the Escape key) must drive the same
teardown, so the mode listens for `fullscreenchange` and clears itself when
full screen goes away underneath it.

**Why not CSS rotation.** A `transform: rotate(90deg)` on the shell leaves
`getBoundingClientRect()` reporting the axis-aligned bounding box of the
rotated element, so every `clientX - rect.left` computation returns a wrong
coordinate with the axes effectively swapped. That pattern is the whole
chart interaction surface: 27 call sites in our code (18 in `ChartCore.tsx`,
the rest across `useLineDrag`, `usePointerCrosshair`, `priceAxisGesture`,
`useTrendlinePins` and `useIndicatorCommands`) plus 2 inside klinecharts,
which we cannot patch. Locking the real viewport keeps every one of them
valid.

## The four tools

### Template

Smallest of the four. `Toolbar.tsx` already routes through shared helpers
(`loadSymbolTemplate`, `applySymbolTemplate`, `saveDefaultTemplate`,
`loadDefaultTemplate`, `deleteDefaultTemplate`). The sheet row opens a
second-level sheet with the same actions against the current symbol. No new
persistence, no new state.

### Measure

`ChartController.measureArmed` is the whole entry point. Desktop arms it
with a Shift-held drag, which has no touch equivalent, so mobile arms it
from the sheet row instead and then takes two taps: first tap places the
anchor, second completes the measurement, and the row reads "Measuring, tap
two points" while armed. A third tap or the floating cancel control clears
it. This is the only tool that needs a new interaction model, and it is a
small one.

### Backtest

Partly wired: `MobileIndicatorsSheet` and `MobileModals` already reference
backtest state. What is missing is a config surface and a result surface.
Config on the phone is exactly three fields: strategy preset, date range and
timeframe. Everything else (costs, sizing, exits) is inherited from the last
config the desktop saved and is not editable here, on the principle that a
phone runs a backtest someone configured elsewhere. Results render as a metrics summary
sheet with the trade list behind a second tap. The run itself is the
existing path, unchanged.

### Replay

The largest piece, and the one that reopens a spec decision.

`compactHides` stops gating `replay`, so the pill, ticket and start panel
render in compact mode. Each needs a mobile form:

- **Start panel.** `ReplayStartPanel` is already close to sheet-shaped: a
  jump-window select, a "hide dates" checkbox and Jump/Cancel buttons. It
  becomes a sheet. The pick-a-point-on-the-chart path stays, since a tap on
  the curtain is a natural touch gesture.
- **Pill.** The transport (play, pause, step, speed) docks as a floating bar
  above the tab bar, or above the bottom edge in chart-only mode.
- **Ticket.** `ReplayTicket` is already a separate component from the app's
  `OrderTicket`. It renders as a sheet from the transport bar.
- **Scrubbing.** Dragging the replay position conflicts with chart pan.
  Mobile gets stepper buttons and a speed control instead of a scrub
  gesture; jumping to a different point means re-entering the picker.

The masked-replay protections are unchanged and untouched:
`maskedReplaySignal`, the ledger-routed order actions, and the rule that a
replaying cell draws only its ledger.

## Testing

Per tool and per surface, in the existing mobile test style
(`@testing-library/react` against the component, jsdom):

- `MobileToolsSheet`: each row's enabled and disabled state derives from
  controller state; a disabled row states its reason.
- View mode: the state machine is a pure module (`mobileViewMode`) tested
  directly, including that a rejected `requestFullscreen` or
  `orientation.lock` still yields chart-only, and that a `fullscreenchange`
  away from full screen clears the mode.
- Measure: two taps arm and complete; the third clears.
- Replay: `compactHides` no longer suppresses replay; the start sheet's jump
  path calls through with the armed masking choice.

jsdom has no Fullscreen or Screen Orientation API, so both are injected
behind a small adapter rather than called directly, which is also what makes
the refusal paths testable.

## Phases

1. **View modes.** Chart-only in portrait, landscape with full screen and
   orientation lock. Independent of every tool, and the thing that makes the
   rest usable.
2. **Tools sheet, Template, Measure.** The shell plus the two small tools.
3. **Backtest.** Config and result surfaces.
4. **Replay.** Ungate `compactHides`, then the start sheet, transport bar
   and ticket.

Each phase ships on its own.

## Risks

- Android Chrome's orientation lock requires full screen, so a user who
  refuses or exits full screen gets portrait chart-only rather than
  landscape. That is the designed fallback, not a failure.
- Replay's transport bar competes for the same bottom-edge space as the tab
  bar and the drawing FAB. Phase 4 has to resolve that stacking, and it is
  the part of this design most likely to need revision once seen on a
  device.
