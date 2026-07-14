# Automatic candle accumulation for open charts

Date: 2026-07-14
Status: Design approved (pending spec review)

## Problem

Brokers only retain a rolling window of low-timeframe candles (a Capital/IG 1m
series may only go back days to weeks; older bars are gone forever). If we never
capture them, that history is unrecoverable. We want charts that are actually
being used to accumulate their history over time, so the longer you use a chart
the deeper and more continuous its cached history becomes, independent of what
the broker still offers today.

The backend already has a persistent closed-bar cache
(`core/candle_cache.py`, see `candle-cache` design) that stores bars on demand
when a chart requests them. What is missing:

1. On open, it only fetches what the current viewport needs; it never reaches
   deeper than the first request did.
2. It has no "keep capturing while the chart stays open" behaviour, so a long
   viewing session can still lose bars if the broker later drops them.

## Non-goals / decisions

- **No UI, no toggle.** Opening/viewing a chart is the enrollment signal. This
  supersedes an earlier idea of a per-tab toggle: usage itself decides what
  accumulates, so only charts you actually look at cost anything. (An earlier
  clarifying answer of "keep running with the browser closed" is likewise
  superseded by the open-driven model: accumulation runs while a chart is open.)
- **Scope is the exact viewed series**, keyed `(broker, epic, resolution,
  price_side)`. Opening EURUSD 5m accumulates 5m only, not 1m/15m/1H. (This
  overrides an earlier "all native TFs per symbol" answer, which belonged to the
  toggle model; the open-driven model reads as per-viewed-series.) Derived
  timeframes (3m, 2W/3W/6W, 1M/2M/3M, 1Y) accumulate their base series (1m or
  DAY/WEEK), exactly as the existing fetch/seed paths already target the base.
- **Seconds resolutions are out of scope** (served from `TICK_STORE`, not the
  candle cache).
- No pruning/retention policy (same as candle-cache v1). Disk growth is
  bounded in practice by the number of series a user actually views.

## Architecture

A new `core/candle_accumulator.py` owns accumulation. It is driven by the
existing `/ws/candles` relay lifecycle, which is already the precise
"this series is being viewed right now" signal (the socket stays open for the
whole viewing session, and its `finally` fires on cell close / disconnect).

```
/ws/candles connect  ──▶  accumulator.on_view_start(key, res_seconds, fetchers)
      (per cell)              refcount[key] += 1
                              if first viewer of key:
                                 - spawn deep-backfill task (once, floor-aware)
                                 - start periodic recent() refresh loop

/ws/candles finally  ──▶  accumulator.on_view_stop(key)
      (disconnect)            refcount[key] -= 1
                              if last viewer: cancel the refresh loop
```

The accumulator is a single in-process singleton (mirrors `CANDLE_CACHE`). It
holds a per-key refcount and the running tasks, so N cells viewing the same
series share **one** deep-backfill run and **one** refresh loop.

### Component: `CandleAccumulator`

Responsibilities and interface:

- `on_view_start(key, res_seconds, fetch_range, fetch_recent, *, is_ig) -> None`
  - Increment refcount. On the first viewer of `key`:
    - Fire a background **deep-backfill** task (fire-and-forget, deduped by key).
    - Start a **periodic recent refresh** loop for `key`.
  - `fetch_range` / `fetch_recent` are the same broker-fetch callables the route
    already builds (circuit-breaker-guarded via `guarded()`), so the accumulator
    stays broker-agnostic (no broker imports), matching the cache's design.
  - `is_ig` selects the allowance-conservative backfill policy.
- `on_view_stop(key) -> None`
  - Decrement refcount; when it hits zero, cancel the refresh loop for `key`.
    (The deep-backfill task is one-shot; it either finished or is cancelled.)

Both are cheap, non-throwing, and safe to call from the ws handler's setup and
`finally`.

### Deep backfill (coverage-safe backward paging)

This is the delicate part. It **cannot** reuse `CandleCache.window()` with an
early `start`, because `window()` makes a single `fetch_range` call and then
marks coverage over the *entire requested span* — even bars the broker never
returned. Verified broker behaviour:

- **Capital / IG** `get_candles(start, end)` paginate by time across the whole
  range, so a deep start returns everything retained. IG bills `/prices` against
  a **weekly allowance**, so a wide 1m backfill can lock out the week.
- **MT5** `get_candles` pages backward but **caps at `_MAX_PAGES = 40`
  (~40,000 bars)**. Request more and it silently stops short. Reusing
  `window()` here would mark the unfetched deep region as covered → a permanent
  silent hole (the exact invariant the cache doc calls the cardinal sin).

So deep backfill is a **new `CandleCache` method** (coverage logic stays inside
the cache, under its per-key lock and invariants — not hand-rolled in the
accumulator):

