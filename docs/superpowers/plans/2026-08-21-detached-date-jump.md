# Detached Date Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go-to-date jump far into uncached history loads just the target window in seconds (backend serves it pass-through; the chart shows it as a detached view with a "Back to live" pill) instead of downloading the entire span between the date and today.

**Architecture:** Two independent halves. Backend: `CandleCache.window()` gains a `max_fill_chunks` cap — when the requested window lies entirely below cached coverage and closing the gap would exceed the cap, the cache fetches exactly the requested range from the broker and returns it WITHOUT storing it (the contiguity invariant of the cache is untouched; the data is simply not cached). Frontend: `onGoToDate` detects a target too deep for the parallel cover, and instead of extending history, reloads the chart with only the target window ± context bars ("detached" mode: no live stream, no live-edge logic), with a pill to return to the live series. Near jumps keep today's behavior (parallel cover, continuous history).

**Tech Stack:** Python/FastAPI/sqlite (backend), React + klinecharts + vitest (frontend).

**Spec:** No separate spec doc — the agreed design is in this header and was settled in conversation (2026-08-21): pass-through for deep windows, detached chart view with "Back to live", explicitly NO island/coverage-tracking cache.

## Global Constraints

- No em dashes in end-user copy (toasts, pills, tooltips); use parentheses/colons. Code and commits may use them.
- Tooltips: 1-2 short sentences, lead with the noun, never start with "How". Use the shared `Tooltip` component, never `title=`.
- Frontend tests: run from `frontend/` (`npx vitest run <file>`); `.tsx` test files need `// @vitest-environment jsdom` on line 1 (suite default is node).
- Backend tests: run from `backend/` (`python3 -m pytest tests/<file> -q`).
- Every popover/menu must close on outside click (document `mousedown`/`pointerdown` idiom) — applies if any new popover is added (the pill itself is not a popover).
- Commit after each task. Never commit unrelated pending changes; if the working tree has pre-existing uncommitted work, commit only this plan's files (`git add <specific paths>`).
- Frontend suite baseline is green (3418 tests as of 2026-08-21); any failure you see after your change is real.

---

### Task 1: Backend — pass-through branch in `CandleCache.window()`

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py` (method `window`, ~line 352, and `_window`, ~line 397)
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Produces: `CandleCache.window(..., max_fill_chunks: int | None = None)` — new keyword-only param. `None` (default) = today's behavior for every existing caller. When set: if the requested window lies entirely below cached coverage (`to_ts < cov[0]`) and the contiguous fill it would trigger needs more than `max_fill_chunks` chunks, the window is served pass-through: fetched from the broker in `chunk_bars`-sized chunks covering ONLY `[start, end]`, returned sorted ascending, with neither the bars stored nor coverage touched. The `deadline` (from `budget_s`) still applies; if it expires mid-pass-through, return what landed and set `partial` (same out-param contract). Fetch errors propagate exactly as the fill path's do (first-chunk error raises; later-chunk error returns what landed with `degraded` set — mirror `_window`'s existing "serve what we have + degraded" behavior only if bars already landed, else raise).

**Notes for the implementer:**
- The existing test harness (`FakeFetcher`, `_c`, `_dt`, `KEY` at the top of `test_candle_cache.py`) is what you build on. `FakeFetcher.range` records `(from_ts, to_ts)` tuples in `range_calls` and serves bars filtered to the asked range.
- `cache._coverage(KEY)` reads the coverage row directly — the tests assert on it.
- Chunking: `chunk_secs = res_seconds * chunk_bars`; walk `[start, end]` bottom-up (oldest chunk first) so a deadline expiry keeps the OLDEST bars — the target date is what the user asked to see, and it sits at the bottom of the window.
- Decide pass-through BEFORE acquiring the per-key lock (read coverage, branch): a peek must not queue behind a minutes-long backfill someone else is running. A slightly stale coverage read is harmless (worst case: one unnecessary pass-through).
- Record it as a miss (`self._record_miss(key)` — check the exact private name used by `_window` and reuse it).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_candle_cache.py`:

```python
def test_window_passthrough_deep_gap_serves_window_without_fill(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # Warm coverage to [9000, 9060].
    f0 = FakeFetcher([_c(t, float(t)) for t in (9000, 9060)])
    asyncio.run(cache.window(KEY, 60, _dt(9000), _dt(9060), f0.range, now=10_000))
    # Deep window [100, 220]: gap to coverage is ~150 bars; with chunk_bars=10
    # the fill would need ~15 chunks > max_fill_chunks=2 -> pass-through.
    src = [_c(t, float(t)) for t in (100, 160, 220)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(
        KEY, 60, _dt(100), _dt(220), f.range,
        now=10_000, chunk_bars=10, max_fill_chunks=2,
    ))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220]
    # Fetches covered ONLY the requested window, not the gap up to 9000.
    assert all(to <= 220 + 60 for (_frm, to) in f.range_calls)
    # Nothing was cached: coverage untouched, and asking again re-fetches.
    assert cache._coverage(KEY) == (9000, 9060)


def test_window_small_gap_still_fills_contiguously_despite_cap(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (220, 280)])
    asyncio.run(cache.window(KEY, 60, _dt(220), _dt(280), f0.range, now=10_000))
    # Gap [40, 220] is 3 bars; chunk_bars=10 -> 1 chunk <= cap -> normal fill.
    src = [_c(t, float(t)) for t in (40, 100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(
        KEY, 60, _dt(40), _dt(120), f.range,
        now=10_000, chunk_bars=10, max_fill_chunks=2,
    ))
    assert [int(c.time.timestamp()) for c in out] == [40, 100]
    assert cache._coverage(KEY) == (40, 280)  # fill extended coverage as before


def test_window_no_cap_keeps_deep_fill_behavior(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (9000, 9060)])
    asyncio.run(cache.window(KEY, 60, _dt(9000), _dt(9060), f0.range, now=10_000))
    src = [_c(t, float(t)) for t in (100, 160, 9000, 9060)]
    f = FakeFetcher(src)
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(160), f.range, now=10_000))
    # Unbounded caller (backtest): the contiguous fill ran, coverage now reaches 100.
    assert cache._coverage(KEY)[0] == 100


def test_window_passthrough_chunks_large_window(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (99000, 99060)])
    asyncio.run(cache.window(KEY, 60, _dt(99000), _dt(99060), f0.range, now=100_000))
    # 50-bar window, chunk_bars=10 -> pass-through must make ~5 bounded calls.
    src = [_c(t, float(t)) for t in range(600, 3601, 60)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(
        KEY, 60, _dt(600), _dt(3600), f.range,
        now=100_000, chunk_bars=10, max_fill_chunks=2,
    ))
    assert len(out) == len(src)
    assert len(f.range_calls) >= 2
    assert all((to - frm) <= 60 * 10 for (frm, to) in f.range_calls)
    # Oldest-first: the first call covers the bottom of the window.
    assert f.range_calls[0][0] == 600


def test_window_passthrough_overlapping_coverage_uses_normal_path(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (200, 260)])
    asyncio.run(cache.window(KEY, 60, _dt(200), _dt(260), f0.range, now=10_000))
    # Window [100, 260] overlaps coverage -> not "entirely below" -> normal fill.
    src = [_c(t, float(t)) for t in (100, 160, 200, 260)]
    f = FakeFetcher(src)
    asyncio.run(cache.window(
        KEY, 60, _dt(100), _dt(260), f.range,
        now=10_000, chunk_bars=10, max_fill_chunks=2,
    ))
    assert cache._coverage(KEY) == (100, 260)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_candle_cache.py -q -k passthrough_or_cap or true` — simplest: `python3 -m pytest tests/test_candle_cache.py -q`. Expected: the 5 new tests FAIL with `TypeError: window() got an unexpected keyword argument 'max_fill_chunks'`.

- [ ] **Step 3: Implement**

In `candle_cache.py`, add the param to `window()` and branch before the lock:

```python
    async def window(
        self, key, res_seconds, start, end, fetch_range, *,
        now=None, chunk_bars=_BACKFILL_CHUNK_BARS,
        degraded=None, budget_s=None, partial=None,
        max_fill_chunks: int | None = None,
    ) -> list[Candle]:
        deadline = None if budget_s is None else time.monotonic() + budget_s
        # Deep-window pass-through (interactive peeks): when the window sits
        # entirely below coverage and closing the gap would exceed
        # max_fill_chunks, serve exactly [start, end] from the broker and cache
        # NOTHING — the contiguity invariant stays intact by not writing at
        # all. Decided before the lock: a peek must not queue behind someone
        # else's minutes-long backfill (stale coverage here is harmless).
        if max_fill_chunks is not None:
            from_ts, to_ts = int(start.timestamp()), int(end.timestamp())
            cov = await asyncio.to_thread(self._coverage, key)
            chunk_secs = res_seconds * max(1, chunk_bars)
            if cov is not None and to_ts < cov[0]:
                gap_chunks = -(-(cov[0] - from_ts) // chunk_secs)  # ceil
                if gap_chunks > max_fill_chunks:
                    self._record_miss(key)
                    return await self._passthrough(
                        key, res_seconds, from_ts, to_ts, fetch_range,
                        chunk_secs=chunk_secs, deadline=deadline,
                        degraded=degraded, partial=partial,
                    )
        async with self._key_lock(key):
            return await self._window(...)  # unchanged
```

