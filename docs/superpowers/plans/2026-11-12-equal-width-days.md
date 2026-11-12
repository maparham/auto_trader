# Equal-width Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global, off-by-default setting that draws intraday charts with every UTC day the same width (one slot per chart period, missing periods left as gaps), display-only, so a Trendlines line pinned to 1D comes out straight.

**Architecture:** The app builds a slot grid (candle index to display position) from the candle timestamps. A small klinecharts store patch asks a global provider for that grid and does its index/x math in positions; with no provider it is unchanged. The setting installs or removes the provider and relays out every chart. The Trendlines step map takes the grid so a coarser pin's spans are whole days in slot units.

**Tech Stack:** TypeScript, React, klinecharts 10.0.0 (patched via patch-package), vitest.

**Spec:** docs/superpowers/specs/2026-11-12-equal-width-days-design.md

**Spike (reference only, do not merge):** worktree `../auto_trader-gaps`, branch `spike/gap-slots`: `docs/superpowers/spike/gap-slots-klinecharts.diff` (the store patch to start from) and `frontend/src/lib/gapSlots.ts` (the grid to start from), plus `/tmp/ghost-spike/shot.py`-style headless screenshots.

## Global Constraints

- Off means today's chart, pixel for pixel: with no provider every position equals the data index.
- Display-only: the candle list passed to klinecharts is never modified.
- Drawings, indicators, chart-timeframe trendlines, alert lines and picked-line clones get no code changes (spec Non-goals).
- A day is a UTC calendar day (`floor(t / 86_400_000)`); only days holding candles get room.
- Slots per day run from the earliest to the latest time-of-day offset seen in the loaded candles, one chart period each.
- The provider returns null for a chart whose period is one day or longer.
- Nothing in a klinecharts draw or layout path may throw (a throw silently kills later layouts): the patch wraps every provider call and falls back to identity.
- UI copy: no em dashes; tips via the shared `InfoTip`/`Tooltip`, short lines.
- Commit to the current branch by explicit path; never run the full frontend suite; `npx tsc -b` and eslint on touched files.

## Review Focus

1. Loading older history widens or keeps the grid: when slots per day are unchanged, every existing candle's position shifts by the same constant, so the patched store keeps the view steady. Test in Task 1.
2. Two candles in one slot (DST fall-back, irregular stamps) must still get strictly increasing positions, or idxOf divides by zero. Test in Task 1.
3. A one-candle or empty list, and a daily chart, get no grid (identity), never a throw. Test in Task 1.
4. A live candle opening a new slot or a new day changes the grid: the cache must key on length and first/last timestamp, not the list identity alone. Test in Task 1.
5. A provider that throws must leave the chart on identity. Test in Task 2 (the provider wrapper).

---

### Task 1: The slot grid

**Files:**
- Create: `frontend/src/lib/equalWidthDays.ts`
- Test: `frontend/src/lib/equalWidthDays.test.ts`

**Interfaces:**
- Produces:
  - `interface SlotGrid { readonly n: number; readonly perDay: number; readonly pos: readonly number[]; posOf(i: number): number; idxOf(p: number): number; count(): number }`. `posOf` takes a fractional index (interpolates between neighbours, extrapolates 1:1 past either end); `idxOf` is its inverse; `count()` is `pos[n-1] + 1`.
  - `buildSlotGrid(times: readonly number[]): SlotGrid | null` (null for fewer than 2 candles or a median gap of a day or more).
  - `setEqualWidthDays(on: boolean): void`: installs or removes `globalThis.__chartkarSlots`.
  - `equalWidthDaysOn(): boolean`.
  - `slotGridFor(list: readonly { timestamp: number }[]): SlotGrid | null`: the cached grid when on, else null. Cached per list, keyed on `(list, n, first timestamp, last timestamp)`.
  - The global provider is `globalThis.__chartkarSlots = (list) => slotGridFor(list)`.

- [ ] **Step 1: Write the failing tests** in `equalWidthDays.test.ts`, with hourly candles (1h step) built from a helper `day(dayOffset, hours[])` giving UTC timestamps:

