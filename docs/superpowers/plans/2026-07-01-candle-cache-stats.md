# Candle Cache Statistics Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-chart candle-cache statistics (coverage, hit/miss rate, freshness, raw debug numbers) via a small badge in the chart legend that opens a detail popover on click.

**Architecture:** Backend adds in-memory hit/miss/last-fetch instrumentation to `CandleCache` plus two read-only stats routes; frontend polls the per-series route from `ChartCore`, renders a small badge in `ChartLegend` row 0, and opens a popover (modeled on `InstrumentDetailsModal`) showing per-series + global stats on click.

**Tech Stack:** Python/FastAPI/sqlite3 (backend), React/TypeScript (frontend), pytest, Playwright.

## Global Constraints

- Stats routes are read-only: they must never call the broker or mutate cache state (spec: Backend section).
- Hit/miss counters and last-fetch timestamps are in-memory only, reset on process restart — do not persist them (spec: Backend section).
- Badge/popover must degrade to a neutral "no cache data" state on any fetch failure or empty series; must never block chart rendering (spec: Error handling).
- Each chart cell shows stats for its own displayed series only, no cross-cell coupling (spec: Scope / Per-cell independence).

---

### Task 1: `CandleCache` hit/miss/last-fetch instrumentation

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py`
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Produces: `CandleCache.stats(key: CandleKey) -> dict` with keys `oldest_ts: int | None`, `newest_ts: int | None`, `cached_bar_count: int`, `hits: int`, `misses: int`, `last_fetch_ts: float | None`.
- Produces: `CandleCache.global_stats() -> dict` with keys `total_bars: int`, `total_hits: int`, `total_misses: int`, `db_size_bytes: int`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_candle_cache.py` (after the existing sync-helper tests, before `class FakeFetcher`):

```python
def test_stats_empty_series_has_none_watermarks_and_zero_counts(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    stats = cache.stats(KEY)
    assert stats == {
        "oldest_ts": None,
        "newest_ts": None,
        "cached_bar_count": 0,
        "hits": 0,
        "misses": 0,
        "last_fetch_ts": None,
    }


def test_stats_reflects_coverage_and_count(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(100, 1.0), _c(160, 2.0)], cutoff_ts=10_000)
    stats = cache.stats(KEY)
    assert stats["oldest_ts"] == 100
    assert stats["newest_ts"] == 160
    assert stats["cached_bar_count"] == 2


def test_global_stats_sums_across_series(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    other_key = ("capital", "GBPUSD", "MINUTE", "mid")
    cache._store_closed(KEY, [_c(100, 1.0)], cutoff_ts=10_000)
    cache._store_closed(other_key, [_c(100, 1.0), _c(160, 2.0)], cutoff_ts=10_000)
    gstats = cache.global_stats()
    assert gstats["total_bars"] == 3
    assert gstats["db_size_bytes"] > 0
```

Add near the bottom of the file, after the existing `_window`/`_recent` behavior tests (find the last test in the file and append below it):

```python
def test_window_hit_increments_hits_not_misses(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220)], cutoff_ts=10_000)
    fetcher = FakeFetcher()
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), fetcher.range, now=10_000))
    stats = cache.stats(KEY)
    assert stats["hits"] == 1
    assert stats["misses"] == 0
    assert stats["last_fetch_ts"] is None  # fully served from cache, no broker call


def test_window_miss_increments_misses_and_records_last_fetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    fetcher = FakeFetcher(bars=[_c(t, float(t)) for t in (100, 160, 220)])
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), fetcher.range, now=10_000))
    stats = cache.stats(KEY)
    assert stats["misses"] == 1
    assert stats["hits"] == 0
    assert stats["last_fetch_ts"] == 10_000


def test_recent_cold_counts_as_miss(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    fetcher = FakeFetcher(bars=[_c(t, float(t)) for t in (100, 160, 220)])
    asyncio.run(cache.recent(KEY, 60, 3, fetcher.recent, now=220))
    stats = cache.stats(KEY)
    assert stats["misses"] == 1
    assert stats["hits"] == 0
    assert stats["last_fetch_ts"] == 220


def test_recent_warm_counts_as_hit(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220, 280)], cutoff_ts=10_000)
    fetcher = FakeFetcher(bars=[_c(340, 340.0)])
    asyncio.run(cache.recent(KEY, 60, 3, fetcher.recent, now=340, tail=1))
    stats = cache.stats(KEY)
    assert stats["hits"] == 1
    assert stats["misses"] == 0
    assert stats["last_fetch_ts"] == 340
```

