# Local MT5 broker over the terminal's built-in MCP server

**Date:** 2026-09-23
**Status:** Phase 1 implemented (`backend/auto_trader/brokers/mt5_mcp.py`). Reads verified live; dealing paths are unit-tested only.
**Supersedes:** the transport in [2026-07-11-mt5-selfhosted-http-broker-design.md](2026-07-11-mt5-selfhosted-http-broker-design.md). The goal (leave MetaApi) and the phase plan stay; the custom REST bridge is dropped.

## What changed

MT5 build 6180+ runs an MCP server inside the desktop terminal (Tools > Options > MCP,
`http://127.0.0.1:22346/mcp`, bearer API key). It already exposes what the planned
Windows FastAPI bridge would have: account, positions and orders, candle history,
Market Watch, and the trade calls. So there is nothing to write or run on the
terminal side. The backend adapter is an MCP client.

A spike on 2026-09-23 ran the macOS MT5 app (MetaQuotes' own Wine bundle) on an
8 GB M2 MacBook Air, logged into the AvaTrade live account:

- MCP reads answer in 0.01 to 0.2 s once history is local; 60 days of EURUSD M1
  (61k bars, two pages) in about 1 s.
- The `MetaTrader5` Python package also works under the same Wine prefix
  (64-bit embeddable Python 3.11; the python.org installer is 32-bit and fails
  in the 64-bit-only prefix). It is not needed by the adapter.
- Login needed the exact server name typed into File > Open an Account; the
  broker search and AvaTrade's own web installer both fail under Wine.

## Transport

A thin JSON-RPC client over httpx, not the `mcp` SDK (its task-group lifetime
does not fit a long-lived broker):

- `initialize`, then `notifications/initialized`; carry `Mcp-Session-Id`;
  a 404 on a known session means the terminal restarted, so re-initialize once.
- Responses are JSON or SSE; tool payloads are JSON inside `content[0].text`.
- Errors: connect error to `BrokerReconnecting`, timeout to `BrokerTimeout`,
  401 to `MCPAuthError` (wrong key, not retryable), `isError` to `MCPToolError`.

Config (`MT5MCP_` prefix, gated on the key): `MT5MCP_URL` (default above),
`MT5MCP_KEY`, `MT5MCP_SERVER_UTC_OFFSET_MINUTES` (default 0).

## Registration

Broker id `mt5-self`, beside the MetaApi `mt5`: data + `mt5-self:paper` +
`mt5-self:live`. Restricted like the other credentialed brokers. Label from the
account block: "Ava Trade Markets Ltd. (live, local)"; frontend fallback
"AvaTrade MT5 (local)". `BROKER_HEALTH` gives it a 60 s per-key budget.

## Behaviour the MCP forces

| Area | Finding | Adapter behaviour |
|---|---|---|
| Server time | Timestamps are naive broker time; Ava-Real 1-MT5 runs on UTC | Offset setting, default 0 |
| Candle freshness | M1 is live; H1/H4/D1/W1 lag until the terminal rebuilds them (D1 was missing today's bar) | Newest bars above M1 are rebuilt from M1 (`_patch_tail`), capped at 8 days |
| Bar alignment | H4 on the server clock; W1 opens Sunday 00:00 | Same bucketing in the rebuild |
| History depth | The terminal downloads history lazily: a cold symbol's first reply is short and grows in steps for 30 to 60 s; `data_available_from` overstates real depth | A reply stopping more than 5 days short of the request is retried (3 s apart, about 10 s per call). It is accepted once its oldest bar has held still for 12 s (tracked per series across calls); still moving means a retryable 503, never a truncated range |
| Symbols | History and quotes fail with "symbol not found" until the symbol is in Market Watch | Add it and retry once (changes Market Watch visibility) |
| Quotes | `get_marketwatch_symbols` carries bid/ask for selected rows only | Select on a miss |
| Specs | Market Watch rows carry contract size, volume min/max/step, digits | Lots and units converted as on `mt5` |
| Sessions, margin | No trading sessions; tick value is 0 and there is no margin tool | `closed` stays None; no leverage figure |
| Streaming | None | `supports_streaming = False` |
| Partial close | Not offered | REJECTED. Not emulated with an opposite order: the account is hedging, so that would open a second position |
| Pending price/expiry change | Only SL/TP can be modified | REJECTED with a reason |
| SL/TP modify | Unchanged values are rejected by the server | Send only changed levels |

## Dealing (untested against a terminal)

- Trade calls get a 150 s budget: with Trading = Manual confirmation in the
  terminal's AI Assistant options, a call may wait on a dialog.
- `isError` or a failing retcode is REJECTED; a timeout or dropped connection
  is UNKNOWN and never retried, since the order can still land.
- The trade result and pending-order row shapes were not seen (no orders were
  placed); both are parsed defensively. The first real test belongs on a demo
  account, with Algo Trading on in the terminal.

## Roadmap

- **Phase 1 (done):** data, paper and live dealing over MCP.
- **Phase 2:** live ticks, likely by polling Market Watch into a pseudo-stream.
  Still the gate to removing MetaApi.
- **Phase 3:** delete `mt5.py`, promote `mt5-self` to `mt5`;
  `_mt5_symbols.py` becomes the only copy of the symbol classifier.

Hosting: the terminal must run and stay logged in. On the Mac it stops with
sleep; for 24/7 dealing, run it on a Windows VPS and reach the MCP through a
tunnel (it binds 127.0.0.1 only).
