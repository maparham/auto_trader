# Telegram Live Chart Snapshot — Design

**Date:** 2026-09-07
**Status:** Approved design, pre-implementation

## Problem

The chart photo attached to a Telegram alert is a synthetic matplotlib
candlestick (`backend/auto_trader/core/alert_chart.py`): no indicators, no
drawings, fixed light theme — unrelated to the chart the user actually looks
at. The goal is that the user sees **their real chart** — their indicators,
drawings, theme, and zoom, with live data at the moment the alert fires —
directly in Telegram, **without opening the app**.

## Decision

At fire time the backend renders the user's chart itself: a headless Chromium
(Playwright) opens the frontend in a dedicated snapshot mode that reconstructs
the user's last-seen view for that symbol, loads **fresh live data**, and is
screenshotted. The PNG replaces the matplotlib image in the Telegram photo
message. The matplotlib renderer stays as the fallback for every failure mode
(no heartbeat yet, frontend unreachable, render timeout), and text remains the
final fallback — the existing degradation chain is extended, not replaced.

Because `activeTabId`/`activeLayoutId` are deliberately per-browser-tab (not
mirrored), the backend cannot infer which chart the user watches. A **view
heartbeat** closes that gap: while the app is open, the active cell passively
reports a small view descriptor. The heartbeat only identifies the *view*;
every pixel is rendered fresh at fire time — so it keeps working hours or days
after the user closed every tab.

## Components

### 1. View heartbeat (frontend)

The active chart cell writes a descriptor through the existing state mirror
(`save()` → `PUT /api/state/<key>`), one key per symbol:

- Key: `auto-trader.b.<broker>.view.<epic>` (mirrored, NOT device-local).
- Value: `{ cellScope, timeframe, theme, barsVisible, width, height, updatedAt }`
  - `cellScope` — the cell's `tab.<id>[.cell.<id>]` scope, which addresses all
    mirrored per-cell content (indicators, indicatorConfig, drawings, avwap).
  - `barsVisible` — current zoom (bar count on screen), so the snapshot keeps
    the user's zoom while scrolling to live.
  - `width`/`height` — the cell's pixel size, for a matching aspect ratio.
- Written debounced (~2 s) when the active cell's symbol, timeframe, zoom,
  theme, or indicator set changes, and on tab/cell focus change. Last writer
  wins across devices — i.e. the most recently *used* view.

### 2. Snapshot mode (frontend)

A query-flag boot mode (`/?snapshot=1&broker=..&epic=..&scope=..&level=..&price=..&t=..`)
in `main.tsx` that bypasses the normal app shell and renders exactly one
full-window `ChartCore`:

- Hydrates the user's state from `/api/state` as usual, then renders the chart
  for the given scope: same indicators, indicator configs, drawings, theme.
- No chrome: no tabs, toolbars, panels, modals — chart canvas + legend +
  price/time axes only.
- Draws the alert level as the alert-line overlay and marks the fired price.
- Loads live candles for the descriptor's timeframe, applies `barsVisible`
  zoom, scrolls to the latest bar.
- When candles are loaded and indicators have computed, sets
  `window.__snapshotReady = true` (and `__snapshotError = <msg>` on failure)
  for the renderer to await.
- Dev-build always on; production only with `VITE_AGENT_BRIDGE`-style gating is
  NOT needed — the mode renders only the authenticated user's own data (see
  auth below), so it ships enabled.

### 3. Headless renderer (backend)

New `backend/auto_trader/core/chart_snapshot.py`:

- One persistent headless Chromium via `playwright` (new backend dependency;
  Chromium installed in the Dockerfile). Lazy-launched on first use,
  relaunched if it dies; pages are pooled/serialized (max 2 concurrent
  renders, queue behind that).
- `render_live_chart(user_id, payload) -> bytes | None`:
  1. Read the heartbeat key for `(user, broker, epic)` from `STATE_STORE`.
     Missing → return `None` (fallback).
  2. Mint a short-lived render token for `user_id` (hosted mode only).
  3. Open `<FRONTEND_URL>/?snapshot=1&...` in a fresh browser context sized to
     the descriptor's `width × height` (device scale 2 for a crisp photo).
  4. Wait for `__snapshotReady` (10 s budget). Screenshot the chart element.
  5. Any error/timeout → log + `None`.
- `FRONTEND_URL` env (default `http://localhost:5173` in dev; the hosted
  deploy sets its real origin). Unset/unreachable → `None`.

### 4. Auth: render token

Hosted mode requires a Clerk JWT for `/api/state` and candles. The headless
browser is the backend itself, so it self-mints: a signed short-TTL (60 s)
token carrying the `user_id`, issued by a new internal signer (random per-boot
secret, HS256), accepted by the auth layer as an *additional* verification
path alongside Clerk — scoped read-only in spirit (it authenticates the
snapshot page's GETs/websockets as that user). Local dev (auth off) needs no
token. The token travels as a query param the snapshot page passes into its
API client for the session.

### 5. Delivery integration

`telegram_notify._render_snapshot` becomes a chain:

1. `chart_snapshot.render_live_chart(...)` — the real chart.
2. Existing matplotlib `render_alert_chart(...)`.
3. Text-only message.

Same single Telegram photo message as today; the render is bounded by the
10 s timeout so a firing is never delayed beyond that. Nothing changes for
`/ws/state`, web push, or triggered history.

## Error handling

| Failure | Behavior |
|---|---|
| No heartbeat for (user, epic) | matplotlib fallback |
| Frontend origin down / unreachable | fallback, warn log |
| `__snapshotReady` timeout / `__snapshotError` | fallback, warn log |
| Browser crash | relaunch next render; this render falls back |
| Playwright not installed / Chromium missing | feature auto-off, fallback (import guarded like matplotlib) |
| Concurrent firings | serialized page pool, queue; queue wait counts against the 10 s budget |

## Testing

- Unit: heartbeat write triggers + debounce (frontend); snapshot-mode boot
  renders scope content and sets `__snapshotReady` (vitest + jsdom where
  possible); renderer fallback chain with a stubbed `render_live_chart`
  (backend); render-token mint/verify round-trip.
- Integration probe: `backend/scripts/snapshot_probe.py` (pattern of
  `alert_probe`): reads a real heartbeat, renders against the running dev
  stack, writes the PNG to disk for eyeballing.
- Playwright-in-CI is NOT required: the headless path is exercised by the
  probe against the dev stack; CI covers the chain via stubs.

## Out of scope

- Screenshot for web push / in-app toast (Telegram only, as today).
- Multi-cell / whole-layout screenshots — one chart, the heartbeat's cell.
- Historical viewport replay — the snapshot always shows live data at fire
  time, user's zoom, latest bar at the right edge.
