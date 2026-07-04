# Favorite Timeframes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pin any timeframe into the chart's quick-access bar, which shows the fixed defaults merged with pinned favorites, sorted by duration.

**Architecture:** Pure-logic helpers in `feed.ts` build the merged, duration-sorted quick bar from the fixed `PERIODS` plus a persisted list of favorite resolution keys. `persist.ts` stores that list globally (mirroring the existing indicator/drawing favorites). `Toolbar.tsx` renders the merged bar and adds a right-click context menu (reusing the existing `ContextMenu` component) to add/remove favorites. Frontend only — every favoritable resolution is already supported by the chart and backend.

**Tech Stack:** React + TypeScript (Vite), Vitest for unit tests. Chart is klinecharts-core (unaffected).

## Global Constraints

- Frontend only — no backend/API changes.
- Favorites are **global** (not per-cell/per-symbol), consistent with `loadFavoriteIndicators`/`loadFavoriteDrawings`.
- Default resolutions (`PERIODS`: `MINUTE MINUTE_5 MINUTE_15 MINUTE_30 HOUR HOUR_4 DAY WEEK`) are always shown and never removable.
- Quick bar is **always** sorted ascending by `RESOLUTION_SECONDS`; the favorites list's own order is irrelevant to display.
- No stars, no hover chrome — add/remove is via right-click only.
- Follow the app's UX conventions: TV-flat, no shadows, content-sized, dismiss-on-outside-click (the reused `ContextMenu` already conforms).
- Run commands from `frontend/`. Test: `npm run test:unit`. Typecheck+build: `npm run build`.

---

### Task 1: `feed.ts` — merged/sorted quick-bar helpers

**Files:**
- Modify: `frontend/src/lib/feed.ts` (add exports near `PERIODS`/`RESOLUTION_SECONDS`)
- Test: `frontend/src/lib/quickBar.test.ts` (new)

**Interfaces:**
- Consumes: existing `Period`, `PERIODS`, module-private `SECONDS_PERIODS`, `DERIVED_PERIODS`, `RESOLUTION_SECONDS` (all in `feed.ts`).
- Produces:
  - `ALL_PERIODS: Period[]`
  - `DEFAULT_RESOLUTIONS: Set<string>`
  - `periodByResolution(resolution: string): Period | undefined`
  - `quickBarPeriods(favoriteResolutions: string[]): Period[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/quickBar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  quickBarPeriods,
  periodByResolution,
  DEFAULT_RESOLUTIONS,
  PERIODS,
} from "./feed";

describe("quickBarPeriods", () => {
  it("returns exactly the defaults (in duration order) when there are no favorites", () => {
    const bar = quickBarPeriods([]);
    expect(bar.map((p) => p.resolution)).toEqual([
      "MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30",
      "HOUR", "HOUR_4", "DAY", "WEEK",
    ]);
  });

  it("inserts a sub-minute favorite before 1m", () => {
    const bar = quickBarPeriods(["SECOND_30"]).map((p) => p.resolution);
    expect(bar[0]).toBe("SECOND_30");
    expect(bar[1]).toBe("MINUTE");
  });

  it("inserts a derived favorite after 1W in duration order", () => {
    const bar = quickBarPeriods(["WEEK_2"]).map((p) => p.resolution);
    expect(bar[bar.length - 1]).toBe("WEEK_2");
    expect(bar[bar.indexOf("WEEK_2") - 1]).toBe("WEEK");
  });

  it("does not duplicate a favorite that equals a default", () => {
    const bar = quickBarPeriods(["HOUR"]).map((p) => p.resolution);
    expect(bar.filter((r) => r === "HOUR")).toHaveLength(1);
    expect(bar).toEqual(quickBarPeriods([]).map((p) => p.resolution));
  });

  it("ignores unknown resolution keys and de-dupes repeats", () => {
    const bar = quickBarPeriods(["NOPE", "SECOND_30", "SECOND_30"]).map((p) => p.resolution);
    expect(bar.filter((r) => r === "SECOND_30")).toHaveLength(1);
    expect(bar).not.toContain("NOPE");
  });
});

describe("periodByResolution", () => {
  it("resolves defaults, seconds, and derived keys", () => {
    expect(periodByResolution("HOUR")?.label).toBe("1H");
    expect(periodByResolution("SECOND_30")?.label).toBe("30s");
    expect(periodByResolution("WEEK_2")?.label).toBe("2W");
    expect(periodByResolution("NOPE")).toBeUndefined();
  });
});

describe("DEFAULT_RESOLUTIONS", () => {
  it("is exactly the PERIODS resolution set", () => {
    expect([...DEFAULT_RESOLUTIONS].sort()).toEqual(
      PERIODS.map((p) => p.resolution).sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- quickBar`
