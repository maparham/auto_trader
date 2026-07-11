# Self-hosted MT5 broker: native Windows VPS + our own REST bridge

**Date:** 2026-07-11
**Status:** Design approved, pending implementation plan

## Problem

The MT5/AvaTrade integration runs through the **MetaApi cloud bridge**
(`brokers/mt5.py`). MetaApi's cloud terminal has proven unreliable: the socket
goes half-open and wedges, and we can't force a clean reconnect from our side —
`brokers/mt5.py` carries ~400 lines of wedge-detection/rebuild/SDK-teardown code
that exists purely to work around this, and it still surfaces as outages.

We want a **self-hosted transport** to the same AvaTrade account so recovery is
ours to control, and — eventually — to **remove MetaApi entirely**.

## Approach: native Windows VPS + our own thin REST bridge

Run the **MetaTrader 5 terminal natively on a Windows VPS**, logged into the same
AvaTrade account, with the official **`MetaTrader5` Python package** driving it. A
**small FastAPI service we write** ("the bridge") runs on that VPS and exposes the
handful of endpoints our backend needs over HTTP. Our backend gets a new broker
adapter (`mt5_http.py`) that is a plain `httpx` REST client to the bridge — the
same shape as the Capital/IG adapters, with **none** of the MetaApi wedge
machinery.

### Why this over the Docker/QEMU route

The psyb0t/mt5-httpapi project (and the other Docker candidates) run MT5 in a
**QEMU/KVM Windows VM**, which needs hardware virtualization (VT-x) exposed to the
guest. Standard AWS Lightsail/EC2 virtualized instances **do not expose VT-x**
(nested virt is bare-metal-only, or the new C8i/M8i types) — so those need an
expensive bare-metal host. A **native Windows VPS runs MT5 directly**, no nested
virtualization, from ~$5–15/mo. Rolling our **own** wrapper (vs adopting a
third-party bridge) means we control both sides of the contract and its
reliability — which is the entire reason we're leaving MetaApi.

### Two deliverables

1. **`mt5-bridge`** — a small FastAPI app (Windows-only; imports `MetaTrader5`)
   that runs on the VPS beside the MT5 terminal. **Deliberately dumb:** it returns
   raw `MetaTrader5` structs as JSON and translates REST calls into
   `MetaTrader5` calls. No business logic, no lots↔units, no taxonomy — those live
   in the backend adapter (per "backend owns business logic"). Lives in the repo
   (e.g. `tools/mt5_bridge/` or its own top-level dir); deployed to the VPS.
2. **`mt5_http.py`** — the backend broker adapter (`httpx` client to the bridge),
   shaped like Capital/IG.

## Decisions (locked)

1. **Same AvaTrade account, redundant transport.** The bridge terminal logs into
   the same AvaTrade MT5 credentials — a second independent route to the same
   positions.
2. **Full parity minus streaming** for v1: data + `mt5-self:paper` +
   `mt5-self:live` (real-money dealing). No live tick stream.
3. **Standalone backend module.** `mt5_http.py` copies the ~80 lines of
   transport-agnostic logic it needs from `mt5.py` (symbol taxonomy, lots↔units
   arithmetic, `_lvl`). `mt5.py` is left **untouched**. Justified because MetaApi
   is being phased out — the copy becomes the canonical version once `mt5.py` is
   deleted, so no duplication debt survives.
4. **Dumb bridge, smart adapter.** The Windows bridge is a thin proxy over the
   `MetaTrader5` package; all mapping/conversion/classification is in the backend
   adapter. Keeps the rarely-touched Windows service tiny and stable.

## Roadmap (MetaApi phase-out)

- **Phase 1 — this build:** `mt5-bridge` on the VPS + `mt5-self` data + paper +
  live dealing, REST-only, coexists with the MetaApi `mt5` broker.
- **Phase 2 — later:** live ticks. Either a REST-poll pseudo-stream in the adapter
  (poll `/tick`, synthesise the forming bar) or a websocket added to the bridge →
  flip `supports_streaming=True`. This is the **gate** to removing MetaApi, since
  MetaApi is what streams live ticks today.
- **Phase 3 — later:** delete `mt5.py`, promote broker id `mt5-self` → `mt5`, drop
  the `(self-hosted)` label suffix.

Phases 2 and 3 are **not** built now and no migration/rename code is written ahead
of time.

## The bridge REST contract (Phase 1)

We define it; endpoints return **raw `MetaTrader5` shapes** (lots, retcodes, native
`symbol_info`/`account_info`/`positions_get` fields). Auth: `Authorization: Bearer
<token>` (shared secret). All timestamps are UTC unix seconds.

