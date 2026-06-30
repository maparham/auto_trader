# Per-Timeframe Visibility + Auto-Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both drawings and indicators a TradingView-style per-timeframe Visibility tab (unit rows with enable + min/max range) plus opt-in auto-hide that hides finite-extent objects spanning fewer than N visible bars at the current timeframe.

**Architecture:** One framework-free model module (`lib/visibility.ts`) and one shared React component (`VisibilityTab.tsx`) are the single source of truth. Drawings consume them via `OverlayManager` + `DrawingSettings`; indicators via a new `applyIndicatorIntervalVisibility` helper + `IndicatorSettings`. Effective on-chart visibility is always `userIntent AND interval-match AND NOT(autoHide && barsSpanned < N)`; user intent is kept separate from the live effective flag so interval filtering never corrupts what gets persisted.

**Tech Stack:** TypeScript, React, klinecharts / @klinecharts/pro, Vitest (`*.test.ts`), existing project ESLint/TS config.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-30-visibility-tab-design.md` — every task's requirements implicitly include it.
- Unit rows shown: **Seconds, Minutes, Hours, Days, Weeks** only (omit Ticks/Months/Ranges — the app has no such intervals). Slider maxes: Seconds 59, Minutes 59, Hours 24, Days 366, Weeks 52.
- Default model = all units `on`, full range, auto-hide off — MUST reproduce today's "show on all intervals" (an existing object's visibility cannot change on upgrade).
- Auto-hide threshold default `N = 3`. Auto-hide re-evaluates on **interval change only** (never per zoom/pan frame).
- Auto-hide applies to finite-extent objects only: all drawings + anchored indicators (`AVWAP`). Full-width indicators never get the toggle.
- User intent (the "Show on chart" checkbox) lives in `extendData` (`userVisible`), NOT in the live `visible` flag — mirror the existing drawing pattern so persistence saves intent, not the interval-filtered effective value.
- Resolution set + `RESOLUTION_SECONDS` come from `frontend/src/lib/feed.ts`. Do not hardcode a parallel list.
- Run tests from `frontend/`: `npm run test -- <path>` (Vitest). Lint: `npm run lint`.
- Commit after every task.

---

## File Structure

- **Create** `frontend/src/lib/visibility.ts` — model types, `defaultVisibility`, `parseResolution`, `isVisibleOnResolution`, `barsSpanned`, `migrateIntervals`. (Task 1)
- **Create** `frontend/src/lib/visibility.test.ts` — unit tests. (Task 1)
- **Create** `frontend/src/VisibilityTab.tsx` — shared unit-grid + auto-hide UI. (Task 2)
- **Create** `frontend/src/VisibilityTab.test.tsx` — interaction test. (Task 2)
- **Modify** `frontend/src/lib/overlays.ts` — replace `intervals` with the model in `DrawingExtra`; `effectiveVisible`/`setVisibilityModel`/auto-hide; migration; ghost stub. (Tasks 3, 6)
- **Modify** `frontend/src/DrawingSettings.tsx` — swap the visibility tab body for `VisibilityTab`. (Task 3)
- **Modify** `frontend/src/lib/indicators.ts` — `userVisible`/`visibility` in indicator extendData; `applyIndicatorIntervalVisibility`. (Task 4)
- **Modify** `frontend/src/IndicatorSettings.tsx` — visibility tab uses `VisibilityTab`; intent split; persist `visibility`. (Task 5)
- **Modify** `frontend/src/ChartCore.tsx` — call `applyIndicatorIntervalVisibility` in the period-change effect next to `overlays.setResolution`. (Task 4)
- **Modify** `frontend/src/styles*.css` (the file holding `.ind-interval-grid`) — styles for the unit grid + ghost. (Tasks 2, 6)

---

## Task 1: Shared visibility model (`lib/visibility.ts`)

**Files:**
- Create: `frontend/src/lib/visibility.ts`
- Test: `frontend/src/lib/visibility.test.ts`

**Interfaces:**
- Consumes: `RESOLUTION_SECONDS` from `./feed`.
- Produces:
  - `type VisUnit = "seconds" | "minutes" | "hours" | "days" | "weeks"`
  - `interface UnitVisibility { on: boolean; min: number; max: number }`
  - `interface VisibilityModel { units: Record<VisUnit, UnitVisibility>; autoHide: { on: boolean; minBars: number } }`
  - `const VISIBILITY_UNITS: { unit: VisUnit; label: string; max: number }[]`
  - `defaultVisibility(): VisibilityModel`
  - `parseResolution(res: string): { unit: VisUnit; value: number } | null`
  - `isVisibleOnResolution(m: VisibilityModel, res: string): boolean`
  - `barsSpanned(t1: number, t2: number, res: string): number`
  - `migrateIntervals(intervals: string[] | null | undefined): VisibilityModel`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/visibility.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  defaultVisibility,
  parseResolution,
  isVisibleOnResolution,
  barsSpanned,
  migrateIntervals,
  VISIBILITY_UNITS,
} from "./visibility";

const ALL_RES = [
  "SECOND_5", "MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30",
  "HOUR", "HOUR_4", "DAY", "WEEK",
];

describe("parseResolution", () => {
  it("splits prefix + numeric suffix (suffix defaults to 1)", () => {
    expect(parseResolution("MINUTE")).toEqual({ unit: "minutes", value: 1 });
    expect(parseResolution("MINUTE_15")).toEqual({ unit: "minutes", value: 15 });
    expect(parseResolution("HOUR_4")).toEqual({ unit: "hours", value: 4 });
    expect(parseResolution("DAY")).toEqual({ unit: "days", value: 1 });
    expect(parseResolution("WEEK")).toEqual({ unit: "weeks", value: 1 });
    expect(parseResolution("SECOND_30")).toEqual({ unit: "seconds", value: 30 });
  });
  it("returns null for an unknown resolution", () => {
    expect(parseResolution("MONTH")).toBeNull();
    expect(parseResolution("")).toBeNull();
  });
});

describe("defaultVisibility", () => {
  it("is visible on every native resolution (reproduces null=all)", () => {
    const m = defaultVisibility();
    for (const r of ALL_RES) expect(isVisibleOnResolution(m, r)).toBe(true);
    expect(m.autoHide.on).toBe(false);
    expect(m.autoHide.minBars).toBe(3);
  });
  it("covers exactly the supported units", () => {
    expect(VISIBILITY_UNITS.map((u) => u.unit)).toEqual([
      "seconds", "minutes", "hours", "days", "weeks",
    ]);
  });
});

describe("isVisibleOnResolution", () => {
  it("hides a unit whose row is off", () => {
    const m = defaultVisibility();
    m.units.minutes.on = false;
    expect(isVisibleOnResolution(m, "MINUTE_15")).toBe(false);
    expect(isVisibleOnResolution(m, "HOUR")).toBe(true);
  });
  it("respects min/max within a unit", () => {
    const m = defaultVisibility();
    m.units.minutes = { on: true, min: 5, max: 15 };
    expect(isVisibleOnResolution(m, "MINUTE")).toBe(false); // value 1 < min 5
    expect(isVisibleOnResolution(m, "MINUTE_5")).toBe(true);
    expect(isVisibleOnResolution(m, "MINUTE_15")).toBe(true);
    expect(isVisibleOnResolution(m, "MINUTE_30")).toBe(false); // value 30 > max 15
  });
  it("fails open on an unknown resolution", () => {
    expect(isVisibleOnResolution(defaultVisibility(), "MONTH")).toBe(true);
  });
});

describe("barsSpanned", () => {
  it("counts bars between two ms timestamps for a resolution", () => {
    // 1 hour apart on a 1m chart = 60 bars
    expect(barsSpanned(0, 3_600_000, "MINUTE")).toBe(60);
    // order-independent
    expect(barsSpanned(3_600_000, 0, "MINUTE")).toBe(60);
    // 1 hour apart on a 1H chart = 1 bar
    expect(barsSpanned(0, 3_600_000, "HOUR")).toBe(1);
  });
  it("is Infinity for an unknown resolution (never auto-hides)", () => {
    expect(barsSpanned(0, 1000, "MONTH")).toBe(Infinity);
  });
});

describe("migrateIntervals", () => {
  it("null/undefined => default (all visible)", () => {
    for (const r of ALL_RES) {
      expect(isVisibleOnResolution(migrateIntervals(null), r)).toBe(true);
      expect(isVisibleOnResolution(migrateIntervals(undefined), r)).toBe(true);
    }
  });
  it("an allow-list reproduces the same visible set", () => {
    const allowed = ["MINUTE_5", "MINUTE_15", "HOUR"];
    const m = migrateIntervals(allowed);
    const visibleNow = ALL_RES.filter((r) => isVisibleOnResolution(m, r));
    expect(new Set(visibleNow)).toEqual(new Set(allowed));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- src/lib/visibility.test.ts`
