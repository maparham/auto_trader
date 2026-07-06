# Backtest Period Shading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shade the trading period(s) a backtest ran over on the chart — one faint band for the whole window, or the finer recurring sessions when a mask is on — plus a labeled chip on the time axis, with an on/off toggle.

**Architecture:** A pure `computePeriodBands` samples the loaded bars through the existing `isActive` mask oracle and coalesces active runs into `[fromMs,toMs]` bands. Each band is drawn as a locked, non-interactive klinecharts overlay (like the existing `tradeZone` overlay) whose `createPointFigures` fills a full-pane-height rect and whose `createXAxisFigures` draws the labeled axis chip. The window+mask are persisted on the stored result so the shading rehydrates like the markers do. A single global device-local toggle (default on) gates drawing.

**Tech Stack:** TypeScript, React, klinecharts, Vitest.

## Global Constraints

- Periods come from the configured window + mask **only**, never from trade times.
- Mask on ⇒ shade only the finer active sessions; **never** a whole-window band underneath, and **no fallback** band when the mask doesn't intersect the loaded range.
- The window is clamped to the loaded candle range (`[barTimes[0], barTimes.at(-1)]`).
- Reuse `resolveMask` / `isActive` from `lib/backtestSchedule.ts` — do **not** re-implement any day-of-week / month / time-of-day / overnight-wrap logic.
- Band overlays are `lock: true` with every figure `ignoreEvent: true` — non-interactive, ephemeral (created via `chart.createOverlay`, never persisted as a user drawing).
- Neutral grey tint: `#59646f`. Faint band fill ≈ 6% alpha (`#59646f0f`); axis chip ≈ 20% alpha (`#59646f33`); label text solid `#59646f`.
- Bands are independent of `markerMode` — they render on every timeframe, even when markers are in `"none"` mode.
- The cursor's time-axis timestamp pill (klinecharts' native crosshair label, drawn above the overlay layer) must stay fully legible over the axis chip.
- Toggle is a single global display preference, device-local, default **on** (a per-cell version can be layered on later — kept global here for minimal plumbing).

---

### Task 1: Pure `computePeriodBands` + `BacktestPeriod` type

**Files:**
- Create: `frontend/src/lib/backtestPeriods.ts`
- Test: `frontend/src/lib/backtestPeriods.test.ts`

**Interfaces:**
- Consumes: `isActive` from `lib/backtestSchedule.ts`; `RecurrenceMask` from `lib/backtestConfig.ts`.
- Produces:
  - `interface BacktestPeriod { fromMs: number; toMs: number; mask?: RecurrenceMask }`
  - `interface PeriodBand { fromMs: number; toMs: number }`
  - `function computePeriodBands(period: BacktestPeriod, barTimes: number[]): PeriodBand[]`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/backtestPeriods.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computePeriodBands, type BacktestPeriod } from "./backtestPeriods";

// Hourly bars across two UTC days: 2021-01-01 00:00 .. 2021-01-02 23:00.
const HOUR = 3_600_000;
const DAY_START = Date.UTC(2021, 0, 1, 0, 0, 0); // Fri 2021-01-01
const HOURLY: number[] = [];
for (let i = 0; i < 48; i++) HOURLY.push(DAY_START + i * HOUR);

