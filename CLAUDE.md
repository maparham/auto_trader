# CLAUDE.md

## Frontend conventions

### Tooltips

Use the shared `Tooltip` component (`frontend/src/components/Tooltip.tsx`) instead
of a native `title=` attribute or a hand-rolled tooltip. It's portaled, flat
(no shadow), collision-aware (default `top`, flips/shifts to stay on screen),
shows on hover (~100ms delay + instant grace group between nearby triggers) and
keyboard focus, with a fade + slide animation.

```tsx
<Tooltip content={string | string[] | ReactNode} title?={string} placement?={"top"|"bottom"|"left"|"right"} delay?={number} asChild?>
  {trigger}
</Tooltip>
```

For the common ⓘ info-icon pattern, use `InfoTip`
(`frontend/src/components/InfoTip.tsx`) instead — it wraps `Tooltip` for you:

```tsx
<InfoTip title={string} text={string | string[]} />
```

Where a wrapper span would break layout (a `tr`, an `li`, an absolutely
positioned button, a flex child that code finds with `:scope > .x`), pass
`asChild`. The handlers and the anchor ref then go on the child itself, and
the child's own handlers and ref still run. Keep the wrapper for a disabled
button, since it may not fire mouse events. When triggers are nested (a row
hint around buttons that have their own tooltips), only the innermost open
tooltip shows. The app has no native `title=` tooltips left; don't add new ones.

### Side panels

Only one right-docked side panel is open at a time (patterns, trade list,
alerts, order ticket, backtest config, live trading, screener). Each one
registers a closer with `frontend/src/lib/sidePanels.ts` and calls
`claimSidePanel(id)` on the way open, so a new panel closes whichever was open.
Use `toggleSidePanel(id)` from `lib/signals.ts` for the five signal-backed panels
rather than flipping their signals directly. Claims are inert until App calls
`endSidePanelRestore()`, because the backtest and live panels persist their
open-state and a boot-time cross-close would overwrite the saved flag; when
both are saved open, live wins and backtest just starts closed.

## Agent UI Bridge

MCP agents can drive the running UI: connect to `http://localhost:8000/mcp`
(streamable HTTP). The endpoint only accepts requests whose Host header is
`localhost`, `127.0.0.1` or `[::1]` on any port (the MCP SDK's DNS-rebinding
protection), so it is local-only by design: any other Host gets a 421.

The generic half of this lives in github.com/maparham/agent-ui-bridge: the
npm package `agent-ui-bridge` (action registry, relay client, confirm gate,
confirm dialog, tab.title.set, the Tab Bridge client) and the python package
of the same name (`agent_ui_bridge`: BridgeHub, serve_tab, the ten ui_*
tools, the probe). Chartkar depends on both as git dependencies, in
`frontend/package.json` and `backend/pyproject.toml`, and keeps thin shims at
`frontend/src/agent/{registry,index}.ts`, `frontend/src/agent/AgentConfirmHost.tsx`,
`frontend/src/agent/actions/tab.ts`, `frontend/src/lib/tabBridge.ts` and
`backend/auto_trader/api/agent_bridge.py`, so the app's import paths did not
move. Chartkar's OWN actions (`chart.*`, `backtest.*`, `sweep.*`, dealing,
drawings, indicators, `market.select`, the tab helpers) and the direct
`ta_*`/`wf_*`/`runs_*` tools stay here. Editing the bridge itself means
editing that repo; `npm link` and
`uv pip install -e ../agent-ui-bridge/python` for local iteration.