```
CandleCache.backfill_below(key, res_seconds, fetch_range, *,
                           target_oldest_ts, max_bars_per_step) -> None
```

Behaviour, under `_key_lock(key)`:
1. Read current coverage `oldest` (or "now" if the series is cold — cold series
   get their forward block from the normal `recent()` path first).
2. Page **backward** from `oldest` in steps of `max_bars_per_step` bars: request
   `fetch_range(step_start, step_end)`, store returned closed bars, and extend
   `oldest` **only to the min ts actually returned** (never to `step_start`).
3. Stop when: a step returns no new bars below the current oldest (broker floor
   reached), or `target_oldest_ts` is reached, or a broker error/allowance limit
   is raised (IG). Record a persistent **floor marker** for the key when the
   broker floor is confirmed, so later reopens don't re-page empty pre-history.

The floor marker lives in a new additive table (e.g. `backfill_state`: key +
`floor_ts` + `reached_floor`), so the existing `coverage`/`bars` schema is
untouched (no migration; `CREATE TABLE IF NOT EXISTS`).

`target_oldest_ts` is derived from a **per-resolution max-lookback** policy
(e.g. 1m ~ weeks, 5m/15m ~ months, 1H ~ a couple years, DAY/WEEK ~ decades),
capped tighter for IG to respect the weekly allowance. This bounds each series
to a sane depth and, for MT5, keeps a single step within its page limit.

Deep backfill runs as a background task so first paint is never blocked; the
chart's interactive load continues to go through the normal `recent()`/`window()`
paths unchanged.

### Forward capture while open (periodic recent)

Chosen over stream write-through to avoid adding coverage-extension code to the
streaming hot path (this codebase has four documented silent-hole bugs, all in
that union/disjoint coverage logic). The refresh loop simply calls the existing,
fully-debugged `CandleCache.recent(key, res_seconds, count, fetch_recent)` on a
cadence of roughly one bar-period (with sensible floor/ceiling, e.g. min ~30s
for 1m, and no faster than the bar period for higher TFs). On a warm cache
`recent()` fetches only a tiny tail and reuses the bridge/disjoint logic, so
each tick is cheap and coverage stays correct by construction.

The forming-bar live feed to the chart is unchanged — it still rides the
`/ws/candles` stream. The refresh loop only persists **closed** bars into the
cache; it does not touch the socket.

## Data flow summary

- **On open:** ws connects → `recent()` (normal load, forward bridge) +
  background `backfill_below` (deep history, once per key until floor) → cache
  fills in both directions.
- **While open:** periodic `recent()` persists each newly-closed bar.
- **On close:** ws `finally` → refresh loop cancelled; cached history persists.
- **Reopen later:** forward bridge fills the gap since last close (if still
  within the broker's window); deep backfill resumes only if the floor wasn't
  reached last time.

## Error handling

- All accumulator broker calls go through the existing `guarded()` circuit
  breaker, so a down broker degrades accumulation without starving other work.
- Deep backfill is best-effort: any broker/breaker error stops that run,
  coverage is left marked only to what was actually fetched, and the floor
  marker is **not** set (so it resumes next session). IG `IGAllowanceExceeded`
  is caught and treated as a graceful stop, not an error.
- The periodic loop swallows transient errors (logs + continues); a persistent
  failure just means no new closed bars are persisted until it recovers, and the
  next open's forward bridge catches up.
- Refcount underflow / double-stop are guarded (clamp at zero) so an odd
  connect/disconnect ordering can't leave orphan loops.

## Testing

- `candle_accumulator` unit tests with a fake fetcher (mirrors candle_cache
  tests): refcount dedup (N starts → one backfill, one loop; last stop cancels),
  and the loop calls `recent()` on cadence.
- `CandleCache.backfill_below` tests: (a) full reach to floor sets the marker;
  (b) **MT5-style truncation** — a fetcher that returns fewer bars than the
  requested span must NOT over-claim coverage (regression guard for the silent
  hole); (c) IG allowance error mid-page stops gracefully with partial coverage
  and no floor marker; (d) idempotent reopen after floor reached issues no new
  broker calls.
- ws-handler wiring test: connect calls `on_view_start` with the right key
  (incl. derived → base key), disconnect calls `on_view_stop`, and a stream
  error path still runs the stop (no orphaned loop).

## Files touched

- **New:** `backend/auto_trader/core/candle_accumulator.py` (singleton +
  refcount + tasks + policy).
- **New method:** `CandleCache.backfill_below` + `backfill_state` table in
  `backend/auto_trader/core/candle_cache.py`.
- **Wiring:** `backend/auto_trader/api/routers/stream.py` — call
  `on_view_start` in setup and `on_view_stop` in `finally` for native and
  derived (base-key) paths; skip seconds.
- **Tests:** new `test_candle_accumulator.py`; extend candle_cache tests.
- No frontend changes.
