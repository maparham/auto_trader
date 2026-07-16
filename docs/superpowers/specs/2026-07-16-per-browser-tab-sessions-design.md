# Per-browser-tab sessions: independent broker, layout, and chart selection

Date: 2026-07-16
Status: Approved

## Goal

Open the app in multiple browser tabs without interference. Each browser tab
independently selects its broker/account, named layout, and active chart tab.
Saved data (drawings, indicators, alerts, layouts, settings) stays one shared,
backend-synced store: two tabs looking at the same thing still sync live
(selection-only isolation, TradingView-style).

Out of scope: the concurrent-edit drawing stomp when two tabs draw on the exact
same cell at the same time. Drawing saves remain full per-cell snapshots.

## Current state (why tabs fight today)

- `activeAccount` is a bare localStorage key; both browser tabs read/write it,
  and `persistBroker` (module singleton in `lib/persist/core.ts`) is seeded
  from it. Two tabs cannot be on different brokers.
- `activeLayoutId` is device-local localStorage, shared by all tabs in the
  browser.
- The live working chart-tab set is one shared, backend-mirrored key
  `root("tabs")`. Loading a layout in one browser tab rewrites it and reseeds
  every other tab.
- `onBackendPush` (`App.tsx`) treats every backend push as potentially "my
  view".
- Already per-tab and kept as-is: active chart tab (sessionStorage
  `auto-trader.activeTabId`), sweep resume, scratch/autosave, backtest/live
  UI-pref flat keys, and the live-engine BroadcastChannel lease.

## Design

### 1. Session-scoped selections (with device seed)

Pattern: read sessionStorage first, fall back to localStorage as the
"last used" seed; every change writes both. Same shape as the existing
`ACTIVE_TAB_SESSION_KEY` handling.

Applies to:

- **Active account/broker** (`activeAccount`). `persistBroker` stays a per-tab
  module singleton, now driven by this tab's session value. The single-writer
  invariant (App broker-switch effect) is unchanged. `lastAccountByBroker`
  stays device-local.
- **Active layout id** (`activeLayoutKey`). Gains the sessionStorage layer so
  two tabs can sit on different layouts and survive their own reloads.
- **Active chart tab**: already sessionStorage; keep `pickActiveTabId`
  semantics.

A fresh browser tab opens looking like the most recently used tab (broker +
layout), then diverges freely.

### 2. Per-layout working sets

Retire the single `root("tabs")` key. Each layout's live working state (the
`ChartTab[]` array) autosaves under a per-layout, backend-mirrored key:

- `root("layoutTabs.<layoutId>")` for named layouts.
- The unnamed workspace keeps the existing device-local `scratch`/`autosave`
  keys.

Consequences:

- Two browser tabs on the same broker + same layout share
  `layoutTabs.<id>`; edits propagate via the existing WS push + reseed path.
- Tabs on different layouts or brokers write to disjoint keys and never
  interact.
- Named layout bodies (`familyRoot("layout.<id>")`) remain the explicit
  "Save layout" snapshots, unchanged. `layoutTabs.<id>` is the autosaved
  working copy.
- Startup resolution: session `activeLayoutId` -> its `layoutTabs` working
  copy if present -> the saved layout body -> scratch -> default seed.

**Migration (one-time, on boot):** if legacy `root("tabs")` exists, copy it
into `layoutTabs.<activeLayoutId>` (or scratch when no active layout), then
delete the legacy key locally and on the backend via `removeKeyEverywhere`.
No dual-read path remains after boot.

### 3. Backend-push relevance gate

`onBackendPush` acts on a pushed key only if it belongs to this tab's current
broker namespace AND, for workspace keys, either this tab's active layout's
`layoutTabs` key or a cell scope currently mounted in this tab. Irrelevant
pushes still land in localStorage silently so a later broker/layout switch
finds fresh data.

- Alerts: keep the per-epic in-place reconcile; relevance is "epic visible in
  one of my cells" (existing `bumpAlerts` behavior).
- Layouts index (`familyRoot("layouts")`) stays globally relevant so the
  layout picker refreshes everywhere. If the layout this tab is viewing gets
  deleted from another tab, this tab falls back to scratch.

### 4. Shared surfaces (unchanged)

Settings, magnet mode, drawing/indicator templates and presets, named layout
index and bodies, default layout, alerts, triggered history, per-cell
drawings/indicators/AVWAP, backtest results. All remain global, mirrored, and
live-synced.

### 5. Edge cases

- **Live engine:** the BroadcastChannel lease is already per `epic|account`.
  Two tabs on different brokers can each arm; the same market still gets
  single-owner protection. No change.
- **`?tab=` deep link:** unchanged; resolves within the session layout's
  working set.
- **Duplicated tab:** seeds from localStorage last-used values, opens as a
  twin, diverges from there.
- **Broker switch (`reseedFromLocal`):** also re-resolves the layout selection
  from this tab's session value within the new broker's namespace.

## Testing

Unit tests:

- Session-with-seed storage helper (fresh tab seeds from localStorage; writes
  update both layers).
- Legacy `tabs` migration: legacy present, absent, and no-active-layout cases.
- Startup resolution order (working copy vs saved body vs scratch vs seed).
- Push relevance gate: my layout, other layout, other broker, layouts index,
  visible-epic alerts.

Manual two-tab pass: different brokers side by side; different layouts side by
side; same layout live-syncs both ways; live-engine lease still blocks a
duplicate arm on the same market.
