# Trendlines Rebuild Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a history load, run at most one Trendlines rebuild per instance, always behind the busy spinner, while ticks and appends stay synchronous.

**Architecture:** All changes live in the calc path of `frontend/src/lib/indicators/trendlines.ts`. Deferral is decided by the kind of calc (incremental vs rebuild) instead of the rebuilt span. The deferred chain waits on a per-instance settle deadline that each rebuild-kind calc pushes out by 250 ms, capped at 1000 ms from the first one, so a prepend plus the floor stamp after it (and a burst of prepends) collapse into one compute.

**Tech Stack:** TypeScript, klinecharts v10 (async `calc`), vitest (node environment, fake timers).

**Spec:** `docs/superpowers/specs/2026-09-29-trendlines-rebuild-coalescing-design.md`

## Global Constraints

- `TL_SETTLE_MS` = 250 (just over the 200 ms viewport-pass debounce in `ChartCore.tsx`).
- `TL_DEFER_MIN_BARS` = 500: a rebuild on a shorter list runs inline.
- `TL_DEFER_BARS` (2000) is removed.
- Incremental calcs (same list object, same config, same floor, bars only appended) stay synchronous when nothing is pending.
- The settle wait uses `setTimeout`, never rAF.
- No em dashes in comments or UI text.
- Run only the affected test files, never the full frontend suite. Batch test and `tsc -b` runs into one ask; the user works on the same laptop.
- Commit to `main` (no new branch), staging files by explicit path.

## Review Focus

1. **Live ticks during the settle window.** A tick every 100 ms must not keep pushing the deadline out. Only rebuild-kind calcs bump it. Pinned in Task 1 ("ticks do not starve the rebuild").
2. **A continuous drag that prepends every 100 ms.** The window must not slide forever. The 1000 ms cap forces a compute. Pinned in Task 1 ("a prepend burst is capped").
3. **A tick that lands on a stale session while a rebuild is pending.** The session has not seen the newest list yet, so `rebuildSpan` is wrong mid-chain. The pending-path classification uses the last calc's inputs instead. Pinned in Task 1 ("prepend then tick computes once from the newest list").
4. **Short charts.** A 400-bar first load must still paint inline with no spinner flicker. Pinned in Task 1.
5. **Existing callers that expected sync rows** on 500 bars or more (`trendlinesDebugDraw.test.ts` at 900 bars). They must await calc. Fixed in Task 1, step 6.

---

### Task 1: Kind-based defer plus settle window

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (constants near line 3745 to 3755; `TRENDLINES_TEMPLATE.calc` near lines 3800 to 3850)
- Test: `frontend/src/lib/indicators/trendlines.incremental.test.ts`
- Modify test: `frontend/src/lib/indicators/trendlinesDebugDraw.test.ts:177-190`

**Interfaces:**
- Consumes: `markIndicatorBusy`, `clearIndicatorBusy`, `afterNextPaint` from `../indicatorBusy` (already imported); `createTrendlinesSession().rebuildSpan(dataList, cfg, floorTs): number`; `sessionRows(session, dataList, ind)`; `parseTrendlinesConfig`.
- Produces: no new exports. Module-private `TL_SETTLE_MS`, `TL_SETTLE_MAX_MS`, `TL_DEFER_MIN_BARS`, `TL_SETTLE`, `TL_LAST_IN`, `bumpSettle(ind)`, `waitSettled(ind)`.

- [ ] **Step 1: Write the failing tests**