| Bridge endpoint | `MetaTrader5` call | Returns |
|---|---|---|
| `GET /health` | `terminal_info()` / `mt5.initialize` state | `{connected, build}` — liveness probe |
| `GET /rates?symbol=&timeframe=&count=&from=&to=` | `copy_rates_from` / `copy_rates_range` | array of `{time,open,high,low,close,tick_volume}` |
| `GET /tick?symbol=` | `symbol_info_tick` | `{time,bid,ask,last,volume}` |
| `GET /symbols?group=` | `symbols_get` | array of symbol-name strings |
| `GET /symbol?symbol=` | `symbol_info` | full struct: `trade_contract_size`, `volume_min/max/step`, `digits`, `point`, `trade_tick_value/size`, `currency_profit`, `description` |
| `GET /account` | `account_info` | `balance,equity,margin,margin_free,currency,leverage,trade_mode` |
| `GET /positions?symbol=` | `positions_get` | array: `ticket,type,volume,price_open,sl,tp,price_current,profit,symbol,time` |
| `GET /orders?symbol=` | `orders_get` | array of pending orders (int `type`, `volume_current`, `price_open`, `sl`, `tp`, `time_expiration`) |
| `POST /orders/market` | `order_send(TRADE_ACTION_DEAL)` | `{symbol,side,volume,sl,tp,deviation}` → result |
| `POST /orders/pending` | `order_send(TRADE_ACTION_PENDING)` | `{symbol,side,volume,price,sl,tp,type_time,expiration}` → result |
| `POST /positions/:ticket/close` | `order_send(TRADE_ACTION_DEAL, opposite)` | `{volume?}` (partial) → result |
| `PUT /positions/:ticket` | `order_send(TRADE_ACTION_SLTP)` | `{sl,tp}` → result |
| `PUT /orders/:ticket` | `order_send(TRADE_ACTION_MODIFY)` | `{price,sl,tp,type_time,expiration}` → result |
| `DELETE /orders/:ticket` | `order_send(TRADE_ACTION_REMOVE)` | result |

Order results pass through the native `order_send` result verbatim: `retcode`,
`order`, `deal`, `price`, `volume`, `comment`. The bridge builds the fiddly MT5
request dict (action/type/type_filling constants); the adapter never sees them.

**Bridge internals:** single MT5 terminal connection is process-global and not
thread-safe, so serialise requests behind one lock (or a single worker) and return
a `503` when busy past a small queue, `504` on an MT5 call that hangs — same
backpressure contract the adapter maps below. Run under a process supervisor so a
crashed terminal/bridge restarts.

## Backend adapter (`mt5_http.py`)

- **`MT5HttpBroker(MarketDataBroker)`** — candles, quote, catalogue, meta/detail;
  owns the shared `httpx.AsyncClient`. `supports_streaming = False`.
- **`MT5HttpExecutionBroker(ExecutionBroker)`** — real-money dealing through the
  same client.
- **`register(registry, *, base_url, token)`** → `add_data("mt5-self", broker)`,
  `paper_exec.register(registry, broker, broker_id="mt5-self")` (→
  `mt5-self:paper`), `add_exec("mt5-self:live", …)`,
  `broker.start_display_name_fetch()`.

### Config & wiring

New settings block in `config.py`, env prefix `MT5HTTP_`, gated by
`mt5http_settings.has()` in `build_registry()` (same pattern as IG/MT5):
`MT5HTTP_BASE_URL`, `MT5HTTP_TOKEN`. Client:
`AsyncClient(base_url=…, headers={"Authorization": f"Bearer {token}"}, timeout=…)`.
`display_name` = `account_info.company` (via `/account`) + `" (self-hosted)"`
suffix, so the selector disambiguates it from the MetaApi `Ava Trade Ltd. (live)`
entry. Surfaced via `describe()["labels"]` like the MetaApi broker (no static
frontend map edit needed).

### Transport & error mapping (replaces ~400 lines of wedge code)

No wedge machinery — per-request timeout budgets + the existing `BrokerHealth`
circuit breaker (`deps.py`). Map bridge failures onto the broker-health exceptions
`guarded()` understands:

- `503` (bridge busy) → `BrokerReconnecting` (retryable; next poll rides through)
- `504` (MT5 call hung) / httpx read timeout → `BrokerTimeout`
- connect error → `BrokerReconnecting`
- deep-history reads get a longer per-call budget than live reads (mirroring
  `mt5.py`'s `RPC_BUDGET` vs `HISTORY_BUDGET` split). History should be fast (the
  terminal is local to the VPS), so revisit the budget once measured.

### Data methods

- **Candles:** `Resolution → M1/M5/M15/M30/H1/H4/D1/W1` (MT5 `TIMEFRAME_*` ints,
  encoded as strings on the wire). Page backward with `count` from a `from`-anchor
  (unix seconds), same loop as `get_candles` today. Keep the last (forming) bar,
  matching Capital/IG/MetaApi.
- **Quote:** `/tick` → `(bid, ask)`.
- **Catalogue/meta/detail:** `/symbols` (+ copied `_classify_symbol`), `/symbol` →
  contract size, volume bounds in instrument **units** (× `trade_contract_size`),
  digits, leverage inputs.
