# Backend Alert Engine — Design

**Date:** 2026-09-06
**Status:** Approved design, pre-implementation

## Problem

Price alerts are evaluated entirely in the browser (`frontend/src/lib/alertEngine.ts`):
the engine only opens feeds for epics visible in some open tab, so alerts on closed
symbols never fire, expiry is only enforced on ticks, and nothing fires when the app
isn't open. Alerts are stored as opaque localStorage JSON blobs
(`auto-trader.b.<broker>.alerts.<epic>`), mirrored per-user into `app_state.db`.

## Decision

Rebuild alerts as a **first-class backend system** (data model, API, evaluation
engine, delivery), covering **all** of a user's alerts regardless of what's open in
any browser. The frontend becomes a pure alert editor + renderer. The old
localStorage-based system is removed; existing alerts get a best-effort one-shot
migration.

Alert capabilities are unchanged for now (price level + condition + once/every +
message + expiry + channels), but the schema anticipates future alert kinds
(drawings, indicators) via a `kind` discriminator and a JSON `params` payload.

Delivery when an alert fires:

1. **Triggered history** — always written server-side.
2. **Open tabs** — server pushes a `fired` event; the browser renders toast /
   sound / browser-notification / tab badge as today.
3. **Web Push** — OS notifications with the app closed (service worker).
4. **Telegram** — bot DM, works with everything closed.

## Architecture

One global engine (a supervised background task in the FastAPI process) owns all
evaluation. It keeps every user's alerts in an in-memory registry grouped by
`(broker, epic)`, opens **one price feed per distinct (broker, epic)** that any
alert needs (deduped across users), evaluates each tick against every alert on
that pair, and fires through the delivery pipeline. CRUD notifies the engine
in-process (no polling). Feeds use the broker's streaming generator when
`supports_streaming`, otherwise fall back to polling `get_quote` every ~5 s. A
feed error never kills the engine; feeds reconnect with backoff; the engine task
itself restarts on crash (watchdog pattern, like mt5).

Alerts fire only while the backend runs — true 24/7 means keeping the backend up.

## Data model (`alerts.db`, new `AlertStore` singleton)

Stdlib sqlite + `run_migrations`, same pattern as `state_store`/`tick_store`.

**`alerts`**

| column | notes |
|---|---|
| `user_id TEXT`, `id TEXT` | PK `(user_id, id)`; server-generated `al-<uuid>` |
| `broker TEXT`, `epic TEXT` | what to watch (epics are broker-specific) |
| `kind TEXT` | `"price_level"` only, for now |
| `params TEXT` | JSON per kind. `price_level`: `{level, condition, trigger}` — condition ∈ `crossing, crossing_up, crossing_down, greater, less`; trigger ∈ `once, every` |
| `message TEXT` | optional custom message |
| `expires_at INTEGER NULL` | ms UTC; null = never |
| `notify TEXT` | JSON `{toast, browser, sound, push, telegram}`, all default on |
| `active INTEGER` | future pause/resume; always 1, no UI yet |
| `created_at`, `updated_at INTEGER` | ms UTC |

**`triggered`** — firing history: `user_id, time, alert_id, broker, epic, kind,
price, level, condition, message, precision`. Pruned to last ~500 per user.
Replaces the localStorage triggered log.

**`push_subscriptions`** — `user_id, endpoint (PK), keys JSON, created_at`. One
row per browser that granted permission; rows pruned when a push returns 404/410.

**`telegram_links`** — `user_id (PK), chat_id, linked_at`. Pending one-time link
codes live in memory only (code → user_id, ~10 min TTL).

**`meta`** — VAPID keypair, generated once at first use (zero-config push).

Arming + crossing-baseline state is **in-memory in the engine**, keyed
`(user_id, alert_id)` — never persisted. On restart every alert re-arms with an
empty baseline; the two-sample crossing guard prevents a spurious fire on the
first tick (same invariant as the TS engine).

## API (`api/routers/alerts.py`, all per-user via `current_user`)

Alert CRUD:

- `GET /api/alerts` — all the user's alerts (frontend filters per chart)
- `POST /api/alerts` `{broker, epic, kind, params, message?, expires_at?, notify?}` → created alert (server assigns id)
- `PATCH /api/alerts/{id}` — partial update (level drags send `{params}`)
- `DELETE /api/alerts/{id}`

History:

- `GET /api/alerts/triggered` → log + `seen` watermark
- `POST /api/alerts/triggered/seen {time}`; `DELETE /api/alerts/triggered`

Telegram:

