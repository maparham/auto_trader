# Agent Full Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MCP agents see the live chart (screenshot + numeric state), control the view and indicators programmatically, and reach server-side TA / walk-forward / archives through direct MCP tools.

**Architecture:** Two families. (1) New bridge action groups `chart.*` and `indicator.*` in `frontend/src/agent/` following the existing `drawing.*` provider-injection pattern; a new `ui_screenshot` MCP tool returns a real MCP image block. (2) New direct MCP tools in `backend/auto_trader/api/mcp_server.py` that call the app's own REST routes in-process via `httpx.ASGITransport` (full middleware, zero duplicated validation), plus one genuinely new REST route for named indicator series.

**Tech Stack:** TypeScript/React/klinecharts/vitest (frontend), FastAPI + `mcp` SDK (`MCPServer`, mcp>=2.0) + pytest (backend).

**Spec:** `docs/superpowers/specs/2026-09-14-agent-full-access-design.md`

## Global Constraints

- Never run the full frontend test suite; run only the affected test files (`cd frontend && npx vitest run src/agent/...`).
- Shared worktree: `git add` by explicit path only; never `git stash`/`git clean`; commit to the current branch (`main`).
- No em dashes in UI text, descriptions, or docs prose.
- Frontend typecheck: `cd frontend && npx tsc -b` (judge by per-file parity, `--noEmit` is a no-op).
- Backend tests: `cd backend && python3 -m pytest tests/<file> -q`.
- All `chart.*`/`indicator.*` actions are plain `read`/`write` kind, never `confirm`. No new direct tool touches dealing.
- Action registration must not close over first-render React state; use the provider / ref-per-render idiom (`drawings.ts` header comment explains it).
- Commit messages: existing style, e.g. `feat(agent): ...`, with the Claude trailer from the session guidance.

---

### Task 1: `chart.state` bridge action + FocusedChart provider + App wiring

**Files:**
- Create: `frontend/src/agent/actions/chart.ts`
- Create: `frontend/src/agent/actions/chart.test.ts`
- Modify: `frontend/src/agent/index.ts` (call `registerChartActions()` beside `registerDrawingActions()`)
- Modify: `frontend/src/App.tsx` (~line 2500, next to the `setFocusedDrawingsProvider` effect)

**Interfaces:**
- Consumes: `registerAction`, `ActionError` from `../registry`; `getIndicatorsByPane` from `../../lib/indicators`; `ChartController` (`../../lib/chartController`), `Period`/`ALL_PERIODS`/`periodByResolution` (`../../lib/feed`).
- Produces (used by Tasks 2-4):
  ```ts
  export interface FocusedChart {
    chart: Chart;                    // klinecharts instance (controller.chart, non-null)
    controller: ChartController;
    scope: string;                   // controller.scope
    epic: string;
    cellId: string;
    resolution: string;              // focused cell's period.resolution
    setPeriod: (p: Period) => void;  // App's setPeriod
  }
  export function setFocusedChartProvider(fn: () => FocusedChart | null): void;
  export function registerChartActions(): void;
  function focusedChart(): FocusedChart;  // throws ActionError("NO_FOCUSED_CHART", ...)
  ```

- [ ] **Step 1: Write the failing test**

`frontend/src/agent/actions/chart.test.ts` (module scaffolding mirrors `drawings.test.ts`; the fake chart provides the klinecharts surface `chart.state` reads):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, listActions, invokeAction } from "../registry";
import { registerChartActions, setFocusedChartProvider } from "./chart";

const ctx = { progress: () => {}, signal: new AbortController().signal };

function fakeBars(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600_000,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i,
  }));
}

// Minimal klinecharts double: only what chart.state touches.
function fakeChart(bars = fakeBars(20)) {
  return {
    getDataList: () => bars,
    getVisibleRange: () => ({ from: 5, to: 20, realFrom: 5, realTo: 20 }),
    getBarSpace: () => ({ bar: 8 }),
    // Map<paneId, Map<name, Indicator>> like getIndicatorsByPane builds it —
    // but chart.state must use the real helper, so give it the raw API:
    getIndicators: () => [],
  };
}

function fakeController(chart: unknown) {
  return {
    chart,
    scope: "t1.c1",
    indicators: { value: [{ id: "RSI#a1", type: "RSI" }] },
    indicatorsHidden: { value: false },
  };
}

function provide(chart = fakeChart()) {
  const controller = fakeController(chart);
  setFocusedChartProvider(() => ({
    chart: chart as never,
    controller: controller as never,
    scope: "t1.c1",
    epic: "US100",
    cellId: "c1",
    resolution: "HOUR",
    setPeriod: () => {},
  }));
  return { chart, controller };
}

