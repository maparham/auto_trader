# Public Demo Page (Home Page) Design

Date: 2026-09-12
Status: approved in chat, pending spec review

## Goal

A sales-teaser demo as the public home page. Visitors who are signed out
see the real Chartkar app running on an admin-published layout, with data
fixed to Dukascopy and no broker selection. They can explore the chart,
switch timeframes and whitelisted symbols, add indicators, draw, and
browse pre-baked backtest results. Heavy or stateful features are locked
and become sign-up CTAs.

Non-goals: anonymous compute (live backtests, sweeps, WFO, pattern
search), anonymous server-side persistence, dealing of any kind, a
separate marketing site.

## Feature matrix

Included for anonymous visitors:

- Real chart UI on the admin-published layout: multi-chart grid, legend,
  range bar, toolbar.
- Timeframe switching; symbol switching within an admin-curated demo
  watchlist (no full symbol search).
- Indicators and drawing tools, fully usable, session-local only
  (localStorage, never mirrored to the backend).
- Browsable pre-baked backtest results (markers, trade popovers,
  analysis panel) published by the admin, with a result picker. The Run
  button is replaced by a sign-up CTA.
- Theme and appearance toggles.
- Persistent sign-up CTA where the broker selector normally sits, plus
  CTA hooks on locked features. Sign-in reachable from the header.

Excluded (hidden in demo mode, still 401/403 on the backend):

- Broker selector (data source hard-fixed to `dukascopy`), accounts,
  order ticket, positions, live trading.
- Live backtest runs, sweeps, WFO, pattern search.
- Alerts, notifications, Telegram.
- Backend persistence: `/api/state`, snapshot gallery, trade lists.
- Agent bridge, admin console, mobile app, server-writing settings.

## Architecture

One codebase, one deployment. A demo principal inside the existing app
rather than a separate static build or proxy.

### Backend: demo principal

- In hosted mode (`CLERK_JWKS_URL` set), unauthenticated requests
  currently 401 in `backend/auto_trader/api/auth.py`. Change: a request
  without a bearer token is assigned `user_id="demo"`, `is_demo=True`,
  `is_admin=False`, and is allowed only if it matches a demo allowlist;
  everything else keeps the current 401.
- Demo allowlist (GET only):
  - candles and market metadata, scoped to broker `dukascopy` only
    (any other broker: 403),
  - the published demo snapshot endpoint (layout + watchlist + canned
    backtest results),
  - static assets and `/health` as today.
- The `/ws/state` WebSocket stays closed to demo users. Demo users can
  never read or write `/api/state`.
- Per-IP rate limiting on the demo allowlist (none exists today and the
  surface becomes public). Simple in-process token bucket keyed by
  client IP; conservative defaults, env-tunable. Dukascopy fetches
  already cache per (epic, resolution, side), which bounds upstream
  load.
- Dev mode (`CLERK_JWKS_URL` unset) is unchanged: everyone is `dev` and
  admin, demo logic dormant.

### Admin publish

- Admin curates a layout, watchlist, and backtest runs in their own
  account, then calls a new admin-gated publish endpoint
  (`deps.require_admin_console` family gate, POST) that freezes:
  - the layout JSON,
  - the demo symbol whitelist,
  - selected backtest result payloads (full result objects as rendered
    by the backtest panel).
- Stored server-side in a small versioned store (SQLite table alongside
  `app_state.db` patterns): each publish is a new version; the demo
  serves the latest; admin can roll back to a prior version.
- Anonymous visitors fetch the latest snapshot at boot via the public
  GET endpoint above.

### Frontend: demo boot

- In `frontend/src/main.tsx`, when Clerk is enabled and the visitor is
  signed out, the home page renders the real `App` in demo mode instead
  of the sign-in card. Sign-in stays reachable via a header button and
  a `/sign-in` style route or query flag.
- Demo mode flag threads through as a single context/module flag:
  - broker hard-fixed to `dukascopy`; `BrokerSelector` replaced by a
    sign-up CTA,
  - persistence backend mirror disabled (`persist/core.ts` mirror gate);
    localStorage only, keyed so a later sign-up does not collide with a
    real account (existing `AccountGate` wipe covers the transition),
  - feature gates hide dealing, alerts, sweeps/WFO/pattern panels, live
    backtest run, snapshot gallery, and server-writing settings,
  - backtest panel renders published canned results with a picker; Run
    becomes a sign-up CTA,
  - symbol search limited to the published demo watchlist.

## Error handling

- No published demo snapshot yet: demo boot shows a minimal fallback
  (single chart, default symbol from the whitelist env or `US100`) so
  the page never hard-fails; admin console shows "no demo published".
- Rate-limited or failed candle fetches: existing chart error surfaces;
  no retries beyond current behavior.
- Publish endpoint validates the layout JSON shape and that every
  referenced symbol resolves on `dukascopy` before accepting.

## Testing

- Backend: allowlist unit tests (anonymous GET dukascopy candles 200,
  anonymous POST backtest 401, anonymous GET capital candles 403,
  `/api/state` blocked, WS rejected), publish/fetch round-trip,
  version rollback, rate limiter behavior.
- Frontend: demo-mode gate tests (hidden panels, CTA rendering,
  mirror disabled, canned backtest picker). Affected test files only,
  never the full suite.
- Manual probe: signed-out browser hit on the hosted URL renders the
  published layout with live Dukascopy candles.