These four tests use `asyncio.run(...)`, matching every other `window()`/`recent()` test already in this file (no `pytest.mark.asyncio` needed — this repo doesn't use pytest-asyncio).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -v -k "stats or hit or miss"`
Expected: FAIL with `AttributeError: 'CandleCache' object has no attribute 'stats'` (and similar for `global_stats`).

- [ ] **Step 3: Implement the instrumentation**

In `backend/auto_trader/core/candle_cache.py`, add `import os` to the imports at the top (alongside the existing `import asyncio` etc.).

In `CandleCache.__init__`, after `self._locks: dict[CandleKey, asyncio.Lock] = {}`, add:

```python
        # In-memory only (reset on restart) — debug/introspection counters for the
        # candle-cache-stats UI, not durable telemetry.
        self._hits: dict[CandleKey, int] = {}
        self._misses: dict[CandleKey, int] = {}
        self._last_fetch: dict[CandleKey, float] = {}
```

Add these methods right after `_cached_count` (before `async def window`):

```python
    def _record_hit(self, key: CandleKey) -> None:
        self._hits[key] = self._hits.get(key, 0) + 1

    def _record_miss(self, key: CandleKey) -> None:
        self._misses[key] = self._misses.get(key, 0) + 1

    def _record_last_fetch(self, key: CandleKey, when: float) -> None:
        self._last_fetch[key] = when

    def stats(self, key: CandleKey) -> dict:
        """Read-only per-series introspection for the cache-stats UI. Never
        touches the broker; safe to call from a route handler."""
        cov = self._coverage(key)
        return {
            "oldest_ts": cov[0] if cov else None,
            "newest_ts": cov[1] if cov else None,
            "cached_bar_count": self._cached_count(key),
            "hits": self._hits.get(key, 0),
            "misses": self._misses.get(key, 0),
            "last_fetch_ts": self._last_fetch.get(key),
        }

    def global_stats(self) -> dict:
        """Cache-wide introspection (all series) for the cache-stats popover."""
        conn = self._connect()
        try:
            (total_bars,) = conn.execute("SELECT COUNT(*) FROM bars").fetchone()
        finally:
            conn.close()
        return {
            "total_bars": total_bars,
            "total_hits": sum(self._hits.values()),
            "total_misses": sum(self._misses.values()),
            "db_size_bytes": os.path.getsize(self._db_path) if os.path.exists(self._db_path) else 0,
        }
```

In `_window`, change the hit branch:

```python
        if cov is not None and cov[0] <= from_ts and cov[1] >= to_ts:
            return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
```

to:

```python
        if cov is not None and cov[0] <= from_ts and cov[1] >= to_ts:
            self._record_hit(key)
            return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
```

Still in `_window`, right after the `try/except` block that computes `fetched` (i.e. right after the `except Exception:` block ends, before `cutoff = _bucket_start(...)`), add the miss recording guarded on whether a fetch actually happened:

```python
        if start < fetch_end:
            self._record_miss(key)
            self._record_last_fetch(key, now if now is not None else time.time())
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
```

(This replaces the existing standalone `cutoff = _bucket_start(...)` line — fold the new `if` block in front of it rather than duplicating the line.)

In `_recent`, right after `fetched = await fetch_recent(fetch_n)` succeeds (i.e. immediately after the `try/except` block that sets `fetched`, before the `# Store without auto-extending coverage...` comment), add:

```python
        self._record_last_fetch(key, now if now is not None else time.time())
        if cold:
            self._record_miss(key)
        else:
            self._record_hit(key)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -v`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(candle-cache): add hit/miss/last-fetch instrumentation + stats()/global_stats()"
```

---

### Task 2: Backend stats routes

**Files:**
- Modify: `backend/auto_trader/api/app.py`

**Interfaces:**
- Consumes: `CANDLE_CACHE.stats(key: CandleKey) -> dict` and `CANDLE_CACHE.global_stats() -> dict` from Task 1.
- Consumes: `SECONDS_INTERVALS` (dict, already imported), `is_derived(str) -> bool`, `DERIVED: dict[str, BucketRule]` (already imported), `_parse_resolution(str) -> Resolution` (defined in this file), `get_data`/`_candle_dto` patterns are NOT needed here (no broker call).
- Produces: `GET /api/candle-cache/stats?epic=&resolution=&priceSide=&broker=` → `CandleCacheStatsDTO`.
- Produces: `GET /api/candle-cache/stats/global` → `CandleCacheGlobalStatsDTO`.

- [ ] **Step 1: Add the DTOs**

In `backend/auto_trader/api/app.py`, add after the existing `CandleDTO` class (around line 230, right before `class MarkerDTO`):

```python
class CandleCacheStatsDTO(BaseModel):
    oldest_ts: int | None
    newest_ts: int | None
    cached_bar_count: int
    hits: int
    misses: int
    last_fetch_ts: float | None


class CandleCacheGlobalStatsDTO(BaseModel):
    total_bars: int
    total_hits: int
    total_misses: int
    db_size_bytes: int
```

- [ ] **Step 2: Add the routes**

Add right after the `candles()` route function ends (after line 911, `return [_candle_dto(c) for c in loaded]`, and before `@app.get("/api/backtest"...)`):

```python
@app.get("/api/candle-cache/stats", response_model=CandleCacheStatsDTO)
async def candle_cache_stats(
    epic: str = Query(...),
    resolution: str = Query(...),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Query("capital", alias="broker"),
) -> CandleCacheStatsDTO:
    """Read-only cache introspection for the chart's cache-stats badge/popover.
    Never touches the broker or mutates cache state."""
    if resolution in SECONDS_INTERVALS:
        # Sub-minute intervals are served from TICK_STORE, not CANDLE_CACHE.
        return CandleCacheStatsDTO(
            oldest_ts=None, newest_ts=None, cached_bar_count=0,
            hits=0, misses=0, last_fetch_ts=None,
        )
    if is_derived(resolution):
        rule = DERIVED.get(resolution)
        if rule is None:
            raise HTTPException(422, f"unknown resolution '{resolution}'")
        res_value = rule.base.value
    else:
        res_value = _parse_resolution(resolution).value
    key = (broker_id, epic, res_value, price_side)
    stats = await asyncio.to_thread(CANDLE_CACHE.stats, key)
    return CandleCacheStatsDTO(**stats)


@app.get("/api/candle-cache/stats/global", response_model=CandleCacheGlobalStatsDTO)
async def candle_cache_global_stats() -> CandleCacheGlobalStatsDTO:
    """Cache-wide introspection (all series) for the cache-stats popover."""
    stats = await asyncio.to_thread(CANDLE_CACHE.global_stats)
    return CandleCacheGlobalStatsDTO(**stats)
```

- [ ] **Step 3: Manual smoke check**

Run: `cd backend && uvicorn auto_trader.api.app:app --port 8000 &` then:
```bash
curl "http://localhost:8000/api/candle-cache/stats?epic=EURUSD&resolution=MINUTE_5"
curl "http://localhost:8000/api/candle-cache/stats/global"
```
Expected: both return `200` with JSON matching the DTO shapes (first call likely all-empty/zero if the cache hasn't warmed for that series yet). Stop the server afterward (`kill %1` or `fg` + Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add backend/auto_trader/api/app.py
git commit -m "feat(api): add /api/candle-cache/stats and /stats/global routes"
```

---

### Task 3: Frontend fetch helpers

**Files:**
- Modify: `frontend/src/lib/feed.ts`

**Interfaces:**
- Produces: `interface CandleCacheStats { oldestTs: number | null; newestTs: number | null; cachedBarCount: number; hits: number; misses: number; lastFetchTs: number | null }`.
- Produces: `interface CandleCacheGlobalStats { totalBars: number; totalHits: number; totalMisses: number; dbSizeBytes: number }`.
- Produces: `fetchCandleCacheStats(epic: string, resolution: string, priceSide?: PriceSide, brokerId?: string): Promise<CandleCacheStats | null>`.
- Produces: `fetchCandleCacheGlobalStats(): Promise<CandleCacheGlobalStats | null>`.

- [ ] **Step 1: Add the types and functions**

Add to `frontend/src/lib/feed.ts` right after the `fetchMarketDetail` function (after line 273, before `fetchMarketMeta`):

```typescript
export interface CandleCacheStats {
  oldestTs: number | null;
  newestTs: number | null;
  cachedBarCount: number;
  hits: number;
  misses: number;
  lastFetchTs: number | null;
}

export interface CandleCacheGlobalStats {
  totalBars: number;
  totalHits: number;
  totalMisses: number;
  dbSizeBytes: number;
}

// Cache-stats fetches are debug reads, not chart-critical — same short bound as
// the market-meta poll so a hung request can't tie up the connection budget.
const CACHE_STATS_TIMEOUT_MS = 6_000;

/** Per-series candle-cache stats (coverage, hit/miss, last fetch) for the chart
 * legend's cache-stats badge/popover. Returns null on any failure. */
export async function fetchCandleCacheStats(
  epic: string,
  resolution: string,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<CandleCacheStats | null> {
  try {
    const qs = new URLSearchParams({ epic, resolution, priceSide, broker: brokerId });
    const res = await fetchWithTimeout(
      `${BASE}/api/candle-cache/stats?${qs}`,
      CACHE_STATS_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const d = (await res.json()) as {
      oldest_ts: number | null;
      newest_ts: number | null;
      cached_bar_count: number;
      hits: number;
      misses: number;
      last_fetch_ts: number | null;
    };
    return {
      oldestTs: d.oldest_ts,
      newestTs: d.newest_ts,
      cachedBarCount: d.cached_bar_count,
      hits: d.hits,
      misses: d.misses,
      lastFetchTs: d.last_fetch_ts,
    };
  } catch {
    return null;
  }
}

/** Cache-wide stats (all series) shown alongside the per-series stats in the
 * cache-stats popover. Returns null on any failure. */
export async function fetchCandleCacheGlobalStats(): Promise<CandleCacheGlobalStats | null> {
  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/candle-cache/stats/global`,
      CACHE_STATS_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const d = (await res.json()) as {
      total_bars: number;
      total_hits: number;
      total_misses: number;
      db_size_bytes: number;
    };
    return {
      totalBars: d.total_bars,
      totalHits: d.total_hits,
      totalMisses: d.total_misses,
      dbSizeBytes: d.db_size_bytes,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/feed.ts
git commit -m "feat(feed): add candle-cache stats fetch helpers"
```

---

### Task 4: `CandleCacheStatsModal` component

**Files:**
- Create: `frontend/src/CandleCacheStatsModal.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `fetchCandleCacheStats`, `fetchCandleCacheGlobalStats`, `CandleCacheStats`, `CandleCacheGlobalStats` from `./lib/feed` (Task 3); `useDraggable` from `./lib/useDraggable`; `useCloseOnEscape` from `./lib/useCloseOnEscape`; `CloseButton` from `./CloseButton`.
- Produces: `export default function CandleCacheStatsModal(props: { epic: string; resolution: string; priceSide: PriceSide; brokerId: string; title?: string; onClose: () => void }): JSX.Element`.

- [ ] **Step 1: Write the component**

Create `frontend/src/CandleCacheStatsModal.tsx`:

```typescript
// Candle-cache stats popover — opened by clicking the cache badge in the chart
// legend. Shows this chart's own series stats (coverage/hit-rate/freshness) plus
// a global cache summary underneath. Modeled on InstrumentDetailsModal: draggable,
// Escape-closable, generic label/value rows.

import { useEffect, useState } from "react";
import CloseButton from "./CloseButton";
import {
  fetchCandleCacheStats,
  fetchCandleCacheGlobalStats,
  type CandleCacheStats,
  type CandleCacheGlobalStats,
} from "./lib/feed";
import type { PriceSide } from "./theme";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";

interface Props {
  epic: string;
  resolution: string;
  priceSide: PriceSide;
  brokerId: string;
  title?: string;
  onClose: () => void;
}

function fmtTs(ts: number | null): string {
  if (ts == null) return "never";
  const secs = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function fmtRange(oldest: number | null, newest: number | null): string {
  if (oldest == null || newest == null) return "no cache data";
  const days = Math.max(0, Math.round((newest - oldest) / 86400));
  return `${new Date(oldest * 1000).toISOString().slice(0, 10)} → ${new Date(
    newest * 1000,
  )
    .toISOString()
    .slice(0, 10)} (${days}d)`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hitRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total === 0) return "n/a";
  return `${Math.round((hits / total) * 100)}% (${hits}/${total})`;
}

export default function CandleCacheStatsModal({
  epic,
  resolution,
  priceSide,
  brokerId,
  title,
  onClose,
}: Props) {
  const drag = useDraggable();
  const [series, setSeries] = useState<CandleCacheStats | null>(null);
  const [global, setGlobal] = useState<CandleCacheGlobalStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  // One fetch on open (not polled) — this is a point-in-time debug snapshot.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void Promise.all([
      fetchCandleCacheStats(epic, resolution, priceSide, brokerId),
      fetchCandleCacheGlobalStats(),
    ]).then(([s, g]) => {
      if (cancelled) return;
      if (s || g) {
        setSeries(s);
        setGlobal(g);
        setState("ready");
      } else {
        setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [epic, resolution, priceSide, brokerId]);

  useCloseOnEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal cache-stats-modal"
        style={drag.style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head" {...drag.handleProps}>
          <span className="instrument-title">{title || "Cache stats"}</span>
          <CloseButton onClick={onClose} />
        </div>
        <div className="instrument-body">
          {state === "loading" && <p className="instrument-note">Loading…</p>}
          {state === "error" && (
            <p className="instrument-note">Couldn’t load cache stats.</p>
          )}
          {state === "ready" && (
            <>
              <div className="instrument-section">
                <div className="instrument-section-title">This chart</div>
                <dl className="instrument-grid">
                  <div className="instrument-row">
                    <dt>Coverage</dt>
                    <dd>{fmtRange(series?.oldestTs ?? null, series?.newestTs ?? null)}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Cached bars</dt>
                    <dd>{series?.cachedBarCount ?? 0}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Hit rate</dt>
                    <dd>{hitRate(series?.hits ?? 0, series?.misses ?? 0)}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Last fetch</dt>
                    <dd>{fmtTs(series?.lastFetchTs ?? null)}</dd>
                  </div>
                </dl>
              </div>
              <div className="instrument-section">
                <div className="instrument-section-title">Cache overall</div>
                <dl className="instrument-grid">
                  <div className="instrument-row">
                    <dt>Total bars</dt>
                    <dd>{global?.totalBars ?? 0}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Hit rate</dt>
                    <dd>{hitRate(global?.totalHits ?? 0, global?.totalMisses ?? 0)}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>DB size</dt>
                    <dd>{fmtBytes(global?.dbSizeBytes ?? 0)}</dd>
                  </div>
                </dl>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS**

Add to `frontend/src/App.css` right after the existing `.instrument-row dd { ... }` rule (around line 528-530):

```css
.cache-stats-modal { width: 380px; }
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/CandleCacheStatsModal.tsx frontend/src/App.css
git commit -m "feat(chart): add CandleCacheStatsModal popover"
```

---

### Task 5: Legend badge

**Files:**
- Modify: `frontend/src/ChartLegend.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: nothing new from other tasks (self-contained prop addition).
- Produces: new `Props` fields `cacheBadge: { label: string; title: string; state: "fresh" | "stale" | "none" } | null` and `onOpenCacheStats: () => void` on the `ChartLegend` component (Task 6 will supply these from `ChartCore`).

- [ ] **Step 1: Add the props and render the badge**

In `frontend/src/ChartLegend.tsx`, add to the `Props` interface (right after `onOpenDetails: () => void;` around line 108):

```typescript
  // Candle-cache stats badge (coverage/hit-rate/freshness at a glance) — null
  // hides the badge entirely (e.g. before the first stats poll resolves).
  cacheBadge: { label: string; title: string; state: "fresh" | "stale" | "none" } | null;
  // Click the cache badge to open the cache-stats popover.
  onOpenCacheStats: () => void;
```

Add `cacheBadge` and `onOpenCacheStats` to the destructured function parameters (around line 130-146, next to `onOpenDetails`):

```typescript
  onOpenDetails,
  onChangeSymbol,
  cacheBadge,
  onOpenCacheStats,
  handleRef,
```

Render the badge in row 0, right after the `<span className="cl-change" .../>` closing (around line 296-301), inside the `cl-row cl-ohlc` div:

```typescript
        <span
          className="cl-change"
          ref={(el) => {
            changeRef.current = el;
          }}
        />
        {cacheBadge && (
          <button
            className="cl-cache-badge"
            title={cacheBadge.title}
            onClick={(e) => {
              e.stopPropagation();
              onOpenCacheStats();
            }}
          >
            <span className={`cl-cache-dot cl-cache-${cacheBadge.state}`} aria-hidden="true" />
            {cacheBadge.label}
          </button>
        )}
```

- [ ] **Step 2: Add CSS**

Add to `frontend/src/App.css` right after the existing `.cl-change { ... }` rule (around line 1212):

```css
/* Candle-cache stats badge — a small dot (freshness) + short label, click opens
   the cache-stats popover. Neutral/dim by default so it doesn't compete with the
   OHLC/change values; this is a debug affordance, not a primary chart feature. */
.cl-cache-badge {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: 6px; padding: 1px 6px; border: 0; border-radius: 4px;
  background: transparent; color: var(--text-dim); cursor: pointer;
  font-size: inherit; line-height: inherit;
  transition: background 0.12s ease;
}
.cl-cache-badge:hover { background: var(--hover); }
.cl-cache-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; }
.cl-cache-fresh { background: var(--pos); }
.cl-cache-stale { background: var(--text-dim); }
.cl-cache-none { background: transparent; border: 1px solid var(--text-dim); }
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: FAILS at this step — `ChartCore.tsx`'s `<ChartLegend ... />` call site doesn't yet pass `cacheBadge`/`onOpenCacheStats`. This is expected; Task 6 fixes it. Confirm the error is exactly a missing-prop error on that call site and nothing else.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/ChartLegend.tsx frontend/src/App.css
git commit -m "feat(legend): add candle-cache stats badge"
```

---

### Task 6: Wire polling + badge + modal into `ChartCore`

**Files:**
- Modify: `frontend/src/ChartCore.tsx`

**Interfaces:**
- Consumes: `fetchCandleCacheStats`, `type CandleCacheStats` from `./lib/feed` (Task 3); `CandleCacheStatsModal` (Task 4); `ChartLegend`'s new `cacheBadge`/`onOpenCacheStats` props (Task 5).

- [ ] **Step 1: Import the new pieces**

In `frontend/src/ChartCore.tsx`, add to the existing import from `./lib/feed` (find the current import line for `fetchMarketMeta`/`fetchRecent`/`fetchRange` and add `fetchCandleCacheStats` and the `CandleCacheStats` type to it). Add a new import line right after `import InstrumentDetailsModal from "./InstrumentDetailsModal";` (line 41):

```typescript
import CandleCacheStatsModal from "./CandleCacheStatsModal";
```

- [ ] **Step 2: Add poll state**

Right after the existing `const [detailsOpen, setDetailsOpen] = useState(false);` (line 1069), add:

```typescript
  const [cacheStatsOpen, setCacheStatsOpen] = useState(false);
  const [cacheStats, setCacheStats] = useState<CandleCacheStats | null>(null);
```

- [ ] **Step 3: Poll on an interval, keyed to this cell's series**

Find the existing effect that depends on `[symbol.epic, period.resolution, priceSide, brokerId]` (around line 2624, the one ending the big data-load effect) and add a new, separate effect right after it — do NOT fold this into that effect, so a cache-stats poll failure can never affect candle loading:

```typescript
  // Candle-cache stats badge: poll this cell's own series on an interval, reset
  // to null immediately on series change so the badge never shows a stale
  // series' numbers while the new one's first poll is in flight.
  useEffect(() => {
    let cancelled = false;
    setCacheStats(null);
    const poll = () => {
      void fetchCandleCacheStats(symbol.epic, period.resolution, priceSide, brokerId).then(
        (s) => {
          if (!cancelled) setCacheStats(s);
        },
      );
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol.epic, period.resolution, priceSide, brokerId]);
```

- [ ] **Step 4: Derive the badge display from `cacheStats`**

Add right after the effect from Step 3 (still inside the component body, before the `return (`):

```typescript
  const cacheBadge = (() => {
    if (!cacheStats) return null;
    if (cacheStats.oldestTs == null) {
      return { label: "Cache", title: "No cache data yet for this series.", state: "none" as const };
    }
    const ageSec = cacheStats.lastFetchTs != null ? Date.now() / 1000 - cacheStats.lastFetchTs : null;
    const fresh = ageSec != null && ageSec < 60;
    const days = Math.max(0, Math.round((cacheStats.newestTs! - cacheStats.oldestTs) / 86400));
    return {
      label: `Cache ${days}d`,
      title: `Coverage: ${days}d · ${cacheStats.cachedBarCount} bars · ${cacheStats.hits}/${
        cacheStats.hits + cacheStats.misses
      } hits`,
      state: fresh ? ("fresh" as const) : ("stale" as const),
    };
  })();
```

- [ ] **Step 5: Pass the props to `ChartLegend` and render the modal**

In the `<ChartLegend ... />` call (around line 3918-3943), add `cacheBadge={cacheBadge}` and `onOpenCacheStats={() => setCacheStatsOpen(true)}` right after `onOpenDetails={() => setDetailsOpen(true)}`:

```typescript
        onOpenDetails={() => setDetailsOpen(true)}
        cacheBadge={cacheBadge}
        onOpenCacheStats={() => setCacheStatsOpen(true)}
```

Right after the existing `{detailsOpen && (<InstrumentDetailsModal ... />)}` block (around line 3945-3952), add:

```typescript
      {cacheStatsOpen && (
        <CandleCacheStatsModal
          epic={symbol.epic}
          resolution={period.resolution}
          priceSide={priceSide}
          brokerId={brokerId}
          title={`${symbol.name ?? symbol.epic} cache stats`}
          onClose={() => setCacheStatsOpen(false)}
        />
      )}
```

- [ ] **Step 6: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (this resolves the expected failure from Task 5 Step 3).

- [ ] **Step 7: Manual verification**

Run: `cd frontend && npm run dev` (and `cd backend && uvicorn auto_trader.api.app:app --reload --port 8000` in another terminal if not already running). Open the app in a browser, confirm:
- A small "Cache" badge with a dot appears in the legend row after the OHLC/change values.
- Clicking it opens the popover showing "This chart" and "Cache overall" sections.
- Switching symbol/timeframe updates the badge (or clears it briefly) without breaking the chart.

Close the browser tab and stop the dev servers when done (per this project's dev-environment convention: don't leave stray browser tabs/servers behind).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/ChartCore.tsx
git commit -m "feat(chart): wire candle-cache stats polling + badge + popover into ChartCore"
```

---

### Task 7: e2e coverage

**Files:**
- Create: `frontend/e2e/candle-cache-stats.spec.ts`

**Interfaces:**
- Consumes: `seedSingleChartDefault` from `./helpers` (same helper `symbol-template.spec.ts` uses).

- [ ] **Step 1: Write the test**

Create `frontend/e2e/candle-cache-stats.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault } from "./helpers";

// The cache-stats badge/popover is a debug affordance in the chart legend. Stub
// both stats endpoints so the assertions don't depend on the real cache's warm
// state, mirroring market-closed.spec.ts's page.route stubbing style.
test("cache-stats badge opens a popover with per-series and global stats", async ({ page }) => {
  await page.route("**/api/candle-cache/stats?**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        oldest_ts: 1_700_000_000,
        newest_ts: 1_700_864_000, // +10 days
        cached_bar_count: 1440,
        hits: 9,
        misses: 1,
        last_fetch_ts: Date.now() / 1000,
      }),
    }),
  );
  await page.route("**/api/candle-cache/stats/global", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total_bars: 50_000,
        total_hits: 900,
        total_misses: 100,
        db_size_bytes: 2_500_000,
      }),
    }),
  );

  await seedSingleChartDefault(page);

  const badge = page.locator(".cl-cache-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Cache");

  await badge.click();
  const modal = page.locator(".cache-stats-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("This chart");
  await expect(modal).toContainText("Cache overall");
  await expect(modal).toContainText("1440"); // cached bar count
  await expect(modal).toContainText("2.4 MB"); // db size, human-readable
});
```

Before finalizing, open `frontend/e2e/helpers.ts` and confirm `seedSingleChartDefault`'s exact signature (e.g. whether it takes just `page` or additional args) — copy the call shape used at the top of `symbol-template.spec.ts` exactly.

- [ ] **Step 2: Run the test**

Run: `cd frontend && npx playwright test candle-cache-stats.spec.ts`
Expected: PASS. If the dev server isn't auto-started by the Playwright config, check `frontend/playwright.config.ts` for the `webServer` setup other specs rely on — no manual server start should be needed.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/candle-cache-stats.spec.ts
git commit -m "test(e2e): cover candle-cache stats badge and popover"
```

---

## Post-implementation check

Run the full backend and frontend test suites once all tasks are committed:

```bash
cd backend && python -m pytest
cd ../frontend && npx vitest run && npx playwright test
```

Expected: all green, no regressions in unrelated suites.
