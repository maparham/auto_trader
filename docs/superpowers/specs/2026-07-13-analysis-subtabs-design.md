# Analysis Sub-tabs and Collapsible Sections: Design

**Problem:** The backtest Analysis tab stacks eight sections (placement readouts + three distributions, the What-if section, Exit reasons, and five condition tables). After the what-if suite landed, the page is too long to scan.

**Decision (user-approved):** Split the Analysis page into three sub-tabs and make every section header collapsible. No backend changes.

## Sub-tabs

A secondary segmented control at the top of the Analysis page, reusing the shared `.seg` pattern (`role="tablist"`, `seg-on` active class) already used for the Overview/Trades/Analysis/Inspect row in `BacktestPanel.tsx`. Visually secondary to that main row (smaller; exact sizing at implementer's discretion within the existing `.seg` styling).

Pages and contents (all content moves verbatim from the current single page; no section is redesigned):

| Sub-tab | Contents |
| --- | --- |
| Placement | Placement readout bullets, then the three `Dist` blocks (winners MAE, losers MAE, result distribution) |
| What-if | The `WhatIfSection` content: what-if bullets, then the Tighter stop and Target placement tables |
| Context | Exit reasons table, then the five condition tables (Trend at entry, Volatility regime, Session, Entry-bar pattern, Day of week) |

The What-if sub-tab button is hidden entirely when `WhatIfSection` would render null (whatif absent or all six sections null, e.g. old stored runs). If the persisted active tab is the hidden What-if tab, fall back to Placement.

## Collapsible sections

Every section `h4` on each page becomes a toggle: a chevron glyph plus the existing header content (InfoTips stay in the header and must keep working; clicking the InfoTip must not toggle the section). All sections start expanded. Collapsing hides the section body, header remains.

Section identity for persistence is a stable slug per section (e.g. `placement-readouts`, `dist-winners-mae`, `whatif`, `exit-reasons`, `ctx-trend`), not the display label.

## Persistence

Device-global, one preference for the whole app:

- Active sub-tab: flat `saveLocal` key (e.g. `<PREFIX>.backtestAnalysisTab`).
- Collapsed set: flat `saveLocal` key holding an array of collapsed section slugs (e.g. `<PREFIX>.backtestAnalysisCollapsed`).

Both keys MUST be registered in `DEVICE_LOCAL_FLAT_KEYS` in `frontend/src/lib/persist/core.ts`, otherwise `hydrateFromBackend` prunes them on reload (known gotcha, see device-local persist keys). Unknown slugs in the stored array are ignored; sections not listed are expanded.

## Testing

`BacktestAnalysisPanel.test.tsx`:
- Existing assertions updated to activate the right sub-tab first (What-if assertions switch to the What-if tab, context-table assertions to Context).
- New: default tab is Placement; switching tabs swaps content; What-if tab button absent when whatif is undefined or all-None (and the other two tabs still work); collapsing a section hides its body and persists across remount; expanded is the default for unknown/new sections.

## Constraints

- Frontend only; formatting and layout, no analysis logic changes.
- Reuse shared components/classes (`.seg`, existing `bt-analysis-*` classes); no new one-off styling systems.
- No em dash or "--" as punctuation anywhere in copy or comments.
- Typecheck via `npx tsc -b` (60 pre-existing errors, zero new).