```ts
it("one slot per hour from the earliest to the latest hour seen", () => {
  // Day 0 13:00..19:00, day 1 14:00..17:00 (late open, early close).
  const g = buildSlotGrid([...day(0, [13,14,15,16,17,18,19]), ...day(1, [14,15,16,17])])!;
  expect(g.perDay).toBe(7);
  expect(g.pos).toEqual([0,1,2,3,4,5,6, 8,9,10,11]);
});
it("days without candles take no room (weekend)", () => {
  const g = buildSlotGrid([...day(4, [13,14]), ...day(7, [13,14])])!; // Fri, Mon
  expect(g.pos).toEqual([0, 1, 2, 3]);
});
it("posOf and idxOf invert, across gaps and past both ends", () => {
  const g = buildSlotGrid([...day(0, [13,14,15,16,17,18,19]), ...day(1, [14,15,16,17])])!;
  for (const i of [-2, 0, 3.5, 6.5, 7, 9.25, 10, 13]) expect(g.idxOf(g.posOf(i))).toBeCloseTo(i, 9);
  expect(g.count()).toBe(12);
});
it("prepending days with the same slots shifts every position by a constant", () => {
  const later = [...day(1, [13,14,15]), ...day(2, [13,15])];
  const a = buildSlotGrid(later)!;
  const b = buildSlotGrid([...day(0, [13,14,15]), ...later])!;
  const shift = b.pos[3] - a.pos[0];
  a.pos.forEach((p, k) => expect(b.pos[k + 3] - p).toBe(shift));
});
it("two candles in one slot still get increasing positions", () => {
  const t = day(0, [13, 14]);
  const g = buildSlotGrid([t[0], t[0] + 1_800_000, t[1]])!; // 13:00, 13:30, 14:00 on a 1h median
  expect(g.pos[1]).toBeGreaterThan(g.pos[0]);
  expect(g.pos[2]).toBeGreaterThan(g.pos[1]);
});
it("no grid for one candle or a daily chart", () => {
  expect(buildSlotGrid(day(0, [13]))).toBeNull();
  expect(buildSlotGrid([0, 86_400_000, 172_800_000])).toBeNull();
});
it("slotGridFor follows the switch and a live candle", () => {
  const list = [...day(0, [13,14,15]), ...day(1, [13])].map((timestamp) => ({ timestamp }));
  setEqualWidthDays(false);
  expect(slotGridFor(list)).toBeNull();
  setEqualWidthDays(true);
  expect(slotGridFor(list)!.pos).toEqual([0, 1, 2, 3]);
  list.push({ timestamp: day(1, [15])[0] }); // same array, new last candle
  expect(slotGridFor(list)!.pos).toEqual([0, 1, 2, 3, 5]);
  setEqualWidthDays(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `equalWidthDays.ts`.** Port the spike's `buildSlots` (median gap of the last 200, UTC day, offset slots, `pos = dayNum * perDay + (off - minOff)`, bump to `pos[i-1] + 1` when not increasing) into `buildSlotGrid`, then add `posOf`/`idxOf` (binary search, linear between neighbours) as the spike patch's `_posOf`/`_idxOf` did. Header comment: what the grid is and that it is display-only.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/equalWidthDays.ts frontend/src/lib/equalWidthDays.test.ts
git commit -m "feat(chart): slot grid for equal-width days"
```

### Task 2: The klinecharts store patch

**Files:**
- Modify: `frontend/node_modules/klinecharts/dist/index.esm.js`, then regenerate `frontend/patches/klinecharts+10.0.0.patch` with `npx patch-package klinecharts` (ESM only, like the existing patch; tests and Vite both load the ESM build).
- Modify: `frontend/src/lib/equalWidthDays.ts` (the guarded provider)
- Test: `frontend/src/lib/equalWidthDays.test.ts`

**Interfaces:**
- Consumes: `globalThis.__chartkarSlots(list) -> { posOf, idxOf, count } | null` from Task 1.
- Produces: store methods `_slots()`, `_posOf(i)`, `_idxOf(p)`, `_posCount()`, `_coordinateToFloatPos(x)`; `dataIndexToCoordinate`, `coordinateToFloatIndex`, `_adjustVisibleRange`, the zoom anchor and the `'backward'` append all in positions, exactly as in the spike diff, except `_slots()` calls `globalThis.__chartkarSlots` (not `__chartkarSlotBuilder`) and uses the returned object's methods instead of its own pos array math.

- [ ] **Step 1: Write the failing test** for the provider wrapper:

```ts
it("the installed provider never throws and falls back to null", () => {
  setEqualWidthDays(true);
  const provider = (globalThis as { __chartkarSlots?: (l: unknown) => unknown }).__chartkarSlots!;
  expect(provider(null)).toBeNull();
  expect(provider([{ timestamp: NaN }, { timestamp: NaN }])).toBeNull();
  setEqualWidthDays(false);
  expect((globalThis as { __chartkarSlots?: unknown }).__chartkarSlots).toBeUndefined();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.test.ts`
Expected: FAIL (provider throws on null, or returns a grid for NaN stamps).

- [ ] **Step 3: Guard the provider** in `setEqualWidthDays`: try/catch, null for a non-array or any non-finite timestamp.

- [ ] **Step 4: Apply the store patch** to `node_modules/klinecharts/dist/index.esm.js` from the spike diff with the provider rename above, keeping its try/catch around the provider call. Then `npx patch-package klinecharts`.

- [ ] **Step 5: Verify**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.test.ts && git diff --stat patches/ && npx tsc -b`
Expected: 8 passed; the patch file grows; tsc exit 0.
The visual check runs in Task 3, once the setting can switch the provider on.

- [ ] **Step 6: Commit**

```bash
git add frontend/patches/klinecharts+10.0.0.patch frontend/src/lib/equalWidthDays.ts frontend/src/lib/equalWidthDays.test.ts
git commit -m "feat(chart): klinecharts places candles by display slot when a provider is set"
```

### Task 3: The setting

**Files:**
- Modify: `frontend/src/theme.ts` (`Settings.equalWidthDays: boolean`, default `false`)
- Modify: `frontend/src/Settings.tsx` (a row after "Weekday", same Off/On segmented control)
- Modify: `frontend/src/ChartCore.tsx` (prop `equalWidthDays: boolean`; an effect calling `setEqualWidthDays(equalWidthDays)` then relaying out with `c.setOffsetRightDistance(c.getOffsetRightDistance())`)
- Modify: callers passing the prop like `showWeekday`: `App.tsx`, `ChartGrid.tsx`, `SnapshotApp.tsx`, `mobile/MobileChartView.tsx`
- Test: `frontend/src/theme.equalWidthDays.test.ts`

**Interfaces:**
- Consumes: `setEqualWidthDays(on)` from Task 1.
- Produces: `Settings.equalWidthDays`.

- [ ] **Step 1: Write the failing test**

```ts
it("equalWidthDays defaults to off, also for settings saved before it existed", () => {
  localStorage.clear();
  expect(loadSettings().equalWidthDays).toBe(false);
  // save a blob without the field through the same raw saver loadSettings reads
  expect(loadSettings().equalWidthDays).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/theme.equalWidthDays.test.ts`
Expected: FAIL, `undefined` is not `false`.

- [ ] **Step 3: Implement** the field and default, the Settings row (label "Equal-width days", an `InfoTip` with lines: "Draws every day on an intraday chart the same width." / "Missing hours show as gaps." / "Lines pinned to 1D come out straight." / "Display only: indicators and alerts are unchanged."), the ChartCore prop and effect, and the four callers.

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd frontend && npx vitest run src/theme.equalWidthDays.test.ts src/Settings.demo.test.tsx && npx tsc -b`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Headless visual check.** Against the main dev server (:5173), a headless Chrome with its own throwaway profile (never the owner's Chrome), `?snapshot=1&broker=capital-live&epic=AAPL`, with the stored settings blob in that profile's localStorage set to `equalWidthDays: true` before load: candles sit in slots with gaps; wheel zoom and drag scroll work; no page errors. With it off the screenshot matches the chart before this work.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/theme.ts frontend/src/Settings.tsx frontend/src/ChartCore.tsx frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/src/SnapshotApp.tsx frontend/src/mobile/MobileChartView.tsx frontend/src/theme.equalWidthDays.test.ts
git commit -m "feat(settings): Equal-width days"
```

### Task 4: Straight pinned 1D lines

**Files:**
- Modify: `frontend/src/lib/indicators/trendlineSteps.ts`
- Modify: `frontend/src/lib/indicators/trendlines.ts` (the coarser-pin draw block only)
- Test: `frontend/src/lib/indicators/trendlineSteps.test.ts`, `frontend/src/lib/indicators/trendlinesMtf.test.ts`

**Interfaces:**
- Consumes: `slotGridFor(list)`, `SlotGrid` from Task 1.
- Produces: `buildHtfStepMap(timeAt, nChart, starts, htfMs, timeframe?, slots?: SlotGrid | null)`. With `slots`, every position in the map is a slot position: a loaded bar's span is `{ from: dayStart(pos[a]) - 0.5, to: dayStart(pos[b]) + perDay - 0.5 }` with `dayStart(p) = floor(p / perDay) * perDay`, `perBar` is measured in slots, and `jAt` finds the bar by position. `HtfStepMap` gains `candlePos(c: number): number` (identity without slots, `slots.posOf(c)` with) and `toIndex(p: number): number` (identity without, `slots.idxOf(p)` with). `stepMapFor` passes `slotGridFor(dataList)` and keys its memo on the grid too. `stepRange`'s `endPos` becomes `map.candlePos(nChart - 1) + 0.5`.
- In `trendlines.ts`, every chart position handed to the map goes through `candlePos` and every map position drawn goes through `toIndex`: `xOf = (p) => xAxis.convertToPixel(map.toIndex(p))`, `posMin/posMax`, `edgeIdx`, `stepY(c)`, `stepPoint(c)` and the clone's candle picks.

- [ ] **Step 1: Write the failing tests.** In `trendlineSteps.test.ts`, with the existing hourly stock fixture (7 candles 13:30..19:30 a day) and holes punched on days 2 and 5:

```ts
it("with slots every day spans perDay and the ramp is one straight line", () => {
  const times = hourlyWithHoles(); // days 2 and 5 lose their first 3 candles
  const grid = buildSlotGrid(times)!;
  const map = buildHtfStepMap((i) => times[i], times.length, startsOf(days), DAY, "DAY", grid);
  for (let j = 0; j < map.forming; j++) expect(map.span(j)!.to - map.span(j)!.from).toBe(grid.perDay);
  const pieces = buildSteps(map, value, 0, 8, all);
  const slope = (p: StepPiece) => (p.y1 - p.y0) / (p.x1 - p.x0);
  for (const p of pieces.slice(0, -1)) expect(slope(p)).toBeCloseTo(slope(pieces[0]), 9);
  expect(map.candlePos(times.length - 1)).toBe(grid.pos[times.length - 1]);
  expect(map.toIndex(map.candlePos(4))).toBeCloseTo(4, 9);
});
it("without slots the map is unchanged", () => {
  const map = mapOf(hourly(days), startsOf(days));
  expect(map.candlePos(5)).toBe(5);
  expect(map.toIndex(5.5)).toBe(5.5);
});
```

In `trendlinesMtf.test.ts`, a 1D pin on hourly bars with holes, `setEqualWidthDays(true)`, and the harness `xAxis` simulating the patched chart (`convertToPixel: (i) => grid.posOf(i)`, `convertFromPixel: (x) => Math.round(grid.idxOf(x))`): every recorded stroke piece of the line before the newest day lies on one straight line (same slope to 1e-9), and the newest day's piece is flat.

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlineSteps.test.ts src/lib/indicators/trendlinesMtf.test.ts`
Expected: FAIL (no `slots` parameter, no `candlePos`).

- [ ] **Step 3: Implement** the `slots` path in `buildHtfStepMap`, `candlePos`/`toIndex`, the memo key, `stepRange`'s end, and the conversions in `trendlines.ts`.

- [ ] **Step 4: Run the trendline tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlineSteps.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/indicators/trendlineMarks.test.ts src/lib/overlays/indicatorAlerts.test.ts src/lib/equalWidthDays.test.ts`
Expected: all pass (the existing tests prove the no-slots path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlineSteps.ts frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlineSteps.test.ts frontend/src/lib/indicators/trendlinesMtf.test.ts
git commit -m "feat(trendlines): straight 1D pins under equal-width days"
```

### Task 5: Docs and the live check

**Files:**
- Modify: `CLAUDE.md` (a short "Equal-width days" paragraph: the setting, the provider hook `globalThis.__chartkarSlots`, display-only, what is out of scope)

- [ ] **Step 1:** Write the paragraph; commit with `git add CLAUDE.md`.
- [ ] **Step 2:** `cd frontend && npx tsc -b && npx eslint <every touched file>`. Expected: tsc exit 0, no eslint errors.
- [ ] **Step 3:** Owner's live check: Settings, Equal-width days On; a Capital stock on 1H with a Trendlines pane pinned to 1D: candles in slots with gaps, the pinned line straight, zoom and scroll smooth; Off restores today's chart.
