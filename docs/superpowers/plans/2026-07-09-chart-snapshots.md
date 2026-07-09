# Chart Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save the focused chart cell's full state (symbol, timeframe, visible range, drawings, indicators, thumbnail) as an immutable snapshot, browse snapshots in a thumbnail gallery, and restore any snapshot into a fresh one-cell tab scrolled to the saved range with a taken-at marker.

**Architecture:** Snapshots reuse the symbol-template blob contract verbatim (`IndicatorInstance[]`, `SavedIndicatorConfig` map, `SavedOverlay[]`, AVWAP anchor map) so capture/restore ride proven persistence + hydration paths. Each snapshot is one broker-scoped key plus an index key. Restore mints a new one-cell tab (detach-tab pattern), pre-writes the blobs into its fresh scope before mount, then ChartCore's existing paging machinery covers the saved range and positions the window. A persisted per-scope `snapshotMeta` drives a vertical taken-at marker overlay.

**Tech Stack:** React 19 + TypeScript, klinecharts 9.8, vitest (jsdom) for unit tests, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-07-09-chart-snapshots-design.md`

## Global Constraints

- All frontend code under `frontend/src/`; run unit tests with `cd frontend && npx vitest run <file>`; e2e with `cd frontend && npx playwright test e2e/<file>` (needs dev server + backend at :8000).
- Light theme first, flat (no shadows), content-sized, dismiss-on-outside-click (standing UX conventions).
- Use the shared `Tooltip`/`InfoTip` components for any tooltip — never native `title=` on NEW interactive elements is acceptable for icon buttons only where the toolbar already does so (existing toolbar buttons use `title=`; match the surrounding idiom).
- No backward-compat/migration code — there is no old snapshot data.
- Commit after every task; work happens in a dedicated git worktree on branch `chart-snapshots`.
- `Date.now()` is fine in app code; tests must not depend on wall-clock values.

---

### Task 1: Snapshot persistence layer

**Files:**
- Create: `frontend/src/lib/persist/snapshots.ts`
- Modify: `frontend/src/lib/persist.ts` (barrel — add one export line)
- Test: `frontend/src/lib/persist/snapshots.test.ts`

**Interfaces:**
- Consumes: `load`, `save`, `removeKeyEverywhere`, `root`, `ns` from `./core` (`frontend/src/lib/persist/core.ts`); `IndicatorInstance`, `SavedIndicatorConfig`, `SavedOverlay` types from `./artifacts`; `Instrument`, `Period` types from `../feed`.
- Produces (used by Tasks 2, 4, 5, 6):
  - `interface ChartSnapshot { id, name, note?, epic, symbol: Instrument, period: Period, takenAt, range: {from,to}, indicators, indicatorConfigs, drawings, avwapAnchors, thumb? }`
  - `interface SnapshotMeta { snapshotId: string; name: string; takenAt: number; pendingRange?: { from: number; to: number } }`
  - `loadSnapshotIndex(): string[]`, `loadSnapshot(id: string): ChartSnapshot | null`, `saveSnapshot(s: ChartSnapshot): void`, `deleteSnapshot(id: string): void`
  - `loadSnapshotMeta(scope: string): SnapshotMeta | null`, `saveSnapshotMeta(scope: string, m: SnapshotMeta): void`, `deleteSnapshotMeta(scope: string): void`

Key layout (matches template precedent): snapshots are broker-scoped like symbol templates — `auto-trader.b.<broker>.snapshot.<id>` and index `auto-trader.b.<broker>.snapshots` — because a snapshot's epic belongs to a broker. `snapshotMeta` is cell-scoped via `ns(scope, "snapshotMeta")`, so `purgeScope` cleans it up for free when a tab closes.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/lib/persist/snapshots.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "../testMemStorage";
import {
  loadSnapshot,
  loadSnapshotIndex,
  saveSnapshot,
  deleteSnapshot,
  loadSnapshotMeta,
  saveSnapshotMeta,
  deleteSnapshotMeta,
  type ChartSnapshot,
} from "./snapshots";
import { purgeScope } from "./core";

function makeSnap(id: string): ChartSnapshot {
  return {
    id,
    name: `Snap ${id}`,
    epic: "US100",
    symbol: { epic: "US100", name: "US 100", status: "TRADEABLE" },
    period: { resolution: "MINUTE_15", label: "15m" },
    takenAt: 1_700_000_000_000,
    range: { from: 1_699_990_000_000, to: 1_700_000_000_000 },
    indicators: [{ id: "EMA", type: "EMA" }],
    indicatorConfigs: { EMA: { calcParams: [9] } },
    drawings: [{ name: "segment", points: [{ timestamp: 1, value: 2 }] }],
    avwapAnchors: {},
  };
}

beforeEach(() => {
  installMemStorage();
});

describe("snapshot persistence", () => {
  it("round-trips a snapshot and maintains the index newest-first", () => {
    expect(loadSnapshotIndex()).toEqual([]);
    saveSnapshot(makeSnap("a"));
    saveSnapshot(makeSnap("b"));
    expect(loadSnapshotIndex()).toEqual(["b", "a"]);
    expect(loadSnapshot("a")?.name).toBe("Snap a");
    expect(loadSnapshot("missing")).toBeNull();
  });

  it("re-saving an existing id updates in place without duplicating the index entry", () => {
    saveSnapshot(makeSnap("a"));
    saveSnapshot({ ...makeSnap("a"), name: "Renamed" });
    expect(loadSnapshotIndex()).toEqual(["a"]);
    expect(loadSnapshot("a")?.name).toBe("Renamed");
  });

  it("deleteSnapshot removes the record and its index entry", () => {
    saveSnapshot(makeSnap("a"));
    saveSnapshot(makeSnap("b"));
    deleteSnapshot("a");
    expect(loadSnapshotIndex()).toEqual(["b"]);
    expect(loadSnapshot("a")).toBeNull();
  });

  it("snapshotMeta round-trips per scope and is purged with the scope", () => {
    const scope = "tab.T1";
    expect(loadSnapshotMeta(scope)).toBeNull();
    saveSnapshotMeta(scope, {
      snapshotId: "a",
      name: "Snap a",
      takenAt: 5,
      pendingRange: { from: 1, to: 5 },
    });
    expect(loadSnapshotMeta(scope)?.pendingRange).toEqual({ from: 1, to: 5 });
    deleteSnapshotMeta(scope);
    expect(loadSnapshotMeta(scope)).toBeNull();
    saveSnapshotMeta(scope, { snapshotId: "a", name: "Snap a", takenAt: 5 });
    purgeScope(scope);
    expect(loadSnapshotMeta(scope)).toBeNull();
  });
});
```