UI tools (need a connected browser tab): `ui_sessions`, `ui_actions`
(self-describing manifest), `ui_set_title`, `ui_invoke`, `ui_wait`, `ui_read_state`,
`ui_screenshot` (returns the focused chart as an image plus a text line
naming epic/resolution/cell; pairs with `chart.state` for the numbers behind
the pixels). No tab connected gives a clear error ("no UI session connected:
open the app in a browser"). Every driven tab must be named first:
`ui_invoke`, `ui_read_state` and `ui_screenshot` refuse with UNTITLED_TAB
until `ui_set_title("US100 4H backtest")` has run on that session. The
title survives a reload and a backend restart (the tab keeps it in
sessionStorage and announces it on reconnect); only a fresh tab needs naming. The tab's `tab.title.set` action stamps a
✻ in front of the title so the owner can tell agent tabs from their own.
The 29 registered actions today, by group:
`backtest.*` (config.get, config.set, run, cancel, result, progress),
`sweep.*` (start, cancel, rows), dealing (`order.place`, `position.close`,
`order.cancel`), `drawing.*` (list, add, remove, clear), `chart.*` (state,
screenshot, timeframe.set, range.set), `indicator.*` (list, add, set,
remove), and app shell (`market.select`, `tab.list`, `tab.focus`,
`tab.title.set`, `panel.backtest.open`). The dealing actions require an in-browser Approve
click. The frontend bridge is on in dev builds and off in production unless
`VITE_AGENT_BRIDGE=1`.

Browser tab control (macOS local dev only; AppleScript drives Chrome from
the backend): `ui_open_tab` opens the app (or focuses an existing tab),
`ui_focus_tab` raises the Chartkar tab, `ui_close_tab` closes it (refuses
when several are open). Recovery chain for a hidden tab: TAB_HIDDEN from
`ui_screenshot`, then `ui_focus_tab`, then retry. First use needs the macOS
automation permission for whatever app hosts the backend process; a pending
permission dialog surfaces as a 15 s osascript timeout with a hint. Hosted
mode refuses these tools.

Tab Bridge extension (`extension/` in the agent-ui-bridge repo, generic,
unpacked install per that repo's `extension/README.md`): a page can
screenshot or focus its own tab through `chrome.debugger` / `chrome.tabs`,
which works while the tab is backgrounded. The `chart.screenshot` action
descriptions and its TAB_HIDDEN message name that repo; `ui_focus_tab`'s
own text still says "extension/README.md", meaning the one in that repo.
`chart.screenshot` uses it when its `hello` probe answers
(result carries `via: "extension"`), clipped to the chart container, and
falls back to the canvas composite otherwise (`via: "canvas"`, TAB_HIDDEN
when hidden). `ui_focus_tab` tries the in-page `tab.focus` action first, so
it works on any OS with the extension, and only then AppleScript. The
extension is not Chartkar-specific: it answers a namespaced `postMessage`
protocol on any http(s) origin and never targets a tab other than the
requester's.

Direct tools (no tab needed; call the app in-process): `ta_candles`,
`ta_indicator_series`, `ta_pattern_search`, `ta_pattern_scan`,
`ta_pattern_families`, `wf_run`, `wf_status`, `wf_cancel`, `wf_fold`,
`runs_list`, `run_get`. These hit the FastAPI app directly over an ASGI
transport, attaching the API token when one is configured, so they work
without a browser at all.

End-to-end probe: `cd backend && python3 -m agent_ui_bridge.probe
[--url URL] [--read-state KEY] [--invoke ACTION --args JSON]
[--screenshot [PATH]]`. `--screenshot` (default path `screenshot.png`) calls
`ui_screenshot`, decodes the image block, and writes it to PATH. The old
`--run` shorthand is gone; use `--invoke backtest.run`.

### How to run a backtest through the bridge (agent recipe)

1. `ui_sessions` to confirm a tab is connected (empty list: `ui_open_tab`
   opens one on macOS local dev, then poll `ui_sessions` until the bridge
   connects; elsewhere ask the user to open http://localhost:5173).
2. `ui_set_title("US100 4H backtest")`: name the tab for what you are about
   to do. Nothing else works on the session until this has run.
3. `ui_actions` for the live manifest; every action carries its JSON schema.
   Invalid args come back with the expected schema, so self-correct from the
   error rather than guessing.
4. `ui_invoke("market.select", {"epic": "US100"})` to focus (or open) the
   chart, then `ui_read_state("backtest.config.get")` and
   `ui_invoke("backtest.config.set", {"patch": {...}})` to shape the run
   (strategy, range, costs; the patch is a shallow merge).
5. `ui_invoke("backtest.run", {})` returns `{"handle": ...}` immediately.
   Poll `ui_wait(handle, timeout_s=30)`: status `running` carries progress
   (phase, pct, eta); `done` carries the full result (metrics, trades,
   analysis); `error` carries the reason (for example "no candles in the
   selected range"). The run renders live on the user's chart.
6. Sweeps: `ui_invoke("sweep.start", {"axes": [...]})` (same handle flow),
   `ui_read_state("sweep.rows")` afterwards.
7. Dealing (`order.place`, `position.close`, `order.cancel`) also returns a
   handle; it resolves only after the user clicks Approve in the browser
   (Reject or 120 s timeout gives error code REJECTED). Never assume an
   order went through without a `done` status.
8. One backtest or sweep at a time: a second `run`/`sweep.start` while one
   is in flight is rejected. `ui_read_state` only works for read-kind
   actions (NOT_READ_ACTION otherwise); use `ui_invoke` for writes.

### How to analyse a chart visually (agent recipe)

1. `ui_set_title("US100 4H review")`, then
   `ui_invoke("market.select", {"epic": "US100"})` to focus the chart, then
   `ui_invoke("chart.timeframe.set", {"resolution": "HOUR_4"})` for the
   timeframe under review.
2. `ui_invoke("indicator.add", {"type": "RSI", "calcParams": [14]})` to add
   the indicator pane needed for the read.
3. `ui_read_state("chart.state")` for the numbers (candles, indicator
   values, visible range) and `ui_screenshot` for the picture; read both
   together rather than guessing the layout from one alone. `ui_screenshot`
   works with the tab backgrounded when the Tab Bridge extension is
   installed; without it, it fails with TAB_HIDDEN, so call `ui_focus_tab`
   and retry.
4. Iterate: adjust the timeframe, swap or remove indicators
   (`indicator.set`, `indicator.remove`), re-screenshot, until the view
   answers the question.

## Symbol search categories

The category chips in the symbol-search modal are declared by the broker, not by
the frontend: each data broker sets `CATEGORIES` (`brokers/base.py`) as
`[{key, label, types, row}]` over the `type` values IT stamps on its own market
rows, and `registry.describe()` ships them to the frontend under `categories` in
`GET /api/brokers`. Capital/IG/MT5 use Capital's instrumentType words
(`SHARES`, `CURRENCIES`, ...); yfinance and dukascopy use their own
(`stock`, `etf`, `fx`, `metal`, ...). `row` is the muted phrase on each result
row, so Yahoo rows read "etf" rather than "etf cfd"; oanor mirrors the
`category` its upstream feed reports (currency/gold/coin/crypto). A broker that
declares nothing shows Recent/Favorites/All only, never a dead chip. `tests/test_market_categories.py` asserts every type an
offline catalogue emits is claimed by one of that broker's own chips.

## Alerts

Price alerts are backend-owned: every alert is evaluated server-side in
`backend/auto_trader/core/alert_engine.py` off one live feed per (broker,
epic), independent of any open browser tab. CRUD is `/api/alerts` (create,
list, patch, delete) plus `/api/alerts/triggered` for fired history; delivery
fans out to `/ws/state`, web push, and Telegram. `TELEGRAM_BOT_TOKEN` in the
environment enables the Telegram channel. End-to-end probe:
`cd backend && python3 -m scripts.alert_probe [--epic EPIC --broker BROKER
--timeout SECONDS]`.

Create and patch both 409 on a duplicate: same (broker, epic, kind) and the
same `kind.sig(params)` another of the user's alerts already has (message,
notify, and expiry don't count, since they don't change what fires). The
check lives in `api/routers/alerts.py`'s `_check_duplicate`, reusing each
kind's own `sig()`.

Alert kinds live in `core/alert_kinds.py` (`price_level`, `indicator`,
`line`): each validates its params and resolves a `(subject, level)` pair;
`core/alert_eval.py` is the one evaluator. Indicator alerts run on the
backtest series registry: params are `{type, config, output}` where `config`
is the registry's parsed config as JSON (`indicators/alert_series.py`), and
`indicators/alert_specs.py` says which outputs of each type are alertable
(level or 0/1 event, price axis or not), the label and the refusals. Create
and patch take the raw pane as `params.instance` and the server parses it;
old `{indicator, calcParams, config}` params are upgraded by
`alert_kinds.upgrade_params` (store migration 2, re-arm, triggered history).
The frontend mirrors none of this: `GET /api/alerts/indicators` lists the
alertable types and `POST /api/alerts/describe` returns a pane's outputs,
labels, refusal and current values from the alert hub. Event outputs are
stored as a close-mode cross up through 0.5. "Every" alerts fire at most once
per bar of their timeframe. Probe an indicator alert with
`python3 -m scripts.alert_probe --indicator`.

Trendline alerts come in two forms. The `line` kind is a frozen straight line
in bars of its timeframe (`tRef`, `pRef`, `slope`), made from a right-clicked
Trendlines line; the engine rolls `tRef` forward every 1000 bars
(`LINE_REBASE_BARS`) so it stays inside the 2000-bar seed, and create 422s
when the chart's reference bar is not one the server holds. Nearest-line
alerts are `indicator` alerts on `TRENDLINES`, output `tl_nearest` (the only
alertable Trendlines output); the hub runs the full Trendlines compute once
per close, in a worker thread (the series is not ready for it until the
result lands, and close mode evaluates on the first sample after), and keeps
the held line, so close mode judges a cross against one line
(`resolve_close`) and intrabar only projects it. Nearest-line alerts refuse
the 1m timeframe.

Telegram alert photos are live chart screenshots: `core/chart_snapshot.py`
drives a headless Chromium over the frontend's `/?snapshot=1` boot mode,
reconstructing the user's last-seen view (mirrored `view.<epic>` heartbeat)
with live data; matplotlib (`core/alert_chart.py`) and text remain fallbacks.
Needs `FRONTEND_URL` (default `http://localhost:5173`) and Playwright
Chromium; `SNAPSHOT_DISABLED=1` turns it off. Probe:
`cd backend && python3 -m scripts.snapshot_probe --epic EPIC`.
`SNAPSHOT_DISABLED` with any non-empty value disables the feature.

## Screener

The screener (`ScreenerPanel.tsx`, right-docked side panel) runs one
expression over a list of symbols on one timeframe and lists the symbols
where it holds, with optional value columns. Backend: `api/routers/screens.py`
(`POST /api/screens/run` starts a job, `/api/screens/jobs/{id}` polls it,
`/api/screens` is saved-screen CRUD), `api/screen_jobs.py` (fetch under a
per-broker semaphore, judging under its own `per_compute=2` semaphore, cancel
checked before each judge), `core/screen_eval.py` (`compile_screen`,
`judge`), `core/screen_store.py` (SQLite, path from `screens_db_path`). Caps:
500 symbols, 2000-character expressions, 8 columns. Symbol sources, in panel
order: "All tabs" (every open chart tab, resolved at run time; the default for
a new screen), "Selected tabs", or a typed list; a saved screen stores `source` as `list` or `allTabs` only, since tab
ids are per browser, and always stores the resolved `symbols`. Clicking a
result row jumps to that epic at the screen's timeframe (App's `onOpen`).
"Include the open bar" (`includeOpenBar` on the run body and saved row,
store column `open_bar`) judges the forming bar, as the chart draws it, so
matches can change until it closes. A new screen has it on; off, and on every
row saved before it existed, a screen judges the last CLOSED bar.

### Chart indicators in screens

A screen's expressions can reference chart panes by instance
(`RSI.bullDiv`, `TRENDLINES.tl_nearest`), as backtest rules do, and the
backend computes them on every screened symbol. No chart is changed. The
screen holds a COPY of each referenced pane's settings (`indicators`, a
`{id: {type, calcParams, extendData}}` map on the run body and the saved
row; at most 16 entries and 32 KB, every type in `SERIES_INDICATORS`, else
422). Copy semantics live in `lib/screenerIndicators.ts`: the copy wins for
every id it holds, the focused chart only supplies ids the copy lacks, Run
and Save send only the panes the text references and adopt that map as the
new copy ONLY after the server accepts it (a 422 must not freeze bad
settings), and "Refresh from chart" is the one way a copied pane changes.
Pins at the screen's timeframe or coarser (`EMA(50)@W`, a pane pinned in
its settings) are fetched per symbol through `api/htf_source.py`, the one
service that also feeds the backtest, sweep, WFO, evaluate and closeness
paths (`htf_needs` + `fetch_htf` + `closed_before`; `source_htf` for
shipped-or-fetched with a sufficiency cutoff) and the timeframes a coded
strategy discovers mid-run (`fetch_discovered`, fixed 300-bar warm-up). Finer pins 422 with
`screen_tf_lower` (run the screen on that timeframe and pin the coarser one
instead); more than 3 canonical timeframes 422 with `screen_tf_too_many`; a
symbol with too few closed pinned bars before the judged bar is skipped with
`not enough @W history`. A pinned term costs no base bars (`warmup_bars`
gets the base resolution). A ref found in neither copy nor chart 422s as
"not one of this screen's indicators". Pivot-based outputs see only the fetched bars (300 to
2000), so results can differ from the chart.

