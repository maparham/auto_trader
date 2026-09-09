# Viewport-Scoped Indicator Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MTF indicator stashes cover a two-ended interval driven by the visible range instead of the full loaded history, and chart-timeframe Trendlines compute from a viewport floor instead of bar 0, so deep pattern-jump clicks stop stalling the chart.

**Architecture:** The stash contract in `mtfCoordinator.ts` changes from "reach from the live edge back to the oldest loaded bar" to "cover `[coveredFromMs, coveredToMs]` containing the visible range plus warmup and a one-screenful margin". A debounced `onVisibleRangeChange` subscription in ChartCore replaces the "history grew" trigger. `htfBarCache` becomes an interval store that fetches only missing spans, with parallel window lanes. The trendlines calc session gains a monotone compute floor stamped from the same subscription.

**Tech Stack:** TypeScript, React, klinecharts v10, vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-viewport-scoped-indicator-coverage-design.md`

## Global Constraints

- No em dashes in comments or UI copy; split sentences instead.
- Never stash/clean/restore; `git add` by explicit path only; commit to the current branch.
- Test command: `cd frontend && npx vitest run <file>`; typecheck: `cd frontend && npx tsc -b --noEmit` (or the project's `npm run typecheck` if defined in frontend/package.json).
- Existing behaviors that MUST NOT change: replay no-lookahead clamp (`clampHtfBars` applied per caller at the end of `fetchHtfBars`), retry/backoff on failed walks (`mtfFetchTail`), "the ask is final" semantics of `coveredFromMs` (out-asked broker history stays terminal), persistence saving only `mtf.timeframe`, the pinned-slope `nominalBarHours` width rule, and `computeTrendlines`' default (startIdx 0) results byte for byte (parity goldens).
- `applyData`/prepend behavior of the candle pagers is untouched; this plan changes only indicator coverage.

---

### Task 1: Parallel span fetcher in historyPaging

**Files:**
- Modify: `frontend/src/lib/historyPaging.ts` (add one exported function; do not touch existing exports)
- Test: `frontend/src/lib/historyPaging.test.ts` (extend; create if missing)

**Interfaces:**
- Produces: `fetchSpanParallel<T extends BarLike>(args: FetchSpanParallelArgs<T>): Promise<{ bars: T[]; failed: boolean }>` where

```ts
export interface FetchSpanParallelArgs<T extends BarLike> {
  fromMs: number;            // span left edge (inclusive ask)
  toMs: number;              // span right edge
  resSec: number;            // seconds per bar
  pageBars: number;          // bars per window
  maxWindows: number;        // safety cap
  concurrency: number;       // parallel lanes
  fetchWindow: (fromSec: number, toSec: number) => Promise<T[]>;
}
```

Semantics: compute windows newest-to-oldest exactly like `coverHistoryRangeParallel` (same `[max(from, to - pageBars*resSec), to]` then step past arithmetic), run a fixed lane pool, and on any thrown window keep only the contiguous window prefix NEAREST `toMs` (the newest side) and return `failed: true`. Empty windows are fine (closed market or history edge) and do not break contiguity. Result bars ascending, deduped by timestamp.

- [ ] **Step 1: Write the failing tests** in `frontend/src/lib/historyPaging.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fetchSpanParallel } from "./historyPaging";

const bar = (t: number) => ({ timestamp: t });
// 1 bar per second windows of 10 bars, span 0..30s
const args = (fetchWindow: (f: number, t: number) => Promise<{ timestamp: number }[]>) => ({
  fromMs: 0, toMs: 30_000, resSec: 1, pageBars: 10,
  maxWindows: 10, concurrency: 3, fetchWindow,
});