describe("chart.state", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  it("registers the chart actions", () => {
    expect(listActions().map((a) => a.name)).toContain("chart.state");
  });

  it("errors without a focused chart", async () => {
    setFocusedChartProvider(() => null);
    await expect(invokeAction("chart.state", {}, ctx)).rejects.toThrow(/no focused chart/);
  });

  it("returns epic, resolution, visible range and visible candles", async () => {
    provide();
    const res = (await invokeAction("chart.state", {}, ctx)) as {
      epic: string; resolution: string; cellId: string;
      visibleRange: { from: number; to: number; bars: number };
      candles: Array<{ timestamp: number; open: number; close: number }>;
      indicators: Array<{ id: string; type: string }>;
    };
    expect(res.epic).toBe("US100");
    expect(res.resolution).toBe("HOUR");
    expect(res.candles).toHaveLength(15); // visible slice 5..20
    expect(res.visibleRange.bars).toBe(15);
    expect(res.candles[0].timestamp).toBe(1700000000000 + 5 * 3600_000);
    expect(res.indicators).toEqual([{ id: "RSI#a1", type: "RSI" }]);
  });

  it("caps candles at the bars argument", async () => {
    provide();
    const res = (await invokeAction("chart.state", { bars: 3 }, ctx)) as { candles: unknown[] };
    expect(res.candles).toHaveLength(3); // the LAST 3 visible bars
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts`
Expected: FAIL (`Cannot find module './chart'`).

- [ ] **Step 3: Write the implementation**

`frontend/src/agent/actions/chart.ts`:

```ts
// Agent chart actions: let MCP agents see and steer the focused chart the way
// a human does, as direct calls (never simulated clicks). Same provider
// idiom as drawings.ts: App re-sets the provider every render, handlers read
// through it at call time.
import { ActionError, registerAction } from "../registry";
import type { Chart } from "klinecharts";
import type { ChartController } from "../../lib/chartController";
import type { Period } from "../../lib/feed";

export interface FocusedChart {
  chart: Chart;
  controller: ChartController;
  scope: string;
  epic: string;
  cellId: string;
  resolution: string;
  setPeriod: (p: Period) => void;
}

type Provider = () => FocusedChart | null;
let provider: Provider | null = null;

export function setFocusedChartProvider(fn: Provider): void {
  provider = fn;
}

export function focusedChart(): FocusedChart {
  const cur = provider?.() ?? null;
  if (!cur) {
    throw new ActionError(
      "NO_FOCUSED_CHART",
      "no focused chart (is a chart with a symbol open and focused?)",
    );
  }
  return cur;
}

const MAX_BARS = 500;
const DEFAULT_BARS = 100;

interface Bar {
  timestamp: number; open: number; high: number; low: number; close: number; volume?: number;
}

export function registerChartActions(): void {
  registerAction({
    name: "chart.state",
    description:
      "Numeric state of the focused chart: epic, resolution, visible time range, active indicators (id/type), and the last N visible candles (OHLCV). Read-only. Pair with chart.screenshot for the visual.",
    kind: "read",
    params: {
      type: "object",
      properties: {
        bars: { type: "number", description: `visible candles to return, newest last (default ${DEFAULT_BARS}, max ${MAX_BARS})` },
      },
    },
    handler: async (args) => {
      const { chart, controller, epic, cellId, resolution } = focusedChart();
      const data = chart.getDataList() as Bar[];
      const vr = chart.getVisibleRange();
      const visFrom = Math.max(0, vr.from);
      const visTo = Math.min(data.length, vr.to);
      const visible = data.slice(visFrom, visTo);
      const want = Math.min(MAX_BARS, Math.max(1, Number(args.bars) || DEFAULT_BARS));
      const candles = visible.slice(-want).map((b) => ({
        timestamp: b.timestamp, open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume,
      }));
      return {
        epic, cellId, resolution,
        visibleRange: {
          from: visible[0]?.timestamp ?? null,
          to: visible[visible.length - 1]?.timestamp ?? null,
          bars: visible.length,
        },
        barSpace: chart.getBarSpace().bar,
        indicators: controller.indicators.value.map((i) => ({ id: i.id, type: i.type, inset: i.inset })),
        candles,
        indicatorValues: indicatorValuesFor(chart, controller, candles.length),
      };
    },
  });
}

// The values each indicator instance is DISPLAYING (its klinecharts result
// rows), aligned to the returned candles (newest last). Uses the real chart's
// indicator objects via getIndicatorsByPane; instances the chart hasn't
// computed yet just don't appear.
function indicatorValuesFor(
  chart: Chart,
  controller: ChartController,
  count: number,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const panes = getIndicatorsByPane(chart);
  for (const inst of controller.indicators.value) {
    for (const [, inds] of panes ?? []) {
      const ind = inds.get(inst.id) as { result?: unknown[] } | undefined;
      if (ind?.result?.length) {
        out[inst.id] = ind.result.slice(-count);
        break;
      }
    }
  }
  return out;
}
```

Add the import: `import { getIndicatorsByPane } from "../../lib/indicators";`. In the Task 1 test's fake chart, `getIndicators: () => []` makes `getIndicatorsByPane` return an empty map, so assert `res.indicatorValues` is `{}` in the "returns epic, resolution..." test (add `expect(res.indicatorValues).toEqual({})`); check `getIndicatorsByPane`'s actual chart calls (lib/indicators.ts:74) and extend the fake chart with whatever it reads.

`frontend/src/agent/index.ts`: import and call `registerChartActions()` exactly where `registerDrawingActions()` is called.

`frontend/src/App.tsx`: extend the existing provider effect at ~2500. `setPeriod` is defined at App.tsx:1838 and is stable per render; the effect body re-runs every render so no ref is needed inside this effect (same as the drawings provider):

```tsx
// (inside the same no-deps useEffect that sets setFocusedDrawingsProvider)
setFocusedChartProvider(() =>
  focusedController && focusedController.chart && focusedCell && symbol
    ? {
        chart: focusedController.chart,
        controller: focusedController,
        scope: focusedController.scope,
        epic: symbol.epic,
        cellId: focusedCell.id,
        resolution: focusedCell.period.resolution,
        setPeriod,
      }
    : null,
);
```

Check the actual field for the cell's period at the wiring site: `tab.list` (App.tsx:1243) reports `c.period` per cell; if `focusedCell.period` is a `Period` object use `.resolution`, if it is already a resolution string use it directly. Import `setFocusedChartProvider` from `./agent/actions/chart`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts && npx tsc -b`
Expected: PASS, typecheck parity.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/actions/chart.ts frontend/src/agent/actions/chart.test.ts frontend/src/agent/index.ts frontend/src/App.tsx
git commit -m "feat(agent): chart.state bridge action reads the focused chart"
```

---

### Task 2: `chart.screenshot` bridge action

**Files:**
- Modify: `frontend/src/agent/actions/chart.ts`
- Modify: `frontend/src/agent/actions/chart.test.ts`

**Interfaces:**
- Consumes: `focusedChart()` from Task 1; klinecharts `chart.getConvertPictureUrl(includeOverlay: boolean, type: "png"|"jpeg", backgroundColor: string)` (existing usage: `lib/snapshots.ts:98`).
- Produces: action `chart.screenshot` returning `{ epic, resolution, cellId, mime: string, image_base64: string }` (consumed by Task 5's `ui_screenshot`).

- [ ] **Step 1: Write the failing tests** (append to `chart.test.ts`)

```ts
describe("chart.screenshot", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  it("returns base64 png from getConvertPictureUrl", async () => {
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: (_ov: boolean, type: string) =>
        `data:image/${type};base64,QUJD`,
    });
    provide(chart as never);
    const res = (await invokeAction("chart.screenshot", {}, ctx)) as {
      mime: string; image_base64: string; epic: string;
    };
    expect(res.mime).toBe("image/png");
    expect(res.image_base64).toBe("QUJD");
    expect(res.epic).toBe("US100");
  });

  it("falls back to jpeg when the png exceeds the size budget", async () => {
    const bigPng = "A".repeat(3_000_000);
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: (_ov: boolean, type: string) =>
        type === "png" ? `data:image/png;base64,${bigPng}` : "data:image/jpeg;base64,U01BTEw=",
    });
    provide(chart as never);
    const res = (await invokeAction("chart.screenshot", {}, ctx)) as { mime: string };
    expect(res.mime).toBe("image/jpeg");
  });

  it("errors when export fails", async () => {
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: () => { throw new Error("canvas gone"); },
    });
    provide(chart as never);
    await expect(invokeAction("chart.screenshot", {}, ctx)).rejects.toThrow(/screenshot failed/i);
  });
});
```

Adjust `provide()` from Task 1 to accept a chart argument (it already does).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts`
Expected: new tests FAIL (unknown action `chart.screenshot`), Task 1 tests still PASS.

- [ ] **Step 3: Implement** (append inside `registerChartActions()`)