- **UTC:** MT5 candle/tick times are in the broker-server timezone. Normalise to
  UTC **in the bridge** (it knows the terminal's server offset via
  `timezone`/tick comparison) so the wire is always real-UTC unix — the adapter
  assumes UTC. Documented as a bridge responsibility + deployment note.

### Execution methods

- **place_order:** market → `/orders/market`; limit → `/orders/pending` + `price`;
  SL/TP inline; expiry via `type_time=SPECIFIED` + `expiration`. `order.quantity`
  (units) → lots via copied `_units_to_lots`. **Fill price is in the result**
  (`price`) — no read-back. `deal_id` = result `order` ticket (**verify-live** it's
  the position ticket close/modify key on in AvaTrade hedging mode — the MT5
  position ticket normally equals the opening order ticket). Idempotent on
  `client_order_id` via a process-local ledger, same posture as `mt5.py`.
- **retcode mapping:** success is a **set**, not one code — MT5 returns different
  retcodes for a filled market order vs an accepted pending order vs a partial
  fill: `TRADE_RETCODE_PLACED (10008)`, `TRADE_RETCODE_DONE (10009)`,
  `TRADE_RETCODE_DONE_PARTIAL (10010)` are all success. A retcode **outside** that
  set → **REJECTED** (business reject); transport failure (timeout / connect /
  503 / 504) → **UNKNOWN** → caller reconciles via `get_positions`, never
  blind-retries.
- **close/modify:** `/positions/:ticket/close`, `PUT /positions/:ticket`.
  Carry-forward the untouched SL/TP leg like `mt5.py` (fetch current, merge), since
  MT5 SLTP sets both.
- **working orders:** parse int `type` codes (`2=BUY_LIMIT`, `3=SELL_LIMIT`, …).
  `modify_working_order` uses an **in-place** `PUT /orders/:ticket` including
  `type_time`/`expiration` — the direct `MetaTrader5` `TRADE_ACTION_MODIFY` path
  supports changing expiration (unlike MetaApi's bridge), so the cancel-replace
  dance from `mt5.py` is **not** needed. **Verify-live**; keep cancel-replace as a
  documented fallback only if a live test shows MT5 rejects it.
- **cancel:** `DELETE /orders/:ticket`.

## Security (real money over HTTP — must-have)

The `mt5-self:live` path deals real money, so the bridge must not be openly
reachable:

- Bearer token on every request (shared secret in `MT5HTTP_TOKEN`).
- **Do not** expose the bridge port to the public internet. Reach it from the
  backend over a private link — **Tailscale** (MagicDNS, simplest) or a
  firewall/security-group IP allowlist pinned to the backend host — and terminate
  **TLS** (Tailscale gives this, or a reverse proxy with a cert).
- Bridge binds to the tunnel/loopback interface, not `0.0.0.0` public.

This is a spec-level requirement, called out in the deployment runbook.

## Known limitations (accepted for v1)

- **No live streaming** (`supports_streaming=False`). Charts load REST history but
  don't tick live; `mt5-self:paper` fills market orders off REST quotes, but
  resting paper limit/SL/TP triggers won't auto-fire — `paper_exec.check_triggers`
  reads the latest tick from the streamed tick store, and (per its own docstring,
  `paper_exec.py:619`) "an epic that isn't being streamed won't trigger". Existing
  documented paper limitation for a non-streaming feed. Addressed in Phase 2.
- **Live dealing ships wired-but-untested.** Real-money place/close/modify/cancel
  can't be exercised without a real order; needs a hands-on 0.01-lot check, exactly
  as the MetaApi `mt5:live` path still awaits.
- **Frontend:** expected near-zero (the selector is data-driven off `describe()`).
  Include a task to **verify** the `mt5-self` id renders with the backend-supplied
  label, charts-follow-broker works, and there's no static-map gap.

## Testing

- **Bridge:** unit tests with `MetaTrader5` mocked (it's Windows-only and can't run
  in CI) — assert each endpoint builds the right `order_send` request dict and
  passes struct fields through. A manual smoke script run on the VPS against the
  live terminal (read paths + a 0.01-lot round-trip) is the real acceptance gate.
- **Adapter:** unit tests with a stubbed httpx transport (following capital/ig
  patterns): candle paging + forming-bar retention + timeframe mapping; lots↔units
  (contract size + volume-step snapping); `place_order` retcode → status
  (FILLED/PENDING/REJECTED/UNKNOWN) + idempotency ledger; int-typecode
  position/order parsing; `get_account_summary` mapping; error mapping (503 →
  reconnecting, 504/timeout → timeout, connect error → reconnecting).

## Out of scope

- Live ticks / streaming (Phase 2)
- Removing/renaming the MetaApi broker (Phase 3)
- Server-side TA/backtest, historical ticks/deals — not needed by the current app.
</content>
