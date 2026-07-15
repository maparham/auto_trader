# klinecharts v9 → v10 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `frontend` from klinecharts 9.8.12 to 10.0.0 with all current chart behavior preserved, dropping all three klinecharts patches (future-time axis and weak-magnet are native/fixed in v10; scale-price-only is reimplemented via the supported `createRange` override).

**Architecture:** v10 is a breaking rewrite of the public API: enums become string literals, data flows through a `setSymbol`/`setPeriod`/`setDataLoader` loader instead of `applyNewData`/`updateData`, indicator/overlay lookups become filter-based, `setCustomApi` becomes `setFormatter`, and y-axis log/percentage become axis names instead of styles. We migrate module-by-module behind a small data-facade seam, keeping each task compiling toward a final integration checkpoint. The app will NOT be usable between early tasks; this migration must run on an isolated branch/worktree and merge only after final verification.

**Tech Stack:** React + Vite + TypeScript, klinecharts 10.0.0, vitest, patch-package (being retired for klinecharts).

## Global Constraints

- Pin exactly `klinecharts@10.0.0` in `frontend/package.json` (released 2026-07-11; no 10.0.x patch releases exist yet).
- Delete `frontend/patches/klinecharts+9.8.12.patch`; do NOT create a v10 patch. If a v10 defect forces a patch, stop and surface it instead.
- No backward-compat shims, dual-version code paths, or migration helpers left in the tree (user rule: no legacy code).
- No em dashes in any copy, comments, or commit messages.
- All work on the migration worktree/branch; `main` stays on v9 until final verification passes.
- Ground truth for v10 API shapes is `node_modules/klinecharts/dist/index.d.ts` after install. The klinecharts.com migration guide has at least one error (it claims `calc` returns a timestamp-keyed object; the d.ts says `calc` still returns `D[]`). When docs and d.ts disagree, trust the d.ts.
- Reference inventory of every v9 call site (counts, file:line) lives in the "v9 usage inventory" section at the bottom of this plan. Task file lists cite it.

## v9 → v10 API mapping (verified against 10.0.0 d.ts)

| v9 | v10 |
|---|---|
| `DomPosition.Main / .Root / .YAxis` (enum) | `'main' / 'root' / 'yAxis'` (type `DomPosition = "root"\|"main"\|"yAxis"`) |
| `ActionType.OnScroll / OnZoom / OnPaneDrag / OnCrosshairChange` | `'onScroll' / 'onZoom' / 'onPaneDrag' / 'onCrosshairChange'` |
| `ActionType.OnTooltipIconClick` | REMOVED. `'onIndicatorTooltipFeatureClick'` / `'onCandleTooltipFeatureClick'` / `'onCrosshairFeatureClick'` |
| `LineType.Solid / .Dashed` (enum) | `'solid' / 'dashed'` (no dotted, unchanged from v9) |
| `IndicatorSeries.Price / .Normal` | `'price' / 'normal'` (also `'volume'`) |
| `TooltipShowRule.None` | `'none'` |
| `PolygonType.*` | `'stroke' \| 'fill' \| 'stroke_fill'` |
| `YAxisType.Log / .Normal` (styles `yAxis.type`) | REMOVED from styles. Y-axis kind is an axis name: `chart.overrideYAxis({ paneId: 'candle_pane', name: 'logarithm' \| 'normal' \| 'percentage' })` |
| `LoadDataType.Forward / .Backward` | `DataLoadType = 'init' \| 'forward' \| 'backward' \| 'update'` |
| `chart.applyNewData(bars, more)` | REMOVED. Data enters via `setDataLoader.getBars` `callback(bars, more)`; full replacement via `chart.resetData()` re-triggering `getBars` with `type: 'init'` |
| `chart.updateData(bar)` | REMOVED. Realtime bars go through the `subscribeBar` callback captured from `setDataLoader` |
| `chart.setLoadDataCallback(cb)` | `chart.setDataLoader({ getBars, subscribeBar?, unsubscribeBar? })` |
| `chart.setPriceVolumePrecision(p, v)` | `chart.setSymbol({ ticker, pricePrecision, volumePrecision })` |
| (new, mandatory) | `chart.setSymbol({ ticker })` and `chart.setPeriod({ span, type })` must be set or `getBars` never fires; `setPeriod` also powers native future-time projection on the x-axis and crosshair |
| `chart.setCustomApi({ formatDate })` with `(dateTimeFormat, timestamp, format, type) => string` | `chart.setFormatter({ formatDate })` with `(params: { dateTimeFormat, timestamp, template, type: 'tooltip'\|'crosshair'\|'xAxis' }) => string` |
| `chart.getIndicatorByPaneId(paneId, name)` | `chart.getIndicators({ paneId, name })[0] ?? null` |
| `chart.overrideIndicator({ name, ... }, paneId)` | `chart.overrideIndicator({ id, ... })` or `{ paneId, name, ... }` (single filter-carrying object) |
| `chart.removeIndicator(paneId, name)` | `chart.removeIndicator({ paneId, name })` |
| `chart.createIndicator(value, stack, { id: paneId, ...paneOpts })` | `chart.createIndicator({ ...value, paneId }, stack)` then `chart.setPaneOptions({ id: paneId, height, minHeight, dragEnabled })` |
| `chart.getOverlayById(id)` | `chart.getOverlays({ id })[0] ?? null` |
| `chart.overrideOverlay({ id, ... })` | same name, arg is `Partial<OverlayCreate>` (still carries `id`) |
| `chart.removeOverlay(id)` / `(filter)` | `chart.removeOverlay({ id })` (filter object) |
| `registerYAxis({ name, createTicks })` + `paneOptions.axisOptions.name` | `PaneOptions` has NO `axisOptions`. Attach per-pane axis behavior with `chart.overrideYAxis({ paneId, createTicks })`, or `registerYAxis` + reference by name via `overrideYAxis({ paneId, name })` |
| private `chart._scalePriceOnly` + patched `YAxisImp.calcRange` | supported `chart.overrideYAxis({ paneId: 'candle_pane', createRange: (params) => AxisRange })` |
| `getConvertPictureUrl(true, 'jpeg', bg)` | unchanged |
| `convertToPixel(points, { paneId, absolute })` | unchanged shape (`ConvertFilter = { paneId?, yAxisId?, absolute? }`) |
| indicator `draw` params | now `{ ctx, chart, indicator, bounding, xAxis, yAxis }`; `barSpace` no longer passed, use `chart.getBarSpace()` |
| `createTooltipDataSource` return `{ name, calcParamsText, values, icons }` | `{ name, calcParamsText, legends, features }` |
| overlay template fields | unchanged names: `totalStep`, `needDefault*Figure`, `createPointFigures`, `createXAxisFigures`, `mode`, `modeSensitivity`, `onDrawStart/onDrawing/onDrawEnd`, figure `onClick`/`onMouseEnter`/... All callbacks now receive `chart` in params |
| `KLineData` | unchanged `{ timestamp, open, high, low, close, volume?, turnover? }` |
| `Period` | `{ span: number, type: 'second'\|'minute'\|'hour'\|'day'\|'week'\|'month'\|'year' }` |

