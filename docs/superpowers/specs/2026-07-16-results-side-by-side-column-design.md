# Backtest/Sweep results in a side-by-side column

## Goal

Let the user view backtest/sweep results in their own column *beside* the config
panel, instead of stacked below it, so both config and results get full height
and more room. The current stacked layout stays the default.

## Today's layout

`BacktestSettingsModal` renders a right-docked `aside.bt-cfg-panel` (resizable
width, `flex-shrink:0`) as a sibling of `<main class="chart">` inside the
`.workspace` flex row. Inside the panel:

```
aside.bt-cfg-panel
  bt-cfg-head
  bt-split (flex column)
    bt-settings-region   (config: htabs + scrolling content)
    bt-split-divider      (draggable, collapsible)
    bt-results-region     (results — follows active Backtest|Sweep mode)
  modal-foot bt-cfg-foot  (RunBar: mode switch + Run)
```

The results region shows `<BacktestPanel/>` in backtest mode and an inline sweep
block in sweep mode. Both result signals stay populated; the view follows the
mode switch, never "which results exist".

## Approach

Add a device-local toggle **`resultsSideBySide`** (default **off**). Off is
today's stacked layout, unchanged.

**When on**, the results content leaves the config panel and renders in a **new
docked column** — `aside.bt-results-col` — placed immediately *left of*
`bt-cfg-panel` in the fragment (so it sits between the chart and the config
panel in the `.workspace` flex row). Because it is another `flex-shrink:0`
sibling, the chart shrinks to make room automatically; no chart-side changes
needed.

In this mode the config panel shows only its settings region at full height:
the `bt-split-divider` and `bt-results-region` are not rendered inside the panel.

### Single results instance

The results content is lifted into one `resultsBody` value (the existing
backtest branch `btMode === "backtest" && <BacktestPanel/>` plus the inline
sweep branch, minus the stacked-mode collapse chevron). It renders in **exactly
one** place per layout:

- stacked → inside `bt-results-region`
- side-by-side → inside `aside.bt-results-col`

Nothing is duplicated; it still follows the active Backtest|Sweep mode and the
past-sweeps picker.

### The results column

- Own left-edge resize handle + device-local persisted width
  (`resultsColWidth`), mirroring the existing `panelWidth` /
  `saveBacktestPanelWidth` / `clampWidth` pattern (same clamp helper and
  double-click-to-reset).
- Header: a "Results" title and a **dock-back** button that flips the toggle
  off (results return to the stacked region).
- Full height (`align-self: stretch`), `border-left`/`border-right` to read as a
  distinct surface next to the config panel.

### The toggle control

- Stacked mode: a small side-by-side / pop-out icon button in the existing
  `bt-results-toggle` header row turns it on.
- Side-by-side mode: the dock-back button in the column header turns it off.
- Persisted device-local (UI chrome, not results — consistent with
  `panelWidth`, even though results themselves are tab+cell-scoped).

## Behavior decisions

- **Remount on flip (accepted).** Moving `resultsBody` between two DOM parents
  remounts `BacktestPanel`, so its local `useState` resets: the
  Overview/Trades/Analysis/Inspect **sub-tab** returns to Overview (or Inspect
  if inspect mode is active) and the **trade-table sort** returns to default;
  scroll position resets. Result *data*, the **selected/highlighted trade**, and
  the marker/period/equity view toggles are signals and survive. This is
  acceptable for a rare, deliberate layout switch. (Follow-up if it ever feels
  bad: lift `tab`/`sort` from `BacktestPanel` local state to signals — out of
  scope here.) The remount re-renders from signals only; it does not re-run a
  backtest or sweep.
- **Collapse interaction.** Side-by-side ignores the stacked `split.collapsed`
  state — the column is always shown. Docking back restores whatever collapse
  state was in effect before.
- **Chart floor.** With three docked asides possible (alerts + results column +
  config) against `.chart { min-width: 0 }`, the chart can get very narrow. The
  user accepted "shrinks chart." Optional nicety: clamp the results column width
  against remaining space so the chart keeps a small minimum; not required for
  v1.
- **Close.** The column is part of `BacktestSettingsModal`, so closing the panel
  closes the column with it.
- **LiveTradingPanel** reuses `bt-cfg-panel` but has no results region; it is
  unaffected.
- **RunBar footer** stays in the config panel in both layouts.

## Files

- `frontend/src/BacktestSettingsModal.tsx` — toggle state + persistence,
  `resultsBody` extraction, the new `aside.bt-results-col` branch, column resize
  handle, toggle/dock-back buttons.
- `frontend/src/lib/persist/*` — `resultsSideBySide` + `resultsColWidth`
  getters/setters (device-local flat keys, mirroring the panel-width helpers).
- `frontend/src/App.css` — `.bt-results-col`, its resize handle and header, and
  the `bt-mode-*` / stacked-vs-column style tweaks.

## Testing

- Existing `BacktestSettingsModal.test.tsx` assertions query results *inside* the
  panel; default-off keeps them green.
- New coverage: with the toggle on, results render in the sibling
  `aside.bt-results-col` and not in `bt-results-region`; toggling back returns
  them; persistence round-trips the flag and column width.