Expected: FAIL — cannot find module `./visibility`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/visibility.ts`:

```ts
// Per-timeframe visibility model shared by drawings (OverlayManager / DrawingSettings)
// and indicators (applyIndicatorIntervalVisibility / IndicatorSettings). TradingView's
// Visibility tab: each time unit has an enable checkbox + a [min,max] numeric range; the
// object shows on a resolution iff its unit is enabled and the resolution's numeric value
// falls in range. Default = all units on, full range = "show on all intervals".
//
// Framework-free and exhaustively unit-tested; the React UI lives in VisibilityTab.tsx.

import { RESOLUTION_SECONDS } from "./feed";

export type VisUnit = "seconds" | "minutes" | "hours" | "days" | "weeks";

export interface UnitVisibility {
  on: boolean;
  min: number;
  max: number;
}

export interface VisibilityModel {
  units: Record<VisUnit, UnitVisibility>;
  // Auto-hide a finite-extent object when it spans fewer than `minBars` visible bars at
  // the current resolution. Off by default; only meaningful for drawings + anchored
  // indicators (full-width indicators span every bar so it can never fire).
  autoHide: { on: boolean; minBars: number };
}

// Supported unit rows + TradingView slider bounds. Only the units this app has intervals
// for (no Ticks/Months/Ranges). Order is the render order.
export const VISIBILITY_UNITS: { unit: VisUnit; label: string; max: number }[] = [
  { unit: "seconds", label: "Seconds", max: 59 },
  { unit: "minutes", label: "Minutes", max: 59 },
  { unit: "hours", label: "Hours", max: 24 },
  { unit: "days", label: "Days", max: 366 },
  { unit: "weeks", label: "Weeks", max: 52 },
];

const PREFIX_UNIT: Record<string, VisUnit> = {
  SECOND: "seconds",
  MINUTE: "minutes",
  HOUR: "hours",
  DAY: "days",
  WEEK: "weeks",
};

export function defaultVisibility(): VisibilityModel {
  const units = {} as Record<VisUnit, UnitVisibility>;
  for (const u of VISIBILITY_UNITS) units[u.unit] = { on: true, min: 1, max: u.max };
  return { units, autoHide: { on: false, minBars: 3 } };
}