Patches disposition (all three removed, nothing replaces them in `patches/`):
- Future-time axis: NATIVE in v10. `StoreImp.dataIndexToTimestamp` extrapolates past both ends using the declared `Period`, feeding both x-axis ticks and `crosshair.timestamp`.
- Weak-magnet below-low: FIXED upstream (v10 uses `lowY + modeSensitivity` with reverse handling).
- Scale-price-only: reimplemented in Task 8 via `overrideYAxis({ createRange })`.

---

### Task 1: Dependency swap, patch removal, breakage census

**Files:**
- Modify: `frontend/package.json` (klinecharts `9.8.12` → `10.0.0`)
- Delete: `frontend/patches/klinecharts+9.8.12.patch`
- Create: `docs/superpowers/plans/2026-07-15-klinecharts-v10-breakage.txt` (tsc census, committed for reference)

**Interfaces:**
- Produces: v10 installed; the full `tsc --noEmit` error list that later tasks burn down.

- [ ] **Step 1: Swap the dependency and remove the patch**

```bash
cd frontend
npm install klinecharts@10.0.0 --save-exact
git rm patches/klinecharts+9.8.12.patch
```

- [ ] **Step 2: Capture the breakage census**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tee ../docs/superpowers/plans/2026-07-15-klinecharts-v10-breakage.txt | tail -5
```

Expected: hundreds of errors (enum members, removed methods, changed signatures). This file is the master checklist; each later task should shrink it.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore(chart): install klinecharts 10.0.0, drop v9 patch (breakage census committed)"
```

---

### Task 2: Enum-to-string-literal sweep (source + all test mocks)

**Files:**
- Modify: every file importing `DomPosition`, `ActionType`, `LineType`, `IndicatorSeries`, `TooltipShowRule`, `PolygonType`, `YAxisType`, `LoadDataType` per inventory §1 (ChartCore.tsx, ChartGrid.tsx, chart/useIndicatorCommands.ts, chart/usePointerCrosshair.ts, chart/useChartPaint.ts, chart/useLineDrag.ts, lib/chartSync.ts, lib/indicators.ts, lib/chartTheme.ts, lib/overlays.ts, lib/lineStyle.ts, lib/snapshotMarker.ts, lib/backtest.ts, DrawingSettings.tsx, ToolbarControls.tsx, Toolbar.tsx, DrawSidebar.tsx, all `lib/indicators/*.ts`)
- Modify: all 21 test files with `vi.mock('klinecharts', ...)` per inventory §8

**Interfaces:**
- Produces: no enum value imports remain; values are the v10 string literals. Types (`LineType` etc.) may still be imported as types.

- [ ] **Step 1: Mechanical replace, per the mapping table**

Replacement recipe (apply exactly; example for each enum):

```ts
// before                                   // after
DomPosition.Main                            'main'
DomPosition.Root                            'root'
DomPosition.YAxis                           'yAxis'
ActionType.OnScroll                         'onScroll'
ActionType.OnZoom                           'onZoom'
ActionType.OnPaneDrag                       'onPaneDrag'
ActionType.OnCrosshairChange                'onCrosshairChange'
LineType.Solid                              'solid'
LineType.Dashed                             'dashed'
IndicatorSeries.Price                       'price'
IndicatorSeries.Normal                      'normal'
TooltipShowRule.None                        'none'
LoadDataType.Forward                        'forward'
LoadDataType.Backward                       'backward'
```

Where a value import becomes unused, delete it from the import list; keep type-only imports as `import type { LineType } from 'klinecharts'`. `ActionType.OnTooltipIconClick` and `YAxisType.*` sites are NOT converted here; they are reworked in Tasks 6 and 7 (leave a `// @ts-expect-error v10-migration Task 6/7` marker so tsc keeps flagging them).

Note: v9's enum values were already these same strings at runtime (`LineType.Solid === 'solid'`), so persisted artifacts (drawing templates, indicator presets) keep working with no data migration.

- [ ] **Step 2: Update the 21 klinecharts test mocks**

The common v9 stub shape becomes plain string re-exports; enums no longer exist to mock. New canonical mock (apply the same transformation to all variants listed in inventory §8):

```ts
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
```

Files whose production code only reads types and string literals no longer need `LineType`/`IndicatorSeries`/`DomPosition` entries in the mock at all; remove them. Where a test itself asserted on `LineType.Dotted` (curveLabels.test.ts, pivotAnalysis.test.ts) replace with the literal `'dotted'` only if production code uses that string; otherwise fix the test to the real literal used.