"Pick from chart" is `lib/useIndicatorPick.ts`: a field arms the chart
(`controller.indicatorPickArmed`), the clicked pane arrives on
`controller.indicatorPickResult`, and a module-level owner Signal makes sure
only the last-armed hook (backtest panel or screener) consumes it. The
token comes from `lib/exprChartToken.ts`: parameterised types emit a call
(`RSI(14)`), instance types emit `<id>.<output>`; an RSI pane with
divergence on emits the ref to its first enabled divergence output
(`RSI.bullDiv`) so the event is usable without typing. Confirmed divergence
outputs fire once, on the confirming bar (pivot + lookbackRight); the
`...Forming` twins (`RSI.bullDivForming`) are states that hold while the chart
drawn up to that bar shows a dotted forming divergence, so they repaint but
never read ahead. A match carries `divergences` (`{ref, pivot, barsAgo}`) per
divergence ref in the condition, shown as the panel's Divergence column. The Indicators line
under Condition shows `paneLabels`: the id plus the pane's
`ExprInstance.detail`. Spec:
docs/superpowers/specs/2026-10-22-screener-chart-indicators-design.md.

## Account history

Capital.com dealing accounts (`capital:demo`, `capital-live:live`) report
closed trades and the cash ledger through `ExecutionBroker.get_history`
(`supports_history`), served by `GET /api/history?account=&days=7|30|90`
with epoch-ms times; other accounts answer `{supported: false}`. Upstream
limits shape `brokers/_capital_history.py`: transactions cap at 100 rows per
call (paged, deduped on `reference`), activity at one day per call (walked
sequentially through the shared rate limiter, past days kept in `DayCache`).
The History tab (`HistoryPane.tsx`) and the chart's closed-trade markers both
read `lib/accountHistory.ts`; on a history account the markers replace the
live journal's exits. The chart draws only the History row selected for that
account, or every trade of the last 30 days while "Show all on chart" is on
(`historyShowAllSignal`, per browser, default off). Clicking a History
marker (entry or exit) toggles that selection like its row. The selected row's trade box is a
locked overlay that is never saved (`lib/historyTradeBox.ts`); it leaves with
the selection. Spec: docs/superpowers/specs/2026-10-21-capital-account-history-design.md.

