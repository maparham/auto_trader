# Mobile Companion (PWA) — Design

**Date:** 2026-09-07
**Status:** Approved design, pre-implementation

## Goal

A phone-friendly companion surface for auto_trader, delivered as an
installable PWA inside the existing frontend codebase. It is a focused
monitoring-and-action surface: live charts (with indicators and drawing
tools), alerts, positions & P&L, and a simple order ticket. Backtesting,
sweeps, WFO, replay, and heavy analysis remain desktop-only.

## Approach (decided)

Reuse `ChartCore` with a new `compact` mode inside a dedicated mobile
shell (`MobileApp`), rather than making the desktop UI responsive or
building a parallel chart on raw klinecharts. The data layer
(`lib/http`, `lib/feed`, `lib/persist`, `lib/alertsApi`, `lib/trading`),
auth, and `theme.ts` are reused untouched. `api.ts` (backtest/sweep
surface), `Toolbar`, `DrawSidebar`, `ChartGrid`, and App's desktop
panels are not mounted on mobile.

## 1. Entry, shell, and navigation

**Boot.** A third branch in `main.tsx`, alongside the snapshot branch
but *inside* `ClerkProvider > SignedIn > AccountGate`, so auth, token
wiring, and per-account storage wipes are inherited. Selection:

- `?m=1` forces mobile; `?m=0` forces desktop.
- Otherwise auto-detect via
  `matchMedia('(max-width: 768px) and (pointer: coarse)')`.
- The choice is persisted so an installed PWA always boots mobile.

The static `App.tsx` import in `main.tsx` stays, so the module-level
`registerCustomIndicators()` / `registerBacktestIndicators()` /
`registerCustomOverlays()` / `registerPositionLine()` side effects still
run (see `lib/moduleInitOrder.test.ts` for ordering caveats).

`MobileApp` bootstraps exactly as `SnapshotApp` does:
`hydrateFromBackend()` → `hydrateAlerts()` →
`applyThemeToDocument(loadSettings())` → mount.

**Shell.** Full-screen layout with a bottom tab bar: **Chart · Alerts ·
Positions · Trade**. The Chart tab has a slim top bar (symbol +
timeframe); tapping symbol opens the symbol search as a mobile sheet,
tapping timeframe opens a period picker. Initial market: freshest
`view.<epic>` heartbeat, falling back to the first favorite.

**Scope.** The mobile chart uses its own persist scope for
layout/zoom/indicators, independent of desktop tabs. All mobile UI
(sheets, modals) are new mobile-sized components; no desktop panels are
mounted.

## 2. Chart: compact mode, indicators, drawings

**Compact mode.** `ChartCore` gains `compact?: boolean`. When set:

- `ChartRangeBar`, replay pills/ticket/start panel, `DetachedPill`, and
  `CandleCacheStatsModal` do not render.
- `ChartLegend` renders in a smaller, tap-to-expand form.
- The right-click `ContextMenu` is replaced by long-press → the same
  menu as a bottom sheet.
- Everything else (live feed, hydration, scales, bid/ask, crosshair) is
  untouched. klinecharts 10 handles pinch/pan/touch-crosshair natively.

**Drawings scope.** Drawings persist keyed `scope+epic` per desktop
cell. Mobile adopts the scope from the freshest `view.<epic>` heartbeat
for the current market — you see and edit the drawings of the desktop
cell you last viewed that market in; edits sync live over `/ws/state`.
No heartbeat for the epic → fall back to the mobile shell's own scope.

**Drawing on touch.** A floating pencil button opens a horizontal tool
strip (same 13 `DRAW_TOOLS`, same `DrawIcons` glyphs, favorites first).
Arming a tool feeds taps into klinecharts' point-placement state
machine. Magnet snapping becomes a toggle in the strip (replacing the
Ctrl/Cmd modifier). Tapping an existing drawing selects it and shows a
small action bar: **Edit** (`DrawingSettings` re-hosted as a bottom
sheet), **Delete**, **Duplicate**. Move/reshape uses klinecharts'
built-in overlay drag.

**Indicators.** An "Indicators" button in the top bar opens a sheet
listing active indicators (toggle/remove) with an add-picker — thin
wrappers over the same `lib/indicators.ts` sync as desktop, plus
`IndicatorSettings` re-hosted as a bottom sheet.

**Signal re-hosting.** `MobileApp` subscribes to and hosts, in
mobile-sheet form: `alertEditRequest`, `drawingSettingsRequest`,
`indicatorSettingsRequest`, `requestConfirm`, `requestSymbolSearch`,
`stageChartOrder`. Desktop-only signals (backtest drill, trade editor,
etc.) are no-ops on mobile.

## 3. Alerts, Positions, Trade tabs

**Alerts.** Active list + fired history via `lib/alertsApi.ts`
(`/api/alerts`, `/api/alerts/triggered`), live over `/ws/state`. Row:
symbol, condition, price; tap → edit sheet (mobile
re-host of `AlertModal` fields); delete with confirm. Create via a +
button prefilled with the current chart market. Alert lines render and
drag on the mobile chart (existing `OverlayManager` behavior). Fired
history shows time, price, and chart snapshot image when present.

**Positions.** Account summary strip (balance, equity, open P&L from
`/api/account`) above open positions and working orders from
`lib/trading.ts`, live-updating. Position → detail sheet with **Close**
(full close, confirm). Working order → **Cancel**. Partial closes and
amendments are desktop-only in V1.

**Trade.** Mobile order ticket: market picker (defaults to chart
market), direction, size, optional stop/limit distances, submitting via
the same `lib/trading.ts` endpoints as desktop `OrderTicket`. Hosts the
`stageChartOrder` flow with price prefilled. Placement always confirms
before sending; no one-tap dealing.

## 4. PWA, push, error handling

**PWA.** `manifest.webmanifest` (standalone display, icons, theme
color), apple/theme-color meta tags in `index.html`, generated icons in
`public/`. Start URL `/?m=1`. Offline: fold a minimal app-shell precache
into the existing `alert-sw.js` — it must remain the single root-scope
SW or push breaks. Cache built assets; network-first otherwise; an
explicit "you're offline" state, no offline data.

**Push.** Reuse the existing pipeline (`pushClient.ts`, VAPID,
`/api/alerts/push/subscribe`) untouched. A small settings sheet surfaces
the enable prompt, with the iOS install-to-home-screen hint when
applicable.

**Errors.** All HTTP via `apiFetch` (401 refresh-retry). Reconnecting
banner when `/ws/candles` or `/ws/state` drops (both auto-redial).
Snackbar for action failures. Dealing renders server-confirmed state
only.

## 5. Testing

Vitest + Testing Library, matching repo conventions:

- Boot-branch selection (`?m=1`/`?m=0`/auto-detect/persisted choice).
- Mobile drawing-scope resolution (heartbeat → fallback).
- Signal re-hosting: signal fires → corresponding sheet mounts.
- Order-ticket confirm gate (no request without confirmation).

Chart/touch behavior verified manually via Chrome device emulation; no
new Playwright infra in V1.

## Out of scope (V1)

Backtesting/sweeps/WFO/replay on mobile, partial closes and order
amendments, multi-chart layouts, Capacitor/native wrappers, offline
data, desktop-UI responsiveness changes.
