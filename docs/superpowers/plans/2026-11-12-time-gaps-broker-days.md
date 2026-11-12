# Time Gaps: Broker Days and Weeks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under Time gaps, a chart's days are the broker's own days (from a pinned pane's daily bars, else inferred from the candles) and every week has the same day columns, so lines pinned to 1D and 1W are straight for any broker.

**Architecture:** `buildSlotGrid` gains day boundaries (inferred offset or given starts) and a weekly layout (fixed day columns per week). Pinned panes register their 1D/1W bar starts per chart; the klinecharts patch passes its chart to the provider, keys its cache on a version, and gains one relayout entry point that keeps the centre candle in place. The Trendlines step map uses week-wide units for week pins.

**Tech Stack:** TypeScript, klinecharts 10.0.0 (patch-package), vitest.

**Spec:** docs/superpowers/specs/2026-11-12-time-gaps-broker-days-design.md (earlier work: docs/superpowers/specs/2026-11-12-equal-width-days-design.md)

## Global Constraints

- Setting off: chart unchanged, pixel for pixel (no provider means identity).
- No per-broker code: nothing branches on broker id or epic.
- A day's calendar date is `floor((dayStart + 12h) / 24h)` (so FX's Sunday 22:00 open is Monday's day); weekday 0 = Monday is `(cal + 3) % 7`.
- Inferred day start: the start of the time-of-day bin (one chart period wide) with the fewest candles; ties go to the bin closest to 00:00 UTC, measured round the clock.
- Week columns: the weekdays holding candles anywhere in the loaded data, Monday first. A holiday is an empty column; weekdays no week trades and weeks with no candles take no room.
- Position = weekNum * columns * perDay + column * perDay + slot.
- The newest HTF bar stays flat (unchanged).
- Nothing in a klinecharts layout path may throw; every provider call keeps its try/catch.
- Plain, literal words in UI and docs (owner is not a native speaker); no em dashes.
- Commit to the current branch by explicit path; never run the full frontend suite; `npx tsc -b` and eslint on touched files.

## Review Focus

