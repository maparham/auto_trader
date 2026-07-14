# Results-panel chart toggles: Show Markers + moved Equity

Date: 2026-07-14

## Goal

Speed up rapid backtesting by letting the user suppress the trade markers the
backtest draws on the chart (the bulk of on-chart render cost), while keeping the
results panel and trade-selection overlays fully usable. Also relocate the equity
curve control out of the settings form so the three chart-visualization toggles
live together in one row.

## Outcome

The three chart-display toggles collapse into a single **Display** dropdown in the
Results summary row, so the row spends its width on the stats, not on three pills:

```
Results row:  +8.46  246 trades  -5.39 dd  44% win  1.58 RR   [ Display ▾ ] [Inspect]  [✕]

Display ▾
  ✓ Trade markers
  ✓ Trading periods
  _ Equity curve
```

- **Trade markers** — new toggle. Default **ON**. When OFF, per-fill arrows,
  signal-candle carets, and aggregate pills are not drawn (and are cleared
  instantly if already on the chart). Equity curve, period shading, and
  trade-selection overlays are unaffected.
- **Trading periods** — the pre-existing Periods toggle, moved into the dropdown.
- **Equity curve** — moved here from the settings form. Default **OFF**. Live
  toggle: flipping it instantly adds/removes the equity sub-pane. The "Show equity
  curve" checkbox is removed from the settings form.

All three are live (clear + redraw on flip) and device-local persisted. The
dropdown follows the shared `.menu`/`.dropdown` idiom (see `LayoutPicker.tsx`):
own open state, outside-click/Esc close, right-aligned panel, `menuitemcheckbox`
rows with a ✓ column. Toggling a row leaves the menu open; only an outside click
or Esc closes it. Inspect stays a standalone pill (it's a mode, not a display
layer).

## Behavior details

### Show Markers
- Gates only `drawMarkers(...)` (native arrows + carets, aggregate pills).
- Trade selection still works with markers off: selecting a trade row draws its
  risk/reward zone and scrolls to it; hovering a row draws the transient segment
  line. This works for free because the toggle-off case keeps `markerMode` at
  `native`/`aggregate` (not `none`), so `renderArtifacts` does not hit the
  `markerMode === "none"` early-return that skips the highlight/selection
  subscriptions. Those subscriptions are installed after the (now-gated) marker
  draw, independent of it.
- `reanchorBacktestMarkers` (history page-back redraw) gets a guard so paging
  does not resurrect markers while the toggle is OFF.

### Equity
- Becomes a live, device-local, global preference (like Periods), not a
  per-run config value. `result.showEquity` / `cfg.showEquity` plumbing is
  removed (single-user app, no back-compat needed).
- `renderArtifacts` decides whether the equity pane is present from
  `canEquity && backtestEquityShownSignal.value`, where `canEquity` is the
  timeframe-known flag from `backtestRenderFlags` (unchanged). A subscription
  adds/removes the equity sub-pane on flip.

## State + persistence

Two new signals in `lib/signals.ts`, mirroring `backtestPeriodsShownSignal`:

- `backtestMarkersShownSignal` — default `true`, seeded from
  `loadBacktestMarkersShown()`.
- `backtestEquityShownSignal` — default `false`, seeded from
  `loadBacktestEquityShown()`.

Two new device-local flat keys in `lib/persist/defaults.ts` mirroring
`BACKTEST_PERIODS_SHOWN_KEY` (`${PREFIX}.backtestMarkersShown`,
`${PREFIX}.backtestEquityShown`), each with `load*/save*` helpers, both added to
`DEVICE_LOCAL_FLAT_KEYS` so `hydrateFromBackend` does not prune them.

## Files touched

- `lib/signals.ts` — add the two signals.
- `lib/persist/defaults.ts` — two keys + load/save helpers + DEVICE_LOCAL_FLAT_KEYS.
- `lib/backtest.ts`
  - `renderArtifacts`: gate `drawMarkers` on `backtestMarkersShownSignal`; add a
    marker toggle subscription (clear ids / redraw on flip); source equity from
    `backtestEquityShownSignal` with add/remove subscription; extend
    `artifacts.unsub` to cover both new unsubscribes. Change the equity param to a
    `canEquity` (timeframe-known) flag.
  - `reanchorBacktestMarkers`: bail when `backtestMarkersShownSignal.value` is false.
  - `runAndRender` + `rehydrateBacktest`: drop the `showEquity` argument threading;
    equity is now sourced from the signal inside `renderArtifacts`.
- `lib/persist/artifacts.ts` — remove `showEquity` from `StoredBacktestResult` and
  the `saveBacktestResult` signature/body.
- `lib/backtestConfig.ts` — remove `showEquity` field + default.
- `BacktestSettingsModal.tsx` — remove the "Show equity curve" checkbox.
- `BacktestButton.tsx` — drop the `cfg.showEquity` argument.
- `BacktestPanel.tsx` — add the markers/equity signal hooks + flip handlers
  (`useSyncExternalStore`, flip signal + save helper), and replace the three
  standalone pills with the **Display** dropdown (own open state +
  outside-click/Esc effect + `.menu`/`.dropdown` markup).
- `App.css` — `.bt-display-menu` / `.bt-display-btn` / `.bt-display-dropdown`
  rules; retarget the summary row's `margin-left:auto` from `.bt-periods-toggle`
  to `.bt-display-menu`.
- `lib/ruleSeriesParityGolden.test.ts` — drop the now-removed `showEquity` field.

## Non-goals

- Skipping `coverBacktestHistory` history paging / `fitBacktestTrades` framing when
  markers are off. Those feed equity, period shading, and selection too, so they
  stay. A more aggressive "faster" mode can be revisited later.
- No migration of old persisted results carrying `showEquity` (harmless ignored
  property on cached render entries).

## Follow-on tweaks (same session)

- **Inspect moved to the footer.** The Inspect toggle left the Results summary row
  and now sits at the far-left of the modal footer (next to Run backtest), via
  `margin-right:auto`. It drives the shared `inspectModeSignal`; `BacktestPanel`
  reacts to that signal turning on by switching to its Inspect tab (an effect,
  replacing the old in-handler `setTab`).
- **Traded period in the status line.** The Results summary row now shows the
  traded date span (`formatPeriodDateRange`, e.g. "1 Jul – 14 Jul 2026") and, when
  a daily session window is set, the daily hours (`formatDayWindow`, e.g.
  "02:00 – 20:00"), each as a muted `.bt-period-label` with an icon. `minToTime` +
  `formatDayWindow` live in `lib/backtestSchedule.ts`; `formatPeriodRange` +
  `formatPeriodDateRange` in `lib/backtestPeriods.ts` (the modal's local
  `formatDateRange`/`minToTime` were deduped onto these shared helpers).

## Testing

- Vitest: existing `backtestRenderFlags` / parity tests still pass after the
  `showEquity` removal; update the golden fixture.
- Manual (browser): run a backtest, verify Show Markers OFF clears markers +
  carets instantly and keeps equity/periods; selecting a trade row still draws its
  zone with markers off; Equity toggle adds/removes the pane live; both persist
  across reload; the settings-form equity checkbox is gone.