```ts
// ~2 MB of base64 keeps the bridge frame well under the WS frame budget and
// the image big enough to read; beyond it, drop to jpeg which compresses
// candle charts far harder than png.
const MAX_B64 = 2_000_000;

registerAction({
  name: "chart.screenshot",
  description:
    "PNG of the focused chart exactly as rendered (candles, indicators, panes, drawings). Returns base64; use the ui_screenshot MCP tool to receive it as an image. Read-only.",
  kind: "read",
  params: { type: "object", properties: {} },
  handler: async () => {
    const { chart, epic, cellId, resolution } = focusedChart();
    const grab = (type: "png" | "jpeg") => {
      const url = chart.getConvertPictureUrl(true, type, type === "png" ? "transparent" : "#ffffff");
      const comma = url.indexOf(",");
      const mime = url.slice(5, url.indexOf(";"));
      return { mime, b64: url.slice(comma + 1) };
    };
    try {
      let shot = grab("png");
      if (shot.b64.length > MAX_B64) shot = grab("jpeg");
      return { epic, cellId, resolution, mime: shot.mime, image_base64: shot.b64 };
    } catch (e) {
      throw new ActionError("SCREENSHOT_FAILED", `screenshot failed: ${String(e)}`);
    }
  },
});
```

Note: `"transparent"` renders on the page background; if it comes out black in the real app, use the theme background the way `makeChartThumbnail` passes `"#ffffff"`. Verify visually via the probe in Task 10.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/actions/chart.ts frontend/src/agent/actions/chart.test.ts
git commit -m "feat(agent): chart.screenshot exports the focused chart as base64"
```

---

### Task 3: `chart.timeframe.set` + `chart.range.set`

**Files:**
- Modify: `frontend/src/agent/actions/chart.ts`, `chart.test.ts`

**Interfaces:**
- Consumes: `FocusedChart.setPeriod`; `ALL_PERIODS`, `periodByResolution` from `../../lib/feed`; klinecharts `chart.scrollToTimestamp(ts)`, `chart.setBarSpace(px)`, `chart.getBarSpace().bar`.
- Produces: `chart.timeframe.set {resolution}` and `chart.range.set {from?, to?, bars?}` write actions.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe("chart view writes", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  it("timeframe.set resolves label or resolution and calls setPeriod", async () => {
    const calls: unknown[] = [];
    const chart = fakeChart();
    const controller = fakeController(chart);
    setFocusedChartProvider(() => ({
      chart: chart as never, controller: controller as never, scope: "t1.c1",
      epic: "US100", cellId: "c1", resolution: "HOUR",
      setPeriod: (p) => calls.push(p),
    }));
    await invokeAction("chart.timeframe.set", { resolution: "4H" }, ctx);
    expect(calls).toEqual([{ resolution: "HOUR_4", label: "4H" }]);
    await expect(
      invokeAction("chart.timeframe.set", { resolution: "13m" }, ctx),
    ).rejects.toThrow(/unknown timeframe/);
  });

  it("range.set scrolls to the target and sets bar space for the window", async () => {
    const scrolled: number[] = [];
    let barSpace = 8;
    const chart = Object.assign(fakeChart(), {
      scrollToTimestamp: (ts: number) => scrolled.push(ts),
      setBarSpace: (px: number) => { barSpace = px; },
      getSize: () => ({ width: 800, height: 600 }),
    });
    provide(chart as never);
    const from = 1700000000000, to = from + 100 * 3600_000; // 100 hourly bars
    await invokeAction("chart.range.set", { from, to }, ctx);
    expect(scrolled).toEqual([to]);
    expect(barSpace).toBe(8); // 800px / 100 bars
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts`
Expected: new tests FAIL (unknown actions).

- [ ] **Step 3: Implement** (append inside `registerChartActions()`)

```ts
registerAction({
  name: "chart.timeframe.set",
  description:
    "Switch the focused chart's timeframe. Accepts a resolution (HOUR_4) or its label (4H); see lib/feed ALL_PERIODS.",
  kind: "write",
  params: {
    type: "object",
    properties: { resolution: { type: "string", description: "e.g. HOUR, HOUR_4, DAY, or a label like 1H/4H/1D" } },
    required: ["resolution"],
  },
  handler: async (args) => {
    const f = focusedChart();
    const wanted = String(args.resolution);
    const period =
      periodByResolution(wanted) ??
      ALL_PERIODS.find((p) => p.label.toLowerCase() === wanted.toLowerCase());
    if (!period) {
      throw new ActionError(
        "INVALID_ARGS",
        `unknown timeframe: ${wanted} (one of ${ALL_PERIODS.map((p) => p.label).join(", ")})`,
      );
    }
    f.setPeriod(period);
    return { epic: f.epic, cellId: f.cellId, resolution: period.resolution };
  },
});

registerAction({
  name: "chart.range.set",
  description:
    "Scroll/zoom the focused chart to a time window. from/to are timestamps (ms; seconds accepted). Alternatively bars sets the visible bar count ending at the latest data.",
  kind: "write",
  params: {
    type: "object",
    properties: {
      from: { type: "number", description: "window start timestamp" },
      to: { type: "number", description: "window end timestamp" },
      bars: { type: "number", description: "visible bar count instead of from/to" },
    },
  },
  handler: async (args) => {
    const { chart, epic, cellId, resolution } = focusedChart();
    const toMs = (v: unknown): number | null => {
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ActionError("INVALID_ARGS", "from/to: expected a number");
      return n < 1e12 ? n * 1000 : n;
    };
    const from = toMs(args.from);
    const to = toMs(args.to);
    const width = (chart as unknown as { getSize?: () => { width: number } | null }).getSize?.()?.width ?? 800;
    const data = chart.getDataList() as Array<{ timestamp: number }>;
    if (data.length < 2) throw new ActionError("NO_DATA", "chart has no data to navigate");
    const barMs = data[1].timestamp - data[0].timestamp;
    let bars = Number(args.bars) || 0;
    if (from != null && to != null) {
      if (to <= from) throw new ActionError("INVALID_ARGS", "to must be after from");
      bars = Math.max(2, Math.round((to - from) / barMs));
    }
    if (bars > 0) chart.setBarSpace(Math.max(0.5, Math.min(50, width / bars)));
    if (to != null) chart.scrollToTimestamp(to);
    else if (from != null) chart.scrollToTimestamp(from + (bars || 1) * barMs);
    return { epic, cellId, resolution, bars: bars || undefined };
  },
});
```

Add the imports at the top of `chart.ts`: `import { ALL_PERIODS, periodByResolution } from "../../lib/feed";`.