- [ ] **Step 3: Typecheck delta**

```bash
cd frontend && npx tsc --noEmit 2>&1 | wc -l
```

Expected: error count drops sharply; remaining errors are the API-shape ones addressed by Tasks 3-9 plus the deliberate `@ts-expect-error` markers.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(chart): klinecharts enums to v10 string literals"
```

---

### Task 3: Data pipeline: setSymbol / setPeriod / setDataLoader facade

**Files:**
- Create: `frontend/src/chart/chartDataFacade.ts`
- Modify: `frontend/src/ChartCore.tsx` (init effect ~1249-1260, `setLoadDataCallback` block ~2060, `setPriceVolumePrecision` ~2574, `setTimezone` unchanged)
- Modify: `frontend/src/chart/useLiveMarketData.ts` (`applyNewData` :194, `scrollToRealTime` :206 unchanged, `updateData` :433, `setPriceVolumePrecision` :102)
- Modify: `frontend/src/lib/overlays.ts` (`applyNewData(merged, true)` :2115)
- Test: `frontend/src/chart/chartDataFacade.test.ts`

**Interfaces:**
- Produces (exact, other tasks and hooks consume this):

```ts
// chart/chartDataFacade.ts
import type { Chart, KLineData, DataLoadMore, SymbolInfo, Period } from "klinecharts";

export interface ChartDataFacade {
  /** Wire the facade into a chart: calls chart.setDataLoader once. */
  attach(chart: Chart): void;
  /** Declare instrument + precision. Calls chart.setSymbol. Triggers getBars(init). */
  setSymbol(ticker: string, pricePrecision: number, volumePrecision: number): void;
  /** Declare the timeframe. Calls chart.setPeriod. Triggers getBars(init). */
  setPeriod(period: Period): void;
  /** Full dataset replacement (was applyNewData). Stores bars and calls chart.resetData(). */
  setBars(bars: KLineData[], more: DataLoadMore): void;
  /** Realtime bar tick (was chart.updateData). Forwards to the captured subscribeBar callback. */
  pushBar(bar: KLineData): void;
  /** Handler invoked when the chart hits the left/right edge (was setLoadDataCallback). */
  onLoadRequest: (type: "forward" | "backward", timestamp: number | null,
                  done: (bars: KLineData[], more: DataLoadMore) => void) => void;
  getBars(): KLineData[];
}
export function createChartDataFacade(): ChartDataFacade;
```

- [ ] **Step 1: Write failing tests for the facade**

```ts
// chart/chartDataFacade.test.ts
import { describe, it, expect, vi } from "vitest";
import { createChartDataFacade } from "./chartDataFacade";

function fakeChart() {
  let loader: any = null;
  return {
    setDataLoader: vi.fn((l) => { loader = l; }),
    setSymbol: vi.fn(),
    setPeriod: vi.fn(),
    resetData: vi.fn(),
    _loader: () => loader,
  } as any;
}

