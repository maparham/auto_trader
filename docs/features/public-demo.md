# Public demo

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