## Admin console

`/admin` is a read-only operator page (Clerk users, system health, per-user
usage counts, recent logs). Every panel reads a gated `/api/admin/*` endpoint;
the gate is `deps.require_admin_console` (403 `admin access required`), which
is separate from the dealing gate on purpose. Admin identity is unchanged:
`ADMIN_EMAILS` / `ADMIN_USER_IDS`, with dev mode always admin.

The Users panel needs `CLERK_SECRET_KEY` (Clerk Backend API, backend only);
without it the endpoint answers `configured: false` and the panel says so.
Logs come from an in-process ring buffer (`core/log_buffer.py`), so they cover
the current process only and reset on restart. Cross-user queries live in
`core/admin_usage.py` and must not be imported anywhere else.

### Impersonation

An admin can view the app read-only as any Clerk user. The admin's own token
stays the credential: the target id rides in the `X-Impersonate-User` header
(HTTP) or the `impersonate` query param (WebSocket), and
`auth.resolve_impersonation` swaps the identity at both call sites, forces
`is_admin` false and refuses every method outside GET/HEAD. Nothing is minted,
so ending a session is dropping the header.

Every identity-stamping branch in the HTTP middleware (Clerk claims, the
internal render-token path, the signed-out demo principal) stamps
`request.state.impersonator`, and every branch besides the Clerk-claims one
refuses an `X-Impersonate-User` header outright rather than acting on it, so
none of the other "act as someone else" mechanisms can stack with real
impersonation. `POST /api/admin/impersonate` validates the target against
Clerk and writes the audit start line; the target id is percent-encoded into
the Clerk API URL so it cannot be used to steer that request elsewhere.