And the helper (match `_window`'s idioms — bottom-up chunk walk, deadline check before each chunk, degraded/partial out-params):

```python
    async def _passthrough(
        self, key, res_seconds, from_ts, to_ts, fetch_range, *,
        chunk_secs, deadline, degraded, partial,
    ) -> list[Candle]:
        out: list[Candle] = []
        cur = from_ts
        total = max(1, -(-(to_ts - from_ts) // chunk_secs))
        done = 0
        while cur <= to_ts:
            if deadline is not None and time.monotonic() >= deadline:
                if partial is not None:
                    partial.update({"done_chunks": done, "total_chunks": total})
                break
            chunk_to = min(to_ts, cur + chunk_secs)
            try:
                chunk = await fetch_range(
                    datetime.fromtimestamp(cur, tz=timezone.utc),
                    datetime.fromtimestamp(chunk_to, tz=timezone.utc))
            except Exception as e:  # noqa: BLE001 — same contract as _window
                if not out:
                    raise
                if degraded is not None:
                    degraded["reason"] = str(e) or type(e).__name__
                break
            out.extend(chunk)
            done += 1
            cur = chunk_to + 1
        out.sort(key=lambda c: c.time)
        return [c for c in out if from_ts <= int(c.time.timestamp()) <= to_ts]
```

(Adapt names to the file's actual private helpers — e.g. use its real miss counter. If `_record_miss` doesn't exist under that name, find how `_window` records misses and do the same.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_candle_cache.py -q`. Expected: all pass, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): serve deep windows pass-through under max_fill_chunks"
```

---

### Task 2: Backend — wire pass-through into the chart candles route

**Files:**
- Modify: `backend/auto_trader/api/deps.py` (`_fetch_symbol_candles`, ~line 257)
- Modify: `backend/auto_trader/api/routers/charts.py` (`candles` route, ~line 67)
- Test: `backend/tests/test_api_candles.py`

**Interfaces:**
- Consumes: `CandleCache.window(..., max_fill_chunks=...)` from Task 1.
- Produces: `_fetch_symbol_candles(..., max_fill_chunks: int | None = None)` — forwarded to BOTH `CANDLE_CACHE.window(...)` calls inside it (the derived-resolution branch and the native branch; `recent()` calls are untouched). `charts.py` defines `CHART_PASSTHROUGH_MAX_FILL_CHUNKS = 8` next to `CHART_FILL_BUDGET_S` and passes it from the `/api/candles` route only. No other caller passes it (backtests, expression eval, sweeps keep completeness semantics).

**Notes:** Look at how `test_api_candles.py` builds its client/fixtures and follow the same pattern; the test seeds the cache via the same route (or via `CANDLE_CACHE` directly) with a fake broker. `CHART_PASSTHROUGH_MAX_FILL_CHUNKS = 8` is ~24k bars (8 chunks x 3000): roughly 80 days of 5m — under that, filling contiguously is cheap and keeps the cache growing; over it, a chart read serves the window directly.

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_api_candles.py`, following its existing fixture style (fake data broker + test client), add:

```python
def test_deep_window_served_passthrough_leaves_cache_coverage(client, ...):
    # 1. Prime the cache near "now" (one normal /api/candles window call).
    # 2. Request a window ~1 year older than coverage (far beyond 8 chunks).
    # 3. Assert: 200 with the requested bars; the fake broker saw fetches only
    #    inside the requested window (no call reaching up toward coverage);
    #    CANDLE_CACHE coverage for the series is unchanged from step 1.
```

Write it concretely against the file's real fixtures (read the file first; it already fakes the broker registry). The three assertions above are the required ones.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_api_candles.py -q`. Expected: new test FAILS (broker sees gap-filling fetches / coverage extended), pre-existing tests pass.

- [ ] **Step 3: Implement**

`deps.py`: add `max_fill_chunks: int | None = None` to `_fetch_symbol_candles`'s signature (documented alongside `budget_s`) and forward it in the two `CANDLE_CACHE.window(...)` calls.

`charts.py`:

```python
# Deep-window pass-through cap for interactive chart reads: a window this many
# chunks (x 3000 bars) below cached coverage is served straight from the broker
# without the contiguous fill. 8 chunks = 24k bars (~80 days of 5m): nearer
# gaps are cheap to fill and keep the cache growing; deeper asks are peeks and
# should cost seconds, not a year of downloads.
CHART_PASSTHROUGH_MAX_FILL_CHUNKS = 8
```

and pass `max_fill_chunks=CHART_PASSTHROUGH_MAX_FILL_CHUNKS` in the route's `_fetch_symbol_candles(...)` call.

- [ ] **Step 4: Run backend suite**

Run: `cd backend && python3 -m pytest tests/test_api_candles.py tests/test_candle_cache.py tests/test_candles_derived.py -q` then the full `python3 -m pytest -q`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/deps.py backend/auto_trader/api/routers/charts.py backend/tests/test_api_candles.py
git commit -m "feat(api): chart candle reads serve deep windows pass-through"
```

---

### Task 3: Frontend — pure detached-view helpers

**Files:**
- Create: `frontend/src/chart/detachedView.ts`
- Test: `frontend/src/chart/detachedView.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4-5):

```ts
/** Gap (in bars) between the loaded oldest bar and the jump target beyond
 *  which Go-to-date detaches instead of extending history. 50k bars is ~6
 *  months of 5m: under it the parallel cover is at most ~100 requests and a
 *  continuous scrollable history is worth it; over it, extending means
 *  hundreds of requests and (on a cold cache) minutes of backfill. */
export const DETACH_GAP_BARS = 50_000;
/** Bars of context fetched on each side of the target date. */
export const DETACH_CONTEXT_BARS = 1_500;

export interface DetachedTarget { targetMs: number }

export function shouldDetach(
  targetMs: number, loadedOldestMs: number | null, resSec: number,
): boolean;

/** The 500-bar fetch windows covering [target - context, target + context],
 *  in seconds, oldest first. */
export function detachedWindows(
  targetMs: number, resSec: number, pageBars?: number,
): Array<{ fromSec: number; toSec: number }>;
```

- [ ] **Step 1: Write the failing tests** (`detachedView.test.ts`, node env is fine — no DOM):

```ts
import { describe, it, expect } from "vitest";
import {
  shouldDetach, detachedWindows, DETACH_GAP_BARS, DETACH_CONTEXT_BARS,
} from "./detachedView";

const RES = 300; // 5m
const NOW = 1_700_000_000_000;

describe("shouldDetach", () => {
  it("detaches when the gap exceeds the bar budget", () => {
    const target = NOW - (DETACH_GAP_BARS + 10) * RES * 1000;
    expect(shouldDetach(target, NOW, RES)).toBe(true);
  });
  it("stays attached inside the budget (parallel cover handles it)", () => {
    const target = NOW - (DETACH_GAP_BARS - 10) * RES * 1000;
    expect(shouldDetach(target, NOW, RES)).toBe(false);
  });
  it("never detaches with no loaded data (initial load owns it)", () => {
    expect(shouldDetach(NOW - 10 ** 12, null, RES)).toBe(false);
  });
  it("never detaches for a target newer than the loaded oldest", () => {
    expect(shouldDetach(NOW + 1000, NOW, RES)).toBe(false);
  });
});

describe("detachedWindows", () => {
  it("covers target +/- context in 500-bar windows, oldest first", () => {
    const ws = detachedWindows(NOW, RES);
    const spanSec = 2 * DETACH_CONTEXT_BARS * RES;
    expect(ws.length).toBe(Math.ceil((2 * DETACH_CONTEXT_BARS) / 500));
    expect(ws[0].fromSec).toBe(Math.floor(NOW / 1000) - DETACH_CONTEXT_BARS * RES);
    expect(ws[ws.length - 1].toSec).toBe(ws[0].fromSec + spanSec);
    for (let i = 1; i < ws.length; i++) expect(ws[i].fromSec).toBe(ws[i - 1].toSec);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run src/chart/detachedView.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `detachedView.ts` exactly per the interface (plain arithmetic; `pageBars` defaults 500).

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/detachedView.ts frontend/src/chart/detachedView.test.ts
git commit -m "feat(chart): detached-view thresholds and window math"
```

---

### Task 4: Frontend — detached mode: state, load branch, Go-to-date entry

**Files:**
- Modify: `frontend/src/ChartCore.tsx` (detached state, wiring)
- Modify: `frontend/src/chart/useLiveMarketData.ts` (load-effect branch)
- Modify: `frontend/src/chart/useRangeNavigation.ts` (`onGoToDate` deep branch)
- Test: `frontend/src/chart/useRangeNavigation.test.ts` (extend)

**Interfaces:**
- Consumes: `shouldDetach`, `DetachedTarget` from Task 3; `fetchRange` from `../lib/feed`.
- Produces:
  - ChartCore state: `const [detached, setDetached] = useState<DetachedTarget | null>(null)` plus `exitDetached = () => setDetached(null)`. `detached` is passed into `useLiveMarketData` deps AND its effect dep array, and into `useRangeNavigation` deps as `{ detached, enterDetached: (targetMs: number) => void }`.
  - `useRangeNavigation`: `RangeNavigationDeps` gains `enterDetached(targetMs: number): void` and `detached: DetachedTarget | null`. `onGoToDate` computes `loadedOldestMs = chart.getDataList()[0]?.timestamp ?? null` and `resSec = RESOLUTION_SECONDS[period.resolution] ?? 60`. Branch: when NOT detached, `shouldDetach(dateMs, loadedOldestMs, resSec)` decides — true calls `enterDetached(dateMs)` and returns, false runs the existing `goToRange` path. When ALREADY detached, call `enterDetached(dateMs)` whenever the target lies outside the loaded extent (older than the oldest loaded bar or newer than the newest); a target inside the loaded detached window just recenters via the normal `goToRange` path (which finds everything covered and only scrolls).
  - `useLiveMarketData`: deps gain `detached: DetachedTarget | null` and the effect treats it as a third bars source: when `detached && !replaying`, fetch `detachedWindows(detached.targetMs, resSec)` via `fetchRange` (sequential or `Promise.all` — a handful of windows), concat+sort+dedupe by timestamp into `bars`, and thereafter follow the REPLAY guards (`const inert = replaying || detachedMode`): do NOT open the live stream, do NOT run live-edge jump/retry/anchor-coverage/view-restore persistence (`saveViewPos` gated off), DO run overlay/indicator rehydrate. After `setBars`, center the view on `detached.targetMs` with `scrollTsToCenter`. Add `detached` to the effect's dependency array so entering/leaving reloads the series (same idiom as `replayEpoch`).

**Notes for the implementer:**
- `useLiveMarketData.ts` is ~1000 lines with many `replaying` guards. Read the whole effect first. The pattern to follow already exists: `const replaying = replay?.isActive() ?? false` forks the bars source and gates the stream (`if (replaying) { ... } else openLive(...)` near line 916). Introduce `const detachedMode = !!deps.detached && !replaying` and reuse the existing guard sites — where a guard says `!replaying`, decide per-site whether it should be `!replaying && !detachedMode` (stream, live-edge, retries, save/restore of view pos: yes; overlay rehydrate: leave as is). Do not restructure the effect.
- Scroll-back keeps working in detached mode by construction (the pager pages older from the loaded left edge; backend Task 2 makes those requests cheap). `exhaustedRef` must be reset when entering/leaving detached (the load effect already resets it on reload — verify).
- The date-range-link/broadcast concern: a detached cell's view changes still broadcast like a normal deep jump does today; out of scope to change.

- [ ] **Step 1: Write failing tests** in `useRangeNavigation.test.ts`: extend `jumpHarness` deps with `enterDetached: vi.fn()`, `detached: null`, and add:

```ts
it("go-to-date deeper than the detach budget enters detached view", async () => {
  const { onGoToDate, enterDetached, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
  // ~2.5 years behind the loaded oldest on 5m: far past DETACH_GAP_BARS.
  onGoToDate("2021-01-05");
  expect(enterDetached).toHaveBeenCalledTimes(1);
  expect(coverHistoryTo).not.toHaveBeenCalled(); // no fetch storm
});

it("go-to-date inside the detach budget keeps the parallel cover", async () => {
  const { onGoToDate, settled, enterDetached, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
  onGoToDate("2023-11-13"); // hours behind LAST_BAR (2023-11-14T22:13Z): near
  expect(enterDetached).not.toHaveBeenCalled();
  expect(coverHistoryTo).toHaveBeenCalled();
  await vi.waitFor(() => expect(settled()).toBe(true));
});
```

(`jumpHarness` must return `enterDetached` too. Recompute the near/deep example dates against `LAST_BAR = 1_700_000_000_000` = 2023-11-14T22:13:20Z so "near" is within 50k 5m bars ≈ 173 days and "deep" is beyond.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/chart/useRangeNavigation.test.ts`. Expected: FAIL (`enterDetached` not called / deps unknown).

- [ ] **Step 3: Implement** the `useRangeNavigation` branch (per Interfaces above), then the ChartCore state + `useLiveMarketData` branch. Keep the `onGoToDate` comment explaining the two modes.

- [ ] **Step 4: Verify** — `npx vitest run src/chart/useRangeNavigation.test.ts`, then the full `npx vitest run` and `npx tsc --noEmit`. Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useLiveMarketData.ts frontend/src/chart/useRangeNavigation.ts frontend/src/chart/useRangeNavigation.test.ts
git commit -m "feat(chart): detached view for deep go-to-date jumps"
```

---

### Task 5: Frontend — "Back to live" pill

**Files:**
- Create: `frontend/src/DetachedPill.tsx`
- Test: `frontend/src/DetachedPill.test.tsx`
- Modify: `frontend/src/ChartCore.tsx` (render when `detached` and not replaying, near the `<ReplayPill>` mount ~line 4666)
- Modify: `frontend/src/index.css` (pill styles, reuse the visual language of `.crb-cal-pop`: `var(--surface)`, `var(--border)`, radius 7px)

**Interfaces:**
- Consumes: `exitDetached` and `detached` from Task 4.
- Produces:

```tsx
interface Props {
  /** The jump target, for the label. */
  targetMs: number;
  timezone: string;
  onBackToLive(): void;
}
export default function DetachedPill({ targetMs, timezone, onBackToLive }: Props)
```

Renders a small fixed pill at the cell's top-right: label `Viewing <formatted date>` (format with `Intl.DateTimeFormat` in the chart timezone, e.g. "Mar 7, 2024") and a button `Back to live` that calls `onBackToLive`. Copy rule: no em dashes. If any replay session is masked (`maskedSessionNow()` from `../lib/maskedReplay`), show `Viewing <hidden>` instead of the date (same redaction rule the debug logs follow).

- [ ] **Step 1: Write failing test** (`// @vitest-environment jsdom`, testing-library, `afterEach(cleanup)`):

```tsx
it("shows the target date and returns to live on click", () => {
  const onBack = vi.fn();
  render(<DetachedPill targetMs={Date.UTC(2024, 2, 7)} timezone="UTC" onBackToLive={onBack} />);
  expect(screen.getByText(/Mar 7, 2024/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /back to live/i }));
  expect(onBack).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/DetachedPill.test.tsx`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the component + mount in ChartCore (`{detached && !replayActive && <DetachedPill targetMs={detached.targetMs} timezone={timezone} onBackToLive={exitDetached} />}` — use ChartCore's actual timezone/replay variables) + CSS.

- [ ] **Step 4: Verify** — component test, full `npx vitest run`, `npx tsc --noEmit`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/DetachedPill.tsx frontend/src/DetachedPill.test.tsx frontend/src/ChartCore.tsx frontend/src/index.css
git commit -m "feat(chart): Back to live pill for detached view"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1:** `cd backend && python3 -m pytest -q` — all green.
- [ ] **Step 2:** `cd frontend && npx tsc --noEmit && npx vitest run` — all green (baseline 3418 + new tests).
- [ ] **Step 3:** `npx eslint` the files touched by Tasks 3-5 — no NEW findings (two pre-existing: unused directive in ChartRangeBar.tsx, rules-of-hooks in useRangeNavigation.test.ts `harness`).
- [ ] **Step 4:** Report to the user: what landed, and ask them to try Go → a 2024 date on the 5m EURUSD chart with the dev servers running (expect: seconds to land, a "Viewing …" pill, Back to live restores the live series; backend log shows only a handful of `/api/candles` requests, no backfill storm).
