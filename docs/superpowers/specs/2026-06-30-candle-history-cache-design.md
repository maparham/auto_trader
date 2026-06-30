# Backend Candle History Cache — Design

**Date:** 2026-06-30
**Status:** Approved, ready for implementation plan

## Goal

Cache chart history (minute-and-above candles) on the backend so that:

1. Switching timeframes is fast — re-viewing an already-fetched series is instant.
2. IG's weekly `/prices` allowance is preserved — don't re-fetch the same window.
3. Capital round-trips are cut — fewer redundant REST calls.
4. History survives process restarts (`uvicorn --reload`) and brief broker outages.

Sub-minute (seconds) intervals are **out of scope** — they keep flowing through the
existing `TICK_STORE` unchanged.

## Approach (chosen)

**Bar store + coverage watermarks, populated by broker REST fetches.** Rejected
alternatives: a request-keyed response cache with TTL (overlapping-but-not-identical
scroll-back windows miss, so it barely reduces broker calls).

### Why watermarks (not an interval-set)

The frontend's access pattern is strictly:

- **Initial load:** most-recent N bars (`fetchRecent`, 500).
- **Scroll-back:** contiguous leftward windows — the cursor walks backward by fixed
  pages (`fetchRange` in `ChartCore.tsx`), never arbitrary date jumps. There is no
  go-to-arbitrary-date feature.

So coverage per series is fully described by **two watermarks** `[oldest_ts, newest_ts]`,
not a general interval-set. This keeps merge logic trivial.

## Architecture

New module `backend/auto_trader/core/candle_cache.py` owning its own sqlite DB (a
sibling file to `tick_store`'s, so it survives `--reload`).

It sits **between** the `/api/candles` route and the broker. The route asks the cache;
the cache decides what (if anything) to fetch and calls **broker fetch callables passed
in by the route** (`broker.get_candles` / `broker.get_recent_candles`). The cache never
imports brokers — it stays broker-agnostic and unit-testable with a fake fetcher.

## Storage (sqlite, two tables)

**`bars`** — closed bars only:

| col | type | notes |
|-----|------|-------|
| broker | TEXT | |
| epic | TEXT | |
| resolution | TEXT | `Resolution` value |
| side | TEXT | bid/mid/ask, cached independently |
| ts | INTEGER | bar-open unix seconds |
| open, high, low, close, volume | REAL | |

PK: `(broker, epic, resolution, side, ts)`.

**`coverage`** — the contiguous fetched range per series:

| col | type |
|-----|------|
| broker, epic, resolution, side | TEXT (PK) |
| oldest_ts | INTEGER |
| newest_ts | INTEGER |

## Data flow

**Closed cutoff:** a bar is "closed" once its next bar has opened, i.e.
`cutoff = now - resolution.seconds`. Nothing at/after `cutoff` is ever written. The
forming bar never enters the cache.

### Recent-N path (no `from_ts`/`to_ts`)

1. **Always** fetch a small fresh tail (~3 bars) from the broker via
   `get_recent_candles`. This anchors "now" and captures the just-closed bar —
   weekends/holidays/market hours mean the latest valid timestamp can't be computed
   offline. (Decision: always fetch the tail; no skip-on-recent-TTL in v1.)
2. Store the closed bars from the tail; advance `newest_ts`.
3. Serve the requested `bars` count by reading backward from `newest_ts` in the cache.
   If the cache holds fewer than requested (cold/short series), fetch the shortfall via
   `get_recent_candles`, store, then serve.

### Scroll-back window path (`from_ts`/`to_ts` present)

1. If `[from_ts, to_ts] ⊆ [oldest_ts, newest_ts]` → serve from cache, **zero broker
   calls**.
2. Else fetch only the uncovered slice (the part below `oldest_ts`) via `get_candles`,
   store closed bars, extend `oldest_ts`. Serve the merged window from cache.
3. An empty fetched slice still advances `oldest_ts` past the gap (mirrors the
   frontend's "keep walking back past the gap" logic) so closed-market gaps don't cause
   re-fetch loops.

## Error handling

- **Broker fetch raises** (breaker open / IG allowance exhausted / offline): serve
  whatever the cache holds for the window. The existing route-level circuit breaker
  surfaces the error only when the cache is empty. Never crash on a cache hit — this is
  the survives-offline guarantee.
- **Cache writes are best-effort:** a sqlite failure logs and falls through to the live
  broker path. The cache must never be load-bearing for correctness.
- **Seconds intervals untouched:** still served by `TICK_STORE` exactly as today.

## Scope boundaries

- Closed bars only; forming bar never cached.
- Per-side rows; no cross-side derivation.
- **No stream write-through in v1.** Writing each closed bar from the live OHLC streams
  (`ig_stream` / `capital_stream`) so actively-watched epics need zero REST is the
  obvious **v2**.
- **No pruning in v1** (decision). DB grows unbounded for now; retention (age cap per
  resolution, like `tick_store`'s `RETENTION_MS`) is **v2**.

## Testing

Unit tests against `candle_cache.py` with a **fake fetcher** (records calls, returns
canned candles):

- Cold miss fetches & stores.
- Warm window hit makes **zero** fetch calls.
- Partial overlap fetches only the uncovered slice.
- Closed cutoff excludes the forming bar.
- Gap window advances `oldest_ts` without looping.
- Recent-N always makes exactly one tail call.

Plus a route-level test that a repeat scroll-back window short-circuits (no broker call).
Existing broker/parse tests (`test_parse_prices`, etc.) stay green.
