# Visible Range Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a TradingView-style quick date-range bar (`1D 5D 1M 3M 6M YTD 1Y All` + "go to date" calendar) to each chart cell that switches the interval and fits the visible window in one click.

**Architecture:** A new presentational `ChartRangeBar` component renders as a hover-revealed bottom strip inside each `ChartCore` cell. A pure `rangeWindow()` helper maps a button to `{ resolution, fromTs, toTs, wantBars }`. Picking a button changes the focused cell's interval through the existing `setPeriod` path, requests a window-sized initial fetch, and fits the visible window with the existing `applyVisibleRange()` helper once data lands. The calendar scrolls to a chosen date without changing interval.

**Tech Stack:** React + TypeScript (Vite), `@klinecharts/pro`, existing `chartSync.ts` / `feed.ts` helpers, Vitest (unit), Playwright (e2e).

## Global Constraints

- All six target resolutions already exist in `frontend/src/lib/feed.ts` `PERIODS` and are non-`liveOnly`: `MINUTE`, `MINUTE_5`, `MINUTE_30`, `HOUR`, `HOUR_4`, `DAY`. Do NOT add new resolutions.
- Window fitting MUST go through `applyVisibleRange(chart, fromTs, toTs)` in `frontend/src/lib/chartSync.ts`. klinecharts v9 has no `setVisibleRange`; do not call it.
- Timestamps in klinecharts bar data (`KLineData.timestamp`) are **milliseconds**. `feed.ts` `fetchRecent`/`fetchRange` take **seconds** (`from_ts`/`to_ts`). Keep the units straight at every boundary.
- The bar acts on the **focused cell only**. Interval switch stays local; window changes propagate to siblings only via the existing `onRange` broadcast when "Sync date range" is on — no new cross-cell wiring.
- `MAX_BARS = 2500` hard cap on any single initial fetch; `ALL` is bounded by this cap (≈ deep history, not unbounded).
- Follow existing code style: no new deps, no inline styles where a CSS class fits the existing `index.css` pattern, plain copy, no shadows (see UX conventions).

---

### Task 1: `rangeWindow` pure helper

The isolated, testable core: maps a range key + "now" to the resolution, window edges, and the number of bars to fetch.

**Files:**
- Create: `frontend/src/lib/rangeWindow.ts`
- Test: `frontend/src/lib/rangeWindow.test.ts`

**Interfaces:**
- Produces:
  - `type RangeKey = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "All"`
  - `const RANGE_KEYS: RangeKey[]` (display order)
  - `interface RangeWindow { resolution: string; fromTs: number; toTs: number; wantBars: number }` — `fromTs`/`toTs` in **ms**, `resolution` is a `feed.ts` resolution string.
  - `function rangeWindow(key: RangeKey, nowMs: number): RangeWindow`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/rangeWindow.test.ts
import { describe, it, expect } from "vitest";
import { rangeWindow, RANGE_KEYS } from "./rangeWindow";

const DAY = 86_400_000;
// Fixed "now": 2026-06-30T12:00:00Z
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);

