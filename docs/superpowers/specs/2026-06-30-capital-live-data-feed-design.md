# Capital.com Live Data Feed — Design

**Date:** 2026-06-30
**Status:** Approved design, pending spec review

## Problem

Live-only Capital.com instruments — notably **SPCX (SpaceX)** — never appear in
the app's symbol search and cannot be charted, even though the user's live
Capital account can trade them.

### Root cause (proven, not assumed)

The app's entire Capital.com data path — symbol search, quotes, candles, and
streaming — runs against the **demo** host (`CAPITAL_ENV=demo`,
`config.py:22`/`70-71`). SPCX is a **live-only** instrument: it does not exist in
Capital's demo catalogue at all. Direct API probes confirmed:

| Host | `searchTerm=SPCX` result |
|------|--------------------------|
| demo (`demo-api-capital.backend-capital.com`) | SPXC (SPX Corporation) + look-alikes; **no SPCX** |
| live (`api-capital.backend-capital.com`) | `SPCX  SpaceX  type=SHARES  status=TRADEABLE` present |

The live host also serves SPCX market detail (bid/ask) and DAY candles, so it is
genuinely chartable there. The live catalogue is a superset of demo.

The `capital:live` account exists today only as an **execution** broker
(`registry.py:93-94`, `capital.py:register_live_exec`). Its chart feed is routed
off the key prefix `capital`, which maps to the demo data broker — so it shows
demo instruments, not live ones.

## Goal

Let the user browse, chart, and (paper- or real-) trade live-only Capital
instruments by giving Capital.com a **live data feed**, modeled on the existing
IG demo/live split (`ig-demo` / `ig-live` are two independent data brokers).

Non-goal: changing the default. Demo stays the default feed; nothing changes for
normal use unless the user selects the live feed.

## Chosen approach

Promote a live-host `CapitalComBroker` to a full **data broker** (Option 1, user
selected). Rejected alternatives:

- **Flip `CAPITAL_ENV=live` globally** — moves every chart, balance, margin, and
  position to live for everyone. Blast radius far beyond the need; re-opens the
  exact tradeoff that made demo the default (demo carries real quotes; avoids a
  live `/session` 429-storm).
- **Upgrade only the existing real-money `capital:live` account** — smaller, but
  live-only instruments would be visible *only* while pointed at the real-money
  account, with no safe paper option for browsing them.