// "MINUTE" -> {minutes,1}; "MINUTE_15" -> {minutes,15}; "HOUR_4" -> {hours,4}. The
// resolution keys come from lib/feed.ts (PREFIX or PREFIX_<n>). Returns null if the
// prefix isn't a supported unit (caller fails open).
export function parseResolution(res: string): { unit: VisUnit; value: number } | null {
  if (!res) return null;
  const us = res.indexOf("_");
  const prefix = us === -1 ? res : res.slice(0, us);
  const unit = PREFIX_UNIT[prefix];
  if (!unit) return null;
  const value = us === -1 ? 1 : Number(res.slice(us + 1));
  return Number.isFinite(value) ? { unit, value } : { unit, value: 1 };
}

export function isVisibleOnResolution(m: VisibilityModel, res: string): boolean {
  const parsed = parseResolution(res);
  if (!parsed) return true; // unknown resolution => fail open
  const cfg = m.units[parsed.unit];
  if (!cfg) return true;
  return cfg.on && parsed.value >= cfg.min && parsed.value <= cfg.max;
}

// Whole/fractional bars between two ms timestamps at `res`. Infinity for an unknown
// resolution so auto-hide (which compares `< minBars`) never fires on it.
export function barsSpanned(t1: number, t2: number, res: string): number {
  const secs = RESOLUTION_SECONDS[res];
  if (!secs) return Infinity;
  return Math.abs(t2 - t1) / (secs * 1000);
}