Expected: FAIL — `quickBarPeriods`, `periodByResolution`, `DEFAULT_RESOLUTIONS` are not exported from `./feed`.

- [ ] **Step 3: Add the helpers to `feed.ts`**

In `frontend/src/lib/feed.ts`, immediately **after** the `PERIOD_GROUPS` definition (currently ends at line 85), add:

```ts
// Every selectable timeframe (seconds → derived), used to resolve a favorite
// resolution key back to its Period and to build the merged quick bar.
export const ALL_PERIODS: Period[] = [
  ...SECONDS_PERIODS,
  ...PERIODS,
  ...DERIVED_PERIODS,
];

const PERIOD_BY_RESOLUTION = new Map(ALL_PERIODS.map((p) => [p.resolution, p]));

// The fixed defaults that always occupy the quick bar and can't be removed.
export const DEFAULT_RESOLUTIONS = new Set(PERIODS.map((p) => p.resolution));

export function periodByResolution(resolution: string): Period | undefined {
  return PERIOD_BY_RESOLUTION.get(resolution);
}
```

Then add the following **after** the `RESOLUTION_SECONDS` map (currently ends at line 634), since it references `RESOLUTION_SECONDS`:

```ts
// The quick-access timeframe bar: the fixed defaults merged with the user's
// favorite resolutions, de-duped and sorted ascending by duration. The favorite
// list's own order is irrelevant — display order is always by RESOLUTION_SECONDS.
export function quickBarPeriods(favoriteResolutions: string[]): Period[] {
  const byRes = new Map(PERIODS.map((p) => [p.resolution, p]));
  for (const r of favoriteResolutions) {
    const p = periodByResolution(r);
    if (p) byRes.set(r, p);
  }
  return [...byRes.values()].sort(
    (a, b) =>
      (RESOLUTION_SECONDS[a.resolution] ?? 0) -
      (RESOLUTION_SECONDS[b.resolution] ?? 0),
  );
}
```

Note: `SECONDS_PERIODS` and `DERIVED_PERIODS` stay `const` (module-private); they are only re-exported as part of `ALL_PERIODS`. No other change to their declarations.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- quickBar`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/feed.ts frontend/src/lib/quickBar.test.ts
git commit -m "feat(timeframes): quickBarPeriods helper (defaults merged with favorites, duration-sorted)"
```

---

### Task 2: `persist.ts` — favorite-resolutions storage

**Files:**
- Modify: `frontend/src/lib/persist.ts` (add after the `FAVORITE_DRAWINGS_KEY` block, ~line 992)
- Test: `frontend/src/lib/favoriteResolutions.test.ts` (new)

**Interfaces:**
- Consumes: existing `PREFIX`, `load`, `save` in `persist.ts`.
- Produces:
  - `loadFavoriteResolutions(): string[]`
  - `saveFavoriteResolutions(list: string[]): void`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/favoriteResolutions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { loadFavoriteResolutions, saveFavoriteResolutions } from "./persist";