Caveat for the implementer: scrolling past loaded history triggers the chart's own scroll-back loading; the action does not wait for it. That is acceptable v1 behavior; `chart.state` afterwards shows what actually loaded.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/actions/chart.ts frontend/src/agent/actions/chart.test.ts
git commit -m "feat(agent): chart.timeframe.set and chart.range.set view controls"
```

---

### Task 4: `indicator.*` bridge action group

**Files:**
- Create: `frontend/src/agent/actions/indicators.ts`
- Create: `frontend/src/agent/actions/indicators.test.ts`
- Modify: `frontend/src/agent/index.ts` (call `registerIndicatorActions()`)

**Interfaces:**
- Consumes: `focusedChart()` + `FocusedChart` from Task 1 (import from `./chart`); `addIndicatorInstance`, `removeIndicatorById`, `getIndicatorsByPane` from `../../lib/indicators`; `saveIndicators`, `saveIndicatorConfig`, `loadIndicatorConfigs` from `../../lib/persist/artifacts`; `BASE_TEMPLATES` from `../../lib/customIndicators`.
- Produces: actions `indicator.list`, `indicator.add {type, calcParams?, inset?}`, `indicator.set {id, calcParams?}`, `indicator.remove {id}`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/agent/actions/indicators.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, listActions, invokeAction } from "../registry";
import { setFocusedChartProvider } from "./chart";
import { registerIndicatorActions } from "./indicators";
import * as ind from "../../lib/indicators";
import { loadIndicators } from "../../lib/persist/artifacts";

const ctx = { progress: () => {}, signal: new AbortController().signal };

function makeController() {
  let value: Array<{ id: string; type: string }> = [];
  return {
    chart: {},
    scope: "t1.c1",
    indicatorsHidden: { value: false },
    indicators: { get value() { return value; }, set: (v: typeof value) => { value = v; } },
  };
}

function provide(controller = makeController()) {
  setFocusedChartProvider(() => ({
    chart: controller.chart as never, controller: controller as never,
    scope: "t1.c1", epic: "US100", cellId: "c1", resolution: "HOUR",
    setPeriod: () => {},
  }));
  return controller;
}

describe("indicator actions", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerIndicatorActions();
    localStorage.clear();
  });

  it("registers the four indicator actions", () => {
    expect(listActions().map((a) => a.name).sort()).toEqual([
      "indicator.add", "indicator.list", "indicator.remove", "indicator.set",
    ]);
  });

  it("add mints an instance, persists it, and updates the controller", async () => {
    const controller = provide();
    vi.spyOn(ind, "addIndicatorInstance").mockReturnValue({ id: "RSI#x1", type: "RSI" });
    const res = (await invokeAction("indicator.add", { type: "RSI", calcParams: [14] }, ctx)) as { id: string };
    expect(res.id).toBe("RSI#x1");
    expect(controller.indicators.value).toEqual([{ id: "RSI#x1", type: "RSI" }]);
    expect(loadIndicators("t1.c1")).toEqual([{ id: "RSI#x1", type: "RSI" }]);
  });

  it("add rejects unknown types with the valid list", async () => {
    provide();
    await expect(invokeAction("indicator.add", { type: "WOMBAT" }, ctx)).rejects.toThrow(/RSI/);
  });

  it("remove drops the instance everywhere", async () => {
    const controller = provide();
    controller.indicators.set([{ id: "RSI#x1", type: "RSI" }]);
    vi.spyOn(ind, "removeIndicatorById").mockImplementation(() => {});
    await invokeAction("indicator.remove", { id: "RSI#x1" }, ctx);
    expect(controller.indicators.value).toEqual([]);
  });

  it("remove of an unknown id is NOT_FOUND", async () => {
    provide();
    await expect(invokeAction("indicator.remove", { id: "nope" }, ctx)).rejects.toThrow(/no indicator/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/agent/actions/indicators.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`frontend/src/agent/actions/indicators.ts`:

```ts
// Agent indicator actions: manage the focused chart's indicator instances via
// the same code paths the UI uses (addIndicatorInstance / removeIndicatorById
// + persistence), so agent edits persist and mirror like human edits.
import { ActionError, registerAction } from "../registry";
import { focusedChart } from "./chart";
import {
  addIndicatorInstance,
  removeIndicatorById,
  getIndicatorsByPane,
} from "../../lib/indicators";
import {
  saveIndicators,
  saveIndicatorConfig,
  loadIndicatorConfigs,
} from "../../lib/persist/artifacts";
import { BASE_TEMPLATES } from "../../lib/customIndicators";

// Everything the app can add: the custom templates plus the klinecharts
// built-ins the indicator sidebar offers.
const BUILTIN_TYPES = ["MACD", "BOLL", "VOL", "KDJ", "SAR", "BBI"];
const VALID_TYPES = [...Object.keys(BASE_TEMPLATES), ...BUILTIN_TYPES].sort();

export function registerIndicatorActions(): void {
  registerAction({
    name: "indicator.list",
    description: "Active indicator instances on the focused chart (id, type, calcParams). Read-only.",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => {
      const { controller, scope, epic, cellId } = focusedChart();
      const configs = loadIndicatorConfigs(scope);
      return {
        epic, cellId,
        indicators: controller.indicators.value.map((i) => ({
          id: i.id, type: i.type, inset: i.inset,
          calcParams: configs[i.id]?.calcParams,
        })),
      };
    },
  });

  registerAction({
    name: "indicator.add",
    description:
      `Add an indicator to the focused chart in one call. type: one of ${VALID_TYPES.join(", ")}. calcParams sets the periods (e.g. RSI [14], EMA [21]). Returns the instance id.`,
    kind: "write",
    params: {
      type: "object",
      properties: {
        type: { type: "string", description: "indicator type, e.g. RSI" },
        calcParams: { type: "array", description: "numeric params, e.g. [14]" },
        inset: { type: "boolean", description: "draw inside the candle pane's bottom band" },
      },
      required: ["type"],
    },
    handler: async (args) => {
      const { chart, controller, scope, epic, cellId, resolution } = focusedChart();
      const type = String(args.type);
      if (!VALID_TYPES.includes(type)) {
        throw new ActionError("INVALID_ARGS", `unknown indicator type: ${type} (one of ${VALID_TYPES.join(", ")})`);
      }
      const calcParams = Array.isArray(args.calcParams)
        ? (args.calcParams as unknown[]).map(Number).filter(Number.isFinite)
        : undefined;
      const inst = addIndicatorInstance(chart, scope, epic, type, {
        config: calcParams ? { calcParams } : undefined,
        forceHidden: controller.indicatorsHidden.value,
        resolution,
      });
      if (!inst) throw new ActionError("ADD_FAILED", `could not add ${type}`);
      const next = [...controller.indicators.value, inst];
      controller.indicators.set(next);
      saveIndicators(scope, next);
      return { id: inst.id, type: inst.type, epic, cellId };
    },
  });

  registerAction({
    name: "indicator.set",
    description: "Patch an indicator instance's calcParams (see indicator.list for ids).",
    kind: "write",
    params: {
      type: "object",
      properties: {
        id: { type: "string" },
        calcParams: { type: "array", description: "new numeric params" },
      },
      required: ["id", "calcParams"],
    },
    handler: async (args) => {
      const { chart, scope, cellId } = focusedChart();
      const id = String(args.id);
      const calcParams = (args.calcParams as unknown[]).map(Number);
      if (calcParams.some((n) => !Number.isFinite(n))) {
        throw new ActionError("INVALID_ARGS", "calcParams: numbers required");
      }
      let paneId: string | null = null;
      for (const [pid, inds] of getIndicatorsByPane(chart) ?? []) {
        if (inds.has(id)) { paneId = pid; break; }
      }
      if (!paneId) throw new ActionError("NOT_FOUND", `no indicator with id ${id}`);
      chart.overrideIndicator({ name: id, calcParams }, paneId);
      const saved = loadIndicatorConfigs(scope)[id] ?? {};
      saveIndicatorConfig(scope, id, { ...saved, calcParams });
      return { id, calcParams, cellId };
    },
  });

  registerAction({
    name: "indicator.remove",
    description: "Remove one indicator instance from the focused chart by id.",
    kind: "write",
    params: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (args) => {
      const { chart, controller, scope, cellId } = focusedChart();
      const id = String(args.id);
      const cur = controller.indicators.value;
      if (!cur.some((i) => i.id === id)) {
        throw new ActionError("NOT_FOUND", `no indicator with id ${id}`);
      }
      removeIndicatorById(chart, scope, id);
      const next = cur.filter((i) => i.id !== id);
      controller.indicators.set(next);
      saveIndicators(scope, next);
      return { removed: id, cellId };
    },
  });
}
```

Note for the implementer: check `chart.overrideIndicator`'s exact signature in the installed klinecharts version (v10 may take `{ id }` or `{ name }` plus paneId; `frontend/src/lib/indicators.ts` `overrideExtend` at the top of the file shows the working call shape — copy it).

Register in `frontend/src/agent/index.ts` beside the other groups.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/agent/actions/indicators.test.ts src/agent/actions/chart.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/actions/indicators.ts frontend/src/agent/actions/indicators.test.ts frontend/src/agent/index.ts
git commit -m "feat(agent): indicator.list/add/set/remove bridge actions"
```