- **Union demo+live search results without routing data** — produces a dead
  instrument: SPCX would list but open to an empty chart (demo can't price it).
  Rejected outright.

## Architecture

Capital splits into two **feeds**, each with its own accounts:

| Feed (data broker id) | Data host | Accounts (exec keys) |
|-----------------------|-----------|----------------------|
| `capital` (unchanged, default) | demo | `capital:paper` |
| `capital-live` (new) | live | `capital-live:paper`, `capital-live:live` |

- Selecting the `capital-live` feed routes symbol search + quotes + candles +
  streaming to the live host → SPCX appears and charts.
- `capital-live:paper` is the safe default account on the live feed (browse and
  paper-trade live-only instruments, no real money).
- `capital-live:live` is the existing real-money dealing account, **renamed** from
  `capital:live`.

### What is already safe (verified)

- **Candle cache** (`core/candle_cache.py`) is keyed by
  `(broker, epic, resolution, side)` — schema PK at lines 77-87. A shared epic
  (e.g. GOLD) on demo vs live occupies distinct rows, provided the live broker is
  registered as `capital-live` and the frontend sends `?broker=capital-live`.
- **Streaming** (`brokers/capital_stream.py`) opens a fresh upstream socket per
  WebSocket connection (`app.py:ws_candles`, lines 1020/1051/1065). Demo vs live
  is determined by the session **tokens**, not the URL, so a live
  `CapitalComBroker` (its own `_client`/`_cst`/`_auth_lock`) streams live data.
- **Rate limits / resilience** — the live feed uses the separate live API key
  (its own quota) and each broker has its own `_RateLimiter` + circuit breaker, so
  live chart traffic cannot starve the demo feed.

## Components & changes

### 1. Backend wiring — `registry.py`, `capital.py`

- `build_registry()`: build a live-host `CapitalComBroker` (reuse
  `settings.live_creds()` + `settings.live_base_url`), `add_data("capital-live", …)`,
  register a paper executor on it (`paper_exec.register(…, broker_id="capital-live")`
  → `capital-live:paper`), and register the real dealing executor as
  `capital-live:live`. Gate the whole block on `settings.has_live()`.
- Replace today's `register_live_exec` (which added `capital:live` as exec-only).
  The live dealing executor now prices off the `capital-live` data broker instead
  of the demo `capital` feed.
- **One live broker instance, one live session.** The `capital-live` data broker
  and the `capital-live:live` exec must wrap the **same** `CapitalComBroker`
  instance (as IG's `register` shares one broker across data + paper + real exec).
  This codebase has a documented live `/session` 429-storm history, so a careless
  split that spins up two live sessions on the same credentials must be avoided.
- The demo `capital` + `capital:paper` block is unchanged.

### 2. Tick store isolation — `core/tick_store.py` (the one real coupling)

The sub-minute tick recorder is keyed by **epic only** (schema `tick_store.py:108`,
in-memory `_last_tick` keyed by epic). Both Capital streams write by epic
(`capital_stream.py:419,568`) and the SECONDS candle route reads by epic with no
broker (`app.py:807`). For an epic present on both hosts (GOLD/SILVER/…), demo and
live ticks would land in the same rows, so a SECONDS chart or a paper fill could
read the wrong host's tick. SPCX itself is live-only and unaffected.

**Change:** add a `broker` dimension to the tick schema, `_last_tick` key,
`record()`, `bars()`, and `latest()`; thread `broker_id` from the SECONDS route
and the two `capital_stream.record` call sites. (`ig_stream` and the paper
executor's `latest()` calls thread their broker id too.)

This is the heaviest single piece. It is technically deferrable (demo quotes ≈
live quotes, and collisions only occur when the same epic streams on both feeds at
once) but is included because it is the only thing preventing true feed isolation.

### 3. Frontend selector + a latent bug — `lib/trading.ts`, `PositionsPanel.tsx`

- `BROKER_LABELS` (`trading.ts:58-64`): add `capital-live` → "Capital.com (live)"
  and relabel `capital` → "Capital.com (demo)".
- **Bug fix (introduced-by-rename):** `PositionsPanel.tsx:238` uses
  `activeBroker === "capital"` to decide whether the broker's reported balance
  already includes unrealized P&L. A `capital-live` account fails that check and
  would **double-count P&L** in the equity/margin math (lines 244-258). Replace the
  `=== "capital"` checks at lines 238 and 269 (margin-call tooltip gate) with an
  `isCapital(broker)` helper that matches both `capital` and `capital-live`.
- The selector already derives brokers from the `exec[]` accounts list
  (`BrokerSelector.tsx:46-56`) and groups accounts by feed
  (`PositionsPanel.tsx:182-190`), so the new feed and its two accounts render with
  no structural change. `isRealMoneyAccount` (`account.endsWith(":live")`) still
  correctly flags `capital-live:live`.

**Positions dock behavior (account tabs grouped by the active feed).** The dock
account strip filters to the active feed: `brokerAccounts = accounts.filter(a =>
a.broker === activeBroker)` (`PositionsPanel.tsx:186`). So account tabs are shown
**per feed**, not globally:
- On **Capital.com (demo)**: one tab — `capital:paper`.
- On **Capital.com (live)**: two tabs — `capital-live:paper` and the real-money
  `capital-live:live`, switchable in the dock as today.

This is a deliberate behavior change from today, where `capital:paper` and
`capital:live` both show as tabs under the single `capital` feed. After the split
the real-money account moves under the live feed, so demo and live account
positions are no longer shown together in one dock — switching feed switches which
account tabs (and their positions) appear. This matches how IG demo/live already
behave and keeps each feed's accounts with their own data/quotes.

### 4. Migration — `App.tsx`, `lib/trading.ts`, `lib/persist.ts`

One-time, sentinel-gated, mirroring `persist.ts:pruneLegacyGlobalWorkspace`
(`persist.ts:1209-1250`):

- Rewrite localStorage `activeAccount` (`App.tsx:276,348`): `capital:live` →
  `capital-live:live`, so the user's current selection survives instead of bouncing
  to `exec[0]` (paper) via the unknown-account fallback (`App.tsx:332-334`).
- Rewrite the `lastAccountByBroker` map (`trading.ts:39-54`): move the
  `capital → capital:live` entry to `capital-live → capital-live:live`; keep
  `capital → capital:paper`.

**No backend migration needed (verified).** `capital:live` appears in the backend
only in registration code/comments and tests. Paper working orders/triggers are
held in-memory (`paper_exec.py:133 self._working`), not persisted by account; the
renamed account is the **real-money** one, whose positions/working orders live
natively at Capital and are refetched from the broker. So the rename orphans no
persisted backend state. (Escape hatch if this ever changes: an explicit per-exec
data-broker override that breaks the `key.split(":")[0]` routing for one account,
keeping `capital:live` as-is — not needed here.)

### 5. Live workspace — blank, but saved layouts applicable

User decision: the live feed opens **blank** (no tabs), but its **named-layout
library** is populated so a saved layout can be applied.

Per-broker workspace keys live under `auto-trader.b.<broker>.*` (`persist.ts:root`).
Named-layout keys (`persist.ts:529-534`):

- **Seed into `capital-live`** (so layouts can be applied): `layouts` (the index)
  + each `layout.<id>` body, **plus the scope-content keys each body references**
  (the same key set `cloneWorkspace` copies — the implementation plan must
  enumerate these precisely). Copy verbatim with the same ids; namespaces are
  fully broker-prefixed, so same-id copies into a different feed do not alias.
- **Do NOT seed:** `activeLayoutId`, `scratch`, `autosave`, `defaultLayoutId`
  (the device-local active workspace + the startup default). Omitting these is what
  makes the live feed open blank instead of auto-loading a layout.

Result: switching to the live feed shows an empty workspace with the full saved-
layout library available to apply. Going forward the two feeds' libraries drift
independently (acceptable for v1; a future global layout library could unify them).

## Testing

- **Backend — `test_registry.py`:** registry wires two Capital data brokers
  (`capital`, `capital-live`) and three Capital exec accounts (`capital:paper`,
  `capital-live:paper`, `capital-live:live`) when `has_live()`; only `capital` +
  `capital:paper` when not.
- **Backend — `tick_store` isolation test:** record the same epic under two brokers;
  `bars`/`latest` for each broker return only that broker's ticks.
- **Backend — `test_broker_isolation.py`:** candle cache already isolates by broker
  (extend to assert `capital` vs `capital-live` rows don't cross).
- **Frontend — migration test** (vitest, like `persist.test.ts`): given legacy
  `activeAccount="capital:live"` and `lastAccountByBroker={capital: "capital:live"}`,
  the migration yields `capital-live:live` + the remapped map, runs once (sentinel).
- **Frontend — PositionsPanel P&L-by-broker:** `capital-live` is treated like
  `capital` (balance includes uPnL), not like a cash-balance broker.
- **Live smoke (don't kill the user's dev servers):** select Capital.com (live),
  search SPCX → SpaceX appears → open it → chart + quotes + stream render; confirm
  demo feed still shows the demo catalogue and is the default; apply a saved layout
  on the live feed and confirm it reproduces; confirm the real-money account sel
  ection persisted across reload (migration).

## Risks

- **Tick-store schema change** — additive `broker` column; back-compat read for old
  rows (treat NULL broker as the demo `capital` feed, or discard — decide in plan).
- **Layout scope-content copy** — the trickiest frontend bit; must copy exactly the
  keys a layout body references (reuse `cloneWorkspace`'s key set) or applied
  layouts render empty.
- **Account-key rename** — anything persisted against `capital:live` must be
  migrated; `isRealMoneyAccount` (`endsWith(":live")`) is unaffected.
- **Live `/session` load** — live feed now carries chart traffic on the live key;
  separate quota + existing limiter/circuit-breaker mitigate, but watch for 429s
  under many concurrent live streams.