Because `is_admin` is false for the duration, `/api/admin/*` refuses an
impersonating session: the exit control is pure client state
(`components/ImpersonationBanner.tsx`). The frontend keeps the target in
`sessionStorage` via `lib/impersonation.ts`, which every transport reads;
entering and exiting wipe the local workspace (`lib/workspaceKeys.ts`) and
hard-reload, because the workspace keys are broker-keyed rather than
user-keyed. `workspaceKeys.ts` is a separate leaf module (no imports of its
own) purely to avoid an import cycle: `persist/core` imports `impersonation`
for the mirror gate, and `impersonation` needs the wipe, so the wipe cannot
live in `persist/core` or `AccountGate` without reopening that cycle;
`persist/core` re-exports `PREFIX` so its existing importers see no change.
Persist stops mirroring writes to the backend while impersonating
(`mirrorEnabled = !isImpersonating()`).

Audit lines go to the `auto_trader.impersonation` logger: an INFO start line
per session, a throttled INFO summary while active, and an unthrottled
WARNING for every refusal, including `verify_ws` refusing a non-admin's
`impersonate=` query param. Logged header/param values are truncated to
`MAX_LOGGED_VALUE_LEN` (200 chars) because refusal logging is unthrottled and,
on the demo-principal branch, reachable with no credential at all. These
lines reach stdout, so journald keeps them across a restart; the Logs panel
shows them from the ring buffer, which does not.