---

### Task 5: `ui_screenshot` MCP tool (image content block)

**Files:**
- Modify: `backend/auto_trader/api/mcp_server.py`
- Test: `backend/tests/test_mcp_screenshot.py`

**Interfaces:**
- Consumes: `HUB.request("invoke", {"action": "chart.screenshot", "args": {}, "readOnly": True})` returning `{"epic", "cellId", "resolution", "mime", "image_base64"}` (Task 2's shape).
- Produces: MCP tool `ui_screenshot(session: str | None = None)` returning `[ImageContent, TextContent]`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_mcp_screenshot.py` (copy the HUB-monkeypatch style from the existing mcp/bridge tests; find them with `grep -rl "mcp_server" backend/tests`):

```python
import base64

import pytest

from auto_trader.api import mcp_server


class FakeHub:
    def __init__(self, result=None, exc=None):
        self.result = result
        self.exc = exc
        self.calls = []

    async def request(self, kind, payload, session_id=None):
        self.calls.append((kind, payload, session_id))
        if self.exc:
            raise self.exc
        return self.result


@pytest.mark.asyncio
async def test_ui_screenshot_returns_image_block(monkeypatch):
    png = base64.b64encode(b"\x89PNG fake").decode()
    hub = FakeHub(result={
        "epic": "US100", "cellId": "c1", "resolution": "HOUR",
        "mime": "image/png", "image_base64": png,
    })
    monkeypatch.setattr(mcp_server, "HUB", hub)
    blocks = await mcp_server.ui_screenshot()
    image = next(b for b in blocks if getattr(b, "type", "") == "image")
    text = next(b for b in blocks if getattr(b, "type", "") == "text")
    assert image.data == png
    assert image.mimeType == "image/png"
    assert "US100" in text.text and "HOUR" in text.text
    # It must go through the readOnly invoke path:
    kind, payload, _ = hub.calls[0]
    assert kind == "invoke"
    assert payload == {"action": "chart.screenshot", "args": {}, "readOnly": True}


@pytest.mark.asyncio
async def test_ui_screenshot_no_tab_is_friendly(monkeypatch):
    from auto_trader.api.agent_bridge import NoTabError
    monkeypatch.setattr(mcp_server, "HUB", FakeHub(exc=NoTabError("no UI session connected")))
    with pytest.raises(RuntimeError, match="no UI session"):
        await mcp_server.ui_screenshot()
```

If the MCP tool decorator wraps the function so `mcp_server.ui_screenshot` is not directly awaitable, do what the existing mcp_server tests do to reach the underlying function (check them first); if there are none for direct calls, expose the plain async function as `_ui_screenshot_impl` and register the tool as a thin wrapper, testing `_ui_screenshot_impl`.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_mcp_screenshot.py -q`
Expected: FAIL (no `ui_screenshot`).

- [ ] **Step 3: Implement** (append to `mcp_server.py`)

```python
from mcp.types import ImageContent, TextContent


@mcp.tool()
async def ui_screenshot(session: str | None = None) -> list:
    """Screenshot of the focused chart in the connected tab, as an image the
    client renders natively. Pairs with ui_read_state("chart.state") for the
    numbers behind the pixels."""
    try:
        res = await HUB.request(
            "invoke",
            {"action": "chart.screenshot", "args": {}, "readOnly": True},
            session_id=session,
        )
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e
    return [
        ImageContent(type="image", data=res["image_base64"], mimeType=res["mime"]),
        TextContent(
            type="text",
            text=f"{res['epic']} {res['resolution']} (cell {res['cellId']})",
        ),
    ]
```

If `MCPServer` refuses a `list` return annotation for content blocks, check the mcp SDK's structured-content rules (`python3 -c "import mcp, inspect; ..."` or the SDK docs in site-packages) and use the SDK's sanctioned way to return mixed content; the test asserts on the blocks, not the transport.

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_mcp_screenshot.py -q`
Expected: PASS. Also run the existing mcp server tests: `python3 -m pytest tests/ -k "mcp" -q`.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/mcp_server.py backend/tests/test_mcp_screenshot.py
git commit -m "feat(mcp): ui_screenshot returns the focused chart as an image block"
```

---

### Task 6: named indicator series seam + REST route

**Files:**
- Create: `backend/auto_trader/indicators/series_api.py`
- Modify: `backend/auto_trader/api/routers/charts.py` (new route `GET /api/indicators/series`)
- Test: `backend/tests/test_indicator_series_api.py`

**Interfaces:**
- Consumes: `SERIES_INDICATORS` (`indicators/registry.py`), `ema_series/sma_series/rsi_series/atr_series` (`indicators/core.py`), `resolution_seconds` (`core/candle_aggregate.py`), `deps._fetch_symbol_candles` (as `routers/charts.py:95` uses it).
- Produces:
  ```python
  # series_api.py
  SIMPLE = {"EMA", "SMA", "MA", "RSI", "ATR"}
  def compute_indicator_series(
      candles: Sequence[Candle], indicator: str, params: dict, resolution: str,
  ) -> dict:  # {"indicator", "outputs": {name: [float|None]}, "timestamps": [int]}
  def valid_indicator_names() -> list[str]  # sorted(SIMPLE | SERIES_INDICATORS.keys())
  ```
  Route: `GET /api/indicators/series?epic&resolution&indicator&length&bars&from_ts&to_ts&broker` returning `{"epic", "resolution", "indicator", "timestamps", "outputs"}`. Raises 422 on unknown indicator naming the valid ones.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_indicator_series_api.py` (find the Candle constructor used by existing indicator tests: `grep -rn "Candle(" backend/tests | head` and copy that fixture style):

```python
import pytest

from auto_trader.indicators.series_api import compute_indicator_series, valid_indicator_names
# Candle import: match what backend/tests' existing indicator tests import.
from auto_trader.core.models import Candle  # adjust to the real module if different


def mk_candles(n=50, start=1_700_000_000):
    out = []
    for i in range(n):
        px = 100 + (i % 7)
        out.append(Candle(
            timestamp=start + i * 3600, open=px, high=px + 1, low=px - 1,
            close=px + 0.5, volume=1000,
        ))
    return out


def test_rsi_series_shape():
    res = compute_indicator_series(mk_candles(), "RSI", {"length": 14}, "HOUR")
    assert res["indicator"] == "RSI"
    assert len(res["timestamps"]) == 50
    vals = res["outputs"]["rsi"]
    assert len(vals) == 50
    assert vals[0] is None            # warm-up
    assert vals[-1] is not None
    assert 0 <= vals[-1] <= 100


def test_atr_uses_registry_or_core():
    res = compute_indicator_series(mk_candles(), "ATR", {"length": 14}, "HOUR")
    assert any(v is not None for v in next(iter(res["outputs"].values())))


def test_unknown_indicator_lists_valid_names():
    with pytest.raises(ValueError) as e:
        compute_indicator_series(mk_candles(), "WOMBAT", {}, "HOUR")
    assert "RSI" in str(e.value)


def test_valid_names_cover_registry():
    names = valid_indicator_names()
    assert "ATR" in names and "SR_LEVELS" in names and "EMA" in names
```

Fix the `Candle` import to the real model module before running (grep as above); the plan's test asserts behavior, not the import path.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_indicator_series_api.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`backend/auto_trader/indicators/series_api.py`:

```python
"""Named indicator series for agents: 'RSI(14) on these candles' without
composing expression syntax. One seam over the two existing layers: the
simple core series (EMA/SMA/RSI/ATR) and the SERIES_INDICATORS registry."""
from __future__ import annotations

from typing import Sequence

from ..core.candle_aggregate import resolution_seconds
from .core import atr_series, ema_series, rsi_series, sma_series
from .registry import SERIES_INDICATORS

SIMPLE = {"EMA", "SMA", "MA", "RSI", "ATR"}


def valid_indicator_names() -> list[str]:
    return sorted(SIMPLE | set(SERIES_INDICATORS))


def compute_indicator_series(
    candles: Sequence, indicator: str, params: dict, resolution: str,
) -> dict:
    ind = indicator.upper()
    timestamps = [c.timestamp for c in candles]
    if ind in SIMPLE:
        length = int(params.get("length", 14))
        closes = [c.close for c in candles]
        if ind == "RSI":
            outputs = {"rsi": rsi_series(closes, length)}
        elif ind == "EMA":
            outputs = {"ema": ema_series(closes, length)}
        elif ind in ("SMA", "MA"):
            outputs = {"sma": sma_series(closes, length)}
        else:  # ATR
            outputs = {"atr": atr_series(candles, length)}
        return {"indicator": ind, "timestamps": timestamps, "outputs": outputs}
    spec = SERIES_INDICATORS.get(ind)
    if spec is None:
        raise ValueError(
            f"unknown indicator: {indicator} (one of {', '.join(valid_indicator_names())})"
        )
    cfg = spec.parse_config(params or {})
    bar_hours = resolution_seconds(resolution) / 3600.0
    outputs = {
        out: spec.series(cfg, out, candles, bar_hours) for out in spec.outputs(cfg)
    }
    return {"indicator": ind, "timestamps": timestamps, "outputs": outputs}
```

Check `spec.parse_config`'s actual input shape (it parses the frontend's saved config dict; see `_atr.parse_atr_config`) and adapt the params pass-through so `{"length": 14}`-style params reach it; if parse_config wants the SavedIndicatorConfig shape, wrap as `{"calcParams": [...]}` accordingly and document the accepted params per family in the route's docstring.

Route in `routers/charts.py` (same dependency style as `candles` at :74):

```python
@router.get("/api/indicators/series")
async def indicator_series(
    epic: str,
    resolution: str = Query(Resolution.MINUTE_5.value),
    indicator: str = Query(...),
    length: int | None = Query(None),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None),
    to_ts: int | None = Query(None),
    broker_id: str = Depends(broker_query),
) -> dict:
    """Named indicator series over candles (agent-facing). params today:
    length for EMA/SMA/RSI/ATR; registry indicators use their defaults."""
    loaded = await deps._fetch_symbol_candles(
        broker_id, epic, resolution, bars, from_ts, to_ts, "mid",
        degraded={}, budget_s=CHART_FILL_BUDGET_S, partial={},
        max_fill_chunks=CHART_PASSTHROUGH_MAX_FILL_CHUNKS,
    )
    if not loaded:
        raise HTTPException(404, f"no data for epic '{epic}'")
    params = {"length": length} if length is not None else {}
    try:
        res = compute_indicator_series(loaded, indicator, params, resolution)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"epic": epic, "resolution": resolution, **res}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_indicator_series_api.py -q`
Expected: PASS. Also run the charts router tests if any exist (`python3 -m pytest tests/ -k "charts or candles" -q`).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/series_api.py backend/auto_trader/api/routers/charts.py backend/tests/test_indicator_series_api.py
git commit -m "feat(api): named indicator series endpoint over the registry"
```