Note: check `installMemStorage`'s actual location/name in `frontend/src/lib/testMemStorage.ts` and how `persist.test.ts` imports it (it may also need a broker set — look at the top of `frontend/src/lib/persist.test.ts` for a `setPersistBroker`/similar call in `beforeEach` and copy that setup exactly, since `root()` requires an active broker).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist/snapshots.test.ts`
Expected: FAIL — `./snapshots` module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// frontend/src/lib/persist/snapshots.ts
import { load, save, removeKeyEverywhere, root, ns } from "./core";
import type {
  IndicatorInstance,
  SavedIndicatorConfig,
  SavedOverlay,
} from "./artifacts";
import type { Instrument, Period } from "../feed";

/** Immutable saved chart state. Blob fields reuse the per-cell persisted shapes verbatim. */
export interface ChartSnapshot {
  id: string;
  name: string;
  note?: string;
  epic: string;
  symbol: Instrument;
  period: Period;
  takenAt: number; // ms
  range: { from: number; to: number }; // visible window at capture, ms
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  drawings: SavedOverlay[];
  avwapAnchors: Record<string, number>; // instance id -> anchor ms
  thumb?: string; // small JPEG data-URI
}

/** Per-restored-scope marker state; pendingRange is cleared after the first scroll-to-range. */
export interface SnapshotMeta {
  snapshotId: string;
  name: string;
  takenAt: number;
  pendingRange?: { from: number; to: number };
}

const snapshotKey = (id: string) => root(`snapshot.${id}`);
const indexKey = () => root("snapshots");
const metaKey = (scope: string) => ns(scope, "snapshotMeta");

export function loadSnapshotIndex(): string[] {
  return load<string[]>(indexKey(), []);
}

export function loadSnapshot(id: string): ChartSnapshot | null {
  return load<ChartSnapshot | null>(snapshotKey(id), null);
}

export function saveSnapshot(s: ChartSnapshot): void {
  save(snapshotKey(s.id), s);
  const idx = loadSnapshotIndex();
  if (!idx.includes(s.id)) save(indexKey(), [s.id, ...idx]);
}

export function deleteSnapshot(id: string): void {
  removeKeyEverywhere(snapshotKey(id));
  save(
    indexKey(),
    loadSnapshotIndex().filter((x) => x !== id),
  );
}

export function loadSnapshotMeta(scope: string): SnapshotMeta | null {
  return load<SnapshotMeta | null>(metaKey(scope), null);
}

export function saveSnapshotMeta(scope: string, m: SnapshotMeta): void {
  save(metaKey(scope), m);
}

export function deleteSnapshotMeta(scope: string): void {
  removeKeyEverywhere(metaKey(scope));
}
```

Add to the barrel `frontend/src/lib/persist.ts` (match the existing re-export style):

```typescript
export * from "./persist/snapshots";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/persist/snapshots.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full unit suite to catch barrel collisions**