1. A pin registered or removed while the user is scrolled back must not move the candle at the view's centre. Test in Task 2.
2. Two panes pinned to different timeframes (1D and 1W) on one chart: both register, the grid uses both, neither overwrites the other. Test in Task 3.
3. Candles before the first registered start (history older than the pin's bars) still get a day: they fall back to the inferred offset, never a throw. Test in Task 1.
4. Capital-like stock data with no holidays gives exactly today's positions. Test in Task 1.
5. Removing the last pin of a kind drops back to inferred days. Test in Task 3.

---

### Task 1: The grid knows broker days and weeks

**Files:**
- Modify: `frontend/src/lib/equalWidthDays.ts`
- Test: `frontend/src/lib/equalWidthDays.test.ts`

**Interfaces:**
- Produces:
  - `interface SlotAnchors { dayStarts?: readonly number[]; weekStarts?: readonly number[] }`
  - `buildSlotGrid(times: readonly number[], anchors?: SlotAnchors): SlotGrid | null`
  - `SlotGrid` gains `readonly perWeek: number` (columns * perDay).
  - `inferDayStartOffset(times: readonly number[], step: number): number` (ms after 00:00 UTC, in [0, 24h)).

- [ ] **Step 1: Write the failing tests** (hourly unless said; `day(d, hours)` helper as today; D0 = Monday 2026-11-02):
  - `"stock days with no holidays keep today's positions"`: Mon to Fri, 14:00..20:00, two weeks: positions equal the old `dayNum * 7 + slot` (0..69).
  - `"a holiday is an empty column"`: same, Monday of week 2 missing: Tuesday of week 2 starts at `5*7 + 7 = 42`.
  - `"FX days start at the daily pause"`: 24 candles a day except 22:00, Sun 23:00 to Fri 21:00: `inferDayStartOffset` is `22h`; the Sunday 23:00 candle sits in Monday's column, slot 1.
  - `"24/7 data falls back to 00:00 and seven columns"`: `inferDayStartOffset` is 0; `perWeek` is `7 * 24`.
  - `"a session crossing midnight UTC stays one day"`: 23:00 to 05:00 UTC candles: offset is 23h (closest empty bin to 00:00), each session one day.
  - `"given day starts win, older candles fall back to inference"`: FX data with `dayStarts` at 22:00 for the last 3 days only: those days use the starts, earlier ones the inferred offset, positions strictly increasing.
  - `"given week starts set the weeks"`: stock data with `weekStarts` on Mondays: same positions as without.

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.test.ts`
Expected: FAIL (no `inferDayStartOffset`, no `perWeek`, holiday not empty).

- [ ] **Step 3: Implement.** Per candle: its day start (from `dayStarts` by binary search, the last start at or before it; else `floor((t - off) / DAY) * DAY + off` with the inferred `off`), its slot `floor((t - dayStart) / step)`, its calendar date and weekday (Global Constraints). Columns from the weekdays seen; week number from `weekStarts` (last start at or before `dayStart + 12h`) else `floor((cal + 3 - firstColumnWeekday) / 7)`, compressed so only weeks with candles count. Keep the shared-slot split from the earlier fix.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.test.ts src/lib/indicators/trendlineSteps.test.ts src/lib/indicators/trendlinesMtf.test.ts`
Expected: all pass (existing tests keep passing: their fixtures have no holidays).

- [ ] **Step 5: Commit** `git add frontend/src/lib/equalWidthDays.ts frontend/src/lib/equalWidthDays.test.ts`, message `feat(chart): time gaps use broker days and equal weeks`.

### Task 2: Per-chart anchors and a steady relayout

**Files:**
- Modify: `frontend/src/lib/equalWidthDays.ts`
- Modify: `frontend/node_modules/klinecharts/dist/index.esm.js`, then `npx patch-package klinecharts`
- Modify: `frontend/src/ChartCore.tsx` (the Time gaps effect)
- Test: `frontend/src/lib/equalWidthDays.realchart.test.ts`

**Interfaces:**
- Consumes: `buildSlotGrid(times, anchors)` from Task 1.
- Produces:
  - Provider signature `globalThis.__chartkarSlots(list, chart)`; it records `list -> chart` so `slotGridFor(list)` (no chart) finds the same anchors.
  - `setSlotAnchors(chart: Chart, key: string, anchors: SlotAnchors | null): void`: per chart, per pane key; merged with first-registered-wins per field; relayouts that chart.
  - `relayoutSlots(chart: Chart, change: () => void): void`: runs `change` between the store's `_viewAnchor()` and `_viewAnchorShift(a, 0)`, adjusts `_lastBarRightSideDiffBarCount`, then `_adjustVisibleRange()` and a layout. Implemented on the store as `chartkarRelayoutSlots(change)`.
  - The store's slot cache also keys on `globalThis.__chartkarSlots.version` (a number bumped by `setSlotAnchors` and `setEqualWidthDays`).

- [ ] **Step 1: Write the failing tests** (real chart, as the existing file does, scrolled back):
  - `"registering day starts keeps the centre candle in place"`: FX-like data, `setSlotAnchors(chart, "p", { dayStarts })` with starts one hour off the inferred ones: the centre candle's x is unchanged and the grid changed.
  - `"turning Time gaps on keeps the centre candle in place"`: off, scrolled back; `relayoutSlots(chart, () => setEqualWidthDays(true))`: the centre candle's x is unchanged.

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.realchart.test.ts`
Expected: FAIL (no `setSlotAnchors`).

- [ ] **Step 3: Implement** the registry, the provider's second argument, the version, the store method, and switch ChartCore's Time gaps effect from `setOffsetRightDistance(getOffsetRightDistance())` to `relayoutSlots(c, () => setEqualWidthDays(equalWidthDays))` (this also fixes the earlier deferred minor: the toggle no longer jumps to the newest candle).

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/equalWidthDays.realchart.test.ts src/lib/equalWidthDays.test.ts src/lib/overlays.realchart.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit** the patch file, `equalWidthDays.ts`, `ChartCore.tsx` and the test, message `feat(chart): time gaps anchors per chart, relayout keeps the view`.

### Task 3: Pinned panes register their day and week starts

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts` (`applyHtfPin`, after `write()`, and its chart-timeframe branch)
- Create: `frontend/src/lib/slotAnchorsFromPins.ts`
- Test: `frontend/src/lib/slotAnchorsFromPins.test.ts`

**Interfaces:**
- Consumes: `setSlotAnchors(chart, key, anchors)` from Task 2.
- Produces: `slotAnchorsFor(timeframe: string | null, htfStarts: readonly number[] | undefined): SlotAnchors | null` (`"DAY"` gives `{ dayStarts }`, `"WEEK"` gives `{ weekStarts }`, anything else null). `applyHtfPin` calls `setSlotAnchors(chart, `${paneId}|${name}`, slotAnchorsFor(timeframe, ext.mtf.htfStarts))` after each write, and with null when the pin goes back to the chart timeframe or the pane is removed.

- [ ] **Step 1: Write the failing tests:**
  - `"DAY and WEEK pins give anchors, others none"`.
  - `"a 1D and a 1W pin on one chart both apply"`: two `setSlotAnchors` calls with different keys: the merged anchors hold both fields.
  - `"removing the last 1D pin drops back to inferred days"`: register then null: merged anchors have no `dayStarts`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/lib/slotAnchorsFromPins.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `slotAnchorsFor` and the two calls in `applyHtfPin`; find where a pinned pane is removed (the coordinator's cleanup for a removed indicator) and clear its key there.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/slotAnchorsFromPins.test.ts src/lib/mtfCoordinator.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit** the three files, message `feat(chart): pinned panes give time gaps their days and weeks`.

### Task 4: Straight 1W lines

**Files:**
- Modify: `frontend/src/lib/indicators/trendlineSteps.ts`
- Test: `frontend/src/lib/indicators/trendlineSteps.test.ts`, `frontend/src/lib/indicators/trendlinesMtf.test.ts`

**Interfaces:**
- Consumes: `SlotGrid.perWeek` from Task 1; `slotGridFor(list)` (now chart-aware via Task 2).
- Produces: in `buildHtfStepMap`, the whole-unit width is `perWeek` for pins of at least 7 days and under 28 days, else `perDay` for pins of at least 1 day (monthly stays on days).

- [ ] **Step 1: Write the failing tests:**
  - `trendlineSteps`: `"with slots a week pin spans perWeek, even with a Monday holiday"`: every closed week's span is `perWeek` wide and the ramp pieces before the newest week share one slope.
  - `trendlinesMtf`: `"a 1W pin is straight with time gaps"`: stroke pieces before the newest week share one slope; the newest week's piece is flat.

- [ ] **Step 2: Run them to see them fail**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlineSteps.test.ts src/lib/indicators/trendlinesMtf.test.ts`
Expected: FAIL (a holiday week is narrower).

- [ ] **Step 3: Implement** the unit choice in `leftEdge`/`rightEdge`.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlineSteps.test.ts src/lib/indicators/trendlinesMtf.test.ts src/lib/overlays/indicatorAlerts.test.ts src/lib/equalWidthDays.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit** the four files, message `feat(trendlines): straight 1W pins with time gaps`.

### Task 5: Docs and checks

**Files:**
- Modify: `CLAUDE.md` (the Equal-width days paragraph: broker days, weeks, anchors from pins; remove the word "kinks")

- [ ] **Step 1:** Update the paragraph in plain words; commit `git add CLAUDE.md`.
- [ ] **Step 2:** `cd frontend && npx tsc -b && npx eslint <touched files>`. Expected: tsc exit 0, no eslint errors.
- [ ] **Step 3:** Headless check on :5173 (throwaway profile): TSLA 1H with Time gaps on shows no change on a week without holidays; a pinned 1D pane gives the same picture; scroll back works with no page errors.