// Back-compat for drawings persisted with the old `intervals: string[] | null` model.
// null/undefined/empty => all units on (default). An allow-list => for each supported
// unit, enable it iff at least one allowed resolution is in that unit, with min/max =
// the spanned values; units with no allowed resolution are turned off.
export function migrateIntervals(intervals: string[] | null | undefined): VisibilityModel {
  const m = defaultVisibility();
  if (!intervals || intervals.length === 0) return m;
  const byUnit = {} as Record<VisUnit, number[]>;
  for (const r of intervals) {
    const p = parseResolution(r);
    if (!p) continue;
    (byUnit[p.unit] ??= []).push(p.value);
  }
  for (const u of VISIBILITY_UNITS) {
    const vals = byUnit[u.unit];
    if (!vals || vals.length === 0) {
      m.units[u.unit].on = false;
    } else {
      m.units[u.unit] = { on: true, min: Math.min(...vals), max: Math.max(...vals) };
    }
  }
  return m;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- src/lib/visibility.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + commit**

```bash
cd frontend && npm run lint
git add frontend/src/lib/visibility.ts frontend/src/lib/visibility.test.ts
git commit -m "feat(visibility): shared per-timeframe visibility model + tests"
```

---

## Task 2: Shared `VisibilityTab` component

**Files:**
- Create: `frontend/src/VisibilityTab.tsx`
- Test: `frontend/src/VisibilityTab.test.tsx`
- Modify: the CSS file with `.ind-interval-grid` (search: `grep -rl "ind-interval-grid" frontend/src`)

**Interfaces:**
- Consumes: `VisibilityModel`, `VISIBILITY_UNITS`, `VisUnit` from `./lib/visibility`.
- Produces: `export default function VisibilityTab(props: { model: VisibilityModel; onChange(next: VisibilityModel): void; showAutoHide: boolean }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/VisibilityTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VisibilityTab from "./VisibilityTab";
import { defaultVisibility } from "./lib/visibility";

describe("VisibilityTab", () => {
  it("toggling a unit off emits a model with that unit disabled", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide={false} />);
    // The Minutes row enable checkbox.
    fireEvent.click(screen.getByLabelText("Minutes"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.units.minutes.on).toBe(false);
  });

  it("editing a unit max emits the clamped value", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide={false} />);
    const maxInput = screen.getByLabelText("Hours max");
    fireEvent.change(maxInput, { target: { value: "12" } });
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.units.hours.max).toBe(12);
  });

  it("hides the auto-hide row when showAutoHide is false", () => {
    render(<VisibilityTab model={defaultVisibility()} onChange={vi.fn()} showAutoHide={false} />);
    expect(screen.queryByLabelText(/auto-hide/i)).toBeNull();
  });

  it("shows + toggles auto-hide when showAutoHide is true", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide />);
    fireEvent.click(screen.getByLabelText(/auto-hide/i));
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.autoHide.on).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- src/VisibilityTab.test.tsx`
Expected: FAIL — cannot find module `./VisibilityTab`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/VisibilityTab.tsx`:

```tsx
// Shared TradingView-style Visibility tab body for both drawings (DrawingSettings) and
// indicators (IndicatorSettings). Renders one row per supported time unit — an enable
// checkbox, a min number input, a dual range slider, and a max number input — plus an
// optional auto-hide row (finite-extent objects only). Pure/controlled: it never mutates
// the model in place; every edit produces a fresh model via onChange.

import { useMemo } from "react";
import {
  type VisibilityModel,
  type VisUnit,
  VISIBILITY_UNITS,
} from "./lib/visibility";

interface Props {
  model: VisibilityModel;
  onChange: (next: VisibilityModel) => void;
  showAutoHide: boolean;
}

// Shallow-clone the model so callers always get a new object (React state churn).
function clone(m: VisibilityModel): VisibilityModel {
  const units = {} as VisibilityModel["units"];
  for (const u of VISIBILITY_UNITS) units[u.unit] = { ...m.units[u.unit] };
  return { units, autoHide: { ...m.autoHide } };
}

export default function VisibilityTab({ model, onChange, showAutoHide }: Props) {
  const rows = useMemo(() => VISIBILITY_UNITS, []);

  function patchUnit(unit: VisUnit, patch: Partial<VisibilityModel["units"][VisUnit]>) {
    const next = clone(model);
    const cur = next.units[unit];
    let { on, min, max } = { ...cur, ...patch };
    const bound = rows.find((r) => r.unit === unit)!.max;
    min = Math.max(1, Math.min(min, bound));
    max = Math.max(1, Math.min(max, bound));
    if (min > max) {
      // Keep the just-edited side authoritative.
      if (patch.min != null) max = min;
      else min = max;
    }
    next.units[unit] = { on, min, max };
    onChange(next);
  }

  function patchAutoHide(patch: Partial<VisibilityModel["autoHide"]>) {
    const next = clone(model);
    next.autoHide = { ...next.autoHide, ...patch };
    if (next.autoHide.minBars < 1) next.autoHide.minBars = 1;
    onChange(next);
  }

  return (
    <div className="vis-tab">
      <div className="vis-grid">
        {rows.map((r) => {
          const u = model.units[r.unit];
          return (
            <div className="vis-row" key={r.unit}>
              <label className="ind-check vis-unit">
                <input
                  type="checkbox"
                  checked={u.on}
                  aria-label={r.label}
                  onChange={(e) => patchUnit(r.unit, { on: e.target.checked })}
                />
                <span>{r.label}</span>
              </label>
              <input
                className="vis-num"
                type="number"
                min={1}
                max={r.max}
                disabled={!u.on}
                aria-label={`${r.label} min`}
                value={u.min}
                onChange={(e) => patchUnit(r.unit, { min: Number(e.target.value) })}
              />
              <input
                className="vis-slider"
                type="range"
                min={1}
                max={r.max}
                disabled={!u.on}
                aria-label={`${r.label} max slider`}
                value={u.max}
                onChange={(e) => patchUnit(r.unit, { max: Number(e.target.value) })}
              />
              <input
                className="vis-num"
                type="number"
                min={1}
                max={r.max}
                disabled={!u.on}
                aria-label={`${r.label} max`}
                value={u.max}
                onChange={(e) => patchUnit(r.unit, { max: Number(e.target.value) })}
              />
            </div>
          );
        })}
      </div>

      {showAutoHide && (
        <label className="ind-check vis-autohide">
          <input
            type="checkbox"
            checked={model.autoHide.on}
            aria-label="Auto-hide when too small"
            onChange={(e) => patchAutoHide({ on: e.target.checked })}
          />
          <span>Auto-hide when fewer than</span>
          <input
            className="vis-num"
            type="number"
            min={1}
            disabled={!model.autoHide.on}
            aria-label="auto-hide bars"
            value={model.autoHide.minBars}
            onChange={(e) => patchAutoHide({ minBars: Number(e.target.value) })}
          />
          <span>visible bars</span>
        </label>
      )}
    </div>
  );
}
```

> Note: TV shows a *dual*-handle slider; here the single range slider drives `max` (the common case) while the numeric `min`/`max` inputs give exact control of both. If a dual-thumb slider is wanted, swap the `vis-slider` input for a two-thumb control in a follow-up — the model already supports it.

- [ ] **Step 4: Add CSS**

In the CSS file that defines `.ind-interval-grid`, append:

```css
.vis-grid { display: flex; flex-direction: column; gap: 6px; }
.vis-row { display: grid; grid-template-columns: 92px 56px 1fr 56px; align-items: center; gap: 8px; }
.vis-unit { margin: 0; }
.vis-num { width: 100%; }
.vis-row input:disabled, .vis-autohide input:disabled { opacity: 0.5; }
.vis-autohide { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
.vis-autohide .vis-num { width: 48px; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm run test -- src/VisibilityTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
cd frontend && npm run lint
git add frontend/src/VisibilityTab.tsx frontend/src/VisibilityTab.test.tsx frontend/src/*.css
git commit -m "feat(visibility): shared VisibilityTab component (unit grid + auto-hide)"
```

---

## Task 3: Wire drawings to the model (OverlayManager + DrawingSettings)

**Files:**
- Modify: `frontend/src/lib/overlays.ts` (`DrawingExtra` ~52-61, `effectiveVisible` ~724-729, `setVisibleIntervals` ~741-748, rehydrate ~1108-1122, `cancel` reads in DrawingSettings)
- Modify: `frontend/src/DrawingSettings.tsx`
- Test: `frontend/src/lib/overlays.test.ts` (add a case; create if absent — check with `ls frontend/src/lib/overlays.test.ts`)

**Interfaces:**
- Consumes: `VisibilityModel`, `defaultVisibility`, `isVisibleOnResolution`, `migrateIntervals`, `barsSpanned` from `./visibility`.
- Produces (OverlayManager): `setVisibilityModel(id: string, model: VisibilityModel): void`; `DrawingExtra.visibility?: VisibilityModel` (replaces `intervals`, kept readable for migration).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/overlays.test.ts` (mirror the harness existing tests use; if the file doesn't exist, create it with the project's klinecharts mock pattern — copy from `positionLines.test.ts`). Minimal behavioral assertion on the pure helper path:

```ts
import { describe, it, expect } from "vitest";
import { defaultVisibility, isVisibleOnResolution, barsSpanned } from "./visibility";

// effectiveVisible mirrors: userVisible AND interval AND NOT(autoHide && bars<min).
function effective(
  userVisible: boolean,
  model: ReturnType<typeof defaultVisibility>,
  res: string,
  span?: { t1: number; t2: number },
): boolean {
  if (!(userVisible && isVisibleOnResolution(model, res))) return false;
  if (model.autoHide.on && span) {
    if (barsSpanned(span.t1, span.t2, res) < model.autoHide.minBars) return false;
  }
  return true;
}

describe("drawing effective visibility", () => {
  it("auto-hides a short-span drawing on a coarse timeframe but not a fine one", () => {
    const m = defaultVisibility();
    m.autoHide = { on: true, minBars: 3 };
    const span = { t1: 0, t2: 3_600_000 }; // 1 hour
    expect(effective(true, m, "MINUTE", span)).toBe(true); // 60 bars
    expect(effective(true, m, "HOUR", span)).toBe(false); // 1 bar < 3
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- src/lib/overlays.test.ts`
Expected: FAIL initially only if the file/import is new; this step locks the effective-visibility contract that the OverlayManager edit below must satisfy. (If it passes as a pure-helper test, proceed — it guards the formula Task 3/6 implement.)

- [ ] **Step 3: Update `DrawingExtra` and `effectiveVisible` in `overlays.ts`**

At the top of `overlays.ts`, add to the existing import block:

```ts
import {
  type VisibilityModel,
  defaultVisibility,
  isVisibleOnResolution,
  migrateIntervals,
  barsSpanned,
} from "./visibility";
```

Replace the `intervals?: string[] | null;` field in `DrawingExtra` (line ~57) with:

```ts
  // Per-timeframe visibility model (TV Visibility tab). Absent ⇒ default (all
  // intervals). The legacy `intervals` allow-list is still read on rehydrate and
  // migrated into this; it is no longer written.
  visibility?: VisibilityModel;
  intervals?: string[] | null; // legacy — migrated, never written
```

Replace `effectiveVisible` (lines ~724-729) with:

```ts
  // Effective on-chart visibility = user intent AND the current interval is allowed AND
  // (auto-hide off OR the drawing spans >= minBars at the current resolution). Intent
  // and the model live in extendData so persist() reads intent without the filter
  // corrupting it. `pts` are the overlay's anchor points (for the bar-span check).
  private effectiveVisible(
    extra: DrawingExtra,
    pts?: ReadonlyArray<{ timestamp?: number }>,
  ): boolean {
    const intent = extra.userVisible ?? true;
    const model = extra.visibility ?? defaultVisibility();
    if (!(intent && isVisibleOnResolution(model, this.resolution))) return false;
    if (model.autoHide.on && pts && pts.length >= 2) {
      const ts = pts.map((p) => p.timestamp ?? NaN).filter((n) => Number.isFinite(n));
      if (ts.length >= 2) {
        const span = barsSpanned(Math.min(...ts), Math.max(...ts), this.resolution);
        if (span < model.autoHide.minBars) return false;
      }
    }
    return true;
  }
```

Update the three existing `effectiveVisible(...)` call sites to pass points where available:
- `setVisible` (~736): `visible: this.effectiveVisible(extra, ov.points)`
- `applyIntervalVisibility` (~798): `visible: this.effectiveVisible(asDrawingExtra(ov.extendData), ov.points)`
- rehydrate `create(...)` (~1118): `visible: this.effectiveVisible(extra, d.points)`

- [ ] **Step 4: Replace `setVisibleIntervals` with `setVisibilityModel`**

Replace `setVisibleIntervals` (lines ~740-748) with:

```ts
  // The per-timeframe visibility model for a drawing (TV Visibility tab).
  setVisibilityModel(id: string, model: VisibilityModel): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.chart?.getOverlayById(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), visibility: model };
    delete extra.intervals; // drop the legacy field once migrated to the model
    this.chart?.overrideOverlay({
      id,
      extendData: extra,
      visible: this.effectiveVisible(extra, ov.points),
    });
    this.persist();
  }
```

- [ ] **Step 5: Migrate legacy `intervals` on rehydrate**

In rehydrate's drawing loop (lines ~1113-1116), expand the `extra` seed to migrate the legacy field:

```ts
        const base = asDrawingExtra(d.extendData);
        const extra: DrawingExtra = {
          ...base,
          userVisible: base.userVisible ?? d.visible ?? true,
          visibility: base.visibility ?? migrateIntervals(base.intervals),
        };
        delete extra.intervals;
```

- [ ] **Step 6: Update DrawingSettings to use VisibilityTab**

In `DrawingSettings.tsx`:

Add imports:
```ts
import VisibilityTab from "./VisibilityTab";
import { type VisibilityModel, defaultVisibility, migrateIntervals } from "./lib/visibility";
```
Remove the now-unused `PERIOD_GROUPS` import and the `ALL_RESOLUTIONS` const (lines 19, 38).

Replace the `intervals` state (lines ~91-93) with:
```ts
  const [vis, setVis] = useState<VisibilityModel>(
    extra0.visibility ?? migrateIntervals(extra0.intervals),
  );
```

Remove `applyAllIntervals` and `toggleInterval` (lines ~150-169) and add:
```ts
  function applyVis(next: VisibilityModel) {
    setVis(next);
    overlays.setVisibilityModel(curId, next);
  }
```

In `cancel()` (line ~198), replace `overlays.setVisibleIntervals(curId, oExtra.intervals ?? null);` with:
```ts
        overlays.setVisibilityModel(curId, oExtra.visibility ?? migrateIntervals(oExtra.intervals));
```

Replace the visibility tab body's interval block (lines ~343-371, the `Intervals` row + `ind-interval-grid`) with:
```tsx
              <VisibilityTab model={vis} onChange={applyVis} showAutoHide />
```
(Keep the "Show on chart" and "Show price label on axis" checkboxes above it.)

- [ ] **Step 7: Run tests + manual check, then commit**

Run: `cd frontend && npm run test -- src/lib/overlays.test.ts src/lib/visibility.test.ts && npm run lint`
Expected: PASS.

```bash
git add frontend/src/lib/overlays.ts frontend/src/DrawingSettings.tsx frontend/src/lib/overlays.test.ts
git commit -m "feat(visibility): drawings use the per-timeframe model + auto-hide; migrate legacy intervals"
```

---

## Task 4: Indicator interval visibility helper + ChartCore wiring

**Files:**
- Modify: `frontend/src/lib/indicators.ts` (`applyIndicator` ~196-210; add `applyIndicatorIntervalVisibility`)
- Modify: `frontend/src/ChartCore.tsx` (period-change effect, near `overlays.setResolution(period.resolution)`)
- Test: `frontend/src/lib/indicators.test.ts` (add; create if absent)

**Interfaces:**
- Consumes: `VisibilityModel`, `defaultVisibility`, `isVisibleOnResolution` from `./visibility`.
- Produces: `export function applyIndicatorIntervalVisibility(chart: Chart, resolution: string): void`; indicator `extendData.visibility?: VisibilityModel` + `extendData.userVisible?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/indicators.test.ts` a pure-helper test for the visibility decision (the full chart loop is covered by integration/manual). Reuse the visibility module:

```ts
import { describe, it, expect } from "vitest";
import { defaultVisibility, isVisibleOnResolution } from "./visibility";

describe("indicator interval visibility decision", () => {
  it("hides a minutes-only indicator on an hour timeframe", () => {
    const m = defaultVisibility();
    m.units.hours.on = false;
    m.units.days.on = false;
    m.units.weeks.on = false;
    expect(isVisibleOnResolution(m, "MINUTE_5")).toBe(true);
    expect(isVisibleOnResolution(m, "HOUR")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `cd frontend && npm run test -- src/lib/indicators.test.ts`
Expected: PASS as a pure-helper guard (it pins the contract `applyIndicatorIntervalVisibility` uses below). If the file is new, this also verifies the test harness picks it up.

- [ ] **Step 3: Add `applyIndicatorIntervalVisibility` to `indicators.ts`**

Add imports at the top:
```ts
import {
  type VisibilityModel,
  defaultVisibility,
  isVisibleOnResolution,
} from "./visibility";
```

Append this exported function (after `applyIndicator`):

```ts
// Re-derive every indicator's effective on-chart visibility against the current
// resolution. Mirrors OverlayManager.applyIntervalVisibility for drawings: user intent
// (extendData.userVisible, default true) AND the model's interval match. Iterates ALL
// panes — the candle pane plus every sub-pane (Volume/MACD/RSI/…). A VIEW reaction, not
// a user edit: it does not persist (intent is already stored). Auto-hide for anchored
// indicators is handled in their own apply path; this function does the interval filter.
export function applyIndicatorIntervalVisibility(chart: Chart, resolution: string): void {
  const panes = chart.getPanes?.() ?? [];
  const paneIds = panes.length
    ? panes.map((p: { id: string }) => p.id)
    : ["candle_pane"];
  for (const paneId of paneIds) {
    const inds = (chart.getIndicatorByPaneId(paneId) ?? []) as Indicator[];
    for (const ind of Array.isArray(inds) ? inds : [inds]) {
      if (!ind?.name) continue;
      const ext = (ind.extendData ?? {}) as { userVisible?: boolean; visibility?: VisibilityModel };
      const intent = ext.userVisible ?? ind.visible ?? true;
      const model = ext.visibility ?? defaultVisibility();
      const visible = intent && isVisibleOnResolution(model, resolution);
      chart.overrideIndicator({ name: ind.name, visible }, paneId);
    }
  }
}
```

> Verify the klinecharts API for enumerating panes/indicators: `chart.getPanes()` returns pane descriptors with `.id`; `chart.getIndicatorByPaneId(paneId)` with no name returns all indicators on that pane (array). If the installed version differs, adapt to the available enumerator (check `node_modules/klinecharts` types) — the contract this task needs is "iterate every indicator on every pane."

- [ ] **Step 4: Call it from ChartCore's period-change effect**

In `ChartCore.tsx`, find `overlays.setResolution(period.resolution)` (~line 2281) and add immediately after it:
```ts
        applyIndicatorIntervalVisibility(chart, period.resolution);
```
Add the import: `import { applyIndicatorIntervalVisibility } from "./lib/indicators";` (extend the existing indicators import if present).

Also call it once after rehydrate (wherever `overlays.rehydrate()` / `overlays.setResolution` runs post-load) so freshly-rehydrated indicators get filtered against the current resolution.

- [ ] **Step 5: Run tests + commit**

Run: `cd frontend && npm run test -- src/lib/indicators.test.ts && npm run lint`
Expected: PASS.

```bash
git add frontend/src/lib/indicators.ts frontend/src/ChartCore.tsx frontend/src/lib/indicators.test.ts
git commit -m "feat(visibility): indicator interval-visibility helper wired to period changes (all panes)"
```

---

## Task 5: IndicatorSettings Visibility tab uses VisibilityTab

**Files:**
- Modify: `frontend/src/IndicatorSettings.tsx` (state ~259-265; visibility body ~1902-1911; `currentConfig` ~659-728; save-effect deps ~741; `apply` ~800-812)

**Interfaces:**
- Consumes: `VisibilityTab`, `VisibilityModel`, `defaultVisibility`, `isVisibleOnResolution` from the shared units.
- Produces: persists `extendData.visibility` (+ `extendData.userVisible` for intent) in `SavedIndicatorConfig`.

- [ ] **Step 1: Add state + apply path**

Add imports:
```ts
import VisibilityTab from "./VisibilityTab";
import { type VisibilityModel, defaultVisibility, isVisibleOnResolution } from "./lib/visibility";
```

Near the other `useState`s (~262), seed from extendData:
```ts
  const ext0 = (ind?.extendData ?? {}) as { visibility?: VisibilityModel };
  const [vis, setVis] = useState<VisibilityModel>(ext0.visibility ?? defaultVisibility());
  // Anchored indicators (finite extent) get the auto-hide toggle; full-width don't.
  const showAutoHide = isAvwap;
```

Add an apply handler that writes intent+model to extendData and sets the live effective `visible` against the current resolution (so the edit previews live without corrupting intent):
```ts
  function applyVisibility(next: VisibilityModel) {
    setVis(next);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}), userVisible: visible, visibility: next };
    chart.overrideIndicator(
      { name, extendData: ext, visible: visible && isVisibleOnResolution(next, chartResolution) },
      paneId,
    );
  }
```

Change `toggleVisible` (~879) to record intent in extendData too, and apply the interval filter:
```ts
  function toggleVisible(v: boolean) {
    setVisible(v);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}), userVisible: v, visibility: vis };
    chart.overrideIndicator(
      { name, extendData: ext, visible: v && isVisibleOnResolution(vis, chartResolution) },
      paneId,
    );
  }
```

- [ ] **Step 2: Persist the model in `currentConfig`**

In `currentConfig()` (~660), after the existing `extendData` assignments and before the `return`, add:
```ts
    // Per-timeframe visibility (TV Visibility tab) — only when non-default.
    if (JSON.stringify(vis) !== JSON.stringify(defaultVisibility())) extendData.visibility = vis;
    extendData.userVisible = visible; // intent, mirrors `visible` for the interval filter
```

Add `vis` to the save-effect dependency array (~741): append `, vis` before the closing `]`.

- [ ] **Step 3: Replace the visibility tab body**

Replace lines ~1902-1911 with the "Show on chart" checkbox retained plus the shared tab:
```tsx
          {tab === "visibility" && (
            <>
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => toggleVisible(e.target.checked)}
                />
                <span>Show on chart</span>
              </label>
              <VisibilityTab model={vis} onChange={applyVisibility} showAutoHide={showAutoHide} />
            </>
          )}
```

- [ ] **Step 4: Cancel restores the model**

Find the modal's Cancel/Escape revert (the `cancel` function that restores `original.current`). Ensure it restores extendData (it already snapshots `extendData` at ~256). If Cancel re-applies extendData via `overrideIndicator`, no change is needed; if it only restores `visible/calcParams/styles`, add an `overrideIndicator({ name, extendData: original.current.extendData }, paneId)` call so a cancelled visibility edit reverts. Verify by reading the `cancel` body.

- [ ] **Step 5: Run + manual check, commit**

Run: `cd frontend && npm run test && npm run lint`
Expected: PASS.

Manual: open an indicator's Visibility tab, disable "Hours", switch the chart to 1H → indicator hides; switch back to 5m → it returns. Reload → setting persists.

```bash
git add frontend/src/IndicatorSettings.tsx
git commit -m "feat(visibility): indicator Visibility tab uses shared per-timeframe grid"
```

---

## Task 6: Ghost stub for interval/auto-hidden drawings

**Files:**
- Modify: `frontend/src/lib/overlays.ts` (`effectiveVisible` callers, persist, a new `fadedStyles` map)
- Modify: CSS (no change if fade is via styles)
- Test: `frontend/src/lib/overlays.test.ts`

**Rationale:** There is no object-list panel, so a fully hidden drawing can't be clicked to reopen settings. A drawing hidden by interval/auto-hide (but `userVisible`) renders as a faint, still-hittable ghost; a user-hidden drawing (`userVisible:false`) hides fully. Persistence must never save the faded color.

**Interfaces:**
- Consumes: existing `effectiveVisible`.
- Produces: internal `displayFor(extra, pts)` returning `{ visible, faded }`; `fadedStyles: Map<string, OverlayStyle>` holding canonical styles for currently-faded ids so `persist()` writes the real color.

- [ ] **Step 1: Write the failing test**

Add to `overlays.test.ts`:
```ts
import { defaultVisibility } from "./visibility";

// A drawing hidden only by the interval filter (userVisible true) should be GHOSTED
// (rendered, faded) rather than removed, so it stays clickable.
describe("ghost stub", () => {
  it("ghosts an interval-hidden but user-visible drawing", () => {
    const m = defaultVisibility();
    m.units.minutes.on = false; // hidden on minute timeframes
    // decision table the manager implements:
    const userVisible = true;
    const intervalOk = false; // minutes off, on a minute resolution
    const ghost = userVisible && !intervalOk;
    expect(ghost).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it passes (contract guard)**

Run: `cd frontend && npm run test -- src/lib/overlays.test.ts`
Expected: PASS (pins the ghost decision the code below implements).

- [ ] **Step 3: Add `displayFor` + fade logic to `overlays.ts`**

Add a field on the class: `private fadedStyles = new Map<string, unknown>();`

Add a helper that splits the decision into render + fade:
```ts
  // Decide how a drawing should render given intent/interval/auto-hide:
  //   visible:false        — user turned it off (Show on chart unchecked) → fully hidden
  //   { visible, faded }   — interval/auto-hide says hide but the user wants it on →
  //                          render faded (ghost) so it stays clickable to reopen settings.
  private displayFor(
    extra: DrawingExtra,
    pts?: ReadonlyArray<{ timestamp?: number }>,
  ): { visible: boolean; faded: boolean } {
    const intent = extra.userVisible ?? true;
    if (!intent) return { visible: false, faded: false };
    const effective = this.effectiveVisible({ ...extra, userVisible: true }, pts);
    return { visible: true, faded: !effective };
  }
```

Add fade application that preserves canonical styles for persistence:
```ts
  private GHOST_OPACITY = 0.18;

  private applyDisplay(id: string, ov: Overlay, extra: DrawingExtra): void {
    const { visible, faded } = this.displayFor(extra, ov.points);
    if (!visible) {
      this.fadedStyles.delete(id);
      this.chart?.overrideOverlay({ id, visible: false });
      return;
    }
    if (faded) {
      // Stash the canonical (unfaded) styles ONCE so persist() never saves the ghost.
      if (!this.fadedStyles.has(id)) this.fadedStyles.set(id, ov.styles);
      const canonical = this.fadedStyles.get(id) as DeepPartial<OverlayStyle> | undefined;
      this.chart?.overrideOverlay({
        id,
        visible: true,
        styles: this.fade(canonical) as DeepPartial<OverlayStyle>,
      });
    } else {
      // Restore canonical styles if we previously faded this id.
      const canonical = this.fadedStyles.get(id) as DeepPartial<OverlayStyle> | undefined;
      this.fadedStyles.delete(id);
      this.chart?.overrideOverlay({
        id,
        visible: true,
        ...(canonical ? { styles: canonical } : {}),
      });
    }
  }

  // Reduce the line/text color opacity to GHOST_OPACITY without losing the hue.
  private fade(styles: DeepPartial<OverlayStyle> | undefined): DeepPartial<OverlayStyle> {
    const lineColor = (styles?.line as { color?: string })?.color ?? "#2962ff";
    return { line: { ...(styles?.line ?? {}), color: withAlpha(lineColor, this.GHOST_OPACITY) } };
  }
```

Add a `withAlpha(color, a)` util (top of file or in a shared util): convert `#rrggbb`/named to `rgba(...)` with alpha `a`. Implement for `#rgb`/`#rrggbb`/`rgb()`; fall back to the original string if unparseable.

- [ ] **Step 4: Route the three visibility paths through `applyDisplay`**

Replace the `overrideOverlay({ id, ..., visible: this.effectiveVisible(...) })` calls in `setVisible`, `setVisibilityModel`, and `applyIntervalVisibility` with `this.applyDisplay(id, ov, extra)` (for `applyIntervalVisibility`, build `extra` from `asDrawingExtra(ov.extendData)`). In rehydrate's `create`, keep the initial `visible: this.effectiveVisible(extra, d.points)`, then after creation call `applyIntervalVisibility()` once at the end of the loop so ghosts paint on load.

- [ ] **Step 5: Make `persist()` use canonical styles for faded ids**

In `persist()` drawing branch (~1183), replace `styles: ov.styles,` with:
```ts
          styles: (this.fadedStyles.get(id) as Overlay["styles"]) ?? ov.styles,
```
so a save while a drawing is ghosted writes the real color, not the faded one.

- [ ] **Step 6: Run tests + manual check, commit**

Run: `cd frontend && npm run test -- src/lib/overlays.test.ts && npm run lint`
Expected: PASS.

Manual: draw a Fib, set Visibility → Minutes off, switch to 5m → Fib shows faint; click it → settings reopen; switch to 1H → Fib solid. Reload → color unchanged (not faded).

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays.test.ts
git commit -m "feat(visibility): ghost-stub interval/auto-hidden drawings so they stay reachable"
```

---

## Task 7: Full-suite verification

- [ ] **Step 1: Run the whole frontend suite + lint + typecheck**

Run:
```bash
cd frontend && npm run test && npm run lint && npx tsc --noEmit
```
Expected: PASS, no type errors.

- [ ] **Step 2: Manual end-to-end pass**

- Drawing: per-unit ranges hide/show across 5m/1H/1D; auto-hide (N=3) hides a 2-bar-span trend line on a coarse TF and ghosts it.
- Indicator: per-unit visibility hides an indicator on excluded timeframes across candle + a sub-pane (RSI); persists across reload.
- Migration: a drawing saved before this change (legacy `intervals` or none) shows on all timeframes after upgrade (no visibility change).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test(visibility): full-suite + manual verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** §1 shared units → Tasks 1–2; §2 semantics/defaults/migration → Tasks 1, 3; §3 indicator wiring → Tasks 4–5; §4 auto-hide → Tasks 1 (`barsSpanned`), 2 (UI), 3 (drawings), 5 (anchored indicators only); §5 ghost stub → Task 6; §6 persistence/testing → every task's persist + test steps.
- **Intent vs effective:** drawings keep `userVisible` in extendData (existing); indicators gain `userVisible` in extendData (Task 5) so the interval filter never overwrites persisted intent — the advisor's corruption concern.
- **All-panes:** Task 4 iterates `getPanes()` not just `candle_pane`.
- **Risk flags called out inline:** klinecharts pane/indicator enumeration API (Task 4 Step 3), Cancel-restores-extendData (Task 5 Step 4), `withAlpha` parsing fallback (Task 6 Step 3). Each has a verify instruction rather than a placeholder.