- `POST /api/alerts/telegram/link` → `{url: "https://t.me/<bot>?start=<code>"}`
- `GET /api/alerts/telegram` → `{linked, chat_username?}`; `DELETE` unlinks
- `POST /api/alerts/telegram/test` — sends a test DM
- Bot transport: engine long-polls `getUpdates` (no public webhook needed);
  `/start <code>` claims the pending code. Token via `.env` `TELEGRAM_BOT_TOKEN`.
  Plain `httpx`, no new dependency.

Web Push:

- `GET /api/alerts/push/vapid` → public key
- `POST /api/alerts/push/subscribe` / `DELETE` — this browser's subscription
- New dependency: `pywebpush`. New service worker in `frontend/public/` shows the
  OS notification (suppressed when a tab is focused; click focuses/opens the app
  at the epic). Push works on `http://localhost` (secure-context exemption);
  production needs HTTPS.

Live sync: **reuse `/ws/state`** with a new message family —
`{alert_event: "changed" | "fired", ...payload, origin}` broadcast to the user's
sockets on every mutation (CRUD from any tab, engine deletions, firings).
`fired` carries `alert_id, broker, epic, price, level, condition, message,
precision, notify`.

## Engine (`core/alert_engine.py`)

- **Registry:** loaded from `AlertStore` at startup; router calls
  `engine.on_alert_changed(...)` after every write. Per-id config signature
  (`level|condition|trigger`) diffed on change: a reconfigured alert resets its
  baseline and re-arms (same move-detection semantics as the TS engine — see
  `frontend/docs/alert-identity-redesign.md`).
- **Feeds:** one task per distinct `(broker, epic)` with ≥1 active alert; opened/
  closed as the registry changes. Streaming where supported, ~5 s quote polling
  otherwise.
- **Price side:** ticks carry bid/ask where available; each user's alerts
  evaluate on that user's stored price-side setting (read from the mirrored
  `app_state` settings); mid is the fallback.
- **Evaluation:** `evaluate_alert(prev, price, level, condition, trigger, armed)
  -> (fired, next_armed, remove)` — a direct Python port of
  `frontend/src/lib/alertEval.ts`, pinned by a port of its test suite.
- **Firing order:** (1) triggered row, (2) `fired` broadcast, (3) Web Push if
  `notify.push` (always sent; the service worker suppresses the banner when a tab
  is focused), (4) Telegram DM if `notify.telegram` and linked, (5) `once`/expired
  → delete row + `changed` broadcast. Deletions are by-id, never list overwrites.
- **Expiry sweep:** a 30 s timer prunes expired alerts without firing — expiry
  holds even when the market is closed.

## Frontend changes

- **`lib/persist/alerts.ts` → `lib/alertsApi.ts`:** API-backed client with an
  in-memory cache hydrated by `GET /api/alerts` on startup/reconnect. Read sites
  (`loadAlerts`, `loadAllAlerts`, `loadStoredAlert`, triggered log) stay
  **synchronous** against the cache, so overlay/sidebar/modal/pills keep their
  call shapes. Writes are optimistic (cache first, API call after; rollback +
  toast on failure). Level-drag PATCHes are debounced to the drop.
- **`alert_event` handling:** `changed` patches the cache and `bumpAlerts()`
  (existing reconciliation path unchanged); `fired` drives a new `onAlertFired`
  handler in App that runs today's `fire()` surfaces (toast / `notify` /
  `playPing` / `alertFired.set`), honoring per-alert channels.
- **IDs** are server-assigned (POST returns the alert).
- **Settings UI:** new "Notifications" section — Telegram connect flow
  (deep-link, poll until linked, Test, Disconnect) and per-device Web Push
  enable. `AlertModal` channel checkboxes gain Push and Telegram (Telegram
  disabled with a hint until linked).
- **Removed:** `alertEngine.ts`, `alertEval.ts`, their tests (replaced by Python
  ports), and the alerts branch of the localStorage mirror.

## Migration

One-shot, server-side, at engine startup: scan `app_state` rows for keys matching
`auto-trader.b.<broker>.alerts.<epic>`, parse, insert alerts whose ids aren't
already present, then delete the state rows. Old triggered history migrates the
same way. Unparseable blobs are skipped. Best-effort by agreement.

## Testing

- **Python:** ported `evaluate_alert` suite; store CRUD; engine units with a fake
  feed (arming, once-removal, move-resets-baseline, expiry sweep, per-user price
  side); firing → history + broadcast + channel gating; Telegram link flow with a
  mocked API; migration.
- **Frontend:** `alertsApi` cache tests (hydrate, optimistic write + rollback,
  `changed`/`fired` handling) replacing `alertEngine.test.ts`; existing
  overlay/sidebar tests keep passing (shape-compatible reads).
- **End-to-end:** a small script (or `agent_bridge_probe` extension) that creates
  an alert via API, injects a fake tick, and asserts a `fired` broadcast.