---

### Task 7: direct MCP tools `ta_candles` + `ta_indicator_series`

**Files:**
- Modify: `backend/auto_trader/api/mcp_server.py`
- Modify: `backend/auto_trader/api/app.py` (call `mcp_server.configure_direct_tools(app)` after the app is built)
- Test: `backend/tests/test_mcp_direct_tools.py`

**Interfaces:**
- Consumes: the app's own REST routes in-process.
- Produces:
  ```python
  # mcp_server.py
  def configure_direct_tools(app) -> None      # stores the ASGI app for _api_get
  async def _api_get(path: str, params: dict) -> object   # httpx.ASGITransport GET, raises RuntimeError with the response body on >=400
  async def ta_candles(epic, resolution="HOUR", bars=200, broker=None, from_ts=None, to_ts=None)
  async def ta_indicator_series(epic, indicator, resolution="HOUR", length=None, bars=500, broker=None)
  ```

- [ ] **Step 1: Write the failing test**

`backend/tests/test_mcp_direct_tools.py`:

```python
import pytest
from fastapi import FastAPI

from auto_trader.api import mcp_server


def tiny_app():
    app = FastAPI()

    @app.get("/api/candles")
    async def candles(epic: str, resolution: str, bars: int):
        return [{"timestamp": 1, "open": 1, "high": 2, "low": 0.5, "close": 1.5}]

    @app.get("/api/indicators/series")
    async def series(epic: str, indicator: str, resolution: str, bars: int):
        if indicator == "WOMBAT":
            from fastapi import HTTPException
            raise HTTPException(422, "unknown indicator: WOMBAT (one of ATR, RSI)")
        return {"epic": epic, "indicator": indicator, "timestamps": [1], "outputs": {"rsi": [None]}}

    return app


@pytest.mark.asyncio
async def test_ta_candles_roundtrip():
    mcp_server.configure_direct_tools(tiny_app())
    rows = await mcp_server.ta_candles(epic="US100", resolution="HOUR", bars=10)
    assert rows[0]["close"] == 1.5


@pytest.mark.asyncio
async def test_ta_indicator_series_error_carries_body():
    mcp_server.configure_direct_tools(tiny_app())
    with pytest.raises(RuntimeError, match="unknown indicator: WOMBAT"):
        await mcp_server.ta_indicator_series(epic="US100", indicator="WOMBAT")
```