describe("fetchSpanParallel", () => {
  it("fetches every window and returns ascending bars", async () => {
    const calls: Array<[number, number]> = [];
    const r = await fetchSpanParallel(args(async (f, t) => {
      calls.push([f, t]);
      const out = [];
      for (let s = f; s <= t; s++) out.push(bar(s * 1000));
      return out;
    }));
    expect(r.failed).toBe(false);
    expect(r.bars[0].timestamp).toBeLessThan(r.bars[r.bars.length - 1].timestamp);
    // hole-free: consecutive timestamps
    for (let i = 1; i < r.bars.length; i++)
      expect(r.bars[i].timestamp).toBeGreaterThan(r.bars[i - 1].timestamp);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("a thrown window keeps only the contiguous newest-side prefix and flags failed", async () => {
    const r = await fetchSpanParallel(args(async (f, t) => {
      if (f < 10) throw new Error("boom"); // oldest window fails
      const out = [];
      for (let s = f; s <= t; s++) out.push(bar(s * 1000));
      return out;
    }));
    expect(r.failed).toBe(true);
    expect(r.bars.length).toBeGreaterThan(0);
    expect(r.bars[0].timestamp).toBeGreaterThanOrEqual(10_000);
  });

  it("empty windows do not break contiguity or flag failure", async () => {
    const r = await fetchSpanParallel(args(async (f, t) => {
      if (f < 10) return []; // history edge: nothing older
      const out = [];
      for (let s = f; s <= t; s++) out.push(bar(s * 1000));
      return out;
    }));
    expect(r.failed).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `cd frontend && npx vitest run src/lib/historyPaging.test.ts`. Expected: FAIL, `fetchSpanParallel` is not exported.

- [ ] **Step 3: Implement** `fetchSpanParallel` in `historyPaging.ts`, directly below `coverHistoryRangeParallel`, reusing its window arithmetic verbatim:

```ts
export async function fetchSpanParallel<T extends BarLike>(
  args: FetchSpanParallelArgs<T>,
): Promise<{ bars: T[]; failed: boolean }> {
  const { fromMs, toMs, resSec, pageBars, maxWindows, concurrency, fetchWindow } = args;
  const fromFloorSec = Math.floor(fromMs / 1000);
  const windows: { fromSec: number; toSec: number }[] = [];
  let toSec = Math.floor(toMs / 1000);
  while (toSec * 1000 > fromMs && windows.length < maxWindows) {
    const fromSec = Math.max(fromFloorSec, toSec - pageBars * resSec);
    windows.push({ fromSec, toSec });
    if (fromSec <= fromFloorSec) break;
    toSec = fromSec - 1;
  }
  if (windows.length === 0) return { bars: [], failed: false };
  const results: (T[] | null)[] = new Array(windows.length).fill(null);
  const errored: boolean[] = new Array(windows.length).fill(false);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= windows.length) return;
      try {
        results[i] = await fetchWindow(windows[i].fromSec, windows[i].toSec);
      } catch {
        errored[i] = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, lane),
  );
  // windows[0] is the NEWEST; keep the contiguous prefix up to the first error.
  const firstErr = errored.indexOf(true);
  const usable = firstErr === -1 ? results : results.slice(0, firstErr);
  const seen = new Set<number>();
  const bars: T[] = [];
  for (let i = usable.length - 1; i >= 0; i--)
    for (const b of usable[i] ?? [])
      if (!seen.has(b.timestamp)) {
        seen.add(b.timestamp);
        bars.push(b);
      }
  bars.sort((a, b) => a.timestamp - b.timestamp);
  return { bars, failed: firstErr !== -1 };
}
```

- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git add frontend/src/lib/historyPaging.ts frontend/src/lib/historyPaging.test.ts && git commit -m "feat(chart): parallel span fetcher for known-endpoint history windows"`

---

### Task 2: Interval-aware HTF bar cache

**Files:**
- Modify: `frontend/src/lib/htfBarCache.ts` (rewrite the store; keep file, exports change)
- Test: `frontend/src/lib/htfBarCache.test.ts` (extend/replace existing cases)

**Interfaces:**
- Consumes: nothing new (the span loader is injected by the caller).
- Produces:

```ts
export interface HtfIntervalResult {
  bars: KLineData[];   // ascending, covering [askFromMs, askToMs] as far as data exists
  failed: boolean;     // any span load failed (partial results still returned)
  askFromMs: number;   // the interval this call settled on (the ask, both ends)
  askToMs: number;
}
export type HtfSpanLoader = (fromMs: number, toMs: number) => Promise<{ bars: KLineData[]; failed: boolean }>;
export function htfIntervalKey(parts: { brokerId: string | undefined; epic: string; timeframe: string; priceSide: string }): string;
export function fetchHtfInterval(key: string, fromMs: number, toMs: number, htfMs: number, loadSpan: HtfSpanLoader): Promise<HtfIntervalResult>;
export function clearHtfCache(): void;           // kept
export function htfCacheStats(): { cached: number; inflight: number }; // kept
```

Behavior:
- One entry per key: `{ fromMs, toMs, bars, at }`, one contiguous ascending interval.
- The key drops the live-edge bucket (`newestMs`); freshness of the right edge is handled below. The replay clamp stays per caller, unchanged, so replay cells CAN now share entries with live cells safely (the clamp cuts after the fetch).
- A request `[fromMs, toMs]`:
  - covered by the entry and either `toMs <= entry.toMs - htfMs` (strictly historical) or the entry is younger than `HTF_CACHE_TTL_MS`: serve `bars` filtered to the request, no fetch.
  - left gap (`fromMs < entry.fromMs`): `loadSpan(fromMs, entry.fromMs - 1)` and merge.
  - right gap or stale right edge: `loadSpan(max(entry.fromMs, lastClosedRefetchFromMs), toMs)` where `lastClosedRefetchFromMs = entry.bars.length ? entry.bars[entry.bars.length - 1].timestamp : fromMs` (refetching the last stored bar is deliberate: it may have been forming when stored) and merge by timestamp, new bars win.
  - disjoint from the entry (`toMs < entry.fromMs - htfMs` or `fromMs > entry.toMs + htfMs` with no overlap intent): REPLACE the entry with a fresh `loadSpan(fromMs, toMs)` (rebase mirror of the stash rule).
  - no entry: `loadSpan(fromMs, toMs)`.
- On any `failed: true` span, return what merged with `failed: true` and DO NOT extend the stored ask past what succeeded (failures stay retryable, as today).
- In-flight coalescing per key: a running load whose ask covers the request serves it; otherwise the new request awaits the running one, then applies its own gap logic on the updated entry (simple serialization per key is fine: keep a per-key promise chain).
- Keep `MAX_ENTRIES = 24` eviction by insertion order; entries are bigger now, this matters.

- [ ] **Step 1: Write failing tests** (replace the existing `htfBarCache` cases that assert the old `fetchHtfShared` API; port their intent):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { fetchHtfInterval, htfIntervalKey, clearHtfCache } from "./htfBarCache";
import type { KLineData } from "klinecharts";

const H = 3_600_000;
const mk = (t: number): KLineData => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1 });
const spanLoader = (log: Array<[number, number]>, failBelow = -Infinity) =>
  async (fromMs: number, toMs: number) => {
    log.push([fromMs, toMs]);
    if (fromMs < failBelow) return { bars: [], failed: true };
    const bars: KLineData[] = [];
    for (let t = Math.ceil(fromMs / H) * H; t <= toMs; t += H) bars.push(mk(t));
    return { bars, failed: false };
  };
const KEY = htfIntervalKey({ brokerId: "b", epic: "E", timeframe: "HOUR", priceSide: "mid" });

beforeEach(() => clearHtfCache());

describe("fetchHtfInterval", () => {
  it("first ask loads the full interval, second identical ask is served without a fetch", async () => {
    const log: Array<[number, number]> = [];
    const r1 = await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    expect(r1.bars.length).toBeGreaterThan(0);
    const calls = log.length;
    const r2 = await fetchHtfInterval(KEY, 10 * H, 90 * H, H, spanLoader(log));
    expect(log.length).toBe(calls); // strictly-historical sub-interval: no fetch
    expect(r2.bars[0].timestamp).toBeGreaterThanOrEqual(10 * H);
  });

  it("a left extension fetches only the missing span", async () => {
    const log: Array<[number, number]> = [];
    await fetchHtfInterval(KEY, 50 * H, 100 * H, H, spanLoader(log));
    log.length = 0;
    await fetchHtfInterval(KEY, 20 * H, 90 * H, H, spanLoader(log));
    expect(log.length).toBe(1);
    expect(log[0][1]).toBeLessThanOrEqual(50 * H); // only the gap left of 50H
  });

  it("a disjoint ask replaces the entry (rebase)", async () => {
    const log: Array<[number, number]> = [];
    await fetchHtfInterval(KEY, 90 * H, 100 * H, H, spanLoader(log));
    log.length = 0;
    const r = await fetchHtfInterval(KEY, 0, 10 * H, H, spanLoader(log));
    expect(log).toEqual([[0, 10 * H]]);
    expect(r.bars.every((b) => b.timestamp <= 10 * H)).toBe(true);
  });

  it("a failed span returns partial with failed=true and stays retryable", async () => {
    const log: Array<[number, number]> = [];
    const r1 = await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log, 1));
    expect(r1.failed).toBe(true);
    const r2 = await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    expect(r2.failed).toBe(false);
    expect(r2.bars[0].timestamp).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/lib/htfBarCache.test.ts`.
- [ ] **Step 3: Implement** the store. Entry shape `{ fromMs: number; toMs: number; bars: KLineData[]; at: number }`; per-key promise chain `chains = new Map<string, Promise<unknown>>()` serializing all work for a key (`const run = chains.get(key)?.then(work, work) ?? work(); chains.set(key, run.catch(() => {}))`). Merge helper:

```ts
function mergeBars(a: KLineData[], b: KLineData[]): KLineData[] {
  const by = new Map<number, KLineData>();
  for (const x of a) by.set(x.timestamp, x);
  for (const x of b) by.set(x.timestamp, x); // newer fetch wins
  return [...by.values()].sort((x, y) => x.timestamp - y.timestamp);
}
```

The stored ask (`entry.fromMs`/`entry.toMs`) extends only over spans whose load succeeded. Update `htfKey` callers later (Task 3); keep the old `fetchHtfShared`/`htfKey` exports DELETED in this task so the compiler flags every stale call site in Task 3.
- [ ] **Step 4: Run tests.** Expected: new suite PASS; `mtfCoordinator.test.ts` and app build now FAIL to compile, which is expected until Task 3. Run only `npx vitest run src/lib/htfBarCache.test.ts`.
- [ ] **Step 5: Commit** `git add frontend/src/lib/htfBarCache.ts frontend/src/lib/htfBarCache.test.ts && git commit -m "feat(chart): interval-aware HTF bar cache with missing-span fetch"`

---

### Task 3: Interval stash contract in the MTF coordinator

**Files:**
- Modify: `frontend/src/lib/mtf.ts` (add `coveredToMs` to `MtfSeriesBase`, next to `coveredFromMs` at line ~65)
- Modify: `frontend/src/lib/mtfCoordinator.ts` (fetchHtfBars, apply*, covered(), refreshMtfIndicators, docked gating, viewport reader)
- Test: `frontend/src/lib/mtfCoordinator.test.ts`

**Interfaces:**
- Consumes: `fetchHtfInterval`, `htfIntervalKey`, `fetchSpanParallel` from Tasks 1-2.
- Produces (used by Task 4's call sites):

```ts
export interface NeededInterval { fromMs: number; toMs: number }
export function setViewportReader(chart: Chart, read: (() => NeededInterval) | null): void;
export function refreshMtfIndicators(chart: Chart, epic: string, brokerId?: string, needed?: NeededInterval): Promise<void>;
// resolveAskInterval is exported for tests:
export function resolveAskInterval(
  prev: { coveredFromMs?: number; coveredToMs?: number; htfStarts?: number[]; htfMs?: number } | undefined,
  needed: NeededInterval,
  htfMs: number,
): NeededInterval;
```

Core changes:

1. **`MtfSeriesBase.coveredToMs?: number`** in `mtf.ts`, doc mirroring `coveredFromMs`: "How far right the last successful walk asked. Absent on pre-field stashes, which alignment treats as reaching the live edge (the only shape that could have been written)."

2. **`resolveAskInterval(prev, needed, htfMs)`** (pure): previous interval is `[prev.coveredFromMs ?? prev.htfStarts?.[0], prev.coveredToMs ?? lastStart + htfMs]`; no previous interval returns `needed`; overlapping or touching (gap <= one `htfMs` bucket) returns the union; disjoint returns `needed` (rebase). This is the spec's rebase rule; the REBASE_FACTOR clause collapses into "disjoint means rebase" because `needed` always carries a screenful margin. Amend the spec accordingly (Step 8).

3. **`fetchHtfBars`** signature becomes `(chart, epic, timeframe, warmupBars, brokerId, needed: NeededInterval, prev: MtfSeriesBase | undefined)`; body:
   - `fromMs = htfCoverageStartMs(needed.fromMs, htfMs, warmupBars)`; `toMs = Math.min(needed.toMs, Date.now())`.
   - `ask = resolveAskInterval(prev, { fromMs, toMs }, htfMs)`.
   - `key = htfIntervalKey({ brokerId, epic, timeframe, priceSide: side })`.
   - `loadSpan` wraps `fetchSpanParallel` with `resSec: htfSec || 3600, pageBars: HTF_PAGE_BARS, maxWindows: HTF_MAX_PAGES, concurrency: 6, fetchWindow: (f, t) => fetchRangeStrict(epic, timeframe, f, t, side, brokerId)`.
   - result: `{ htf: clampHtfBars(res.bars, cursorMs, htfMs), htfMs, failed: res.failed, askFromMs: res.askFromMs, askToMs: res.askToMs }`.
   - Delete `HTF_MAX_EMPTY` and the `pageHistoryBack` import if now unused.

4. **Every `apply*Timeframe`** passes `needed` + previous stash through, and stamps on success both ends: `...(!failed ? { coveredFromMs: askFromMs, coveredToMs: askToMs } : {})`. The `oldestChartMs?: number` parameter is REPLACED by `needed: NeededInterval` in all six apply functions and their recursive retry closures.

5. **Docked gating.** `const docked = (askToMs: number, chart: Chart): boolean => { const d = chart.getDataList(); const newest = d.length ? d[d.length - 1].timestamp : 0; return !newest || askToMs >= newest; }`. `prepFormingBars` is only invoked when `docked(...)`; when detached, `waitClose === false` stashes get NO forming fold and NO `htfClosed`/`htfSeed` extras (plain closed-bar shape). `refreshFormingBar` returns early per indicator when `mtf.coveredToMs != null && !docked(mtf.coveredToMs, chart)`. The trendlines closed-cut filter `b.timestamp + htfMs <= newestMs` keeps `newestMs` as the chart's newest bar (a detached interval's bars are all older, so all pass, correct).

6. **`covered()` guard** in `refreshMtfIndicatorsUncoalesced` takes the needed interval and checks both ends:

```ts
const covered = (warmup: number): boolean => {
  if (!stashed?.htfStarts?.length || !stashed.htfMs) return false;
  const start = htfCoverageStartMs(needed.fromMs, stashed.htfMs, warmup);
  const leftOk =
    stashed.htfStarts[0] <= start ||
    (stashed.coveredFromMs != null && stashed.coveredFromMs <= start);
  const lastStart = stashed.htfStarts[stashed.htfStarts.length - 1];
  const rightAsk = stashed.coveredToMs ?? lastStart + stashed.htfMs;
  const rightOk = rightAsk >= Math.min(needed.toMs, Date.now()) - stashed.htfMs;
  return leftOk && rightOk;
};
```

7. **`refreshMtfIndicators(chart, epic, brokerId?, needed?)`**: when `needed` is absent, derive it from the registered viewport reader; when no reader is registered (tests, safety), fall back to the full loaded span `[getDataList()[0].timestamp, Date.now()]`, which is today's behavior. Coalescing key becomes `${epic}|${brokerId ?? ""}|${needed.fromMs}|${needed.toMs}`. `setViewportReader` is a WeakMap in the same idiom as `chartIntervals`.

- [ ] **Step 1: Write failing tests** in `mtfCoordinator.test.ts` (the file's harness already mocks `klinecharts`, `../theme`, `./feed`; follow its existing fixture style, e.g. the `applyTrendlinesTimeframe` describe at line 339):
  - `resolveAskInterval`: no prev returns needed; overlapping unions; disjoint rebases; prev derived from `htfStarts`+`htfMs` when stamps absent.
  - apply stamps both `coveredFromMs` and `coveredToMs` on success, neither on failure.
  - `covered()` behavior via `refreshMtfIndicators`: a stash covering the needed interval on both ends triggers no fetch; short on the right (stale `coveredToMs` after scrolling toward present) triggers one; `coveredFromMs <= start` with short bars stays terminal (port the existing OIL_CRUDE regression case to the interval form).
  - rebase: needed disjoint from stashed interval results in an ask equal to needed (assert via the mocked `fetchRangeStrict` windows).
  - detached stash: `refreshFormingBar` leaves a `waitClose:false` stash with `coveredToMs` far behind the newest chart bar untouched.
  - viewport fallback: no reader registered, `refreshMtfIndicators` with no `needed` behaves like today (covers loaded span).
- [ ] **Step 2: Run to verify failures.** `npx vitest run src/lib/mtfCoordinator.test.ts`.
- [ ] **Step 3: Implement** items 1-7. Update existing tests that passed `oldestChartMs` to pass `needed` intervals instead; preserve every regression's intent (the freeze fix cases especially).
- [ ] **Step 4: Run the coordinator + cache + paging suites.** `npx vitest run src/lib/mtfCoordinator.test.ts src/lib/htfBarCache.test.ts src/lib/historyPaging.test.ts`. Expected: PASS. Also `npx tsc -b --noEmit` inside `frontend/` now only fails in files owned by Task 4 (ChartCore, hooks); list them, confirm no others.
- [ ] **Step 5: Commit** `git add frontend/src/lib/mtf.ts frontend/src/lib/mtfCoordinator.ts frontend/src/lib/mtfCoordinator.test.ts && git commit -m "feat(chart): two-ended viewport-driven MTF coverage interval"`

---

### Task 4: Trigger rewiring in ChartCore and hooks

**Files:**
- Modify: `frontend/src/ChartCore.tsx` (extendMtfCoverage at :536, call at :655, :3204; new subscription effect near the :4460 subscribe block)
- Modify: `frontend/src/chart/useRangeNavigation.ts` (:53, :154, :283, :404)
- Modify: `frontend/src/chart/useLiveMarketData.ts` (:976, :1238)
- Modify: `frontend/src/chart/useReplay.ts` (:1480)
- Modify: `frontend/src/lib/useRuleClipboard.ts` (:70, signature only if needed)
- Test: `frontend/src/chart/useRangeNavigation.test.ts` (existing cases referencing extendMtfCoverage)

**Interfaces:**
- Consumes: `setViewportReader`, `refreshMtfIndicators(chart, epic, broker, needed?)`, `NeededInterval` from Task 3.
- Produces: `extendMtfCoverage()` keeps its name but loses its parameter: it now derives `needed` from the viewport and calls `refreshMtfIndicators`. All call sites drop their arguments.

Changes:

1. **Viewport reader registration** in the chart-init effect (where the chart is created) and cleanup on dispose:

```ts
setViewportReader(chart, () => {
  const dl = chart.getDataList();
  const vr = chart.getVisibleRange();
  const from = dl[Math.max(0, Math.min(vr.from, dl.length - 1))]?.timestamp;
  const to = dl[Math.max(0, Math.min(vr.to - 1, dl.length - 1))]?.timestamp;
  const intervalMs = declaredIntervalMs(period.resolution) ?? 60_000;
  const screenMs = Math.max(1, vr.to - vr.from) * intervalMs;
  const now = Date.now();
  return {
    fromMs: (from ?? now) - screenMs,
    toMs: Math.min((to ?? now) + screenMs, now),
  };
});
```

Read `period.resolution` through the existing `resRef` so the closure never staleness-captures. On dispose: `setViewportReader(chart, null)`.

2. **`extendMtfCoverage`** becomes parameterless: `if (chart) void refreshMtfIndicators(chart, epicRef.current, brokerIdRef.current);` (the coordinator derives `needed` from the reader). Delete the `explicitOldestMs` plumbing: ChartCore :3204 becomes `extendMtfCoverage()`, useRangeNavigation :283/:404 unchanged calls but the prop type at :53 becomes `() => void`.

3. **Debounced visible-range subscription**, its own effect next to the :4460 block:

```ts
useEffect(() => {
  const chart = chartRef.current;
  if (!chart) return;
  let t: ReturnType<typeof setTimeout> | null = null;
  const onRange = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      extendMtfCoverage();
      stampTrendlinesFloors(chart); // Task 6; add in that task, not here
    }, 200);
  };
  chart.subscribeAction("onVisibleRangeChange", onRange);
  return () => {
    if (t) clearTimeout(t);
    chart.unsubscribeAction("onVisibleRangeChange", onRange);
  };
}, [/* chart identity effect deps used by the sibling subscription effects */]);
```

`onVisibleRangeChange` fires on programmatic moves too (see GoLivePill's comment), so jump landings, quick-range fits, and timeframe restores all trigger coverage with no extra call sites. The per-coordinator `covered()` guard plus the coalescing key make repeat settles cheap.

4. **useLiveMarketData** :976 and :1238 call `refreshMtfIndicators(chart, epic, brokerId)` with no interval (viewport-derived), unchanged in shape.

5. **useReplay eager pre-cover** at the :1480 call: pass an explicit interval so replay coverage reaches the live edge once, up front:

```ts
void refreshMtfIndicators(chart, latest.current.epic, latest.current.brokerId, {
  fromMs: replayStartMs,       // the cursor's starting timestamp, already in scope at this call
  toMs: Date.now(),
});
```

Inspect the surrounding code for the actual variable carrying the replay start; the existing comment block at :1443 describes the load-effect interplay, keep its contract.

6. **useRuleClipboard** :70 stays `refreshMtfIndicators(controller.chart, epic, brokerId)`, now viewport-scoped for free.

- [ ] **Step 1: Update the failing type sites** flagged by `tsc` in Task 3 Step 4, applying changes 1-6 (no new unit test file; this task is wiring).
- [ ] **Step 2: Fix `useRangeNavigation.test.ts`** expectations (the mock `extendMtfCoverage` becomes zero-arg).
- [ ] **Step 3: Typecheck + full frontend suite.** `npx tsc -b --noEmit && npx vitest run`. Expected: PASS.
- [ ] **Step 4: Commit** `git add frontend/src/ChartCore.tsx frontend/src/chart/useRangeNavigation.ts frontend/src/chart/useRangeNavigation.test.ts frontend/src/chart/useLiveMarketData.ts frontend/src/chart/useReplay.ts frontend/src/lib/useRuleClipboard.ts && git commit -m "feat(chart): visible-range trigger replaces history-grew MTF coverage"`

---

### Task 5: Trendlines compute floor (state layer)

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (`TlState`, `buildTlState` :444, `tlAtrAt` :888, `computeTrendlines` :463)
- Test: `frontend/src/lib/indicators/trendlines.test.ts`

**Interfaces:**
- Produces: `buildTlState(dataList, m, cfg, startIdx = 0)` and `TlState.startIdx: number`. `computeTrendlines` keeps its exact signature and behavior (calls with `startIdx` 0), so parity goldens are untouched.

Changes:
- `TlState` gains `startIdx: number` (0 for the full run).
- `buildTlState(dataList, m, cfg, startIdx = 0)`: `highs`/`lows` stay full-length over the prefix (cheap maps, and `stepTrendlinesBar` reads them below `startIdx` for pivot lookbacks); `atr` is full-length with `null` below the windowed warmup: compute `atrSeries(prefix.slice(startIdx), TL_ATR_LEN)` and copy into positions `startIdx..m-1`; `points` rows below `startIdx` are `{}`; the step loop runs `for (let i = startIdx; i < m; i++)`.
- `tlAtrAt` becomes startIdx-aware: signature `tlAtrAt(atr, dataList, j, startIdx)`; `if (j < startIdx + TL_ATR_LEN - 1) return null;` and the from-scratch seed slices `dataList.slice(startIdx, j + 1)`. `advanceTlBar` passes `st.startIdx` through.
- Confirm `stepTrendlinesBar`'s use of `atr[i]` already null-guards (the file says warm-up bars are null at runtime); if any code path multiplies a null ATR, guard it the same way the warmup bars are handled at index 0.

- [ ] **Step 1: Write failing tests** in `trendlines.test.ts`:

```ts
describe("windowed buildTlState", () => {
  // Use an existing fixture series from this file (there are synthetic OHLC
  // builders already; reuse the one the break/touch cases use, >= 300 bars).
  it("windowed state equals the full-span state over bars the window fully warmed", () => {
    const cfg = parseTrendlinesConfig([]); // defaults
    const full = computeTrendlines(bars, cfg);
    const startIdx = 100;
    const st = buildTlState(bars, bars.length, cfg, startIdx);
    // Any line whose every anchor and touch is >= startIdx + warmup must exist
    // in both runs with identical geometry.
    const warm = startIdx + TL_ATR_LEN + 2 * cfg.pivotLen;
    const fullLate = full.lines.filter((l) => Math.min(l.i1, l.i2) >= warm);
    for (const l of fullLate) {
      const twin = st.lines.find((w) => w.i1 === l.i1 && w.i2 === l.i2 && w.side === l.side);
      expect(twin).toBeTruthy();
    }
    // Point rows below the floor are empty; at/after warm they match.
    expect(st.points[startIdx - 1]).toEqual({});
  });

  it("startIdx 0 is byte-identical to computeTrendlines", () => {
    const cfg = parseTrendlinesConfig([]);
    const full = computeTrendlines(bars, cfg);
    const st = buildTlState(bars, bars.length, cfg, 0);
    expect(st.lines).toEqual(full.lines);
    expect(st.points).toEqual(full.points);
  });
});
```

Adjust field names (`i1`/`i2`/`side`) to the actual `TrendLine` shape in `trendlinesOutputs.ts` when writing the test; read the type first.
- [ ] **Step 2: Run to verify failure** (`buildTlState` not exported / no 4th param). Export `buildTlState` for tests if it is currently module-private.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `npx vitest run src/lib/indicators/trendlines.test.ts src/lib/indicatorParityGolden.test.ts src/lib/indicators/trendlinesDxy.test.ts`. Expected: PASS, goldens untouched.
- [ ] **Step 5: Commit** `git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts && git commit -m "feat(trendlines): windowed detector state behind a compute floor"`

---

### Task 6: Trendlines session floor + calc wiring + floor stamping

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (`createTrendlinesSession` :948, `TrendlinesExtend`, `TRENDLINES_TEMPLATE`'s calc)
- Modify: `frontend/src/lib/mtfCoordinator.ts` (add `stampTrendlinesFloors`)
- Modify: `frontend/src/ChartCore.tsx` (call `stampTrendlinesFloors` from the Task 4 subscription)
- Test: `frontend/src/lib/indicators/trendlines.test.ts`, `frontend/src/lib/mtfCoordinator.test.ts`

**Interfaces:**
- Produces:
  - `TrendlinesExtend.tlFloorTs?: number` (session-only; never persisted, same lifecycle as the mtf series fields).
  - `TrendlinesSession.compute(dataList, cfg, floorTs?: number)`.
  - `export function stampTrendlinesFloors(chart: Chart): void` in `mtfCoordinator.ts`.

Changes:

1. **Session floor.** `createTrendlinesSession` tracks `floorIdx: number` (derived: first index with `dataList[i].timestamp >= floorTs`, 0 when `floorTs` undefined; binary search, the list is ascending). The `usable` check additionally requires `floorIdx === lastFloorIdx`. A floor change in EITHER direction rebuilds: `base = buildTlState(dataList, n - 1, cfg, floorIdx)`. Everything else (fork, per-tick advance) is unchanged.

2. **Calc wiring.** In `TRENDLINES_TEMPLATE`'s calc (find it in `trendlines.ts`; it parses calcParams and calls the session), read `const floorTs = (indicator.extendData as TrendlinesExtend | undefined)?.tlFloorTs;` and pass it to `session.compute(dataList, cfg, floorTs)`. The MTF branch (stash present) is untouched.

3. **Floor stamping** in `mtfCoordinator.ts` (it already owns `overrideExtend`, `getIndicatorsByPane`, `indTypeOf`, and the viewport reader):

```ts
const FLOOR_REBASE_SCREENS = 4;
export function stampTrendlinesFloors(chart: Chart): void {
  const read = viewportReaders.get(chart);
  const byPane = getIndicatorsByPane(chart);
  if (!read || !byPane) return;
  const view = read();
  const chartMs = chartIntervalOf(chart) ?? 60_000;
  byPane.forEach((nameMap, paneId) => {
    nameMap.forEach((indUnknown, id) => {
      const ind = indUnknown as { calcParams?: unknown[]; extendData?: TrendlinesExtend & { mtf?: MtfSeriesBase } };
      if (indTypeOf({ name: id, extendData: ind.extendData }) !== "TRENDLINES") return;
      if (ind.extendData?.mtf?.timeframe) return; // pinned instances use the stash path
      const cfg = parseTrendlinesConfig(ind.calcParams);
      const wantedFloor = view.fromMs - tlWarmup(cfg) * chartMs;
      const cur = ind.extendData?.tlFloorTs;
      const screenMs = Math.max(1, view.toMs - view.fromMs);
      const move =
        cur == null ||
        wantedFloor < cur ||                                  // view moved left past the floor: extend
        wantedFloor > cur + FLOOR_REBASE_SCREENS * screenMs;   // jumped far right: rebase, drop deep-history cost
      if (!move) return;
      overrideExtend(chart, paneId, id, { ...(ind.extendData ?? {}), tlFloorTs: wantedFloor }, ind.calcParams ?? []);
    });
  });
}
```

`viewportReaders` is the WeakMap Task 3 created for `setViewportReader`. `tlWarmup` already exists at :864. Reuse the view interval as stamped (it already carries the one-screenful margin).

4. **ChartCore** adds `stampTrendlinesFloors(chart)` inside the Task 4 debounced settle (the placeholder comment left there).

- [ ] **Step 1: Write failing tests.**
  - Session: `compute(bars, cfg, floorTs)` returns empty point rows below the floor and identical rows to the unfloored session for bars past the warmup; lowering `floorTs` rebuilds (assert by comparing line sets before/after); same `floorTs` across ticks keeps the incremental path (mutate the last bar in place, recompute, assert prefix row identity `result1.points[i] === result2.points[i]` for closed i, which is the session's documented sharing contract).
  - `stampTrendlinesFloors` (in `mtfCoordinator.test.ts`, using its existing chart/indicator mocks): stamps a floor on a chart-TF trendlines instance; does not touch a pinned instance; does not re-stamp when the view wobbles within the hysteresis band; rebase-stamps right after a far-right jump.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** changes 1-4.
- [ ] **Step 4: Run** `npx vitest run src/lib/indicators/trendlines.test.ts src/lib/mtfCoordinator.test.ts src/lib/indicatorParityGolden.test.ts && npx tsc -b --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/mtfCoordinator.ts frontend/src/lib/indicators/trendlines.test.ts frontend/src/lib/mtfCoordinator.test.ts frontend/src/ChartCore.tsx && git commit -m "feat(trendlines): viewport compute floor for chart-timeframe instances"`

---

### Task 7: Full verification + spec amendment

**Files:**
- Modify: `docs/superpowers/specs/2026-09-09-viewport-scoped-indicator-coverage-design.md` (rebase rule wording)

- [ ] **Step 1: Full frontend suite + typecheck.** `cd frontend && npx tsc -b --noEmit && npx vitest run`. Expected: all PASS. Fix anything that fails before proceeding; do not skip tests.
- [ ] **Step 2: Amend the spec**: replace the `REBASE_FACTOR` sentence with "Rebase when the needed interval (which always carries a one-screenful margin) is disjoint from the covered interval by more than one HTF bucket; overlapping or touching intervals union." Add `tlFloorTs` and the `FLOOR_REBASE_SCREENS = 4` right-rebase rule to the chart-TF section.
- [ ] **Step 3: Manual acceptance** (requires the app running; if no browser session is available, note it as pending user verification): OIL_CRUDE HOUR, mixed pinned + chart-TF Trendlines, click a 2019 preset match; indicator work should land well under a second; scroll left streams coverage; return to live re-docks without a stall; replay on a pinned cell still shows no lookahead.
- [ ] **Step 4: Commit** `git add docs/superpowers/specs/2026-09-09-viewport-scoped-indicator-coverage-design.md && git commit -m "docs(specs): align rebase and floor rules with implementation"`