describe("computePeriodBands", () => {
  it("no mask → one band clamped to the loaded bar range", () => {
    const period: BacktestPeriod = { fromMs: DAY_START - 5 * HOUR, toMs: DAY_START + 10 * HOUR };
    const bands = computePeriodBands(period, HOURLY);
    expect(bands).toEqual([{ fromMs: DAY_START, toMs: DAY_START + 10 * HOUR }]);
  });

  it("no bars loaded → nothing", () => {
    expect(computePeriodBands({ fromMs: 0, toMs: DAY_START + HOUR }, [])).toEqual([]);
  });

  it("window entirely before the loaded bars → nothing", () => {
    expect(computePeriodBands({ fromMs: 0, toMs: DAY_START - HOUR }, HOURLY)).toEqual([]);
  });

  it("mask time-of-day 09:00–12:00 UTC → one band per day (half-open, 12:00 excluded)", () => {
    const period: BacktestPeriod = {
      fromMs: DAY_START,
      toMs: DAY_START + 48 * HOUR,
      mask: { enabled: true, tz: "UTC", timeOfDay: { startMin: 9 * 60, endMin: 12 * 60 } },
    };
    const bands = computePeriodBands(period, HOURLY);
    expect(bands).toEqual([
      { fromMs: DAY_START + 9 * HOUR, toMs: DAY_START + 11 * HOUR },       // day 1: 09,10,11
      { fromMs: DAY_START + (24 + 9) * HOUR, toMs: DAY_START + (24 + 11) * HOUR }, // day 2
    ]);
  });

  it("mask day-of-week that excludes both days → nothing (no fallback band)", () => {
    // 2021-01-01 is Fri(5), 2021-01-02 is Sat(6). Allow only Monday(1).
    const period: BacktestPeriod = {
      fromMs: DAY_START,
      toMs: DAY_START + 48 * HOUR,
      mask: { enabled: true, tz: "UTC", daysOfWeek: [1] },
    };
    expect(computePeriodBands(period, HOURLY)).toEqual([]);
  });

  it("overnight-wrap 22:00–02:00 UTC coalesces across midnight into one run", () => {
    const period: BacktestPeriod = {
      fromMs: DAY_START,
      toMs: DAY_START + 48 * HOUR,
      mask: { enabled: true, tz: "UTC", timeOfDay: { startMin: 22 * 60, endMin: 2 * 60 } },
    };
    const bands = computePeriodBands(period, HOURLY);
    // Active bars: 22,23 (day1) → 00,01 (day2), contiguous; then 22,23 (day2) run to the end.
    expect(bands[0]).toEqual({ fromMs: DAY_START + 22 * HOUR, toMs: DAY_START + 25 * HOUR });
    expect(bands[bands.length - 1]).toEqual({
      fromMs: DAY_START + (24 + 22) * HOUR,
      toMs: DAY_START + (24 + 23) * HOUR,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/backtestPeriods.test.ts`
Expected: FAIL — `Failed to resolve import "./backtestPeriods"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/backtestPeriods.ts`:

```ts
// The trading period(s) a backtest ran over, for on-chart shading. A period is
// the configured window ([fromMs,toMs]) restricted, when a recurrence mask is
// on, to the recurring active sessions. We derive the drawable bands by sampling
// the CURRENTLY LOADED bars through the same `isActive` oracle the mask-preview
// heatstrip uses — exact at candle resolution (which is all that shows), bounded
// by the bar count, and correct for DST / overnight wrap because isActive is the
// single source of truth (no second copy of the schedule semantics). Sampling at
// the bars also makes the invariant hold by construction: a marker sits on a bar,
// so an active-bar marker always lands inside a band.

import type { RecurrenceMask } from "./backtestConfig";
import { isActive } from "./backtestSchedule";

/** The window a backtest traded over, plus the RESOLVED mask (resolveMask output,
 * no `session` field) when one was active. Persisted on the stored result. */
export interface BacktestPeriod {
  fromMs: number;
  toMs: number;
  mask?: RecurrenceMask;
}

/** One drawable shaded span (ms). Edges are loaded-bar timestamps. */
export interface PeriodBand {
  fromMs: number;
  toMs: number;
}

/** Bands to shade for `period` given the ascending loaded-bar timestamps
 * (`barTimes`, ms). No mask → one band, the window clamped to the loaded range.
 * Mask → maximal contiguous runs of active bars inside the window. Empty when
 * nothing is loaded, the window doesn't overlap the bars, or the mask keeps no
 * loaded bar active (no fallback to the whole window). Pure + exported for tests. */
export function computePeriodBands(period: BacktestPeriod, barTimes: number[]): PeriodBand[] {
  if (barTimes.length === 0) return [];
  const first = barTimes[0];
  const last = barTimes[barTimes.length - 1];
  const from = Math.max(period.fromMs, first);
  const to = Math.min(period.toMs, last);
  if (!(to > from)) return [];

  if (!period.mask) return [{ fromMs: from, toMs: to }];

  const bands: PeriodBand[] = [];
  let runStart: number | null = null;
  let runEnd = 0;
  for (const t of barTimes) {
    if (t < from || t > to) continue; // only bars inside the window
    if (isActive(period.mask, t)) {
      if (runStart === null) runStart = t;
      runEnd = t;
    } else if (runStart !== null) {
      bands.push({ fromMs: runStart, toMs: runEnd });
      runStart = null;
    }
  }
  if (runStart !== null) bands.push({ fromMs: runStart, toMs: runEnd });
  return bands;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestPeriods.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestPeriods.ts frontend/src/lib/backtestPeriods.test.ts
git commit -m "feat(backtest): pure computePeriodBands for period shading"
```

---

### Task 2: Persist the period on the stored result

**Files:**
- Modify: `frontend/src/lib/persist/artifacts.ts` (StoredBacktestResult type + `saveBacktestResult`)

**Interfaces:**
- Consumes: `BacktestPeriod` from `lib/backtestPeriods.ts`.
- Produces:
  - `StoredBacktestResult` now includes `period?: BacktestPeriod`.
  - `saveBacktestResult(scope, epic, result, period?)` — new optional 4th arg attached to the stored object.

- [ ] **Step 1: Add the import and extend the type**

In `frontend/src/lib/persist/artifacts.ts`, add near the top imports:

```ts
import type { BacktestPeriod } from "../backtestPeriods";
```

Change the `StoredBacktestResult` definition from:

```ts
export type StoredBacktestResult = Omit<BacktestResult, "candles">;
```

to:

```ts
// The persisted result also carries the trading `period` (window + resolved
// mask) so the on-chart period shading rehydrates like the markers do — it is a
// frontend-derived field (not returned by the backend), attached at save time.
export type StoredBacktestResult = Omit<BacktestResult, "candles"> & {
  period?: BacktestPeriod;
};
```

- [ ] **Step 2: Thread `period` through `saveBacktestResult`**

Replace the `saveBacktestResult` function body:

```ts
export function saveBacktestResult(
  scope: string,
  epic: string,
  result: BacktestResult,
  period?: BacktestPeriod,
): void {
  // Strip the bulky candle array before persisting — redraw doesn't need it
  // (markers/equity/periods attach to whatever bars are loaded by absolute
  // timestamp).
  const stored: StoredBacktestResult = { ...result, period };
  delete (stored as Partial<BacktestResult>).candles;
  save(backtestKey(scope, epic), stored);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no NEW errors referencing `artifacts.ts` or `backtestPeriods` (the repo has 23 known pre-existing tsc errors — none in these files).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/persist/artifacts.ts
git commit -m "feat(backtest): persist trading period on the stored result"
```

---

### Task 3: The global show/hide toggle (persist + signal)

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts` (load/save the flag)
- Modify: `frontend/src/lib/persist/core.ts` (register the device-local key)
- Modify: `frontend/src/lib/signals.ts` (the signal)

**Interfaces:**
- Produces:
  - `loadBacktestPeriodsShown(): boolean` / `saveBacktestPeriodsShown(v: boolean): void` (device-local, default `true`).
  - `backtestPeriodsShownSignal: Signal<boolean>` (default `true`).

- [ ] **Step 1: Add the persistence pair**

In `frontend/src/lib/persist/defaults.ts`, after the `BACKTEST_OPEN_KEY` block (search `backtestOpen`), add:

```ts
// Whether the on-chart backtest trading-period shading is shown. Device-local
// view preference (like the panel open/side/split flags above), default on.
const BACKTEST_PERIODS_SHOWN_KEY = `${PREFIX}.backtestPeriodsShown`;
export function loadBacktestPeriodsShown(): boolean {
  return load<boolean>(BACKTEST_PERIODS_SHOWN_KEY, true);
}
export function saveBacktestPeriodsShown(shown: boolean): void {
  saveLocal(BACKTEST_PERIODS_SHOWN_KEY, shown);
}
```

- [ ] **Step 2: Register the key as device-local**

In `frontend/src/lib/persist/core.ts`, add to the `DEVICE_LOCAL_FLAT_KEYS` set (search `DEVICE_LOCAL_FLAT_KEYS`):

```ts
const DEVICE_LOCAL_FLAT_KEYS = new Set([
  `${PREFIX}.backtestOpen`,
  `${PREFIX}.backtestSide`,
  `${PREFIX}.backtestSplit`,
  `${PREFIX}.backtestPeriodsShown`,
  `${PREFIX}.lastDrawTools`,
]);
```

- [ ] **Step 3: Add the signal**

In `frontend/src/lib/signals.ts`, after `backtestResultSignal` (search `backtestResultSignal`), add:

```ts
// Whether the on-chart backtest trading-period shading is shown (global display
// preference, seeded from device-local storage at startup). backtest.ts reads
// this to gate drawing and subscribes to redraw each chart's bands on change.
export const backtestPeriodsShownSignal = new Signal<boolean>(true);
```

- [ ] **Step 4: Confirm the barrel auto-re-exports the new functions**

Run: `cd frontend && grep -n "persist/defaults" src/lib/persist.ts`
Expected: `export * from "./persist/defaults";` — a wildcard, so `loadBacktestPeriodsShown` / `saveBacktestPeriodsShown` are re-exported automatically. No edit needed here.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/persist/defaults.ts frontend/src/lib/persist/core.ts frontend/src/lib/signals.ts
git commit -m "feat(backtest): device-local toggle + signal for period shading"
```

---

### Task 4: The period-band overlay + draw/teardown in backtest.ts

**Files:**
- Modify: `frontend/src/lib/backtest.ts`

**Interfaces:**
- Consumes: `computePeriodBands`, `BacktestPeriod`, `PeriodBand` from `lib/backtestPeriods.ts`; `backtestPeriodsShownSignal` from `lib/signals.ts`.
- Produces:
  - `BacktestArtifacts` gains `periodBandIds: string[]`.
  - `drawPeriodBands(chart, artifacts, result)` — internal; creates the band overlays if the toggle is on.
  - `clearPeriodBands(chart, artifacts)` — internal; removes them.

- [ ] **Step 1: Add imports**

In `frontend/src/lib/backtest.ts`, add to the existing `./signals` import list `backtestPeriodsShownSignal`, and add a new import:

```ts
import { computePeriodBands, type BacktestPeriod, type PeriodBand } from "./backtestPeriods";
```

Also add `backtestPeriodsShownSignal` to the existing:

```ts
import {
  backtestResultSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  backtestClusterHoverSignal,
  backtestPeriodsShownSignal,
} from "./signals";
```

- [ ] **Step 2: Add the artifacts field**

In the `BacktestArtifacts` interface add:

```ts
  // Ids of the locked, non-interactive period-shading overlays (one per band).
  periodBandIds: string[];
```

And in `artifactsFor`'s initializer object add `periodBandIds: []` alongside `markerIds: []`.

- [ ] **Step 3: Add a grey constant near the other color constants**

After `const ACCENT_COLOR = "#2962ff";` add:

```ts
// Neutral grey for the trading-period shading — deliberately off the green/red
// markers and the blue trade lines so an always-on layer doesn't compete.
const PERIOD_COLOR = "#59646f";
```

- [ ] **Step 4: Register the overlay + the draw/clear helpers**

Add, near the `markerOverlay` / `tradeZoneOverlay` definitions:

```ts
const PERIOD_OVERLAY = "backtestPeriod";

interface PeriodExtra { label: string }

// The trading-period band: a faint full-pane-height rect in the price pane, and
// a faint labeled chip in the X-axis pane (createXAxisFigures — the native way to
// draw on the time axis, so it pans/zooms with the axis). Read-only: lock on
// create AND every figure ignoreEvent, so it never intercepts clicks or the
// crosshair — the cursor's time pill (klinecharts' crosshair label, drawn above
// the overlay layer) stays fully legible over the faint chip.
const periodOverlay: OverlayTemplate = {
  name: PERIOD_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const x0 = Math.min(coordinates[0].x, coordinates[1].x);
    const w = Math.abs(coordinates[1].x - coordinates[0].x);
    return [
      {
        type: "rect",
        attrs: { x: x0, y: 0, width: w, height: bounding.height },
        styles: { style: PolygonType.Fill, color: `${PERIOD_COLOR}0f` }, // ~6%
        ignoreEvent: true,
      },
    ];
  },
  createXAxisFigures: ({ overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const { label } = (overlay.extendData as PeriodExtra) ?? { label: "" };
    const x0 = Math.min(coordinates[0].x, coordinates[1].x);
    const x1 = Math.max(coordinates[0].x, coordinates[1].x);
    const w = x1 - x0;
    const figures: OverlayFigure[] = [
      {
        type: "rect",
        attrs: { x: x0, y: 0, width: w, height: bounding.height },
        styles: { style: PolygonType.Fill, color: `${PERIOD_COLOR}33` }, // ~20%
        ignoreEvent: true,
      },
    ];
    if (label && w > 44) {
      figures.push({
        type: "text",
        attrs: { x: (x0 + x1) / 2, y: bounding.height / 2, text: label, align: "center", baseline: "middle" },
        styles: { color: PERIOD_COLOR, size: 10, family: "-apple-system, system-ui, sans-serif" },
        ignoreEvent: true,
      });
    }
    return figures;
  },
};

let periodOverlayRegistered = false;
function ensurePeriodOverlayRegistered(): void {
  if (periodOverlayRegistered) return;
  periodOverlayRegistered = true;
  registerOverlay(periodOverlay);
}

/** Short label for a band's axis chip: a clock span for an intraday-width band
 * (a mask session), a date span for a multi-day one (the whole window). */
function periodLabel(b: PeriodBand, period: BacktestPeriod): string {
  const tz = period.mask?.tz;
  const multiDay = b.toMs - b.fromMs >= 20 * 3600 * 1000;
  if (multiDay) {
    const d: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(tz ? { timeZone: tz } : {}) };
    return `${new Date(b.fromMs).toLocaleDateString([], d)} – ${new Date(b.toMs).toLocaleDateString([], d)}`;
  }
  const t: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) };
  return `${new Date(b.fromMs).toLocaleTimeString([], t)}–${new Date(b.toMs).toLocaleTimeString([], t)}`;
}

/** Remove this chart's period-band overlays and reset the bookkeeping. */
function clearPeriodBands(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.periodBandIds) chart.removeOverlay(id);
  artifacts.periodBandIds = [];
}

/** Draw the trading-period bands for the CURRENT loaded bars, if the global
 * toggle is on and the result carries a period. Caller clears any prior bands
 * first. Independent of markerMode — periods are pure time spans, valid on every
 * timeframe. */
function drawPeriodBands(chart: Chart, artifacts: BacktestArtifacts, result: StoredBacktestResult): void {
  if (!backtestPeriodsShownSignal.value) return;
  const period = result.period;
  if (!period) return;
  const data = chart.getDataList() ?? [];
  if (data.length === 0) return;
  const barTimes = data.map((k) => k.timestamp);
  const bands = computePeriodBands(period, barTimes);
  if (bands.length === 0) return;
  ensurePeriodOverlayRegistered();
  const yVal = data[0].close; // a valid in-range price so the point projects (y is unused)
  for (const b of bands) {
    const id = chart.createOverlay({
      name: PERIOD_OVERLAY,
      lock: true,
      points: [
        { timestamp: b.fromMs, value: yVal },
        { timestamp: b.toMs, value: yVal },
      ],
      extendData: { label: periodLabel(b, period) } satisfies PeriodExtra,
    });
    if (typeof id === "string") artifacts.periodBandIds.push(id);
  }
}
```

- [ ] **Step 5: Draw bands + install the toggle subscription in `renderArtifacts`**

In `renderArtifacts`, immediately AFTER the block that sets `artifacts.trades / result / markerMode / aggClusters` and BEFORE `if (markerMode === "none") return;`, insert:

```ts
  // Period shading — draw now (gated by the toggle) and redraw on toggle flips.
  // Installed BEFORE the markerMode "none" early-return so periods still respond
  // to the toggle on a timeframe where markers aren't drawn.
  clearPeriodBands(chart, artifacts);
  drawPeriodBands(chart, artifacts, result);
  const unsubPeriods = backtestPeriodsShownSignal.subscribe(() => {
    clearPeriodBands(chart, artifacts);
    drawPeriodBands(chart, artifacts, result);
  });
```

Then, change the `markerMode === "none"` early return so it preserves this subscription. Replace:

```ts
  if (markerMode === "none") return;
```

with:

```ts
  if (markerMode === "none") {
    artifacts.unsub = unsubPeriods;
    return;
  }
```

Finally, fold `unsubPeriods` into the composed unsub at the end of `renderArtifacts`. Replace:

```ts
  artifacts.unsub = () => {
    unsubHighlight();
    unsubSelection();
  };
```

with:

```ts
  artifacts.unsub = () => {
    unsubHighlight();
    unsubSelection();
    unsubPeriods();
  };
```

- [ ] **Step 6: Remove bands in `teardownArtifacts`**

In `teardownArtifacts`, after the `markerIds` cleanup block (search `for (const id of artifacts.markerIds)`), add:

```ts
  clearPeriodBands(chart, artifacts);
```

(`teardownArtifacts` already calls `artifacts.unsub()` lower down, which now also detaches the period subscription.)

- [ ] **Step 7: Recompute bands after the history page-back**

In `reanchorBacktestMarkers`, after the existing marker/cluster reset and `drawMarkers(...)` call, add band recompute (the page-back extends `barTimes`, so a period can now cover older bars):

```ts
  clearPeriodBands(chart, artifacts);
  drawPeriodBands(chart, artifacts, artifacts.result);
```

- [ ] **Step 8: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors. If `createXAxisFigures` or `bounding` is missing from klinecharts' `OverlayTemplate` type, that surfaces here — resolve by matching the signature klinecharts exports (the `tradeZone` overlay already uses `bounding` in `createPointFigures`, confirming the param shape; `createXAxisFigures` is a sibling hook on the same template type).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/backtest.ts
git commit -m "feat(backtest): draw period-shading band + axis chip overlays"
```

---

### Task 5: Pass the period from the run, and wire the toggle seed

**Files:**
- Modify: `frontend/src/lib/backtest.ts` (`runAndRender` signature)
- Modify: `frontend/src/BacktestButton.tsx` (build + pass the period; seed the signal)

**Interfaces:**
- Consumes: `BacktestPeriod` from `lib/backtestPeriods.ts`; `loadBacktestPeriodsShown`, `backtestPeriodsShownSignal`.
- Produces: `runAndRender(chart, req, scope, period?)` — new optional 4th arg.

- [ ] **Step 1: Add the `period` param to `runAndRender`**

In `frontend/src/lib/backtest.ts`, change the `runAndRender` signature and its `saveBacktestResult` call. Replace:

```ts
export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
  scope: string,
): Promise<BacktestResult> {
  const result = await runBacktest(req);
  teardownArtifacts(chart);
  saveBacktestResult(scope, req.epic, result);
  renderArtifacts(chart, result, { markerMode: "native", drawEquity: true });
  return result;
}
```

with:

```ts
export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
  scope: string,
  period?: BacktestPeriod,
): Promise<BacktestResult> {
  const result = await runBacktest(req);
  teardownArtifacts(chart);
  // Attach the period so the shading persists + rehydrates like the markers.
  saveBacktestResult(scope, req.epic, result, period);
  const stored = loadBacktestResult(scope, req.epic) ?? result;
  renderArtifacts(chart, stored, { markerMode: "native", drawEquity: true });
  return result;
}
```

Note: we render the freshly-STORED object (which carries `period`) so the period is present at render time. `loadBacktestResult` is already imported in this file.

- [ ] **Step 2: Build + pass the period in `BacktestButton.run`**

In `frontend/src/BacktestButton.tsx`, the `run()` function already computes `windowFromMs`, `windowToMs`, and passes `mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined` into the request. Change the `runAndRender(chart, {...}, controller!.scope)` call to add the 4th arg. After the request object's closing `}`, change:

```ts
        controller!.scope,
      );
```

to:

```ts
        controller!.scope,
        {
          fromMs: windowFromMs,
          toMs: windowToMs,
          mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        },
      );
```

(`windowFromMs` / `windowToMs` are already in scope from the `resolveWindow(...)` destructure; `resolveMask` is already imported.)

- [ ] **Step 3: Seed the toggle signal on mount**

In `frontend/src/BacktestButton.tsx`, add the persist import and a seed effect. Add to the existing `./lib/persist` import:

```ts
import { loadBacktestLastUsed, saveBacktestLastUsed, loadBacktestPeriodsShown } from "./lib/persist";
```

Add `backtestPeriodsShownSignal` to the `./lib/signals` import list. Then, alongside the other `useEffect` subscriptions near the top of the component, add:

```ts
  // Seed the period-shading toggle from device-local storage once at startup
  // (the component is mounted for the whole app session).
  useEffect(() => {
    backtestPeriodsShownSignal.set(loadBacktestPeriodsShown());
  }, []);
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtest.ts frontend/src/BacktestButton.tsx
git commit -m "feat(backtest): thread trading period from run into shading"
```

---

### Task 6: The toggle button in the results header

**Files:**
- Modify: `frontend/src/BacktestPanel.tsx`

**Interfaces:**
- Consumes: `backtestPeriodsShownSignal`, `saveBacktestPeriodsShown`.

- [ ] **Step 1: Add imports**

In `frontend/src/BacktestPanel.tsx`, add `backtestPeriodsShownSignal` to the `./lib/signals` import list, and add:

```ts
import { saveBacktestPeriodsShown } from "./lib/persist";
```

- [ ] **Step 2: Subscribe to the signal + a toggle handler**

Inside the component (the one rendering `summaryRow`), near the other hooks, add:

```ts
  const periodsShown = useSyncExternalStore(
    (cb) => backtestPeriodsShownSignal.subscribe(cb),
    () => backtestPeriodsShownSignal.value,
  );
  const toggleBacktestPeriods = () => {
    const next = !backtestPeriodsShownSignal.value;
    backtestPeriodsShownSignal.set(next);
    saveBacktestPeriodsShown(next);
  };
```

(`useSyncExternalStore` is already imported in this file.)

- [ ] **Step 3: Render the toggle next to the ✕ clear**

In the `summaryRow` JSX, immediately before the existing `<button className="bt-clear" ...>✕</button>`, add:

```tsx
      <button
        className={`bt-periods-toggle${periodsShown ? " on" : ""}`}
        title={periodsShown ? "Hide trading periods on the chart" : "Show trading periods on the chart"}
        aria-pressed={periodsShown}
        onClick={toggleBacktestPeriods}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          {/* two bracketed spans = the shaded period(s) on a time axis */}
          <path d="M2 5v6M2 8h4M9 5v6M9 8h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
```

- [ ] **Step 4: Add minimal styling**

Find the `.bt-clear` rule in the stylesheet (run `cd frontend && grep -rn "\.bt-clear" src`). In the same CSS file, after that rule, add:

```css
.bt-periods-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 4px;
  border: 0;
  background: transparent;
  color: var(--muted, #8a95a1);
  cursor: pointer;
  border-radius: 4px;
}
.bt-periods-toggle:hover { background: rgba(89, 100, 111, 0.12); }
.bt-periods-toggle.on { color: #59646f; }
```

(Match the variable/naming conventions of the surrounding rules; if the file uses a different muted-color token, use that instead.)

- [ ] **Step 5: Manual smoke — the toggle flips and persists**

Run: `cd frontend && npx tsc --noEmit` (Expected: no new errors), then verify in the app in Task 7.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestPanel.tsx frontend/src/*.css
git commit -m "feat(backtest): results-header toggle for period shading"
```

---

### Task 7: The invariant test + full verification

**Files:**
- Modify: `frontend/src/lib/backtestPeriods.test.ts` (add the invariant test)

**Interfaces:**
- Consumes: `computePeriodBands`, `isActive`.

- [ ] **Step 1: Add the "no active-bar marker sits outside a band" invariant test**

Append to `frontend/src/lib/backtestPeriods.test.ts`:

```ts
import { isActive } from "./backtestSchedule";

describe("period bands invariant", () => {
  it("every active loaded bar lands inside some band (mask on)", () => {
    const HOUR2 = 3_600_000;
    const start = Date.UTC(2021, 5, 1, 0, 0, 0); // Tue 2021-06-01
    const bars: number[] = [];
    for (let i = 0; i < 24 * 5; i++) bars.push(start + i * HOUR2); // 5 days hourly
    const period: BacktestPeriod = {
      fromMs: start,
      toMs: start + 24 * 5 * HOUR2,
      // NYSE-ish weekday session, resolved-style mask.
      mask: { enabled: true, tz: "UTC", daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: { startMin: 13 * 60 + 30, endMin: 20 * 60 } },
    };
    const bands = computePeriodBands(period, bars);
    const inBand = (t: number) => bands.some((b) => t >= b.fromMs && t <= b.toMs);
    for (const t of bars) {
      // The discriminating check: a bar the mask deems active MUST be shaded.
      if (isActive(period.mask, t)) expect(inBand(t)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the full vitest suite for this file**

Run: `cd frontend && npx vitest run src/lib/backtestPeriods.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Run the whole frontend test suite (guard against regressions)**

Run: `cd frontend && npx vitest run`
Expected: the pre-existing baseline still passes (534 passed / 50 skipped before this work) plus the new tests; no previously-passing test now fails.

- [ ] **Step 4: Manual verification in the real app**

Start the app (or use the running dev server — do NOT kill the user's HMR server; see the dev-environment memory). Then, on a focused chart cell:

1. Open Backtest, set a **Custom** range, run with **no mask**. Confirm a single faint grey band covers the window in the price pane and a faint labeled chip (date span) sits on the time axis under it.
2. Enable **Repeat / active windows** with a weekday session (e.g. NYSE) and re-run. Confirm only the recurring session bands show (one faint band + axis chip per session), and NO whole-window band underneath.
3. Confirm every trade marker sits inside a shaded band.
4. Switch timeframe (finer and coarser) and reload the page — the shading rehydrates on both.
5. **Cursor pill:** hover across an axis chip and confirm the following timestamp pill stays fully legible over it (the explicit requirement).
6. Toggle the results-header control off/on — the bands vanish/return cleanly; the off state survives a reload.
7. Set a relative window (e.g. Year) that ends at "now" and confirm the band doesn't tint empty space past the last candle.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestPeriods.test.ts
git commit -m "test(backtest): period-band coverage invariant"
```

---

## Self-Review

**Spec coverage:**
- Rule (no-mask one band / mask finer sessions / no fallback / clamp) → Task 1 (`computePeriodBands`) + tests.
- Data plumbing (`period` on stored result) → Tasks 2 + 5.
- Rendering (overlay: full-height rect + axis chip via `createXAxisFigures`, independent of markerMode) → Task 4.
- Cursor-pill constraint → Task 4 (ignoreEvent + faint, below crosshair layer) + Task 7 Step 4.5 verification.
- Interval math reusing `isActive`, wrap handled → Task 1 (bar-sampling through `isActive`).
- Lifecycle (teardown / reanchor page-back) → Task 4 Steps 6–7.
- Toggle (results header, device-local, default on) → Tasks 3 + 5 (seed) + 6 (button).
- Verification (unit + invariant + manual) → Tasks 1, 7.

**Placeholder scan:** No TBD/TODO; every code step shows the code; every command shows expected output.

**Type consistency:** `BacktestPeriod`/`PeriodBand` defined in Task 1, consumed by the same names in Tasks 2/4/5. `periodBandIds`, `drawPeriodBands`, `clearPeriodBands`, `ensurePeriodOverlayRegistered`, `periodLabel`, `PERIOD_OVERLAY`, `PeriodExtra`, `PERIOD_COLOR` all defined and used consistently in Task 4. `backtestPeriodsShownSignal` defined in Task 3, consumed in Tasks 4/5/6. `saveBacktestResult(scope, epic, result, period?)` defined in Task 2, called with 4 args in Task 5. `runAndRender(..., period?)` defined + called in Task 5.