(Same note as Task 5 if the tool decorator hides the plain function.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_mcp_direct_tools.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement** (append to `mcp_server.py`)

```python
import json

import httpx

_ASGI_APP = None


def configure_direct_tools(app) -> None:
    """Give the direct (no-tab) tools the FastAPI app to call in-process."""
    global _ASGI_APP
    _ASGI_APP = app


async def _api_get(path: str, params: dict) -> object:
    if _ASGI_APP is None:
        raise RuntimeError("direct tools not configured (server still starting?)")
    clean = {k: v for k, v in params.items() if v is not None}
    transport = httpx.ASGITransport(app=_ASGI_APP)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        r = await client.get(path, params=clean)
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except json.JSONDecodeError:
            detail = r.text
        raise RuntimeError(f"{path} -> {r.status_code}: {detail}")
    return r.json()


@mcp.tool()
async def ta_candles(
    epic: str, resolution: str = "HOUR", bars: int = 200,
    broker: str | None = None, from_ts: int | None = None, to_ts: int | None = None,
) -> object:
    """OHLCV candles for an epic (no browser tab needed). from_ts/to_ts are
    unix seconds; without them the most recent `bars` are returned."""
    return await _api_get("/api/candles", {
        "epic": epic, "resolution": resolution, "bars": bars,
        "broker": broker, "from_ts": from_ts, "to_ts": to_ts,
    })


@mcp.tool()
async def ta_indicator_series(
    epic: str, indicator: str, resolution: str = "HOUR",
    length: int | None = None, bars: int = 500, broker: str | None = None,
) -> object:
    """A named indicator series (RSI, EMA, ATR, SR_LEVELS, PIVOT_BANDS, ...)
    computed server-side over the epic's candles, aligned to timestamps."""
    return await _api_get("/api/indicators/series", {
        "epic": epic, "indicator": indicator, "resolution": resolution,
        "length": length, "bars": bars, "broker": broker,
    })
```

Check the broker query param name the routes actually use (`broker_query` dependency in `deps.py`; it may be `broker` or `broker_id`) and match it in `_api_get` callers. In `app.py`, right after the app and routers are assembled (near the `/mcp` mount at ~:231), add `mcp_server.configure_direct_tools(app)`. Confirm `httpx` is already a backend dependency (`grep httpx backend/pyproject.toml backend/requirements*.txt`); it is a FastAPI test dependency almost certainly present.

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_mcp_direct_tools.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/mcp_server.py backend/auto_trader/api/app.py backend/tests/test_mcp_direct_tools.py
git commit -m "feat(mcp): direct ta_candles and ta_indicator_series tools"
```

---

### Task 8: direct MCP tools for pattern search/scan

**Files:**
- Modify: `backend/auto_trader/api/mcp_server.py`
- Test: extend `backend/tests/test_mcp_direct_tools.py`

**Interfaces:**
- Consumes: `_api_get` from Task 7 plus a matching `_api_post(path, body)` this task adds; REST routes `POST /api/patterns/search` (`routers/patterns.py:112`) and `POST /api/patterns/scan` + `GET /api/patterns/families` (`routers/pattern_presets.py`).
- Produces:
  ```python
  async def _api_post(path: str, body: dict) -> object
  async def ta_pattern_search(body: dict) -> object   # body = PatternSearchRequest JSON
  async def ta_pattern_scan(body: dict) -> object     # body = scan request JSON
  async def ta_pattern_families() -> object
  ```
  The tool docstrings must tell the agent the request body is the same JSON the REST route takes and that a 422 echoes the schema errors (FastAPI validation), so it can self-correct.

- [ ] **Step 1: Write the failing tests** (append to `test_mcp_direct_tools.py`)

```python
@pytest.mark.asyncio
async def test_ta_pattern_search_posts_body():
    app = tiny_app()

    @app.post("/api/patterns/search")
    async def search(body: dict):
        return {"matches": [], "echo": body["mode"]}

    mcp_server.configure_direct_tools(app)
    res = await mcp_server.ta_pattern_search(body={"mode": "shape"})
    assert res["echo"] == "shape"


@pytest.mark.asyncio
async def test_ta_pattern_search_422_surfaces_validation():
    app = tiny_app()

    @app.post("/api/patterns/search")
    async def search():
        from fastapi import HTTPException
        raise HTTPException(422, [{"loc": ["body", "mode"], "msg": "field required"}])

    mcp_server.configure_direct_tools(app)
    with pytest.raises(RuntimeError, match="field required"):
        await mcp_server.ta_pattern_search(body={})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_mcp_direct_tools.py -q`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** (append to `mcp_server.py`)

```python
async def _api_post(path: str, body: dict) -> object:
    if _ASGI_APP is None:
        raise RuntimeError("direct tools not configured (server still starting?)")
    transport = httpx.ASGITransport(app=_ASGI_APP)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        r = await client.post(path, json=body)
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except (json.JSONDecodeError, AttributeError):
            detail = r.text
        raise RuntimeError(f"{path} -> {r.status_code}: {detail}")
    return r.json()


@mcp.tool()
async def ta_pattern_search(body: dict) -> object:
    """Pattern search (POST /api/patterns/search request JSON, verbatim).
    Invalid bodies come back with FastAPI's field-level errors; fix and retry."""
    return await _api_post("/api/patterns/search", body)


@mcp.tool()
async def ta_pattern_scan(body: dict) -> object:
    """Pattern scan across markets (POST /api/patterns/scan request JSON)."""
    return await _api_post("/api/patterns/scan", body)


@mcp.tool()
async def ta_pattern_families() -> object:
    """The scan's pattern families and preset definitions."""
    return await _api_get("/api/patterns/families", {})
```

Fix `_api_get`'s error branch to tolerate a list detail (the 422 shape) the same way `_api_post` does — `detail` may be a list of dicts; `str(detail)` is fine, the tests match on the message substring. Check the exact scan/families paths in `routers/pattern_presets.py` (:121 scan, :45 families per the exploration; verify prefixes).

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_mcp_direct_tools.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/mcp_server.py backend/tests/test_mcp_direct_tools.py
git commit -m "feat(mcp): direct pattern search/scan/families tools"
```

---

### Task 9: walk-forward + archive direct MCP tools

**Files:**
- Modify: `backend/auto_trader/api/mcp_server.py`
- Test: extend `backend/tests/test_mcp_direct_tools.py`

**Interfaces:**
- Consumes: `_api_get`/`_api_post`; REST routes `POST /api/backtest/walkforward/jobs` (`routers/backtest.py:1037`), `GET .../jobs/{job_id}` (:1147), `POST .../jobs/{job_id}/cancel` (:1170), `GET .../jobs/{job_id}/fold` (:1183), archives `GET /api/backtest/walkforward/archive[/{id}]` (:1207,:1213), backtest archive routes at `routers/backtest.py:653-678`, sweep archive at :700-730 (verify exact paths when implementing).
- Produces:
  ```python
  async def wf_run(body: dict) -> object          # -> {"job_id": ...}
  async def wf_status(job_id: str, cursor: int = 0) -> object
  async def wf_cancel(job_id: str) -> object
  async def wf_fold(job_id: str, key: str) -> object
  async def runs_list(kind: str = "backtest", epic: str | None = None, limit: int = 20) -> object
  async def run_get(kind: str, run_id: str) -> object
  ```

- [ ] **Step 1: Write the failing tests** (append; same tiny-app style — register fake `/api/backtest/walkforward/jobs` POST returning `{"job_id": "wf1"}`, a GET status route, and archive routes; assert `wf_run` returns the job id, `wf_status` hits the right path, `runs_list` maps `kind` to the right archive path and rejects an unknown kind with a `ValueError` listing the valid kinds)

```python
@pytest.mark.asyncio
async def test_wf_run_and_status():
    app = tiny_app()

    @app.post("/api/backtest/walkforward/jobs")
    async def submit(body: dict):
        return {"job_id": "wf1"}

    @app.get("/api/backtest/walkforward/jobs/{job_id}")
    async def status(job_id: str, cursor: int = 0):
        return {"job_id": job_id, "state": "running", "cursor": cursor}

    mcp_server.configure_direct_tools(app)
    sub = await mcp_server.wf_run(body={"epic": "US100"})
    assert sub["job_id"] == "wf1"
    st = await mcp_server.wf_status(job_id="wf1", cursor=3)
    assert st["state"] == "running" and st["cursor"] == 3


@pytest.mark.asyncio
async def test_runs_list_kinds():
    app = tiny_app()

    @app.get("/api/backtest/walkforward/archive")
    async def arch(limit: int = 50, epic: str | None = None):
        return [{"id": "w1"}]

    mcp_server.configure_direct_tools(app)
    rows = await mcp_server.runs_list(kind="walkforward")
    assert rows == [{"id": "w1"}]
    with pytest.raises(ValueError, match="backtest, sweep, walkforward"):
        await mcp_server.runs_list(kind="wombat")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_mcp_direct_tools.py -q`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** (append to `mcp_server.py`)

```python
_ARCHIVES = {
    "backtest": "/api/backtest/archive",
    "sweep": "/api/backtest/sweep/archive",
    "walkforward": "/api/backtest/walkforward/archive",
}


@mcp.tool()
async def wf_run(body: dict) -> object:
    """Start a walk-forward job (POST /api/backtest/walkforward/jobs request
    JSON: a BacktestRequest with the walkforward block). Returns {job_id};
    poll wf_status until state is finished."""
    return await _api_post("/api/backtest/walkforward/jobs", body)


@mcp.tool()
async def wf_status(job_id: str, cursor: int = 0) -> object:
    """Walk-forward job status + incremental fold rows from cursor."""
    return await _api_get(f"/api/backtest/walkforward/jobs/{job_id}", {"cursor": cursor})


@mcp.tool()
async def wf_cancel(job_id: str) -> object:
    """Cancel a running walk-forward job."""
    return await _api_post(f"/api/backtest/walkforward/jobs/{job_id}/cancel", {})


@mcp.tool()
async def wf_fold(job_id: str, key: str) -> object:
    """Detail for one fold of a walk-forward job."""
    return await _api_get(f"/api/backtest/walkforward/jobs/{job_id}/fold", {"key": key})


@mcp.tool()
async def runs_list(kind: str = "backtest", epic: str | None = None, limit: int = 20) -> object:
    """List archived runs. kind: backtest, sweep, walkforward."""
    base = _ARCHIVES.get(kind)
    if base is None:
        raise ValueError(f"unknown kind: {kind} (one of {', '.join(sorted(_ARCHIVES))})")
    return await _api_get(base, {"epic": epic, "limit": limit})


@mcp.tool()
async def run_get(kind: str, run_id: str) -> object:
    """One archived run's full record."""
    base = _ARCHIVES.get(kind)
    if base is None:
        raise ValueError(f"unknown kind: {kind} (one of {', '.join(sorted(_ARCHIVES))})")
    return await _api_get(f"{base}/{run_id}", {})
```

Verify the backtest and sweep archive paths against `routers/backtest.py:653-730` (`grep -n "archive" backend/auto_trader/api/routers/backtest.py`) and fix `_ARCHIVES` to the real paths before committing.

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_mcp_direct_tools.py tests/test_mcp_screenshot.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/mcp_server.py backend/tests/test_mcp_direct_tools.py
git commit -m "feat(mcp): walk-forward and run-archive direct tools"
```

---

### Task 10: probe + docs + end-to-end check

**Files:**
- Modify: `backend/scripts/agent_bridge_probe.py`
- Modify: `CLAUDE.md` (Agent UI Bridge section)

**Interfaces:**
- Consumes: everything above.
- Produces: `--screenshot [PATH]` flag (calls `ui_screenshot`, writes the PNG); docs describing both tool families.

- [ ] **Step 1: Extend the probe**

In `agent_bridge_probe.py`, add a `--screenshot` argument (default path `chart.png`): call the `ui_screenshot` tool, find the image content block in the MCP result, base64-decode, write the file, print size and the text block. Follow the existing `--invoke` code style in the file.

- [ ] **Step 2: Update CLAUDE.md**

Rewrite the Agent UI Bridge section: correct the action count and list the groups (`backtest.*`, `sweep.*`, dealing, `drawing.*`, `chart.*`, `indicator.*`, app shell); document the direct tool family (`ta_*`, `wf_*`, `runs_list`/`run_get`, `ui_screenshot`); extend the agent recipe with the analyse-a-chart flow: `market.select` -> `chart.timeframe.set` -> `indicator.add` -> `chart.state` + `ui_screenshot` -> iterate. Keep the existing terse style; no em dashes.

- [ ] **Step 3: End-to-end check (requires the dev stack running and a tab open)**

```bash
cd backend && python3 -m scripts.agent_bridge_probe --screenshot /tmp/chart.png
python3 -m scripts.agent_bridge_probe --invoke chart.state --args '{}'
python3 -m scripts.agent_bridge_probe --invoke indicator.add --args '{"type":"RSI","calcParams":[14]}'
```

Expected: a readable PNG of the focused chart (open it), chart.state JSON matching the visible chart, and an RSI pane appearing live in the browser. If the stack is not running, note that in the final report instead of skipping silently.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/agent_bridge_probe.py CLAUDE.md
git commit -m "docs(agent): document chart vision + direct MCP tool families; probe --screenshot"
```