Add `vi`, `afterEach` and `beforeEach` to the vitest import at the top of `trendlines.incremental.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

Append this `describe` block at the end of the file. It reuses the file's own `synthBars`, `lcg`, `tick`, `cfg` and `computeTrendlines`:

```ts
describe("TRENDLINES_TEMPLATE.calc rebuild coalescing", () => {
  type Rows = TrendlinesCalcPoint[];
  const calc = TRENDLINES_TEMPLATE.calc as (
    d: KLineData[],
    i: Indicator,
  ) => Rows | Promise<Rows>;
  const mkInd = () =>
    ({ calcParams: [], extendData: undefined, result: [] }) as unknown as Indicator;
  // A prepend: klinecharts builds a NEW list with older bars in front.
  const prepended = (bars: KLineData[], k: number): KLineData[] => {
    const older = synthBars(k, 11).map((b, j) => ({
      ...b,
      timestamp: bars[0].timestamp - (k - j) * 60_000,
    }));
    return [...older, ...bars];
  };
  const settled = (p: Promise<Rows>) => {
    const s = { done: false, rows: null as Rows | null };
    p.then((r) => {
      s.done = true;
      s.rows = r;
    });
    return s;
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a 400-bar first compute runs inline with no busy mark", () => {
    const ind = mkInd();
    const out = calc(synthBars(400), ind);
    expect(out).not.toBeInstanceOf(Promise);
    expect(isIndicatorBusy(ind)).toBe(false);
  });

  it("a 600-bar rebuild is deferred behind the busy mark and the settle window", async () => {
    const ind = mkInd();
    const bars = synthBars(600);
    const out = calc(bars, ind);
    expect(out).toBeInstanceOf(Promise);
    expect(isIndicatorBusy(ind)).toBe(true);
    const s = settled(out as Promise<Rows>);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.done).toBe(true);
    expect(isIndicatorBusy(ind)).toBe(false);
    const ref = computeTrendlines(bars, cfg);
    expect(s.rows![s.rows!.length - 1].lines).toEqual(ref.lines);
  });

  it("an append-only calc on a big built list stays inline", async () => {
    const ind = mkInd();
    const bars = synthBars(2500);
    const first = calc(bars, ind);
    await vi.advanceTimersByTimeAsync(300);
    await first;
    tick(bars, lcg(3));
    expect(calc(bars, ind)).not.toBeInstanceOf(Promise);
    expect(isIndicatorBusy(ind)).toBe(false);
  });

  it("a prepend then a floor stamp 200 ms later compute once, from the newest inputs", async () => {
    const ind = mkInd();
    const bars = synthBars(1500);
    const built = calc(bars, ind);
    await vi.advanceTimersByTimeAsync(300);
    await built;
    const more = prepended(bars, 300);
    const p1 = settled(calc(more, ind) as Promise<Rows>);
    await vi.advanceTimersByTimeAsync(200);
    (ind as { extendData: unknown }).extendData = { tlFloorTs: more[100].timestamp };
    const p2 = settled(calc(more, ind) as Promise<Rows>);
    // 250 ms after the FIRST calc: still waiting, because the second pushed the window.
    await vi.advanceTimersByTimeAsync(100);
    expect(p1.done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(p1.done && p2.done).toBe(true);
    // The older link did not compute: it handed back the current (blanked) rows.
    expect(p1.rows).toBe(ind.result);
    expect(p2.rows!.length).toBe(more.length);
  });

  it("prepend then tick computes once from the newest list", async () => {
    const ind = mkInd();
    const bars = synthBars(1500);
    const built = calc(bars, ind);
    await vi.advanceTimersByTimeAsync(300);
    await built;
    const more = prepended(bars, 300);
    const p1 = settled(calc(more, ind) as Promise<Rows>);
    tick(more, lcg(9));
    const p2 = settled(calc(more, ind) as Promise<Rows>);
    await vi.advanceTimersByTimeAsync(300);
    expect(p1.rows).toBe(ind.result);
    const ref = computeTrendlines(more, cfg);
    expect(p2.rows![p2.rows!.length - 1].lines).toEqual(ref.lines);
  });

  it("ticks do not starve the rebuild", async () => {
    const ind = mkInd();
    const bars = synthBars(1500);
    const p = settled(calc(bars, ind) as Promise<Rows>);
    const rand = lcg(4);
    for (let t = 0; t < 3; t++) {
      await vi.advanceTimersByTimeAsync(100);
      tick(bars, rand);
      void calc(bars, ind);
    }
    // 300 ms in: the ticks did not push the 250 ms window.
    expect(p.done).toBe(true);
  });

  it("a prepend burst is capped at TL_SETTLE_MAX_MS", async () => {
    const ind = mkInd();
    let bars = synthBars(1500);
    const first = settled(calc(bars, ind) as Promise<Rows>);
    for (let t = 0; t < 12 && !first.done; t++) {
      await vi.advanceTimersByTimeAsync(100);
      bars = prepended(bars, 50);
      void calc(bars, ind);
    }
    // Prepends every 100 ms would slide a pure 250 ms window forever.
    expect(first.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.incremental.test.ts`
Expected: FAIL. "a 600-bar rebuild is deferred" fails at `toBeInstanceOf(Promise)` (600 is under today's 2000-bar threshold), and the window and cap tests fail on their `done` checks.

- [ ] **Step 3: Replace the defer constant and add the settle state**

In `trendlines.ts`, replace:

```ts
/** A rebuild over fewer bars than this runs inline: it is quick enough that a
 * busy mark would only flicker. */
const TL_DEFER_BARS = 2000;
```

with:

```ts
/** A rebuild on a list shorter than this runs inline: it is quick enough that
 * a busy mark would only flicker. Measured on a 10k-bar list, a rebuild the
 * floor held under 2000 bars still froze for 301 ms, so the list length, not
 * the rebuilt span, decides. */
const TL_DEFER_MIN_BARS = 500;
/** A deferred rebuild waits until this long has passed with no newer rebuild
 * for the instance. Just over ChartCore's 200 ms viewport-pass debounce, so a
 * prepend and the floor stamp that follows it land in one compute. */
const TL_SETTLE_MS = 250;
/** ...but never longer than this after the first one, so a drag that prepends
 * every 100 ms still gets its lines. */
const TL_SETTLE_MAX_MS = 1000;
// Per instance: the settle deadline, and the inputs of the last calc (a
// pending chain cannot ask the session, which has not seen the newest list).
const TL_SETTLE = new WeakMap<Indicator, { until: number; hardUntil: number }>();
const TL_LAST_IN = new WeakMap<
  Indicator,
  { list: KLineData[]; key: string; floorTs: number | undefined }
>();

function bumpSettle(ind: Indicator): void {
  const now = Date.now();
  const w = TL_SETTLE.get(ind);
  TL_SETTLE.set(ind, {
    until: now + TL_SETTLE_MS,
    hardUntil: w ? w.hardUntil : now + TL_SETTLE_MAX_MS,
  });
}

/** Resolves once the instance's deadline has passed. setTimeout, not rAF: a
 * hidden tab throttles timers but still converges. */
function waitSettled(ind: Indicator): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const w = TL_SETTLE.get(ind);
      if (!w) return resolve();
      const wait = Math.min(w.until, w.hardUntil) - Date.now();
      if (wait <= 0) return resolve();
      setTimeout(check, wait);
    };
    check();
  });
}
```

- [ ] **Step 4: Rewrite the defer branch of `calc`**

In `TRENDLINES_TEMPLATE.calc`, replace everything from `const floorTs = ext?.tlFloorTs;` through `return run;` with:

```ts
    const floorTs = ext?.tlFloorTs;
    const cfg = parseTrendlinesConfig(ind.calcParams, ext);
    const key = JSON.stringify(cfg);
    const last = TL_LAST_IN.get(ind);
    TL_LAST_IN.set(ind, { list: dataList, key, floorTs });
    const pending = TL_PENDING.get(ind);
    if (!pending) {
      if (s.rebuildSpan(dataList, cfg, floorTs) === 0 || dataList.length < TL_DEFER_MIN_BARS)
        return sessionRows(s, dataList, ind);
      bumpSettle(ind);
    } else if (
      !last ||
      last.list !== dataList ||
      last.key !== key ||
      last.floorTs !== floorTs
    ) {
      // A rebuild landing on a pending chain pushes the window. A tick (same
      // list, appended in place) does not, or a live feed would starve it.
      bumpSettle(ind);
    }
    // A REBUILD (a prepend, a floor move, a config change, a first compute on
    // a long list) runs synchronously and freezes the chart, so it goes behind
    // the legend's busy mark: mark, let the burst settle, let a frame paint,
    // then compute. klinecharts awaits calc, so a promise here is fine. Every
    // calc that lands while one is pending chains behind it, keeping results
    // in order, and only the newest in the chain computes: the rest hand back
    // the current rows, which the newest one overwrites anyway.
    const gen = (TL_GEN.get(ind) ?? 0) + 1;
    TL_GEN.set(ind, gen);
    // A prepend shifts every bar index, so the prior rows would draw their
    // lines on the wrong candles for as long as the compute takes. Blank them.
    if (TL_FIRST_TS.get(ind) !== dataList[0]?.timestamp) ind.result = [];
    markIndicatorBusy(ind);
    const run = (pending ?? Promise.resolve())
      .then(() => waitSettled(ind))
      .then(afterNextPaint)
      .then(() => {
        if (TL_GEN.get(ind) !== gen) return ind.result as TrendlinesCalcPoint[];
        TL_SETTLE.delete(ind);
        return sessionRows(s, dataList, ind);
      })
      .finally(() => {
        clearIndicatorBusy(ind);
        if (TL_PENDING.get(ind) === run) TL_PENDING.delete(ind);
      });
    TL_PENDING.set(ind, run);
    return run;
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.incremental.test.ts`
Expected: PASS, including the existing "defers a big rebuild behind the busy mark" test (real timers, so it now also waits the 250 ms window).

- [ ] **Step 6: Fix the 900-bar caller in the debug draw test**

In `trendlinesDebugDraw.test.ts`, the "paints debug when nothing is drawn" test builds a fresh indicator per `draw()`, so each 900-bar calc is now a deferred first compute. Make `draw` async and await calc:

```ts
    const draw = async () => {
      const { ctx } = recCtx();
      const result = await TRENDLINES_TEMPLATE.calc!(bars, { calcParams, extendData: ext } as never);
```

and the two call sites:

```ts
    await draw(); // starts the async run
    await vi.waitFor(() => expect(chartStub.overrideIndicator).toHaveBeenCalled());
    await draw(); // paints the landed result
```

- [ ] **Step 7: Run every file that calls the template's calc, plus the typecheck**

Ask the user once before running (high CPU), then:

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.incremental.test.ts src/lib/indicators/trendlinesDebugDraw.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlineMarks.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/mtfCoordinator.test.ts && npx tsc -b`
Expected: all PASS, `tsc -b` 0 errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.incremental.test.ts frontend/src/lib/indicators/trendlinesDebugDraw.test.ts
git commit -m "perf(trendlines): coalesce rebuilds after history loads behind a settle window"
```

---

### Task 2: Live check on a deep intraday chart

**Files:** none (verification only).

**Interfaces:**
- Consumes: the running dev app at http://localhost:5173, `window.__charts` (Map of chart id to klinecharts Chart).

- [ ] **Step 1: Pick a chart with a visible, unpinned Trendlines on 1H**

The user's US100 1H tab (`data-tab-id="tab-muee31cl-4"`) qualifies. Note the active tab first so it can be restored.

- [ ] **Step 2: Install the recorder** (Playwright `browser_evaluate`, one short call; long in-page waits hang when the window is backgrounded)

```js
() => {
  const c = [...window.__charts.values()][0];
  const P = window.__prof = { t0: performance.now(), calc: [], asyncs: [] };
  for (const ind of c.getIndicators()) {
    const orig = ind.calc;
    ind.calc = function (dl, i) {
      const t0 = performance.now(); const r = orig.call(this, dl, i);
      P.calc.push([Math.round(t0 - P.t0), ind.name, Math.round(performance.now() - t0), dl.length]);
      if (r && r.then) { const a = [Math.round(t0 - P.t0), ind.name, dl.length, null]; P.asyncs.push(a); r.then(() => { a[3] = Math.round(performance.now() - P.t0); }); }
      return r;
    };
  }
  return c.getDataList().length;
}
```

- [ ] **Step 3: Scroll left past the loaded edge once, then read `window.__prof` after about 4 s**

`c.scrollByDistance(3000)` (positive scrolls left). Expected: every TRENDLINES entry in `calc` with more than 500 bars shows 0 ms sync, the rows for one history burst resolve from a single async link, and no Trendlines sync entry exceeds 20 ms.

- [ ] **Step 4: Restore the view**

Click the previously active tab, then `location.reload()` to drop the wrappers and the extra history.