describe("rangeWindow", () => {
  it("exposes the eight keys in TV display order", () => {
    expect(RANGE_KEYS).toEqual(["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "All"]);
  });

  it("pairs each key with the agreed resolution", () => {
    const res = (k: any) => rangeWindow(k, NOW).resolution;
    expect(res("1D")).toBe("MINUTE");
    expect(res("5D")).toBe("MINUTE_5");
    expect(res("1M")).toBe("MINUTE_30");
    expect(res("3M")).toBe("HOUR");
    expect(res("6M")).toBe("HOUR_4");
    expect(res("YTD")).toBe("DAY");
    expect(res("1Y")).toBe("DAY");
    expect(res("All")).toBe("DAY");
  });

  it("sets toTs to now and fromTs back by the window", () => {
    expect(rangeWindow("1D", NOW).toTs).toBe(NOW);
    expect(rangeWindow("1D", NOW).fromTs).toBe(NOW - DAY);
    expect(rangeWindow("5D", NOW).fromTs).toBe(NOW - 5 * DAY);
  });

  it("anchors YTD at Jan 1 of the current UTC year", () => {
    expect(rangeWindow("YTD", NOW).fromTs).toBe(Date.UTC(2026, 0, 1));
  });

  it("caps wantBars at MAX_BARS (2500)", () => {
    // 3M of hourly calendar time is ~2160; All of daily over 5y is bounded too.
    for (const k of RANGE_KEYS) {
      expect(rangeWindow(k, NOW).wantBars).toBeLessThanOrEqual(2500);
      expect(rangeWindow(k, NOW).wantBars).toBeGreaterThan(0);
    }
  });

  it("sizes wantBars to cover the window at the paired interval (1D@1m ≈ 1440 + buffer)", () => {
    const w = rangeWindow("1D", NOW);
    expect(w.wantBars).toBeGreaterThanOrEqual(1440);
    expect(w.wantBars).toBeLessThanOrEqual(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/rangeWindow.test.ts`
Expected: FAIL — `Cannot find module './rangeWindow'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/rangeWindow.ts
// Pure mapping from a TradingView-style range button to the interval to switch
// to, the visible window to fit, and how many bars to fetch up front so the
// window actually fills (the default 500-bar load underfills most presets).

export type RangeKey = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "All";

export const RANGE_KEYS: RangeKey[] = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "All"];

export interface RangeWindow {
  resolution: string; // a feed.ts PERIODS resolution
  fromTs: number; // ms
  toTs: number; // ms
  wantBars: number;
}

const DAY = 86_400_000;
const MAX_BARS = 2500;

// Interval paired with each key, and that interval's length in ms.
const SPEC: Record<RangeKey, { resolution: string; intervalMs: number }> = {
  "1D": { resolution: "MINUTE", intervalMs: 60_000 },
  "5D": { resolution: "MINUTE_5", intervalMs: 300_000 },
  "1M": { resolution: "MINUTE_30", intervalMs: 1_800_000 },
  "3M": { resolution: "HOUR", intervalMs: 3_600_000 },
  "6M": { resolution: "HOUR_4", intervalMs: 14_400_000 },
  YTD: { resolution: "DAY", intervalMs: DAY },
  "1Y": { resolution: "DAY", intervalMs: DAY },
  All: { resolution: "DAY", intervalMs: DAY },
};

// Calendar span back from "now" for each key. YTD/All computed in rangeWindow.
const WINDOW_DAYS: Record<RangeKey, number> = {
  "1D": 1, "5D": 5, "1M": 30, "3M": 90, "6M": 180, YTD: 0, "1Y": 365, All: 5 * 365,
};

export function rangeWindow(key: RangeKey, nowMs: number): RangeWindow {
  const { resolution, intervalMs } = SPEC[key];
  const toTs = nowMs;
  let fromTs: number;
  if (key === "YTD") {
    const d = new Date(nowMs);
    fromTs = Date.UTC(d.getUTCFullYear(), 0, 1);
  } else {
    fromTs = nowMs - WINDOW_DAYS[key] * DAY;
  }
  // Upper-bound bar count from calendar span (markets have gaps, so the broker
  // returns fewer — this is a safe ceiling), plus a small buffer, capped.
  const calendarBars = Math.ceil((toTs - fromTs) / intervalMs);
  const wantBars = Math.min(calendarBars + 20, MAX_BARS);
  return { resolution, fromTs, toTs, wantBars };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/rangeWindow.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/rangeWindow.ts frontend/src/lib/rangeWindow.test.ts
git commit -m "feat(chart): rangeWindow helper for quick date-range presets"
```

---

### Task 2: `ChartRangeBar` presentational component

The hover-revealed bottom strip: range buttons + calendar popover. No chart logic — it only renders and calls back.

**Files:**
- Create: `frontend/src/ChartRangeBar.tsx`
- Modify: `frontend/src/index.css` (append `.chart-range-bar` styles)
- Test: `frontend/src/ChartRangeBar.test.tsx`

**Interfaces:**
- Consumes: `RangeKey`, `RANGE_KEYS` from Task 1.
- Produces:
  - `interface ChartRangeBarProps { activeKey: RangeKey | null; disabled?: boolean; onPick(key: RangeKey): void; onGoToDate(dateMs: number): void }`
  - `export default function ChartRangeBar(props: ChartRangeBarProps): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/ChartRangeBar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChartRangeBar from "./ChartRangeBar";

describe("ChartRangeBar", () => {
  it("renders all eight range buttons", () => {
    render(<ChartRangeBar activeKey={null} onPick={() => {}} onGoToDate={() => {}} />);
    for (const label of ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "All"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active key with aria-pressed", () => {
    render(<ChartRangeBar activeKey="1M" onPick={() => {}} onGoToDate={() => {}} />);
    expect(screen.getByRole("button", { name: "1M" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onPick with the key", () => {
    const onPick = vi.fn();
    render(<ChartRangeBar activeKey={null} onPick={onPick} onGoToDate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "6M" }));
    expect(onPick).toHaveBeenCalledWith("6M");
  });

  it("disables buttons when disabled", () => {
    render(<ChartRangeBar activeKey={null} disabled onPick={() => {}} onGoToDate={() => {}} />);
    expect(screen.getByRole("button", { name: "1D" })).toBeDisabled();
  });

  it("opens the date popover and emits the chosen date in ms", () => {
    const onGoToDate = vi.fn();
    render(<ChartRangeBar activeKey={null} onPick={() => {}} onGoToDate={onGoToDate} />);
    fireEvent.click(screen.getByRole("button", { name: /go to date/i }));
    const input = screen.getByLabelText(/go to date/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-03-15" } });
    fireEvent.submit(input.closest("form")!);
    expect(onGoToDate).toHaveBeenCalledWith(Date.UTC(2026, 2, 15));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/ChartRangeBar.test.tsx`
Expected: FAIL — `Cannot find module './ChartRangeBar'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/ChartRangeBar.tsx
import { useState } from "react";
import { RANGE_KEYS, type RangeKey } from "./lib/rangeWindow";

export interface ChartRangeBarProps {
  activeKey: RangeKey | null;
  disabled?: boolean;
  onPick(key: RangeKey): void;
  onGoToDate(dateMs: number): void;
}

export default function ChartRangeBar({
  activeKey,
  disabled,
  onPick,
  onGoToDate,
}: ChartRangeBarProps) {
  const [calOpen, setCalOpen] = useState(false);
  const [date, setDate] = useState("");

  const submitDate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!date) return;
    // <input type=date> value is "YYYY-MM-DD"; parse as UTC midnight.
    const [y, m, d] = date.split("-").map(Number);
    onGoToDate(Date.UTC(y, m - 1, d));
    setCalOpen(false);
  };

  return (
    <div className="chart-range-bar" data-testid="chart-range-bar">
      {RANGE_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={`crb-btn${k === activeKey ? " active" : ""}`}
          aria-pressed={k === activeKey}
          disabled={disabled}
          onClick={() => onPick(k)}
        >
          {k}
        </button>
      ))}
      <span className="crb-sep" />
      <button
        type="button"
        className="crb-btn crb-cal"
        aria-label="Go to date"
        disabled={disabled}
        onClick={() => setCalOpen((o) => !o)}
      >
        {/* simple calendar glyph; matches the screenshot's outline icon */}
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" />
          <path d="M1.5 5.5h13M5 1v3M11 1v3" stroke="currentColor" />
        </svg>
      </button>
      {calOpen && (
        <form className="crb-cal-pop" onSubmit={submitDate}>
          <input
            type="date"
            aria-label="Go to date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            autoFocus
          />
          <button type="submit" className="crb-btn">Go</button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Append styles**

Append to `frontend/src/index.css` (hover-reveal: hidden until the cell is hovered; the parent `.chart-wrap:hover` drives it — Task 3 adds the bar inside `.chart-wrap`):

```css
/* TradingView-style quick date-range bar (hover-revealed bottom strip). */
.chart-range-bar {
  position: absolute;
  left: 8px;
  bottom: 6px;
  z-index: 11; /* above klinecharts canvases (z2) and bracket/sel overlays (z9/10) */
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  border-radius: 6px;
  background: var(--panel-bg, rgba(20, 20, 24, 0.7));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.chart-wrap:hover .chart-range-bar {
  opacity: 1;
  pointer-events: auto;
}
.crb-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim, #b0b3b8);
  font: inherit;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.crb-btn:hover:not(:disabled) { color: var(--text, #e8e8ea); }
.crb-btn.active { color: var(--accent, #2962ff); font-weight: 600; }
.crb-btn:disabled { opacity: 0.4; cursor: default; }
.crb-sep { width: 1px; height: 14px; background: var(--border, #34363c); margin: 0 2px; }
.crb-cal { display: inline-flex; align-items: center; }
.crb-cal-pop {
  position: absolute;
  right: 4px;
  bottom: 28px;
  display: flex;
  gap: 4px;
  padding: 6px;
  border-radius: 6px;
  background: var(--panel-bg, #1c1c20);
  border: 1px solid var(--border, #34363c);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/ChartRangeBar.test.tsx`
Expected: PASS (5 tests). If `@testing-library/react` is not yet a dep, check `frontend/package.json` — the existing component tests (e.g. for `ChartLegend`) reveal the project's test utilities; reuse those. If the repo has no component-test harness, convert this task's assertions to the project's existing pattern rather than adding a new one.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ChartRangeBar.tsx frontend/src/ChartRangeBar.test.tsx frontend/src/index.css
git commit -m "feat(chart): ChartRangeBar hover-revealed date-range strip"
```

---

### Task 3: Wire the bar into `ChartCore` (interval switch + window fit)

Thread a `setPeriod` callback into the cell, render the bar, and implement the pick / go-to-date behavior with the pending-fit handshake.

**Files:**
- Modify: `frontend/src/App.tsx` (pass `setPeriod` to `ChartGrid` as `onPeriod`)
- Modify: `frontend/src/ChartGrid.tsx` (thread `onPeriod` to `ChartCore`)
- Modify: `frontend/src/ChartCore.tsx` (prop, refs, handlers, render the bar, pending-fit at data-land)

**Interfaces:**
- Consumes: `rangeWindow`, `RangeKey` (Task 1); `ChartRangeBar` (Task 2); existing `applyVisibleRange`, `readVisibleRange` (`chartSync.ts`); existing `fetchRecent` (`feed.ts`); existing `PERIODS` (`feed.ts`); existing `App.setPeriod` (`App.tsx:781`).
- Produces: nothing consumed by later tasks (Task 4 is e2e against the running app).

- [ ] **Step 1: Pass `setPeriod` down from App to ChartGrid**

In `frontend/src/App.tsx`, the `<ChartGrid ... />` render (near line 1221, where `onReady={onCellReady}` is) — add the prop:

```tsx
            onReady={onCellReady}
            onPeriod={setPeriod}
```

`setPeriod` already exists (`App.tsx:781`) and acts on the focused cell. The range bar focuses its cell on pointer-down (existing `onPointerDownCapture` on `.chart-wrap`) before the click fires, so `setPeriod` targets the right cell.

- [ ] **Step 2: Thread `onPeriod` through ChartGrid**

In `frontend/src/ChartGrid.tsx`:

Add to `Props` (after `onFocus` at line 52):
```tsx
  onPeriod: (p: Period) => void;
```
Add `onPeriod,` to the destructure (after `onFocus,` at line 74). Ensure `Period` is imported (it is used via `cell.period`; if not imported, add `import type { Period } from "./lib/feed";`). Pass it to `<ChartCore>` (after `onFocus={onFocus}` at line 118):
```tsx
            onPeriod={onPeriod}
```

- [ ] **Step 3: Add the prop + refs in ChartCore**

In `frontend/src/ChartCore.tsx`:

Add to the props interface (alongside `onFocus`):
```tsx
  onPeriod?: (p: Period) => void;
```
Add `onPeriod` to the component's destructured props.

Add imports near the existing `chartSync`/`feed` imports:
```tsx
import ChartRangeBar from "./ChartRangeBar";
import { rangeWindow, RANGE_KEYS, type RangeKey } from "./lib/rangeWindow";
import { applyVisibleRange, readVisibleRange } from "./lib/chartSync";
```
(`applyVisibleRange`/`readVisibleRange` may already be imported from `chartSync` — merge into the existing import rather than duplicating.)

Add component state + refs (near the other `useState`/`useRef` near the top of the component body):
```tsx
  // Active quick-range button (null once the user manually zooms/scrolls or
  // changes interval). Transient — not persisted.
  const [activeRange, setActiveRange] = useState<RangeKey | null>(null);
  // A range pick that switched interval records the window to fit here; the
  // data-load effect applies it once the new-resolution bars land, then clears.
  const pendingRangeRef = useRef<{ resolution: string; fromTs: number; toTs: number } | null>(null);
  // Initial-fetch bar count for the next load (range presets need more than the
  // default 500 to fill their window). Reset to null after each consuming load.
  const wantBarsRef = useRef<number | null>(null);
```

- [ ] **Step 4: Size the initial fetch from `wantBarsRef`**

In the data-load effect, change the `fetchRecent` call at `ChartCore.tsx:2244`:

```tsx
        const want = wantBarsRef.current ?? 500;
        bars = await fetchRecent(symbol.epic, period.resolution, want, priceSide, brokerId);
```

(Leave the surrounding try/catch intact — only the `bars = await fetchRecent(...)` line and the preceding `const want` are new.)

- [ ] **Step 5: Apply the pending fit when data lands**

In the same effect, immediately AFTER `overlays.setResolution(period.resolution);` (≈ `ChartCore.tsx:2281`), add:

```tsx
      // A quick-range pick that switched interval parked its window here; the
      // new-resolution bars are now loaded, so fit it and clear the one-shots.
      wantBarsRef.current = null;
      const pend = pendingRangeRef.current;
      if (pend && pend.resolution === period.resolution && chartRef.current) {
        applyVisibleRange(chartRef.current, pend.fromTs, pend.toTs);
        pendingRangeRef.current = null;
      }
```

- [ ] **Step 6: Implement the pick + go-to-date handlers**

Add these inside the component body (near the other handlers, after the refs from Step 3):

```tsx
  // A quick-range button: switch interval if needed (sized fetch + deferred
  // fit), else fit immediately over loaded bars.
  const onRangePick = (key: RangeKey) => {
    const chart = chartRef.current;
    if (!chart) return;
    const { resolution, fromTs, toTs, wantBars } = rangeWindow(key, Date.now());
    setActiveRange(key);
    if (resolution !== period.resolution) {
      // Defer the fit: switching interval reloads data asynchronously.
      pendingRangeRef.current = { resolution, fromTs, toTs };
      wantBarsRef.current = wantBars;
      const target = PERIODS.find((p) => p.resolution === resolution);
      if (target) onPeriod?.(target);
      return;
    }
    // Same interval: ensure we have enough bars, then fit. If the loaded
    // history doesn't reach fromTs, refetch a window-sized batch first.
    const data = chart.getDataList();
    const oldest = data?.[0]?.timestamp ?? Infinity;
    if (oldest <= fromTs) {
      applyVisibleRange(chart, fromTs, toTs);
    } else {
      pendingRangeRef.current = { resolution, fromTs, toTs };
      wantBarsRef.current = wantBars;
      (async () => {
        const more = await fetchRecent(symbol.epic, resolution, wantBars, priceSide, brokerId);
        if (!chartRef.current || pendingRangeRef.current?.resolution !== resolution) return;
        chartRef.current.applyNewData(more, true);
        cursorSecRef.current = more.length ? Math.floor(more[0].timestamp / 1000) : cursorSecRef.current;
        exhaustedRef.current = false;
        applyVisibleRange(chartRef.current, fromTs, toTs);
        pendingRangeRef.current = null;
        wantBarsRef.current = null;
      })();
    }
  };

  // Calendar "go to date": center the chosen date in the current window, keeping
  // the interval. Degrades to the loaded extent if the date predates history.
  const onGoToDate = (dateMs: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const cur = readVisibleRange(chart);
    const span = cur ? cur.toTs - cur.fromTs : 30 * 86_400_000;
    setActiveRange(null);
    applyVisibleRange(chart, dateMs - span / 2, dateMs + span / 2);
  };
```

If `readVisibleRange`'s return shape isn't `{ fromTs, toTs }`, adapt to its actual signature (see `chartSync.ts:181`) — the goal is just the current visible span in ms.

- [ ] **Step 7: Clear the highlight on manual zoom/scroll**

In the existing `onRange` broadcast effect (the `ActionType.OnScroll` / `OnZoom` subscriber near `ChartCore.tsx:3024`), add `setActiveRange(null)` inside the handler that fires on a user-driven scroll/zoom, BUT guard it so a programmatic `applyVisibleRange` from a range pick doesn't immediately clear its own highlight. Use a short-lived ref set just before the programmatic calls:

```tsx
  // True while a range pick is programmatically moving the view, so the
  // scroll/zoom listener doesn't treat it as a manual gesture and clear the pill.
  const programmaticMoveRef = useRef(false);
```
Wrap each `applyVisibleRange(...)` call added in Steps 5–6 as:
```tsx
        programmaticMoveRef.current = true;
        applyVisibleRange(chartRef.current, /* … */);
        // released on the next macrotask, after klinecharts emits its scroll event
        setTimeout(() => { programmaticMoveRef.current = false; }, 0);
```
And in the scroll/zoom handler:
```tsx
        if (!programmaticMoveRef.current) setActiveRange(null);
```

- [ ] **Step 8: Render the bar**

In `ChartCore.tsx`'s return, add `<ChartRangeBar>` as a sibling immediately after the `containerRef` div (after `ChartCore.tsx:3427`):

```tsx
      <ChartRangeBar
        activeKey={activeRange}
        disabled={!chartRef.current}
        onPick={onRangePick}
        onGoToDate={onGoToDate}
      />
```

The bar is absolutely positioned (Task 2 CSS) so it overlays the bottom-left without resizing `containerRef`; hover-reveal keeps it out of the way. (We chose absolute-overlay-at-bottom rather than shrinking the container to avoid disturbing klinecharts' layout math — the bar sits over the axis gutter, matching TV.)

- [ ] **Step 9: Typecheck + unit tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib/rangeWindow.test.ts src/ChartRangeBar.test.tsx`
Expected: tsc clean; all unit tests PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/src/ChartCore.tsx
git commit -m "feat(chart): wire date-range bar into ChartCore (switch interval + fit window)"
```

---

### Task 4: End-to-end verification

Prove the feature in the running app, matching the repo's existing chart e2e pattern.

**Files:**
- Create: `frontend/e2e/range-bar.spec.ts` (match the existing e2e dir/naming — if the repo's e2e specs live elsewhere, mirror that location and the existing `/api/state` stubbing the other chart specs use)

**Interfaces:**
- Consumes: the running app + the `data-testid="chart-range-bar"` and button labels from Task 2.

- [ ] **Step 1: Write the e2e spec**

```ts
// frontend/e2e/range-bar.spec.ts
import { test, expect } from "@playwright/test";

// Reuse whatever fixture/stub the existing chart specs use (e.g. a /api/candles
// and /api/state mock). Copy that setup block from a sibling spec rather than
// inventing a new one.

test("range bar switches interval and fits the window", async ({ page }) => {
  await page.goto("/");
  const cell = page.locator(".chart-wrap").first();
  await cell.hover(); // reveal the bar
  const bar = cell.getByTestId("chart-range-bar");
  await expect(bar).toBeVisible();

  // Click 1M → interval picker should reflect 30m and 1M should be active.
  await bar.getByRole("button", { name: "1M" }).click();
  await expect(bar.getByRole("button", { name: "1M" })).toHaveAttribute("aria-pressed", "true");
  // The shared toolbar interval picker now shows 30m (TV-sync requirement).
  await expect(page.getByRole("button", { name: "30m" })).toBeVisible();
});

test("calendar jumps to a chosen date", async ({ page }) => {
  await page.goto("/");
  const cell = page.locator(".chart-wrap").first();
  await cell.hover();
  const bar = cell.getByTestId("chart-range-bar");
  await bar.getByRole("button", { name: "Go to date" }).click();
  await bar.getByLabel("Go to date").fill("2026-03-15");
  await bar.getByRole("button", { name: "Go" }).click();
  // No crash; the chart canvas is still present and the popover closed.
  await expect(bar.locator(".crb-cal-pop")).toHaveCount(0);
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `cd frontend && npx playwright test e2e/range-bar.spec.ts`
Expected: both tests PASS. If the interval-picker label assertion fails because the picker uses different casing (`30m` vs `30M`), read `Toolbar.tsx:455` for the exact label and match it.

- [ ] **Step 3: Manual smoke (visual)**

Run the app (existing dev command, e.g. `cd frontend && npm run dev`), open a chart, hover the bottom-left, and click through `1D 5D 1M 3M 6M YTD 1Y All`. Confirm each switches interval + fits, the active pill highlights, manual scroll clears it, and the calendar scrolls to a date. Note any preset that underfills (intraday presets capped at `MAX_BARS`).

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/range-bar.spec.ts
git commit -m "test(chart): e2e for the date-range bar"
```

---

## Notes / accepted limitations

- **Intraday cap:** `3M@1h` calendar bars (~2160) and any preset whose calendar count exceeds `MAX_BARS=2500` fetch up to the cap; with market-hours gaps the returned history usually still covers the window. If a preset visibly underfills in the smoke test, raise `MAX_BARS` in `rangeWindow.ts` (single constant).
- **Sibling propagation:** window changes reach siblings only through the existing `onRange` broadcast when "Sync date range" is on; the interval switch is deliberately local to the focused cell.
- **No backend cache:** this feature uses the broker path as today; wiring `candle_cache.py` into `/api/candles` is out of scope (separate effort).

## Known design debt — history paging has two owners (revisit with replay)

There are now **two code paths that page older candle history**, and they coordinate
through loose shared refs rather than a single owner:

1. `ChartCore.setLoadDataCallback(...)` — the scroll-back loader (klinecharts fires it
   at the left edge).
2. `ChartCore.ensureCoverageAndFit(...)` — the quick-range "cover back to `fromTs`" walk
   (extracted core in `lib/historyPaging.ts`).

Both read/write the same `cursorSecRef` / `exhaustedRef` / `loadingRef` / `emptyStreakRef`.
The code-review found this could race (concurrent paging → skipped/duplicated windows,
exhausted-flag flip-flop) and that the walk could prepend stale-series bars on a
broker/side switch.

**What we did (the quick fix, shipped):** the range walk now (a) takes the scroll-back
loader's `loadingRef` mutex and waits out any in-flight page before acquiring it, so the
two can't run concurrently; (b) guards same-token re-entry via `launchedTokenRef`; and
(c) captures epic/broker/side in the range token and aborts the walk if any drifts. Bugs
are closed and tested (`historyPaging.test.ts` + `range-bar.spec.ts`).

**The proper fix (deferred):** give the paging state a single owner — a per-chart
`HistoryPager` class (mirrors `PositionLines`) that privately holds cursor/exhausted/
loading and exposes `onForward(params)` (driver 1) and `ensureBack(fromTs)` (driver 2),
both funnelling through one internal `loadPage()`. That removes the shared refs (race
impossible by construction), the wait-out loop, and the dedup/exhaustion duplication.
It is deferred because it also rewrites the battle-tested scroll-back loader — higher
risk than the live bug warrants right now.

**Trigger to do it:** when **chart replay** (built on `candle_cache.py`) adds a *third*
consumer of history paging. Three paths sharing loose refs is genuinely unsafe, and the
`HistoryPager` owner is the right substrate to build replay on — so fold this refactor
into step 1 of the replay work and verify it against the new replay tests, not as
standalone churn. See `2026-06-30-candle-history-cache.md`.
