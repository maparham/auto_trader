# MT5 live WebSocket streaming — design

**Date:** 2026-07-08
**Status:** Approved (design), pre-implementation
**Author:** brainstorming session

## Problem

MT5 (AvaTrade via MetaApi) charts do not tick live. `MT5Broker.supports_streaming`
is `False`, so the chart loads REST history and the last price only refreshes via
`get_quote` polling — visibly laggy next to Capital/IG, whose last candle moves
tick-by-tick. As a knock-on effect, MT5 **paper** limit/SL/TP orders never fire:
the paper-trigger driver (`paper_exec.check_triggers`) only evaluates epics that
have a live tick in `TICK_STORE`, and MT5 feeds none.

Goal: MT5 charts tick live for native intraday timeframes, matching Capital/IG,
and MT5 paper orders start triggering off the same tick stream.

## Scope

**In:** Live forming-bar streaming for native intraday resolutions — 1m, 5m, 15m,
30m, 1h, 4h.

**Out (v1):** DAY/WEEK (no clean epoch-bucket boundary — deferred, same as the
careful case Capital handles via its OHLC channel), sub-minute seconds intervals
(need a tick-history store), and derived timeframes (2W/3W/1M/1Y…). These keep
their REST history and receive a `fatal` "not streamed" frame so the client stops
retrying, exactly like the current IG behavior.

## Findings from the live spike

A throwaway spike (`scripts/mt5_stream_spike.py`) against the live AvaTrade
account established three facts the design rests on:

1. **Quote streaming works on this MetaApi tier** — 76 quote ticks in 12s for a
   live symbol via `subscribe_to_market_data(symbol, [{"type": "quotes"}])` +
   `on_symbol_price_updated`.
2. **The streaming connection coexists with the RPC connection** — an RPC
   `get_symbol_price` succeeded both before and after the stream ran. Streaming is
   a *separate* connection instance (`get_streaming_connection()`), independent of
   the RPC `_conn` the broker trades/reads through today.
3. **The listener receives EVERY symbol's ticks, not just the subscribed one.**
   `on_symbol_price_updated` fired for many instruments (indices, other pairs)
   regardless of what was subscribed. **The listener must filter by
   `price["symbol"]`.** This is why the design uses one shared connection + one
   listener + fan-out by symbol, rather than a connection per chart.

MetaApi's own `subscribe_to_market_data` docstring notes candle streaming is "not
fully implemented on server-side yet", so we build bars from **quote ticks**
(tick-folding), not from `on_candles_updated`. Ticks also carry bid/ask, giving
the optional bid & ask price lines for free.

## Architecture

Three units, mirroring the existing Capital/IG streaming shape.

### 1. `MT5Broker` — a second shared connection + a tick router

The broker gains a MetaApi **streaming** connection alongside the existing RPC
`_conn`, plus a symbol→subscribers registry. New members:

- `_stream_conn`, `_stream_synced`, `_stream_lock` — parallel to `_conn` /
  `_synced` / `_lock`.
- `_ensure_stream()` — re-entrant connect + `wait_synchronized`, mirroring
  `_ensure()`. Attaches the single `_TickListener` on first connect.
- `_tick_subs: dict[str, set[asyncio.Queue]]` — symbols each mapped to the set of
  live consumer queues.
- `_sub_refcount: dict[str, int]` — ref count per symbol so N charts on one symbol
  share one upstream `subscribe_to_market_data`; the last consumer to leave
  unsubscribes.
- `_TickListener(SynchronizationListener)` — `on_symbol_price_updated(idx, price)`
  looks up `price["symbol"]` in `_tick_subs` and pushes `(bid, ask, time)` onto
  each registered queue. Symbols with no subscribers are dropped (that is the
  spike-#3 filter).
- `register_tick_queue(symbol) -> Queue` / `unregister_tick_queue(symbol, q)` —
  register/deregister a consumer queue and drive the subscribe/unsubscribe
  refcount. These run under `_stream_lock`.

RPC stays the transport for `get_quote`, reads, and trades. `get_quote` is **not**
re-pointed at the streaming connection's `terminal_state` in this change (possible
future simplification; noted, not done).

The streaming connection is left connected for the process lifetime and closed in
`aclose()` alongside the RPC connection. Deregistering the last consumer
unsubscribes the symbol but does **not** close the connection.

### 2. `auto_trader/brokers/mt5_stream.py` — the listener→generator bridge

New module, public shape matching `ig_stream` / `capital_stream`.

`async def stream_candles(broker, epic, resolution, price_side="mid") ->
AsyncIterator[LiveBar]`:

1. `await broker._ensure_stream()`.
2. `queue = broker.register_tick_queue(epic)` (subscribes upstream if first).
3. Seed a tick-only forming bar from `broker.get_recent_candles(epic, resolution,
   1)` — real open/high/low/close/volume for the current bucket, best-effort (a
   failed fetch cold-starts from the first tick, never stalls the stream). Only
   seed if the fetched bar's bucket matches the current clock bucket (same guard
   Capital uses, so a stale bar from a rollover gap can't pin the live bar).
