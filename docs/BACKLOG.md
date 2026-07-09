# Backlog

Desired-but-not-yet-built work. Each entry links to its spec. Once a spec ships,
remove it from here (git history and the memory index track shipped features).

## Specced, ready to implement

- **Tauri menu-bar Mac app** — thin always-on native shell that loads the
  existing localhost UI so the browser-driven live engine can't be closed by
  accident. Menu-bar tray icon + status glyph, ⌘⌥T hotkey, close/⌘W/⌘Q all hide
  (tray Quit only), user-settable URL + Settings window, launch-at-login, native
  alert toasts, unread badge, connection splash, App-Nap prevention.
  [spec](superpowers/specs/2026-07-08-tauri-menubar-wrapper-design.md)

- **Sync indicators across layout cells** — layout-wide indicator mirroring
  (add/remove/edit propagate to all cells; AVWAP anchor fan-out).
  [spec](superpowers/specs/2026-07-07-sync-indicators-design.md)

- **Slope-colored moving averages** — render EMA/SMA/VWAP/AVWAP with
  slope-based color coding (up vs. down segments).
  [spec](superpowers/specs/2026-07-06-slope-colored-ma-design.md)

- **Custom range calendar picker** — visual calendar for backtest range
  selection, replacing the native `datetime-local` inputs.
  [spec](superpowers/specs/2026-07-06-custom-range-calendar-picker-design.md)

## In progress

- **Slim large modules** — split the 10 biggest modules into focused files.
  Partially done (3 of 9 committed); the rest remain.
  [plan](superpowers/plans/2026-07-05-slim-large-modules.md)

## Deferred / forward-looking

- **Node backtest compute offload** — run backtest math in a Node service to
  move heavy work off the browser. Explicitly not a current pain point; revisit
  on real slowness or headless/scheduled-run demand.
  [spec](superpowers/specs/2026-07-07-node-backtest-compute-offload-design.md)