describe("favorite resolutions persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to an empty list", () => {
    expect(loadFavoriteResolutions()).toEqual([]);
  });

  it("round-trips a saved list", () => {
    saveFavoriteResolutions(["SECOND_30", "WEEK_2"]);
    expect(loadFavoriteResolutions()).toEqual(["SECOND_30", "WEEK_2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- favoriteResolutions`
Expected: FAIL — `loadFavoriteResolutions` / `saveFavoriteResolutions` not exported from `./persist`.

- [ ] **Step 3: Add the helpers to `persist.ts`**

In `frontend/src/lib/persist.ts`, immediately after the `saveFavoriteDrawings` function (ends ~line 992), add:

```ts
// Favorite timeframes (GLOBAL preference) — resolution keys the user pinned onto
// the quick-access bar, on top of the fixed defaults. Order here is just the pin
// set; the bar itself always renders in duration order. Mirrors the indicator /
// drawing favorites idiom above.
const FAVORITE_RESOLUTIONS_KEY = `${PREFIX}.favoriteResolutions`;
export function loadFavoriteResolutions(): string[] {
  return load<string[]>(FAVORITE_RESOLUTIONS_KEY, []);
}
export function saveFavoriteResolutions(list: string[]): void {
  save(FAVORITE_RESOLUTIONS_KEY, list);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- favoriteResolutions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist.ts frontend/src/lib/favoriteResolutions.test.ts
git commit -m "feat(timeframes): persist favorite resolutions (global)"
```

---

### Task 3: `Toolbar.tsx` — merged bar + right-click add/remove

**Files:**
- Modify: `frontend/src/Toolbar.tsx`

**Interfaces:**
- Consumes: `quickBarPeriods`, `DEFAULT_RESOLUTIONS` from `./lib/feed`; `loadFavoriteResolutions`, `saveFavoriteResolutions` from `./lib/persist`; existing `ContextMenu` (default import already present at line 49).
- Produces: no new exports (UI wiring only).

Manual/visual verification (no unit test — Toolbar depends on chart controller + signals; logic is already covered by Task 1). Verified via typecheck + running app.

- [ ] **Step 1: Add imports**

Find the existing `feed` import in `frontend/src/Toolbar.tsx` (the one bringing in `PERIODS`, `PERIOD_GROUPS`, `Period`) and add `quickBarPeriods` and `DEFAULT_RESOLUTIONS` to it. For example, if the import reads:

```ts
import { PERIODS, PERIOD_GROUPS, type Period } from "./lib/feed";
```

change it to:

```ts
import {
  PERIODS,
  PERIOD_GROUPS,
  quickBarPeriods,
  DEFAULT_RESOLUTIONS,
  type Period,
} from "./lib/feed";
```

(Keep whatever other symbols the existing import already lists.)

Then add to the existing `./lib/persist` import the two new helpers:

```ts
loadFavoriteResolutions,
saveFavoriteResolutions,
```

(alongside the existing `loadFavoriteIndicators` / `saveFavoriteIndicators` etc.)

- [ ] **Step 2: Add state + toggle + merged bar computation**

Near the other favorites state (the `favIndicators` line, ~137) add:

```tsx
const [favResolutions, setFavResolutions] = useState<string[]>(loadFavoriteResolutions);
const [tfMenu, setTfMenu] = useState<{ x: number; y: number; resolution: string } | null>(null);
```

Add the toggle helper near `toggleFavIndicator` (~243):

```tsx
// Pin/unpin a timeframe on the quick bar (global preference). Defaults are never
// passed here — their buttons/rows offer no context action.
function toggleFavResolution(resolution: string) {
  setFavResolutions((prev) => {
    const next = prev.includes(resolution)
      ? prev.filter((r) => r !== resolution)
      : [...prev, resolution];
    saveFavoriteResolutions(next);
    return next;
  });
}
```

Just before the `return (`/JSX for the periods bar (near line 407, after the `if (!symbol || !period)` guard), compute the merged bar:

```tsx
const quickBar = quickBarPeriods(favResolutions);
```

- [ ] **Step 3: Render the merged bar + right-click on bar buttons**

Replace the quick-bar map (currently `PERIODS.map(...)`, lines ~438–447) with `quickBar.map(...)` and add `onContextMenu`:

```tsx
{quickBar.map((p) => (
  <button
    key={p.resolution}
    className={p.resolution === period.resolution ? "on" : ""}
    title={`${p.label} interval`}
    onClick={() => onPeriod(p)}
    onContextMenu={(e) => {
      // Defaults (1m–1W) are fixed — no remove menu.
      if (DEFAULT_RESOLUTIONS.has(p.resolution)) return;
      e.preventDefault();
      setTfMenu({ x: e.pageX, y: e.pageY, resolution: p.resolution });
    }}
  >
    {p.label}
  </button>
))}
```

- [ ] **Step 4: Fix the extra-period chip guard to key off the merged bar**

Change the chip condition (currently `PERIODS.every((p) => p.resolution !== period.resolution)`, ~line 450) to use the merged bar so a pinned-and-active TF renders as a bar button, not the chip:

```tsx
{quickBar.every((p) => p.resolution !== period.resolution) && (
```

(Leave the chip's button body unchanged.)

- [ ] **Step 5: Add right-click on dropdown rows**

In the grouped dropdown `<li>` (currently ~475–486), add an `onContextMenu` alongside the existing `onClick`:

```tsx
<li
  key={p.resolution}
  className={p.resolution === period.resolution ? "on" : ""}
  onClick={() => {
    onPeriod(p);
    setIntervalOpen(false);
  }}
  onContextMenu={(e) => {
    if (DEFAULT_RESOLUTIONS.has(p.resolution)) return;
    e.preventDefault();
    setTfMenu({ x: e.pageX, y: e.pageY, resolution: p.resolution });
  }}
>
  {p.label}
  {p.liveOnly && <span className="live-only">live</span>}
</li>
```

- [ ] **Step 6: Render the timeframe context menu**

Next to the existing `{drawMenu && (<ContextMenu .../>)}` block (~784), add:

```tsx
{tfMenu && (
  <ContextMenu
    x={tfMenu.x}
    y={tfMenu.y}
    items={[
      {
        label: favResolutions.includes(tfMenu.resolution)
          ? "Remove from quick bar"
          : "Add to quick bar",
        onClick: () => toggleFavResolution(tfMenu.resolution),
      },
    ]}
    onClose={() => setTfMenu(null)}
  />
)}
```

- [ ] **Step 7: Typecheck + build**

Run: `npm run build`
Expected: `tsc -b` passes with no type errors and vite build completes.

- [ ] **Step 8: Manual verification in the app**

Start the app (per the project's run skill / existing dev server) and on a chart:
1. Open the interval dropdown, right-click `30s` → menu shows **"Add to quick bar"**; click it. → `30s` appears in the quick bar **before** `1m`.
2. Right-click a derived TF (e.g. `2W`) in the dropdown → add it. → `2W` appears **after** `1W`.
3. Right-click the `30s` **bar button** → **"Remove from quick bar"**; click. → it disappears from the bar.
4. Right-click a default button (e.g. `1H`) → no context menu appears (default guarded).
5. Reload the page → pinned favorites persist and stay in duration-sorted position; open a second chart cell/tab → same quick bar (global).

Expected: all five behave as described.

- [ ] **Step 9: Lint + commit**

```bash
cd frontend && npm run lint
git add frontend/src/Toolbar.tsx
git commit -m "feat(timeframes): favorite timeframes in the quick bar via right-click"
```

---

## Self-Review Notes

- **Spec coverage:** two sets (Task 1 `quickBarPeriods` + `DEFAULT_RESOLUTIONS`); merged duration-sorted bar (Task 1 + Task 3 Step 3); right-click add/remove, defaults guarded (Task 3 Steps 3/5/6); global persistence (Task 2); `feed.ts` helper + `periodByResolution` (Task 1); extra-period chip fix (Task 3 Step 4). Non-goals (reorder, per-cell, presets) intentionally absent.
- **Type consistency:** `quickBarPeriods(favoriteResolutions: string[]): Period[]`, `periodByResolution(resolution: string): Period | undefined`, `DEFAULT_RESOLUTIONS: Set<string>`, `loadFavoriteResolutions(): string[]`, `saveFavoriteResolutions(list: string[]): void`, `tfMenu: { x; y; resolution } | null` — used identically across tasks.
- **No placeholders:** every code step is complete and copy-pasteable.