4. Drain the queue. For each tick: `mid = (bid + ask) / 2` (respect `price_side`
   for the plotted candle; keep raw bid/ask for the price lines). Roll the bar
   when `ts // step` advances (epoch-bucket boundary — intraday only). Fold the
   mid into close, stretch high/low, pin open to the first tick of a tick-rolled
   bar.
5. `TICK_STORE.record(broker.broker_id, epic, ts_ms, mid)` on each tick — this is
   what feeds the paper-trigger driver (mirrors `ig_stream` line 192).
6. `yield LiveBar(candle, bid, ask)` — `LiveBar` is imported from `capital_stream`
   (reused verbatim; the router reads `.candle/.bid/.ask`).
7. `finally: broker.unregister_tick_queue(epic, queue)` — never closes the shared
   connection.

A small **tick-only** bar builder lives in this module (seed / `apply_tick` /
`roll` / `candle`). `capital_stream._BarState` is not reused because it is built
around Capital's separate bid/ask OHLC channel, which MT5 does not have; the
MT5 builder is strictly simpler (ticks only).

Reconnect: `_ensure_stream` re-syncs a stale streaming socket once (mirroring
`MT5Broker.read`'s reconnect-once). A permanent fault (unknown/invalid epic)
surfaces as `StreamFatalError` (reused from `capital_stream`) so the router sends
`fatal=True` and the client stops storming reconnects.

### 3. `api/routers/stream.py` — dispatch branch

Add MT5 handling alongside the existing `is_ig` branch:

- seconds intervals → `_fatal("{broker}: seconds intervals not streamed yet")`.
- derived timeframes → `_fatal("{broker}: {res} is not streamed live")`.
- native DAY/WEEK → `_fatal` (no clean epoch bucket in v1).
- native intraday → `stream = mt5_stream.stream_candles(broker, epic, resolution,
  price_side)`.

Detection mirrors `is_ig = isinstance(broker, IGBroker)` with
`is_mt5 = isinstance(broker, MT5Broker)`. No frontend change — the chart already
dials `/ws/candles?broker=mt5&resolution=…` and handles `fatal` frames.

### 4. `supports_streaming = True`

Flip the flag on `MT5Broker`. This both enables `/ws/candles` for MT5 and arms the
paper-trigger driver for MT5 paper orders. Both consume the same `TICK_STORE`
stream that (3) now feeds, so no MT5-specific gating is needed — MT5 paper orders
begin triggering exactly as Capital/IG paper orders already do. Implementation
verifies a paper limit/SL/TP on an MT5 epic fires once ticks flow.

## Data flow

```
MetaApi streaming conn ──on_symbol_price_updated(price for ANY symbol)──▶ _TickListener
   _TickListener: price["symbol"] → _tick_subs[symbol] → push (bid,ask,time) to each Queue
      stream_candles(epic): drain Queue → fold tick into forming bar
         ├─ TICK_STORE.record(...)  ─────▶ paper-trigger driver (check_triggers)
         └─ yield LiveBar ─▶ /ws/candles forward() ─▶ browser (live candle + bid/ask lines)
```

## Error handling

- Unknown broker / non-streaming broker / bad resolution: unchanged router
  `fatal` frames.
- Stale streaming socket: `_ensure_stream` reconnect-once, then propagate.
- Permanent per-epic fault: `StreamFatalError` → `fatal=True`.
- Seed fetch failure: best-effort, cold-start from first tick, never stalls.
- Consumer disconnect: router cancels `forward()`, generator `finally`
  deregisters + drops the subscription refcount; shared connection stays up.

## Testing

- **Unit (no network):** inject a fake queue/listener and drive a synthetic tick
  sequence. Assert: forming-bar OHLC folds correctly; bucket rollover at
  `ts // step`; bid/ask pass through to `LiveBar`; **ticks for other symbols are
  ignored** (spike-#3 filter); `TICK_STORE.record` is called per tick; refcounted
  subscribe/unsubscribe on register/deregister.
- **Router:** MT5 + seconds/derived/DAY/WEEK → `fatal`; MT5 + intraday → dispatches
  to `mt5_stream.stream_candles`.
- **Live smoke:** `scripts/mt5_stream_spike.py` for the connection path; then a
  manual chart check that the last MT5 candle ticks and an MT5 paper limit fills.

## Out of scope / future

- DAY/WEEK live streaming (rollover-boundary handling).
- Sub-minute seconds intervals + MT5 tick-history store.
- Derived-timeframe live folding for MT5.
- Serving `get_quote` from the streaming connection's `terminal_state` to drop
  RPC polling.