Run: `cd frontend && npx vitest run`
Expected: all pass. If a name collides in the barrel, rename ours (nothing else exports `loadSnapshot*`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/persist/snapshots.ts frontend/src/lib/persist/snapshots.test.ts frontend/src/lib/persist.ts
git commit -m "feat(snapshots): persistence layer — per-id snapshot keys + index + per-scope snapshotMeta"
```

---

### Task 2: Capture & restore-write logic + thumbnail helper

**Files:**
- Create: `frontend/src/lib/snapshots.ts`
- Test: `frontend/src/lib/snapshots.test.ts`

**Interfaces:**
- Consumes (Task 1): `ChartSnapshot`, `SnapshotMeta`, `saveSnapshotMeta`; persist artifacts accessors: `loadIndicators(scope)`, `saveIndicators(scope, list)`, `loadIndicatorConfigs(scope)`, `saveIndicatorConfig(scope, id, cfg)`, `loadDrawings(scope, epic)`, `saveDrawings(scope, epic, list)`, `loadAvwapAnchor(scope, epic, id)`, `saveAvwapAnchor(scope, epic, id, anchorMs)` — all from `./persist`.
- Produces (used by Tasks 3, 4):
  - `captureSnapshot(args: { scope: string; symbol: Instrument; period: Period; range: { from: number; to: number }; thumb?: string }): ChartSnapshot`
  - `writeSnapshotToScope(s: ChartSnapshot, scope: string): void`
  - `makeChartThumbnail(chart: Chart, maxWidth?: number): Promise<string | undefined>`
  - `defaultSnapshotName(symbol: Instrument, period: Period, takenAt: number): string`

Design notes:
- `captureSnapshot` is pure over persisted stores + passed-in range/thumb — the caller (Toolbar, Task 3) reads the visible range via `readVisibleRange(chart)` from `lib/chartSync.ts:227` and the thumb via `makeChartThumbnail`. This keeps the capture unit-testable without a chart.
- AVWAP anchors: for each instance with `type === "AVWAP"`, read `loadAvwapAnchor(scope, epic, id)`; exclude zero/absent anchors (same rule `captureSymbolTemplate` uses, `lib/templates.ts:47-59`).
- `writeSnapshotToScope` write order is load-bearing (templates precedent): AVWAP anchors FIRST, then indicators, configs, drawings, then `snapshotMeta` with `pendingRange` set to the snapshot's range.
- `makeChartThumbnail` wraps `chart.getConvertPictureUrl(true, "jpeg", "#ffffff")` (klinecharts `dist/index.d.ts:897`), downscales via an offscreen canvas to `maxWidth` (default 480), exports `toDataURL("image/jpeg", 0.75)`. Any error → resolve `undefined` (snapshot must never fail on thumbnail).

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/lib/snapshots.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";
import {
  saveIndicators,
  saveIndicatorConfig,
  saveDrawings,
  saveAvwapAnchor,
  loadIndicators,
  loadIndicatorConfigs,
  loadDrawings,
  loadAvwapAnchor,
  loadSnapshotMeta,
} from "./persist";
import {
  captureSnapshot,
  writeSnapshotToScope,
  defaultSnapshotName,
  makeChartThumbnail,
} from "./snapshots";
import type { Chart } from "klinecharts";

const SCOPE = "tab.A";
const EPIC = "US100";
const SYMBOL = { epic: EPIC, name: "US 100", status: "TRADEABLE" };
const PERIOD = { resolution: "MINUTE_15", label: "15m" };
const RANGE = { from: 1_000, to: 2_000 };

beforeEach(() => {
  installMemStorage();
});

describe("captureSnapshot", () => {
  it("assembles blobs from the persisted scope stores", () => {
    saveIndicators(SCOPE, [
      { id: "EMA", type: "EMA" },
      { id: "AVWAP", type: "AVWAP" },
    ]);
    saveIndicatorConfig(SCOPE, "EMA", { calcParams: [9] });
    saveDrawings(SCOPE, EPIC, [
      { name: "segment", points: [{ timestamp: 1, value: 2 }] },
    ]);
    saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1234);

    const s = captureSnapshot({ scope: SCOPE, symbol: SYMBOL, period: PERIOD, range: RANGE });

    expect(s.epic).toBe(EPIC);
    expect(s.range).toEqual(RANGE);
    expect(s.indicators).toEqual([
      { id: "EMA", type: "EMA" },
      { id: "AVWAP", type: "AVWAP" },
    ]);
    expect(s.indicatorConfigs.EMA).toEqual({ calcParams: [9] });
    expect(s.drawings).toHaveLength(1);
    expect(s.avwapAnchors).toEqual({ AVWAP: 1234 });
    expect(s.takenAt).toBeGreaterThan(0);
    expect(s.id).toMatch(/^snap-/);
    expect(s.name).toBe(defaultSnapshotName(SYMBOL, PERIOD, s.takenAt));
  });

  it("excludes unplaced (zero-anchor) AVWAPs from avwapAnchors", () => {
    saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }]);
    const s = captureSnapshot({ scope: SCOPE, symbol: SYMBOL, period: PERIOD, range: RANGE });
    expect(s.avwapAnchors).toEqual({});
  });
});

describe("writeSnapshotToScope", () => {
  it("writes all blobs into the target scope and sets snapshotMeta with pendingRange", () => {
    saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }, { id: "RSI", type: "RSI" }]);
    saveIndicatorConfig(SCOPE, "RSI", { calcParams: [14] });
    saveDrawings(SCOPE, EPIC, [{ name: "segment", points: [{ timestamp: 1, value: 2 }] }]);
    saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 999);
    const s = captureSnapshot({ scope: SCOPE, symbol: SYMBOL, period: PERIOD, range: RANGE });

    const target = "tab.NEW";
    writeSnapshotToScope(s, target);

    expect(loadIndicators(target)).toEqual(s.indicators);
    expect(loadIndicatorConfigs(target).RSI).toEqual({ calcParams: [14] });
    expect(loadDrawings(target, EPIC)).toEqual(s.drawings);
    expect(loadAvwapAnchor(target, EPIC, "AVWAP")).toBe(999);
    const meta = loadSnapshotMeta(target);
    expect(meta).toMatchObject({
      snapshotId: s.id,
      name: s.name,
      takenAt: s.takenAt,
      pendingRange: RANGE,
    });
  });
});

describe("makeChartThumbnail", () => {
  it("resolves undefined when the chart export throws", async () => {
    const chart = {
      getConvertPictureUrl: () => {
        throw new Error("no canvas");
      },
    } as unknown as Chart;
    await expect(makeChartThumbnail(chart)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/snapshots.test.ts`
Expected: FAIL — `./snapshots` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// frontend/src/lib/snapshots.ts
import type { Chart } from "klinecharts";
import {
  loadIndicators,
  saveIndicators,
  loadIndicatorConfigs,
  saveIndicatorConfig,
  loadDrawings,
  saveDrawings,
  loadAvwapAnchor,
  saveAvwapAnchor,
  saveSnapshotMeta,
  type ChartSnapshot,
} from "./persist";
import type { Instrument, Period } from "./feed";

let snapSeq = 0;
function mintSnapshotId(): string {
  snapSeq += 1;
  return `snap-${Date.now().toString(36)}-${snapSeq}`;
}

export function defaultSnapshotName(
  symbol: Instrument,
  period: Period,
  takenAt: number,
): string {
  const d = new Date(takenAt);
  const date = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${symbol.epic} ${period.label} · ${date}`;
}

/** Assemble a snapshot from the PERSISTED scope stores (authoritative — kept
 *  current by OverlayManager.persist / saveIndicators on every edit). */
export function captureSnapshot(args: {
  scope: string;
  symbol: Instrument;
  period: Period;
  range: { from: number; to: number };
  thumb?: string;
}): ChartSnapshot {
  const { scope, symbol, period, range, thumb } = args;
  const epic = symbol.epic;
  const indicators = loadIndicators(scope);
  const avwapAnchors: Record<string, number> = {};
  for (const inst of indicators) {
    if (inst.type !== "AVWAP") continue;
    const anchor = loadAvwapAnchor(scope, epic, inst.id);
    if (anchor > 0) avwapAnchors[inst.id] = anchor;
  }
  const takenAt = Date.now();
  return {
    id: mintSnapshotId(),
    name: defaultSnapshotName(symbol, period, takenAt),
    epic,
    symbol,
    period,
    takenAt,
    range,
    indicators,
    indicatorConfigs: loadIndicatorConfigs(scope),
    drawings: loadDrawings(scope, epic),
    avwapAnchors,
    thumb,
  };
}

/** Pre-write a snapshot's blobs into a FRESH scope before its cell mounts.
 *  Order is load-bearing: AVWAP anchors must exist before indicator rehydrate reads them. */
export function writeSnapshotToScope(s: ChartSnapshot, scope: string): void {
  for (const [id, anchor] of Object.entries(s.avwapAnchors)) {
    saveAvwapAnchor(scope, s.epic, id, anchor);
  }
  saveIndicators(scope, s.indicators);
  for (const [id, cfg] of Object.entries(s.indicatorConfigs)) {
    saveIndicatorConfig(scope, id, cfg);
  }
  saveDrawings(scope, s.epic, s.drawings);
  saveSnapshotMeta(scope, {
    snapshotId: s.id,
    name: s.name,
    takenAt: s.takenAt,
    pendingRange: s.range,
  });
}

/** Full-size chart export downscaled to a small JPEG data-URI.
 *  Never throws — a failed thumbnail must not fail the snapshot. */
export function makeChartThumbnail(
  chart: Chart,
  maxWidth = 480,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const url = chart.getConvertPictureUrl(true, "jpeg", "#ffffff");
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxWidth / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const g = canvas.getContext("2d");
          if (!g) return resolve(undefined);
          g.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.75));
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = url;
    } catch {
      resolve(undefined);
    }
  });
}
```

Note: `chart.getConvertPictureUrl` is typed `(includeOverlay?: boolean, type?: string, backgroundColor?: string) => string` — verified in `frontend/node_modules/klinecharts/dist/index.d.ts:897`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/snapshots.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/snapshots.ts frontend/src/lib/snapshots.test.ts
git commit -m "feat(snapshots): capture from persisted stores + write-to-fresh-scope + thumbnail helper"
```

---

### Task 3: Toolbar camera button + gallery-open button

**Files:**
- Modify: `frontend/src/Toolbar.tsx` (add two icon buttons next to the Template menu, ~line 689 where `.tmpl-menu` starts)
- Modify: `frontend/src/lib/signals.ts` (add gallery-open signal)
- Modify: `frontend/src/App.css` (button styles)

**Interfaces:**
- Consumes (Task 2): `captureSnapshot`, `makeChartThumbnail` from `./lib/snapshots`; (Task 1) `saveSnapshot` from `./lib/persist`; `readVisibleRange` from `./lib/chartSync` (line 227, returns `{ fromTs, toTs } | null`); `toast` from `./lib/notify`; Toolbar's existing props `controller` (→ `controller?.scope`, `controller?.chart`), `symbol`, `period`.
- Produces (used by Task 4): `snapshotsGalleryOpen = new Signal<boolean>(false)` in `signals.ts`.

No unit test for this task (Toolbar has no test harness; the e2e in Task 7 covers the button end-to-end). Verify by lint + typecheck + manual smoke.

- [ ] **Step 1: Add the signal**

In `frontend/src/lib/signals.ts`, near the other panel-open signals (e.g. `alertsPanelOpen`, line ~82):

```typescript
/** Snapshots gallery modal (global, rendered by App). */
export const snapshotsGalleryOpen = new Signal<boolean>(false);
```

- [ ] **Step 2: Add the buttons to Toolbar**

In `frontend/src/Toolbar.tsx`, immediately BEFORE the `.tmpl-menu` div (~line 689), add a save handler and two buttons. Camera SVG inline (match `MenuIcons` stroke style — inspect `frontend/src/lib/menuIcons.tsx` for stroke width/viewBox conventions and copy them):

```tsx
const saveSnapshot_ = async () => {
  if (!chart || !controller || !symbol || !period) return;
  const range = readVisibleRange(chart);
  if (!range) {
    toast("Chart not ready — nothing to snapshot");
    return;
  }
  const thumb = await makeChartThumbnail(chart);
  const snap = captureSnapshot({
    scope: controller.scope,
    symbol,
    period,
    range: { from: range.fromTs, to: range.toTs },
    thumb,
  });
  saveSnapshot(snap);
  toast(`Snapshot saved — ${snap.name}`);
};
```

```tsx
<div className="snap-controls">
  <button
    className="snap-save"
    title="Save a snapshot of this chart (state + drawings + indicators)"
    disabled={!chart || !symbol || !period}
    onClick={() => void saveSnapshot_()}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  </button>
  <button
    className="snap-gallery"
    title="Browse saved snapshots"
    onClick={() => snapshotsGalleryOpen.set(true)}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  </button>
</div>
```

Imports to add at the top of Toolbar.tsx: `captureSnapshot`, `makeChartThumbnail` from `./lib/snapshots`; `saveSnapshot` from `./lib/persist`; `readVisibleRange` from `./lib/chartSync`; `snapshotsGalleryOpen` from `./lib/signals`. (`toast` is already imported, line ~verify.)

- [ ] **Step 3: Style**

In `frontend/src/App.css`, next to the existing toolbar button rules (search `.tmpl-menu` and mirror the sibling button styling): `.snap-controls { display: flex; gap: 2px; }` and make `.snap-save`/`.snap-gallery` visually identical to other toolbar icon buttons (same height, hover state, no shadow).

- [ ] **Step 4: Verify typecheck + lint + existing tests**

Run: `cd frontend && npx tsc -b && npx eslint src/Toolbar.tsx src/lib/signals.ts && npx vitest run`
Expected: clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/Toolbar.tsx frontend/src/lib/signals.ts frontend/src/App.css
git commit -m "feat(snapshots): toolbar camera button (instant save + toast) and gallery-open button"
```

---

### Task 4: SnapshotGallery component + App wiring (restore into fresh tab)

**Files:**
- Create: `frontend/src/SnapshotGallery.tsx`
- Modify: `frontend/src/App.tsx` (render gallery, restore handler)
- Modify: `frontend/src/App.css` (gallery card styles)
- Test: `frontend/src/SnapshotGallery.test.tsx`

**Interfaces:**
- Consumes: `FloatingModal` (`components/FloatingModal.tsx`, props `{ title, onClose, width?, className?, children }`); `loadSnapshotIndex`, `loadSnapshot`, `saveSnapshot`, `deleteSnapshot`, `type ChartSnapshot` from `./lib/persist`; `requestConfirm` from `./lib/signals` (App renders the ConfirmDialog already); `snapshotsGalleryOpen` (Task 3); `writeSnapshotToScope` (Task 2); App internals: `newTabId()` (App.tsx:167), `primaryCellScope` (persist), `setTabs`, `setActiveId`, `ChartTab` type.
- Produces: `SnapshotGallery({ onRestore, onClose }: { onRestore: (s: ChartSnapshot) => void; onClose: () => void })` default export.

- [ ] **Step 1: Write the failing component test**

```tsx
// frontend/src/SnapshotGallery.test.tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";
import { saveSnapshot, loadSnapshot, loadSnapshotIndex } from "./lib/persist";
import { confirmRequest } from "./lib/signals";
import SnapshotGallery from "./SnapshotGallery";
import type { ChartSnapshot } from "./lib/persist";

function makeSnap(id: string, name: string): ChartSnapshot {
  return {
    id,
    name,
    epic: "US100",
    symbol: { epic: "US100", name: "US 100", status: "TRADEABLE" },
    period: { resolution: "MINUTE_15", label: "15m" },
    takenAt: 1_700_000_000_000,
    range: { from: 1, to: 2 },
    indicators: [],
    indicatorConfigs: {},
    drawings: [],
    avwapAnchors: {},
  };
}

beforeEach(() => {
  installMemStorage();
  confirmRequest.set(null);
});

describe("SnapshotGallery", () => {
  it("shows an empty state when there are no snapshots", () => {
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no snapshots yet/i)).toBeTruthy();
  });

  it("lists snapshots newest-first and Restore passes the snapshot", () => {
    saveSnapshot(makeSnap("a", "Old one"));
    saveSnapshot(makeSnap("b", "New one"));
    const onRestore = vi.fn();
    render(<SnapshotGallery onRestore={onRestore} onClose={() => {}} />);
    const names = screen
      .getAllByDisplayValue(/one$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(names).toEqual(["New one", "Old one"]);
    fireEvent.click(screen.getAllByText("Restore")[0]);
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("rename commits on blur", () => {
    saveSnapshot(makeSnap("a", "Old name"));
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    const input = screen.getByDisplayValue("Old name");
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);
    expect(loadSnapshot("a")?.name).toBe("New name");
  });

  it("delete asks for confirmation, then removes on confirm", () => {
    saveSnapshot(makeSnap("a", "Doomed"));
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(loadSnapshotIndex()).toEqual(["a"]); // not deleted yet
    expect(confirmRequest.value).not.toBeNull();
    confirmRequest.value!.onConfirm();
    expect(loadSnapshotIndex()).toEqual([]);
  });
});
```

Check how other component tests set up (e.g. `FloatingModal.test.tsx`) — if FloatingModal portals need cleanup or the test env needs `/* @vitest-environment jsdom */`, copy that idiom.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/SnapshotGallery.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/SnapshotGallery.tsx
import { useState } from "react";
import FloatingModal from "./components/FloatingModal";
import {
  loadSnapshotIndex,
  loadSnapshot,
  saveSnapshot,
  deleteSnapshot,
  type ChartSnapshot,
} from "./lib/persist";
import { requestConfirm } from "./lib/signals";

interface Props {
  onRestore: (s: ChartSnapshot) => void;
  onClose: () => void;
}

function loadAll(): ChartSnapshot[] {
  return loadSnapshotIndex()
    .map((id) => loadSnapshot(id))
    .filter((s): s is ChartSnapshot => s != null);
}

export default function SnapshotGallery({ onRestore, onClose }: Props) {
  const [snaps, setSnaps] = useState<ChartSnapshot[]>(loadAll);
  const refresh = () => setSnaps(loadAll());

  const commitField = (s: ChartSnapshot, patch: Partial<ChartSnapshot>) => {
    saveSnapshot({ ...s, ...patch });
    refresh();
  };

  const remove = (s: ChartSnapshot) =>
    requestConfirm({
      title: "Delete snapshot",
      message: `Delete "${s.name}"? Charts previously restored from it are not affected.`,
      onConfirm: () => {
        deleteSnapshot(s.id);
        refresh();
      },
    });

  return (
    <FloatingModal title="Snapshots" onClose={onClose} width={720} className="snapshot-gallery">
      {snaps.length === 0 ? (
        <div className="snap-empty">
          No snapshots yet — use the camera button in the toolbar to save the
          current chart.
        </div>
      ) : (
        <div className="snap-grid">
          {snaps.map((s) => (
            <div key={s.id} className="snap-card">
              {s.thumb ? (
                <img className="snap-thumb" src={s.thumb} alt="" />
              ) : (
                <div className="snap-thumb snap-thumb-empty">No preview</div>
              )}
              <input
                className="snap-name"
                defaultValue={s.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== s.name) commitField(s, { name: v });
                }}
              />
              <div className="snap-sub">
                {s.epic} @ {s.period.label} ·{" "}
                {new Date(s.takenAt).toLocaleDateString()}
              </div>
              <textarea
                className="snap-note"
                placeholder="Add a note…"
                defaultValue={s.note ?? ""}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== (s.note ?? "")) commitField(s, { note: v || undefined });
                }}
              />
              <div className="snap-actions">
                <button onClick={() => onRestore(s)}>Restore</button>
                <button className="ghost" onClick={() => remove(s)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </FloatingModal>
  );
}
```

- [ ] **Step 4: Wire into App.tsx**

Near the other signal subscriptions (App.tsx ~line 289 pattern):

```tsx
const [snapGalleryOpen, setSnapGalleryOpen] = useState(snapshotsGalleryOpen.value);
useEffect(() => snapshotsGalleryOpen.subscribe(setSnapGalleryOpen), []);
```

Restore handler — model on `detachCell` (App.tsx:1100-1154); place near it:

```tsx
const restoreSnapshot = (s: ChartSnapshot) => {
  const id = newTabId();
  const cid = `${id}-c0`;
  const scope = primaryCellScope(id);
  writeSnapshotToScope(s, scope); // blobs land BEFORE the cell mounts
  const t: ChartTab = {
    id,
    layout: "1",
    activeCellId: cid,
    cells: [{ id: cid, symbol: s.symbol, period: s.period, scope }],
  };
  setTabs([...tabs, t]);
  setActiveId(id);
  snapshotsGalleryOpen.set(false);
};
```

Render (next to the other modals, ~line 1822):

```tsx
{snapGalleryOpen && (
  <SnapshotGallery
    onRestore={restoreSnapshot}
    onClose={() => snapshotsGalleryOpen.set(false)}
  />
)}
```

IMPORTANT: check how `setTabs` is actually shaped in App.tsx (it may be a helper that also persists the workspace — find how `detachCell` commits `nextTabs` at line 1148 and use the identical commit path).

- [ ] **Step 5: Gallery CSS**

In `App.css`: `.snap-grid` (CSS grid, `repeat(auto-fill, minmax(200px, 1fr))`, gap 12px), `.snap-card` (flat border `1px solid var(--border...)` — reuse whatever border-color variable neighboring cards/modals use, radius to match, no shadow), `.snap-thumb` (`width:100%; aspect-ratio: 16/10; object-fit: cover;`), `.snap-thumb-empty` (muted background + centered text), `.snap-name` (borderless input, font-weight 600, full width), `.snap-sub` (muted small text), `.snap-note` (small textarea, 2 rows), `.snap-actions` (flex, gap, right-aligned).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/SnapshotGallery.test.tsx && npx tsc -b`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/SnapshotGallery.tsx frontend/src/SnapshotGallery.test.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(snapshots): thumbnail gallery modal + restore into fresh one-cell tab"
```

---

### Task 5: Restore scroll — cover the saved range and position the window

**Files:**
- Modify: `frontend/src/ChartCore.tsx` (inside the main data-load effect, after `maybeAutoApplyTemplate` at ~line 3680)

**Interfaces:**
- Consumes: `loadSnapshotMeta`, `saveSnapshotMeta` (Task 1); `applyVisibleRange(chart, fromTs, toTs)` from `./lib/chartSync` (line 283); the effect-local `coverBacktestTradeTo(fromTs): Promise<boolean>` walk (ChartCore.tsx:889-945) as the model for a snapshot-range walk; `toast` from `./lib/notify`.
- Produces: nothing exported — behavior only. `pendingRange` on the scope's `snapshotMeta` is consumed exactly once (cleared after the first successful positioning), so reloads of the restored tab do NOT re-scroll.

Mechanism: after data load + rehydrate + template gate, if `loadSnapshotMeta(scope)?.pendingRange` exists, run a paging walk to cover `pendingRange.from` (reuse `coverBacktestTradeTo` directly if its guards allow — it pages back with `maxPages: 80` and returns whether the oldest loaded bar reaches the target; otherwise clone its `pageHistoryBack` call with the same `isStale`/`applyData` wiring), then position and clear:

- [ ] **Step 1: Implement the walk hook**

Insert after the `maybeAutoApplyTemplate` call (~line 3680), following the same staleness idiom the surrounding code uses (`isStale()` checks before touching the chart):

```typescript
const snapMeta = loadSnapshotMeta(scope);
if (snapMeta?.pendingRange) {
  const pr = snapMeta.pendingRange;
  void coverBacktestTradeTo(pr.from).then((reached) => {
    if (isStale()) return;
    const c = chartRef.current;
    if (!c) return;
    const data = c.getDataList() ?? [];
    if (data.length === 0) return;
    const oldest = data[0].timestamp;
    applyVisibleRange(c, Math.max(pr.from, oldest), pr.to);
    saveSnapshotMeta(scope, {
      snapshotId: snapMeta.snapshotId,
      name: snapMeta.name,
      takenAt: snapMeta.takenAt,
    });
    if (!reached && oldest > pr.from) {
      toast("History doesn't reach the snapshot range — showing oldest available");
    }
  });
}
```

Two verifications the implementer MUST do (the surrounding code is subtle):
1. `coverBacktestTradeTo` may early-return based on backtest-specific refs — read its body (ChartCore.tsx:889-945). If it has backtest-only guards, copy its `pageHistoryBack` invocation into a local `coverSnapshotRangeTo(fromTs)` with the same `isStale`/`getData`/`fetchOlder`/`applyData` wiring instead of calling it.
2. `isStale` — use whatever staleness guard the enclosing effect defines (the explorer saw `isStale()` used around lines 3690-3707); match it exactly so a symbol/TF switch mid-walk aborts cleanly.

Also confirm ordering vs. `ensureAnchorCoverage` (line 3690-3692 chains a rangeWalk → anchor walk): chain the snapshot walk into that same promise sequence rather than racing it — e.g. run the snapshot walk FIRST (it usually covers the drawings' anchors too, since drawings live inside the snapshot range), then let `ensureAnchorCoverage` run as already wired.

- [ ] **Step 2: Typecheck + full unit suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: clean.

- [ ] **Step 3: Manual smoke via dev server**

With the user's dev servers already running (do NOT restart them), open the app in a browser (claude-in-chrome), save a snapshot on a 15m chart, scroll far away / switch symbol, restore from the gallery → new tab opens, window sits on the saved range, drawings/indicators present. Reload the page → restored tab does NOT re-scroll (pendingRange consumed).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/ChartCore.tsx
git commit -m "feat(snapshots): restore scrolls to saved range via history-paging walk (one-shot pendingRange)"
```

---

### Task 6: Snapshot-moment marker (vertical line + time-axis chip, dismissible)

**Files:**
- Create: `frontend/src/lib/snapshotMarker.ts`
- Modify: `frontend/src/ChartCore.tsx` (render/remove marker around `overlays.rehydrate`, ~line 3617)

**Interfaces:**
- Consumes: klinecharts `registerOverlay`, `OverlayTemplate`, `LineType`; `SnapshotMeta` (Task 1); `requestConfirm` from `./lib/signals`; `deleteSnapshotMeta` (Task 1). Model: the `periodOverlay` template in `lib/backtest.ts:757-796` (pane figure + `createXAxisFigures` + lazy `ensure…Registered()` idiom).
- Produces: `renderSnapshotMarker(chart: Chart, meta: SnapshotMeta, onDismiss: () => void): string | null` (returns overlay id or null when no data), `ensureSnapshotMarkerRegistered(): void`.

- [ ] **Step 1: Implement the overlay module**

```typescript
// frontend/src/lib/snapshotMarker.ts
import {
  registerOverlay,
  LineType,
  type Chart,
  type OverlayTemplate,
} from "klinecharts";
import type { SnapshotMeta } from "./persist";

const MARKER_OVERLAY = "snapshotMarker";
const MARKER_COLOR = "#787b86"; // same neutral grey family as backtest period shading

let registered = false;
export function ensureSnapshotMarkerRegistered(): void {
  if (registered) return;
  registered = true;
  const tpl: OverlayTemplate = {
    name: MARKER_OVERLAY,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding }) => [
      {
        type: "line",
        attrs: {
          coordinates: [
            { x: coordinates[0].x, y: 0 },
            { x: coordinates[0].x, y: bounding.height },
          ],
        },
        styles: {
          style: LineType.Dashed,
          color: MARKER_COLOR,
          size: 1,
          dashedValue: [4, 4],
        },
        ignoreEvent: true, // the pane line never swallows chart interactions
      },
    ],
    createXAxisFigures: ({ coordinates, bounding, overlay }) => [
      {
        type: "text",
        attrs: {
          x: coordinates[0].x,
          y: bounding.height / 2,
          text: `⌖ ${String(overlay.extendData ?? "Snapshot")}`,
          align: "center",
          baseline: "middle",
        },
        styles: {
          color: "#ffffff",
          backgroundColor: MARKER_COLOR,
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 2,
          paddingBottom: 2,
          borderRadius: 2,
        },
        // NOT ignoreEvent — the chip is the dismiss target
      },
    ],
  };
  registerOverlay(tpl);
}

/** Draw the taken-at marker. Click on the time-axis chip → onDismiss. */
export function renderSnapshotMarker(
  chart: Chart,
  meta: SnapshotMeta,
  onDismiss: () => void,
): string | null {
  ensureSnapshotMarkerRegistered();
  const data = chart.getDataList() ?? [];
  if (data.length === 0) return null;
  const id = chart.createOverlay({
    name: MARKER_OVERLAY,
    lock: true,
    extendData: meta.name,
    points: [{ timestamp: meta.takenAt, value: data[0].close }], // value unused by figures
    onClick: () => {
      onDismiss();
      return true;
    },
  });
  return typeof id === "string" ? id : null;
}
```

Verify against klinecharts' actual `OverlayTemplate`/figure typings (`dist/index.d.ts`) — exact figure `styles` keys for text (backgroundColor/padding/borderRadius) should be cross-checked against another text-figure usage in the codebase (search `type: "text"` in `frontend/src/lib/`); adjust keys to what the version supports.

- [ ] **Step 2: Wire into ChartCore**

In the main data-load effect, right after `overlays.rehydrate(period.resolution)` (~line 3617). Keep the overlay id in a ref (`snapMarkerIdRef`) declared next to the other refs, remove the previous marker before re-creating (effect re-runs on TF/symbol switch):

```typescript
if (snapMarkerIdRef.current) {
  chartRef.current.removeOverlay(snapMarkerIdRef.current);
  snapMarkerIdRef.current = null;
}
const markerMeta = loadSnapshotMeta(scope);
if (markerMeta) {
  snapMarkerIdRef.current = renderSnapshotMarker(chartRef.current, markerMeta, () => {
    requestConfirm({
      title: "Remove snapshot marker",
      message: "Remove the snapshot marker from this chart? The saved snapshot itself is not affected.",
      confirmLabel: "Remove",
      onConfirm: () => {
        deleteSnapshotMeta(scope);
        const c = chartRef.current;
        if (c && snapMarkerIdRef.current) c.removeOverlay(snapMarkerIdRef.current);
        snapMarkerIdRef.current = null;
      },
    });
  });
}
```

Note: this runs BEFORE Task 5's pendingRange walk in program order (rehydrate at ~3617, template gate at ~3680) — that's correct; the marker doesn't depend on the window position.

- [ ] **Step 3: Typecheck + full unit suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: clean.

- [ ] **Step 4: Manual smoke**

Restore a snapshot in the browser: dashed vertical grey line at the taken-at moment + grey chip on the time axis with the snapshot name. Click chip → confirm dialog → marker gone; reload → still gone (meta deleted). Original snapshot still in gallery.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/snapshotMarker.ts frontend/src/ChartCore.tsx
git commit -m "feat(snapshots): taken-at marker overlay (dashed line + axis chip, click-to-dismiss)"
```

---

### Task 7: End-to-end test

**Files:**
- Create: `frontend/e2e/snapshots.spec.ts`

**Interfaces:**
- Consumes: the whole feature; Playwright patterns from `frontend/e2e/symbol-template.spec.ts` — REQUIRED: stub `**/api/state` and `**/api/state/**` to `{}` (test isolation from the live backend, lines 129-134 there); `window.__chart` (focused cell's chart) and `window.__charts` hooks (ChartCore.tsx:3280-3282).

- [ ] **Step 1: Write the spec**

Structure (adapt selectors to actual DOM once implemented; reuse helper idioms from `symbol-template.spec.ts` — e.g. its wait-for-chart-data helper and broker-scoped localStorage key discovery by regex):

```typescript
// frontend/e2e/snapshots.spec.ts
import { test, expect, type Page } from "@playwright/test";

async function stubBackendState(page: Page) {
  await page.route("**/api/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

async function waitForChartData(page: Page) {
  await page.waitForFunction(() => {
    const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
    return !!c && c.getDataList().length > 50;
  });
}

test("snapshot: save, restore into new tab with state + marker + range", async ({ page }) => {
  await stubBackendState(page);
  await page.goto("/");
  await waitForChartData(page);

  // 1. Add an indicator via the toolbar (copy the indicator-menu interaction
  //    from symbol-template.spec.ts — open Indicators menu, click EMA).

  // 2. Save a snapshot.
  await page.click(".snap-save");

  // 3. Remove the indicator again (so the source chart no longer has it).

  // 4. Open the gallery and restore.
  await page.click(".snap-gallery");
  await page.click(".snap-card button:has-text('Restore')");

  // 5. A second tab is active; its chart has the EMA back.
  await page.waitForFunction(() => {
    const w = window as unknown as { __charts?: Map<string, unknown> };
    return (w.__charts?.size ?? 0) >= 2;
  });
  await waitForChartData(page);
  // Assert indicator present via __chart.getIndicatorByPaneId (same helper
  // symbol-template.spec.ts uses, lines 18-26).

  // 6. Marker meta exists in the new tab's scope and pendingRange gets consumed.
  await page.waitForFunction(() => {
    const metaKey = Object.keys(localStorage).find((k) =>
      /^auto-trader\.tab\.[^.]+\.snapshotMeta$/.test(k),
    );
    if (!metaKey) return false;
    const meta = JSON.parse(localStorage.getItem(metaKey)!);
    return meta && meta.pendingRange === undefined; // walk finished, one-shot consumed
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx playwright test e2e/snapshots.spec.ts`
Expected: PASS. (Needs the dev server + backend running — same precondition as the other e2e specs. Do not run the full e2e suite; data-dependent specs contend for the live feed.)

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/snapshots.spec.ts
git commit -m "test(snapshots): e2e save → restore → state + marker + consumed pendingRange"
```

---

### Task 8: Final verification + docs

- [ ] **Step 1: Full unit suite + typecheck + lint**

Run: `cd frontend && npx tsc -b && npx vitest run && npx eslint src/`
Expected: all clean.

- [ ] **Step 2: Manual end-to-end pass in the browser**

Full user journey on the live dev app: save two snapshots on different symbols → rename one, add a note → restore each → verify range, drawings, indicators, marker → dismiss one marker → delete a snapshot (confirm dialog) → previously restored tab unaffected → reload app: gallery intact, restored tabs don't re-scroll.

- [ ] **Step 3: Commit any fixes; done**

Integration (merge back to main) is decided by the user per the finishing-a-development-branch flow.