describe("chartDataFacade", () => {
  it("serves stored bars to getBars(init) and forwards more-flags", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const bars = [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1 }];
    const cb = vi.fn();
    f.setBars(bars, { backward: true, forward: false });
    expect(chart.resetData).toHaveBeenCalled(); // setBars asks the chart to re-pull
    // the chart re-pull arrives as getBars(init); the facade must serve the stored bars
    chart._loader().getBars({ type: "init", timestamp: null, symbol: {} as any, period: {} as any, callback: cb });
    expect(cb).toHaveBeenCalledWith(bars, { backward: true, forward: false });
  });

  it("routes edge loads to onLoadRequest", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    f.onLoadRequest = vi.fn((type, ts, done) => done([], false));
    const cb = vi.fn();
    chart._loader().getBars({ type: "backward", timestamp: 123, symbol: {} as any, period: {} as any, callback: cb });
    expect(f.onLoadRequest).toHaveBeenCalledWith("backward", 123, expect.any(Function));
    expect(cb).toHaveBeenCalledWith([], false);
  });

  it("pushBar forwards to the captured subscribeBar callback", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const sub = vi.fn();
    chart._loader().subscribeBar({ symbol: {} as any, period: {} as any, callback: sub });
    const bar = { timestamp: 2, open: 1, high: 1, low: 1, close: 1 };
    f.pushBar(bar);
    expect(sub).toHaveBeenCalledWith(bar);
  });

  it("pushBar before subscribeBar does not throw and is dropped", () => {
    const f = createChartDataFacade();
    f.attach(fakeChart());
    expect(() => f.pushBar({ timestamp: 3, open: 1, high: 1, low: 1, close: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/chart/chartDataFacade.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the facade**

```ts
// chart/chartDataFacade.ts
import type { Chart, KLineData, DataLoadMore, Period } from "klinecharts";

export interface ChartDataFacade { /* as in Interfaces block above */ }

export function createChartDataFacade(): ChartDataFacade {
  let chart: Chart | null = null;
  let bars: KLineData[] = [];
  let more: DataLoadMore = false;
  let subscribe: ((bar: KLineData) => void) | null = null;

  const facade: ChartDataFacade = {
    onLoadRequest: (_type, _ts, done) => done([], false),
    attach(c) {
      chart = c;
      c.setDataLoader({
        getBars: ({ type, timestamp, callback }) => {
          if (type === "init" || type === "update") {
            callback(bars, more);
            return;
          }
          facade.onLoadRequest(type, timestamp, callback);
        },
        subscribeBar: ({ callback }) => { subscribe = callback; },
        unsubscribeBar: () => { subscribe = null; },
      });
    },
    setSymbol(ticker, pricePrecision, volumePrecision) {
      chart?.setSymbol({ ticker, pricePrecision, volumePrecision });
    },
    setPeriod(period: Period) {
      chart?.setPeriod(period);
    },
    setBars(next, nextMore) {
      bars = next;
      more = nextMore;
      chart?.resetData();
    },
    pushBar(bar) {
      subscribe?.(bar);
    },
    getBars: () => bars,
  };
  return facade;
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/chart/chartDataFacade.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Add the TF-string to Period mapper**

The app's timeframe strings (Toolbar values like `1m 3m 5m 15m 30m 1H 4H 1D 1W 1M`) must map to v10 `Period`. Put next to the facade:

```ts
// chart/chartDataFacade.ts (same file)
export function periodFromTf(tf: string): Period {
  const m = /^(\d+)(m|H|D|W|M|Y)$/.exec(tf);
  if (!m) throw new Error(`unknown timeframe: ${tf}`);
  const span = Number(m[1]);
  const type = ({ m: "minute", H: "hour", D: "day", W: "week", M: "month", Y: "year" } as const)[m[2] as "m" | "H" | "D" | "W" | "M" | "Y"];
  return { span, type };
}
```

Check the actual TF token set in `Toolbar.tsx`/`ChartCore.tsx` (`period` prop) and the derived timeframes (2W, 3W, 6W, 2M, 3M, 1Y from the derived-timeframes feature) and extend the regex if a token differs. Derived TFs map cleanly (`2W → {span:2, type:'week'}`); the projection math in v10 handles any span. Add test cases:

```ts
it("maps timeframe strings to periods", () => {
  expect(periodFromTf("5m")).toEqual({ span: 5, type: "minute" });
  expect(periodFromTf("4H")).toEqual({ span: 4, type: "hour" });
  expect(periodFromTf("1D")).toEqual({ span: 1, type: "day" });
  expect(periodFromTf("2W")).toEqual({ span: 2, type: "week" });
});
```

- [ ] **Step 6: Wire ChartCore + useLiveMarketData + overlays through the facade**

In `ChartCore.tsx` init effect (after `init(el)` succeeds):

```ts
const dataFacade = createChartDataFacade();
dataFacade.attach(chart);
// replaces the v9 setLoadDataCallback block at ~2060:
dataFacade.onLoadRequest = (type, timestamp, done) => {
  if (type === "forward") { /* body of the old LoadDataType.Forward branch, ending in done(bars, more) instead of params.callback */ }
  else { /* old Backward branch */ }
};
```

Store `dataFacade` on the same handle object that carries `chartRef` (add `dataFacadeRef`) so `useLiveMarketData` and `overlays.ts` reach it the same way they reach the chart today. Exact rewires:
- `useLiveMarketData.ts:194` `chart.applyNewData(bars, !liveOnly)` → `dataFacade.setBars(bars, { backward: !liveOnly, forward: false })` (v9's boolean `more` governed backward paging; keep forward false since v9 had no forward loading here).
- `useLiveMarketData.ts:433` `chart.updateData(bar)` → `dataFacade.pushBar(bar)`.
- `useLiveMarketData.ts:102` `chart.setPriceVolumePrecision(prec, 0)` and `ChartCore.tsx:2574` same → `dataFacade.setSymbol(epic, prec, 0)`.
- `overlays.ts:2115` `chart.applyNewData(merged, true)` → the overlay manager receives the facade (add it to its constructor deps next to `chart`) and calls `dataFacade.setBars(merged, { backward: true })`.
- Symbol/period declaration: in the effect where `epic`/`period` currently configure the feed, call `dataFacade.setSymbol(epic, precision, 0)` and `dataFacade.setPeriod(periodFromTf(period))`, and again whenever the cell's symbol or TF changes (same effect deps that currently reset the feed).

Ordering note: call `attach` before the first `setSymbol`/`setPeriod`, and only call `setBars` after both are set, because v10 fires `getBars(init)` when symbol+period+loader are all present; the facade serving stored `bars` makes double-fires harmless (idempotent).

- [ ] **Step 7: Typecheck + facade tests**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "applyNewData\|updateData\|setLoadDataCallback\|setPriceVolumePrecision"`
Expected: 0. Run `npx vitest run src/chart/chartDataFacade.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(chart): v10 data loader facade replaces applyNewData/updateData pipeline"
```

---

### Task 4: Indicator call-site migration (filter-based API)

**Files:**
- Modify (per inventory §2 counts): `IndicatorSettings.tsx` (12 getIndicatorByPaneId + 13 overrideIndicator), `lib/indicators.ts` (7 + 3 + 4 removeIndicator + 3 createIndicator + 3 setPaneOptions), `lib/mtfCoordinator.ts` (5 + 7), `chart/useIndicatorCommands.ts` (6 + 3), `indicatorSettings/PrevHlPanels.tsx` (6 + 6), `chart/chartGeometry.ts` (5), `ChartLegend.tsx` (3), `chart/useLineDrag.ts` (3), `ChartCore.tsx` (2 + 3 + 1), `lib/backtest.ts` (2 removeIndicator + 1 createIndicator), remaining single sites per inventory.

**Interfaces:**
- Consumes: v10 `getIndicators(filter)`, `overrideIndicator(IndicatorCreate)`, `removeIndicator(filter)`, `createIndicator(value, isStack?)`.
- Produces: a tiny local helper in `lib/indicators.ts` other files import:

```ts
export function getIndicator(chart: Chart, paneId: string, name: string): Indicator | null {
  return chart.getIndicators({ paneId, name })[0] ?? null;
}
```

- [ ] **Step 1: Add `getIndicator` helper + failing typecheck-driven sweep**

Recipes (apply at every listed site):

```ts
// lookup
chart.getIndicatorByPaneId(paneId, name)          → getIndicator(chart, paneId, name)
// override with paneId arg
chart.overrideIndicator({ name, visible }, paneId) → chart.overrideIndicator({ paneId, name, visible })
// override without paneId (v9 applied to every instance of name; v10 filter by name only)
chart.overrideIndicator({ name, calcParams })      → chart.overrideIndicator({ name, calcParams })
// remove
chart.removeIndicator(paneId, name)                → chart.removeIndicator({ paneId, name })
// create with pane options (indicators.ts:461,515)
chart.createIndicator(value, stack, { id: paneId, axisOptions: {...} })
  → chart.createIndicator({ ...value, paneId }, stack)   // axisOptions handled in Task 7
    + chart.setPaneOptions({ id: paneId, height, minHeight, dragEnabled }) where v9 passed them
// create backtest equity (backtest.ts:1291)
chart.createIndicator({ name, extendData }, false) → unchanged shape, verify paneId behavior (v9 defaulted to a new pane; v10 same when paneId omitted)
```

`createIndicator` return in v10 is `Nullable<string>` = the pane id, same contract as v9; call sites that store it keep working.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "getIndicatorByPaneId\|removeIndicator\|overrideIndicator\|createIndicator"`
Expected: 0.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor(chart): filter-based indicator API for v10"
```

---

### Task 5: Indicator templates: draw params, tooltip legends/features

**Files:**
- Modify: `lib/indicators/{ma,lr,vwap,prevHl,rsi,pivotBands,pivotAnalysis,slope,sessions,timeHighlight,shared}.ts`, `lib/customIndicators.ts`, `lib/indicators.ts` (legendTooltipSource :427, template re-registration :321-361), `lib/backtest.ts` (EQUITY :977)
- Test: existing vitest suites for these indicators (parity goldens, slope.register.test.ts etc.)

**Interfaces:**
- Consumes: v10 `IndicatorTemplate` (calc still returns `D[]`; `series` string literal; `draw` params `{ ctx, chart, indicator, bounding, xAxis, yAxis }`; `createTooltipDataSource` returns `{ name, calcParamsText, legends, features }`).

- [ ] **Step 1: Update template shapes**

Recipes:

```ts
// series
series: IndicatorSeries.Price       → series: 'price'
series: IndicatorSeries.Normal      → series: 'normal'

// draw callbacks (drawRsiDivergences, drawPivotAnalysis, drawSlope, drawSessions, drawTimeHighlight)
// v9: ({ ctx, kLineDataList?, indicator, visibleRange, bounding, barSpace, ... })
// v10: ({ ctx, chart, indicator, bounding, xAxis, yAxis })
// data:        kLineDataList → chart.getDataList()
// visibleRange → chart.getVisibleRange()
// barSpace     → chart.getBarSpace()
// convertToPixel calls already go through the chart or axis; xAxis/yAxis params also expose convertToPixel(value)

// tooltip sources (shared.ts emptyTooltipSource, indicators.ts legendTooltipSource, slope.ts accelTooltipSource)
return { name, calcParamsText, values: [...], icons: [] }
  → return { name, calcParamsText, legends: [...], features: [] }
// TooltipLegend shape: { title: string | { text, color }, value: string | { text, color } } — verify against d.ts lines 142-150 and adapt the constructed objects
```

`regenerateFigures` and `figures` keep their v9 shapes (verified identical in d.ts). `calc` signatures unchanged.

- [ ] **Step 2: Run indicator test suites**

Run: `cd frontend && npx vitest run src/lib/indicators src/lib/indicatorParityGolden.test.ts src/lib/slope.register.test.ts`
Expected: PASS after mock updates from Task 2. Parity goldens prove `calc` outputs unchanged.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor(chart): indicator templates to v10 draw/tooltip shapes"
```

---

### Task 6: Overlays, action subscriptions, legend feature clicks

**Files:**
- Modify: `lib/overlays.ts` (29 getOverlayById + 28 overrideOverlay + 9 removeOverlay + createOverlay :820-890 + private `_chartStore` escape :587-590), `lib/positionLines.ts`, `lib/snapshotMarker.ts`, `lib/tradeMarkers.ts`, `lib/customOverlays.ts`, `lib/backtest.ts` (overlay templates + create/remove sites), `ChartCore.tsx` (subscribeAction block :1274-1300 and :2837-2925, unsubscribe mirror)

**Interfaces:**
- Consumes: v10 `getOverlays(filter)`, `removeOverlay(filter)`, `overrideOverlay(Partial<OverlayCreate>)`, string ActionTypes, `'onIndicatorTooltipFeatureClick'`.

- [ ] **Step 1: Overlay lookup/removal sweep**

```ts
chart.getOverlayById(id)      → chart.getOverlays({ id })[0] ?? null
chart.removeOverlay(id)       → chart.removeOverlay({ id })
chart.removeOverlay({ id })   → unchanged
chart.overrideOverlay({...})  → unchanged (verify each payload field exists on v10 OverlayCreate)
```

Nearly all sites funnel through `lib/overlays.ts`; add one private method there and route the 29 lookups through it:

```ts
private byId(id: string): Overlay | null {
  return this.chart.getOverlays({ id })[0] ?? null;
}
```

- [ ] **Step 2: Overlay template params**

All template callbacks (`createPointFigures`, `createXAxisFigures`) now receive `chart` in params instead of relying on captured references; v9 param names (`overlay, coordinates, bounding, xAxis, yAxis`) are unchanged. `OverlayMode` values become `'weak_magnet'` etc. (overlays.ts:349,836,837). Figure-level event handlers (`onClick`, `onMouseEnter`, `onPressedMoveEnd`, `onRightClick`) keep their names; their `OverlayEvent` param now has `{ chart, overlay, figure*, ...MouseTouchEvent }`; update the handler signatures in positionLines.ts:494-518, snapshotMarker.ts, backtest.ts:1124-1185.

- [ ] **Step 3: Replace the private styles escape**

`overlays.ts:587-590` reaches `(chart as any)._chartStore.setOptions({ styles })` to avoid v9's `setStyles` viewport re-fit. In v10, `setStyles` lives on the Store and no longer forces a pane re-fit (verify by reading `setStyles` in the v10 esm once installed; it routes to `_chartStore.setStyles` + `updatePane`). Replace the escape with plain `chart.setStyles(styles)`; if live verification (Task 10) shows a visible viewport jump on overlay-style changes, surface it before inventing a new escape.

- [ ] **Step 4: Action subscriptions in ChartCore**

```ts
// scroll/zoom/pane-drag/crosshair: string literals (done in Task 2), API unchanged
chart.subscribeAction('onScroll', cb) ...

// legend feature clicks: v9 OnTooltipIconClick handler at ChartCore.tsx:1275-1300
chart.subscribeAction(ActionType.OnTooltipIconClick, handler)
  → chart.subscribeAction('onIndicatorTooltipFeatureClick', handler)
```

The v9 handler destructures `{ paneId, indicatorName, iconId }` with iconId in `'setting' | 'visible_toggle' | 'remove'`. v10's payload comes from `TooltipFeatureStyle` (`features` array items carry an `id`); our tooltip sources emit `features: []`, and the visible legend is our own DOM (ChartLegend), so this handler may be dead code in practice. Port it faithfully anyway: map the payload's feature id field to the same three branches, and confirm the field name (`id`) against the v10 d.ts `TooltipFeatureStyle` once installed. If the legend proves to be 100% DOM-driven during Task 10 verification, delete the subscription instead of keeping a dead path (no legacy code rule).

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "getOverlayById\|OnTooltipIconClick\|OverlayMode\."`
Expected: 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(chart): v10 overlay filters, action names, styles escape removal"
```

---

### Task 7: Axes: sessions blank y-axis, log/normal toggle, formatter

**Files:**
- Modify: `lib/indicators/sessions.ts` (:10, :171 registerYAxis; keep), `lib/indicators.ts` (:458 axisOptions), `ToolbarControls.tsx` (:7 YAxisType import, :250-257), `ChartCore.tsx` (:1034 reverse, :1055 getStyles().yAxis.type, :1928, :1260 + :2607 setCustomApi), `lib/timeFormat.ts` (makeFormatDate)

**Interfaces:**
- Consumes: v10 `overrideYAxis(YAxisOverride)`, `registerYAxis(AxisTemplate)`, `setFormatter({ formatDate })`.

- [ ] **Step 1: Sessions pane blank axis**

v9: `registerYAxis({ name: SESSIONS_AXIS_NAME, createTicks: () => [] })` + `createIndicator(..., { axisOptions: { name: SESSIONS_AXIS_NAME } })`.
v10: `registerYAxis` still exists with the same template `{ name, createTicks }` (d.ts line 1235). Keep the registration; replace the pane wiring at indicators.ts:458:

```ts
// after createIndicator({ ...value, paneId }, stack) returns/uses sessionsPaneId:
chart.overrideYAxis({ paneId: sessionsPaneId, name: SESSIONS_AXIS_NAME });
```

- [ ] **Step 2: Log/normal y-axis toggle**

```ts
// v9 (ToolbarControls.tsx:250-257, ChartCore.tsx:1055,1928)
chart.setStyles({ yAxis: { type: YAxisType.Log } })
chart.getStyles().yAxis.type
// v10
chart.overrideYAxis({ paneId: "candle_pane", name: "logarithm" });   // or "normal" / "percentage"
chart.getYAxes({ paneId: "candle_pane" })[0]?.name                    // current kind
```

Confirm the candle pane id constant is still `"candle_pane"` in the installed v10 (grep `PaneIdConstants` in dist); use whatever the constant is everywhere.
Invert scale (ChartCore.tsx:1034 `setStyles({yAxis:{reverse}})`): v10 moved `reverse` to the axis too: `chart.overrideYAxis({ paneId: "candle_pane", reverse: next })`.

- [ ] **Step 3: Formatter**

```ts
// v9 timeFormat.ts makeFormatDate returns (dateTimeFormat, timestamp, format, type) => string
// v10 signature:
import type { FormatDateParams } from "klinecharts";
export function makeFormatDate(clock: ClockMode, dateFormat: string, showWeekday: boolean) {
  return ({ dateTimeFormat, timestamp, template, type }: FormatDateParams): string => {
    // identical body; rename `format` param reads to `template`
  };
}
// ChartCore.tsx:1260, 2607
chart.setCustomApi({ formatDate: makeFormatDate(...) })
  → chart.setFormatter({ formatDate: makeFormatDate(...) })
```

`FormatDateType` values are now lowercase strings (`'tooltip' | 'crosshair' | 'xAxis'`); update any comparisons inside makeFormatDate.

- [ ] **Step 4: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "YAxisType\|setCustomApi\|axisOptions"` → 0.

```bash
git add -A && git commit -m "refactor(chart): v10 axis overrides and formatter"
```

---

### Task 8: Scale-price-only via supported createRange override

**Files:**
- Create: `frontend/src/chart/priceOnlyRange.ts`
- Modify: `ChartCore.tsx` (:1050, :1256 remove `_scalePriceOnly` private writes; :1042-1060 re-apply effect), `lib/chartController.ts` (:88-90 comment update only)
- Test: `frontend/src/chart/priceOnlyRange.test.ts`

**Interfaces:**
- Produces:

```ts
// chart/priceOnlyRange.ts
import type { Chart, AxisCreateRangeParams, AxisRange } from "klinecharts";
/** Candle-pane y-range from visible candle highs/lows only (ignores indicator curves). */
export function priceOnlyCreateRange(params: AxisCreateRangeParams): AxisRange;
/** Install or remove the override depending on the flag. */
export function applyScalePriceOnly(chart: Chart, enabled: boolean): void;
```

- [ ] **Step 1: Failing test**

```ts
// chart/priceOnlyRange.test.ts
import { describe, it, expect } from "vitest";
import { priceOnlyCreateRange } from "./priceOnlyRange";

const bars = [
  { timestamp: 1, open: 10, high: 12, low: 9, close: 11 },
  { timestamp: 2, open: 11, high: 15, low: 10, close: 14 },
];
const chart = {
  getDataList: () => bars,
  getVisibleRange: () => ({ from: 0, to: 2, realFrom: 0, realTo: 2 }),
} as any;
const defaultRange = { from: 0, to: 100, realFrom: 0, realTo: 100, range: 100, realRange: 100, displayFrom: 0, displayTo: 100, displayRange: 100 };

describe("priceOnlyCreateRange", () => {
  it("spans visible candle low..high with the default gap ratio", () => {
    const r = priceOnlyCreateRange({ chart, paneId: "candle_pane", defaultRange } as any);
    expect(r.from).toBeLessThanOrEqual(9);
    expect(r.to).toBeGreaterThanOrEqual(15);
    expect(r.to).toBeLessThan(100); // ignored the inflated default (indicator) range
  });
  it("falls back to defaultRange when no visible candles", () => {
    const empty = { ...chart, getDataList: () => [] };
    const r = priceOnlyCreateRange({ chart: empty, paneId: "candle_pane", defaultRange } as any);
    expect(r).toEqual(defaultRange);
  });
});
```

Run: `npx vitest run src/chart/priceOnlyRange.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
// chart/priceOnlyRange.ts
import type { Chart, AxisCreateRangeParams, AxisRange } from "klinecharts";

export function priceOnlyCreateRange({ chart, defaultRange }: AxisCreateRangeParams): AxisRange {
  const data = chart.getDataList();
  const { from, to } = chart.getVisibleRange();
  let min = Number.MAX_SAFE_INTEGER;
  let max = Number.MIN_SAFE_INTEGER;
  for (let i = Math.max(0, from); i < Math.min(to, data.length); i++) {
    min = Math.min(min, data[i].low);
    max = Math.max(max, data[i].high);
  }
  if (min > max) return defaultRange;
  // 20% top / 10% bottom gap, matching v10 Layout.yAxis.gap defaults the candle pane uses
  const span = Math.max(max - min, Number.EPSILON);
  const rFrom = min - span * 0.1;
  const rTo = max + span * 0.2;
  const range = rTo - rFrom;
  return { from: rFrom, to: rTo, realFrom: rFrom, realTo: rTo, range, realRange: range,
           displayFrom: rFrom, displayTo: rTo, displayRange: range };
}

export function applyScalePriceOnly(chart: Chart, enabled: boolean): void {
  chart.overrideYAxis({
    paneId: "candle_pane",
    createRange: enabled ? priceOnlyCreateRange : (p) => p.defaultRange,
  });
}
```

Verify the gap ratios against the installed v10 default (`layout.yAxis.gap`); use the real defaults so toggling the flag off/on does not shift the viewport.

- [ ] **Step 3: Wire into ChartCore**

Replace both `_scalePriceOnly` writes (ChartCore.tsx:1050, :1256) with `applyScalePriceOnly(chart, scalePriceOnly.value)`; the existing effect at :1042-1060 that re-applied the y-axis type on toggle now just calls `applyScalePriceOnly` again. Delete the private-field comment at chartController.ts:88-90 and point it at `chart/priceOnlyRange.ts`.

Note: the v9 patch also skipped invisible indicators in range calc for ALL panes. v10's `createRangeImp` does not filter by `visible` either. Candle pane is covered by this task; during Task 10 verification, hide a sub-pane indicator line (eye toggle) and check whether the sub-pane range still tracks the hidden curve. If it does, apply the same `createRange` treatment to sub-panes (compute from visible figures of visible indicators) as a follow-up commit inside this task.

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `npx vitest run src/chart/priceOnlyRange.test.ts` → PASS; `npx tsc --noEmit | grep -c "_scalePriceOnly"` → 0.

```bash
git add -A && git commit -m "feat(chart): scale-price-only via v10 createRange override (patch retired)"
```

---

### Task 9: Styles tree, remaining typecheck burn-down

**Files:**
- Modify: `lib/chartTheme.ts` (klineStyles :42-135), `lib/persist/artifacts.ts`, any file still failing tsc

**Interfaces:**
- Consumes: v10 `Styles` type. Notable renames inside the tree: `indicator.tooltip.text` → `indicator.tooltip.legend` (font/color keys), `indicator.tooltip.icons` → `indicator.tooltip.features: []`, `candle.tooltip` gains `legend`/`features` naming, `crosshair.*.text` keys unchanged, `candle.priceMark.last` gains `compareRule`/`extendTexts` (leave defaults).

- [ ] **Step 1: Rebuild klineStyles against the v10 Styles type**

Let tsc drive: `npx tsc --noEmit 2>&1 | grep chartTheme`. Fix each flagged key using the v10 `Styles` interface in the d.ts as reference. Known changes to apply:

```ts
// v9                                       // v10
candle.tooltip.showRule: TooltipShowRule.None → candle.tooltip.showRule: 'none'
indicator.tooltip.text: { color }             → indicator.tooltip.legend: { color }
indicator.tooltip.icons: []                   → indicator.tooltip.features: []
yAxis: { ...axis }                            → unchanged location (yAxis stays in styles for LOOK; only the log/normal KIND moved to overrideYAxis)
```

- [ ] **Step 2: Full typecheck to zero**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors. Any survivor gets fixed in this task (this is the sweep-up task; consult the mapping table and d.ts).

- [ ] **Step 3: Full unit test run**

Run: `cd frontend && npx vitest run`
Expected: PASS. Fix failures caused by the migration (mock shapes, string literals). Pre-existing unrelated failures: note them, do not mask them.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(chart): v10 styles tree, typecheck clean"
```

---

### Task 10: Live verification pass (the real gate)

**Files:** none (verification only, plus small fixes discovered)

- [ ] **Step 1: Boot the app on the worktree's dev server** (do NOT touch the user's main dev server; use a second port: `npm run dev -- --port 5174`)

- [ ] **Step 2: Drive every affected surface with claude-in-chrome, screenshot each:**

1. Chart loads with candles, volume, RSI panes (data loader init path).
2. Live tick updates move the last candle (subscribeBar path).
3. Scroll left → history pages in (getBars backward path); no duplicate or gap at the seam.
4. TF switch 5m → 1D → 1W (setPeriod path; derived TFs like 2W too).
5. Symbol switch between two epics (setSymbol path; precision correct on y-axis).
6. Future time: pan past the last candle → axis shows projected timestamps natively; crosshair in the blank zone shows projected time (this replaces the v9 patch feature; same acceptance as the 2026-07-15 future-time spec).
7. Indicators: add EMA, MA multi-line, Slope (+ its ACCEL companion), Sessions (blank y-axis pane), Pivot Bands MTF; params edit via settings modal; eye toggle; remove via legend ✕.
8. Scale-price-only: right-click price axis toggle on/off; candle pane fits candles only when on (EMA(200,1H) far away must not compress candles); sub-pane hidden-indicator range check from Task 8 Step 3.
9. Log axis toggle + invert scale (Option+I).
10. Drawings: draw segment/rayLine/fib; weak magnet snaps BELOW a candle low (upstream fix regression check); drag endpoints; delete; templates/defaults menus.
11. Position lines + trade pills + bracket render and drag (positionLines overlay).
12. Backtest: run a backtest, markers/zones/aggregate pills render, click marker → popover, equity pane renders, period shading + axis chip.
13. Alerts: create, drag, cross-tab sanity.
14. Multi-cell layout: split into 2 cells, crosshair sync, date-range sync.
15. Snapshots: camera save + restore into read-only tab (getConvertPictureUrl path).
16. Legend feature-click handler decision from Task 6 Step 4: legend gear/eye/✕ all work via DOM; delete the subscription if truly dead.

- [ ] **Step 3: Fix-forward** any breakage found, committing per fix with `fix(chart): v10 <surface>` messages.

- [ ] **Step 4: Commit + hand to user**

```bash
git add -A && git commit -m "test(chart): v10 migration live verification fixes"
```

Present the screenshot evidence to the user; user does their own pass on the worktree dev server before merge.

---

### Task 11: Merge + memory update

- [ ] **Step 1:** Merge the migration branch/worktree into `main` (fast-forward or merge per user preference at the time), after the user's own verification pass.
- [ ] **Step 2:** Update memory files: `charting-stack.md` (v10, no patches), delete/rewrite the future-time patch note in the session's memory if present, note the facade seam in `charting-stack.md`.
- [ ] **Step 3:** `npm run build` in frontend to confirm production build passes; run backend-affecting nothing (frontend-only change).

---

## v9 usage inventory (reference)

Counts and hot spots from the pre-migration audit (2026-07-15, commit 92afe84):

- Enum value imports: `DomPosition` (8 files, 31 uses), `ActionType` (ChartCore only, 5 action types), `LineType` (12+ files), `IndicatorSeries` (11 files), `TooltipShowRule`, `PolygonType`, `YAxisType` (ToolbarControls), `LoadDataType` (ChartCore).
- Chart methods by count: `getOverlayById` 79 (all in lib/overlays.ts funnel), `convertToPixel` 67, `getIndicatorByPaneId` 56, `getDataList` 51, `overrideIndicator` 41, `overrideOverlay` 32, `getSize` 30, `removeOverlay` 22, `setStyles` 18, `getStyles` 12, `convertFromPixel` 11, `createOverlay` 4 real sites, `getBarSpace` 8, `subscribeAction` 7 (OnTooltipIconClick, OnScroll, OnZoom, OnPaneDrag, OnCrosshairChange), `removeIndicator` 7, `setBarSpace` 5, `getVisibleRange` 6, `setPaneOptions` 3, `setCustomApi` 2, `createIndicator` 3, `applyNewData` 2 (useLiveMarketData:194, overlays:2115), `updateData` 1 (useLiveMarketData:433), `setLoadDataCallback` 1 (ChartCore:2060), `setPriceVolumePrecision` 2, `scrollToTimestamp` 2, `scrollByDistance` 1, `scrollToRealTime` 1, `zoomAtCoordinate` 1, `setZoomEnabled`/`setScrollEnabled` 2 each, `setTimezone` 2, `resize` 1, `getConvertPictureUrl` 1.
- Custom indicators registered: EMA, MA, LR, VWAP, AVWAP, PREV_HL, RSI, PIVOT_BANDS, PIVOT_ANALYSIS, SLOPE, ACCEL, SESSIONS, TIME_HIGHLIGHT (lib/indicators/*), EQUITY (lib/backtest.ts:977). Draw callbacks: RSI, PIVOT_ANALYSIS, SLOPE, ACCEL, SESSIONS, TIME_HIGHLIGHT.
- Custom overlays registered: segment, rayLine, straightLine, rect, fibonacciLine, measure, slope, rangeBand (customOverlays.ts); tradeLine (positionLines.ts); snapshot marker (snapshotMarker.ts); marker/signal/zone/period overlays (backtest.ts).
- Private-API escapes: `chart._scalePriceOnly` (ChartCore 1050, 1256) and `chart._chartStore.setOptions` (overlays.ts 587-590). Both removed by Tasks 8 and 6.
- 21 test files mock 'klinecharts' with enum stubs (list in the Task 2 step).
- v9 patch hunks retired: OverlayView weak-magnet low-side (fixed upstream), YAxisImp scale-price-only (Task 8), XAxis future-time + crosshair (native via setPeriod).