In local dev (`CLERK_JWKS_URL` unset) auth is off and every request is the
fixed dev user with `is_admin` true; the impersonation header is never even
read, so impersonation only exists in hosted mode.

Cross-tab seam: the `/ws/state` push handler in `lib/persist/core.ts` applies
a remote push with a direct `localStorage.setItem`, bypassing `mirrorEnabled`
on purpose to avoid an echo loop. localStorage is shared across every tab of
the app, but the impersonation flag lives in sessionStorage, which is
per-tab. A second tab that is not impersonating (mirroring still on) sits on
the same localStorage keys the impersonated tab is writing, and will mirror
the target's data into the admin's own backend record. Entering only reloads
the current tab. The confirm dialog in `admin/UsersPanel.tsx` tells the
operator to close other tabs first; that is the whole mitigation. Namespacing
localStorage by user would close this properly but is out of scope for this
feature; do not "simplify" the push handler to always honor `mirrorEnabled`
without re-reading this note, since that reopens the echo loop it was written
to avoid.

See docs/superpowers/specs/2026-09-12-user-impersonation-design.md.

## Public demo

Signed-out visitors get the real app on whatever layout an admin last
published, served on the credential-free broker the payload names: new
publishes always target yfinance (Yahoo Finance covers the stocks/ETFs
dukascopy lacks), payloads from before the `broker` field existed fall back
to dukascopy. `deps.resolve_broker` allowlists exactly that pair
(`DEMO_BROKERS`) for the demo principal. Publishing captures the ACTIVE
broker's workspace; a NON-yfinance workspace is best-effort remapped onto
the yfinance catalogue (`lib/demoRemap.ts`): cell symbols in the layout
bodies AND the epic-bearing scope-key suffixes (`drawings.<epic>`,
`avwap.<epic>[.<id>]`) move together, or drawings would silently detach from
their renamed charts; an alias table covers Capital's GOLD/SILVER names.
No symbol ever blocks a publish: anything without a mapping passes through
VERBATIM (yfinance charts unknown epics as raw Yahoo tickers, so searched
symbols like NKE work; a genuinely untranslatable epic degrades to an empty
chart). A yfinance workspace skips the remap entirely. Demo visitors see the
source named in the chart legend ("Yahoo Finance", BROKER_LABELS in
lib/trading.ts) with a demo-only tooltip about delays/adjustment/intraday
caps, and demo sessions never persist their account pin (`activeAccount`
keys are not workspace-prefixed, so a `?demo=preview` tab would otherwise
leak `yfinance:data` into the admin's real seed). Drawings and indicators
stay editable but are
session-local, round-tripping through localStorage instead of the backend.
In hosted mode, an unauthenticated request that matches a narrow GET-only
allowlist (`api/demo_access.py`:
candles, markets, brokers, market details, the demo snapshot) runs as the
shared `demo` principal instead of getting a 401; every other route keeps
its normal auth, so `POST /api/admin/demo/publish` and `/api/alerts` still
401 with no token. Any non-dukascopy broker on an allowlisted path is
refused with a scoping message, not a generic 403. A per-IP token bucket in
`api/demo_limit.py` throttles the surface, tunable without a restart via
`DEMO_RATE_PER_MIN` (default 120) and `DEMO_RATE_BURST` (default 40).

Besides Settings > Public demo, the layout dropdown carries an admin-only
per-row quick publish (`LayoutManager.tsx`, 🌐 icon, inline confirm): it
publishes JUST that layout via `publishDemoLayoutOnly` /
`captureDemoLayoutFor` (index shrunk to that one row, default pointer set to
it) and carries the live demo's watchlist and canned backtests forward
unchanged, so the Settings panel stays the only place those are edited.

Publishing happens from Settings > Public demo, admin-only: it bundles the
current layout, an optional watchlist and a list of named backtests into a
payload and writes it as a new row in `core/demo_store.py`, an append-only,
versioned
store (its own SQLite file, path from `DEMO_DB`) where the latest row always
wins. There is exactly ONE live demo and publishing replaces it: the panel
shows when the live one went out and nothing else. The older rows survive on
disk for hand recovery, but no UI and no endpoint reads them (a version list
whose "roll back" appended yet another version read as a bug, so both the
list and `POST /rollback` are gone). "The layout" is the saved
layout INDEX, the DEFAULT pointer and each layout BODY, plus every cell's
scope content (drawings, indicators, indicatorConfig, avwap, view flags)
under a `scope:` marker key that `demoSnapshot.ts` maps back to the
unprefixed `auto-trader.<scope>.<suffix>` keys; run pointers
(`backtest.`/`sweep.`) and `snapshotMeta` are deliberately dropped, since a
demo visitor cannot fetch them. Publishing is refused with no saved layout,
with no default layout (a visitor's fresh browser falls through to
`defaultLayoutId`), and over a size ceiling the visitor's localStorage
cannot hold; a default layout carrying no scope content warns once and
publishes on a second click. On the frontend, `DemoApp`
is what `SignedOut` boots instead of the sign-in card; it seeds the
published layout (falling back to App's own default chart when nothing has
been published yet) and flips a one-way `isDemoMode()` latch before `App`
mounts. `?sign_in=1` bypasses `DemoApp` and reaches the sign-in card
directly, and `?demo=preview` (Settings > Public demo > View) boots the same
`DemoApp` for a SIGNED-IN admin, so checking a publish no longer means
signing out. That is only safe because `lib/demoPreview.ts` moves the whole
workspace namespace aside for the tab: `workspaceKeys.ts` picks
`auto-trader-preview` over `auto-trader` when the param is present, decided
at module-init time from the URL so every `${PREFIX}.x` constant in the app
agrees. Seeding the demo layout therefore cannot land on the admin's real
keys, exiting just deletes the preview namespace, and demo mode keeps the
backend mirror off throughout. Demo sessions never touch `/api/state` or dial `/ws/state`;
`isDemoMode()` gates both out of `persist/core.ts`, so drawing and indicator
edits round-trip through localStorage only and survive a reload without ever
reaching the backend.

