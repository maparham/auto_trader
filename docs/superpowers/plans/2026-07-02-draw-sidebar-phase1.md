# Drawing Sidebar Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top-toolbar drawing dropdown with a TV-style left sidebar: favorites zone, family buttons with glyph flyouts + stars, measure + magnet relocated, and hide/lock/delete-all bulk actions.

**Architecture:** A new `DrawSidebar.tsx` component mounts as the first child of `<main className="chart">` in `App.tsx` (one per tab, spans all cells), driven by the focused cell's `ChartController`/`OverlayManager` exactly like `Toolbar.tsx` is. Tool metadata lives in a pure-data registry (`lib/drawTools.ts`), glyphs in `DrawIcons.tsx`, preferences in `lib/persist.ts`. Two new OverlayManager capabilities back the bulk buttons (hide-all, lock-all).

**Tech Stack:** React 18 + TypeScript, klinecharts v9, vitest (unit, node env, `FakeChart` mock), Playwright (e2e). Frontend root: `frontend/` — run all commands from there.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-drawing-tools-sidebar-design.md` (§1–§2 = this phase).
- Light theme is canonical; no shadows; content-sized panels; dismiss-on-outside-click (existing UX conventions).
- No legacy/back-compat code: the old Draw dropdown is deleted outright.
- Commit directly to `main` after each task.
- Pre-existing failures to IGNORE (not yours): `overlays.test.ts` "hoverAlert emphasizes…", `persist.test.ts` loadAvwapAnchor, tsc errors in `ChartCore.tsx` (1836, 2972) and `historyPaging.test.ts:38`.
- Phase 1 covers the EXISTING 8 tools only. Family keys: `lines`, `channels`, `fibs`. (Annotations family arrives in Phase 4 — do not add an empty button.)
- Hide-all is session-only (not persisted) and per-cell; the sidebar drives the FOCUSED cell — this matches the spec's "bottom cluster acts on the focused cell".

---

### Task 1: Tool registry + favorites/last-used persistence

**Files:**
- Create: `frontend/src/lib/drawTools.ts`
- Modify: `frontend/src/lib/persist.ts` (append near `FAVORITE_INDICATORS_KEY`, line ~866)
- Test: `frontend/src/lib/drawTools.test.ts`

**Interfaces:**
- Produces: `DRAW_FAMILIES: DrawFamily[]`, `toolLabel(name): string`, `familyOf(name): DrawFamily | undefined` (drawTools.ts); `loadFavoriteDrawings(): string[]`, `saveFavoriteDrawings(list: string[]): void`, `loadLastDrawTools(): Record<string, string>`, `saveLastDrawTools(map: Record<string, string>): void` (persist.ts). Task 4 consumes all of these.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/drawTools.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// node env: in-memory localStorage before importing persist (same idiom as
// persist.test.ts — the load/save helpers write through localStorage).
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { DRAW_FAMILIES, toolLabel, familyOf } = await import("./drawTools");
const P = await import("./persist");

describe("draw-tool registry", () => {
  it("groups the existing 8 tools into lines/channels/fibs", () => {
    expect(DRAW_FAMILIES.map((f) => f.key)).toEqual(["lines", "channels", "fibs"]);
    const lines = DRAW_FAMILIES[0].tools.map((t) => t.name);
    expect(lines).toEqual([
      "segment", "rayLine", "straightLine",
      "horizontalStraightLine", "verticalStraightLine", "priceLine",
    ]);
    expect(DRAW_FAMILIES[1].tools.map((t) => t.name)).toEqual(["priceChannelLine"]);
    expect(DRAW_FAMILIES[2].tools.map((t) => t.name)).toEqual(["fibonacciLine"]);
  });

  it("toolLabel and familyOf resolve by overlay name", () => {
    expect(toolLabel("segment")).toBe("Trend line");
    expect(toolLabel("nope")).toBe("nope"); // graceful fallback
    expect(familyOf("priceChannelLine")?.key).toBe("channels");
    expect(familyOf("nope")).toBeUndefined();
  });
});

describe("draw-tool preferences (persist)", () => {
  it("favorite drawings round-trip (global key, star order preserved)", () => {
    expect(P.loadFavoriteDrawings()).toEqual([]);
    P.saveFavoriteDrawings(["segment", "priceLine"]);
    expect(P.loadFavoriteDrawings()).toEqual(["segment", "priceLine"]);
  });

  it("last-used-per-family round-trips", () => {
    expect(P.loadLastDrawTools()).toEqual({});
    P.saveLastDrawTools({ lines: "rayLine" });
    expect(P.loadLastDrawTools()).toEqual({ lines: "rayLine" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/drawTools.test.ts`
Expected: FAIL — `Cannot find module './drawTools'` (and missing persist exports).

- [ ] **Step 3: Write the registry**

Create `frontend/src/lib/drawTools.ts`:

```typescript
// Drawing-tool registry for the left sidebar (TV-style). Pure data — the
// glyph SVGs live in ../DrawIcons.tsx so this stays importable under the
// node test env. Names are klinecharts overlay names; labels follow TV
// ("Trend line" = the 2-point segment, extendable via the settings modal;
// "Extended line" = the infinite straightLine).
export interface DrawTool {
  name: string; // klinecharts overlay name (create/persist key)
  label: string;
}

export interface DrawFamily {
  key: "lines" | "channels" | "fibs";
  label: string;
  tools: DrawTool[];
}

export const DRAW_FAMILIES: DrawFamily[] = [
  {
    key: "lines",
    label: "Lines",
    tools: [
      { name: "segment", label: "Trend line" },
      { name: "rayLine", label: "Ray" },
      { name: "straightLine", label: "Extended line" },
      { name: "horizontalStraightLine", label: "Horizontal line" },
      { name: "verticalStraightLine", label: "Vertical line" },
      { name: "priceLine", label: "Price line" },
    ],
  },
  {
    key: "channels",
    label: "Channels",
    tools: [{ name: "priceChannelLine", label: "Parallel channel" }],
  },
  {
    key: "fibs",
    label: "Fib / Projections",
    tools: [{ name: "fibonacciLine", label: "Fib retracement" }],
  },
];

const BY_NAME = new Map(
  DRAW_FAMILIES.flatMap((f) => f.tools.map((t) => [t.name, { tool: t, family: f }] as const)),
);

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.tool.label ?? name;
}

export function familyOf(name: string): DrawFamily | undefined {
  return BY_NAME.get(name)?.family;
}
```

- [ ] **Step 4: Add the persist functions**

In `frontend/src/lib/persist.ts`, directly below `saveFavoriteIndicators` (line ~873), add:

```typescript
// --- drawing-tool preferences (left sidebar) ---------------------------------
//
// Starred drawing tools (GLOBAL preference, star order) — mirrors the
// indicator favorites idiom above. And the last-used tool per sidebar family
// (device-local), so each family button re-arms what you used last.
const FAVORITE_DRAWINGS_KEY = `${PREFIX}.drawingFavorites`;
export function loadFavoriteDrawings(): string[] {
  return load<string[]>(FAVORITE_DRAWINGS_KEY, []);
}
export function saveFavoriteDrawings(list: string[]): void {
  save(FAVORITE_DRAWINGS_KEY, list);
}

const LAST_DRAW_TOOLS_KEY = `${PREFIX}.lastDrawTools`;
export function loadLastDrawTools(): Record<string, string> {
  return load<Record<string, string>>(LAST_DRAW_TOOLS_KEY, {});
}
export function saveLastDrawTools(map: Record<string, string>): void {
  save(LAST_DRAW_TOOLS_KEY, map);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/drawTools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/drawTools.ts frontend/src/lib/drawTools.test.ts frontend/src/lib/persist.ts
git commit -m "feat(chart): draw-tool registry + favorites/last-used persistence for the sidebar"
```

---

### Task 2: OverlayManager hide-all + lock-all

**Files:**
- Modify: `frontend/src/lib/overlays.ts` (`displayFor` ~line 899; new methods near `clearDrawings` ~line 1302)
- Test: `frontend/src/lib/overlays.test.ts` (append)

**Interfaces:**
- Produces: `setDrawingsHidden(hidden: boolean): void`, `getDrawingsHidden(): boolean`, `lockAllDrawings(): void`, `allDrawingsLocked(): boolean` on `OverlayManager`. Task 4's bulk buttons consume these (plus existing `clearDrawings()` / `unlockAll()`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/overlays.test.ts`:

```typescript
describe("OverlayManager hide-all drawings (sidebar eye)", () => {
  it("hides every drawing without touching per-drawing intent, and restores on unhide", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const a = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const b = m.addDrawing("priceLine", [{ value: 3 }])!;

    expect(m.getDrawingsHidden()).toBe(false);
    m.setDrawingsHidden(true);
    expect(m.getDrawingsHidden()).toBe(true);
    expect(chart.getOverlayById(a)!.visible).toBe(false);
    expect(chart.getOverlayById(b)!.visible).toBe(false);
    // Intent untouched: getDrawing still reports the user's choice, and persist
    // (which reads intent) is not corrupted by the session-only hide.
    expect(m.getDrawing(a)!.visible).toBe(true);
    const saved = P.loadDrawings("tab.A", "US100");
    expect(saved.every((d) => (asDrawingExtra(d.extendData).userVisible ?? true) === true)).toBe(true);

    m.setDrawingsHidden(false);
    expect(chart.getOverlayById(a)!.visible).toBe(true);
    expect(chart.getOverlayById(b)!.visible).toBe(true);
  });

  it("a ghosted (interval-filtered) drawing comes back as a ghost, not solid", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setResolution("MINUTE_5"); // → ghost (faded, still visible)
    const ghostColor = (chart.getOverlayById(id)!.styles as { line?: { color?: string } }).line?.color;
    expect(ghostColor).toMatch(/^rgba\(/);

    m.setDrawingsHidden(true);
    expect(chart.getOverlayById(id)!.visible).toBe(false);
    m.setDrawingsHidden(false);
    const back = chart.getOverlayById(id)!;
    expect(back.visible).toBe(true);
    expect((back.styles as { line?: { color?: string } }).line?.color).toMatch(/^rgba\(/);
  });
});

describe("OverlayManager lock-all drawings (sidebar padlock)", () => {
  it("lockAllDrawings locks only drawings; allDrawingsLocked reflects it", () => {
    const { chart, m } = setup();
    const d = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const alert = m.addAlert(5, { note: "", condition: "crossing" } as never)!;

    expect(m.allDrawingsLocked()).toBe(false);
    m.lockAllDrawings();
    expect(m.allDrawingsLocked()).toBe(true);
    expect(chart.getOverlayById(d)!.lock).toBe(true);
    expect(chart.getOverlayById(alert)!.lock).not.toBe(true); // alerts untouched
    // Lock persists (SavedOverlay.lock existed already).
    expect(P.loadDrawings("tab.A", "US100")[0].lock).toBe(true);

    m.unlockAll();
    expect(m.allDrawingsLocked()).toBe(false);
  });

  it("allDrawingsLocked is false with zero drawings (empty ≠ locked)", () => {
    const { m } = setup();
    expect(m.allDrawingsLocked()).toBe(false);
  });
});
```

Note: if `addAlert`'s config type differs, mirror whatever an existing alert test in this file passes — the point is only that a NON-drawing entry stays unlocked.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/overlays.test.ts -t "hide-all|lock-all"`
Expected: FAIL — `m.getDrawingsHidden is not a function` etc.

- [ ] **Step 3: Implement**

In `frontend/src/lib/overlays.ts`:

(a) Add the flag next to `drawingInProgress` (~line 387):

```typescript
  // Sidebar "hide all drawings" eye — SESSION-ONLY master switch layered over
  // per-drawing intent (extendData.userVisible), so toggling it never rewrites
  // (or persists over) what the user chose per drawing.
  private drawingsHidden = false;
  getDrawingsHidden(): boolean {
    return this.drawingsHidden;
  }
```

(b) In `displayFor` (~line 899), short-circuit FIRST — before the intent check:

```typescript
  private displayFor(
    extra: DrawingExtra,
    pts?: ReadonlyArray<{ timestamp?: number }>,
  ): { visible: boolean; faded: boolean } {
    if (this.drawingsHidden) return { visible: false, faded: false }; // master eye off
    const intent = extra.userVisible ?? true;
    if (!intent) return { visible: false, faded: false };
    const effective = this.effectiveVisible({ ...extra, userVisible: true }, pts);
    return { visible: true, faded: !effective };
  }
```

(c) Add the setter + lock-all next to `clearDrawings` (~line 1302), reusing the re-apply loop idiom from `setResolution`:

```typescript
  // Sidebar eye: hide/show every drawing at once (session-only; per-drawing
  // intent and persistence are untouched — see displayFor).
  setDrawingsHidden(hidden: boolean): void {
    if (this.drawingsHidden === hidden) return;
    this.drawingsHidden = hidden;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      const ov = this.chart?.getOverlayById(id);
      if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    }
  }

  // Sidebar padlock: lock every drawing (alerts and the measure ruler are not
  // drawings and stay interactive). Persisted via SavedOverlay.lock.
  lockAllDrawings(): void {
    for (const [id, kind] of this.entries) {
      if (kind === "drawing") this.chart?.overrideOverlay({ id, lock: true });
    }
    this.persist();
  }

  allDrawingsLocked(): boolean {
    let n = 0;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      n++;
      if (!this.chart?.getOverlayById(id)?.lock) return false;
    }
    return n > 0;
  }
```

Also make `unlockAll()` call `this.persist()` at the end if it doesn't already (it currently doesn't — the lock release must survive reload now that lock-all persists).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/overlays.test.ts`
Expected: new tests PASS; only the pre-existing "hoverAlert emphasizes…" failure remains.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays.test.ts
git commit -m "feat(chart): OverlayManager hide-all + lock-all for the draw sidebar"
```

---

### Task 3: Tool glyphs + MagnetIcon relocation

**Files:**
- Create: `frontend/src/DrawIcons.tsx`
- Modify: `frontend/src/lib/menuIcons.tsx` (add `MagnetIcon` export)
- Modify: `frontend/src/Toolbar.tsx` (delete its local `MagnetIcon`, line ~120-135; import from menuIcons instead — Toolbar still renders it until Task 5 removes the whole magnet block)

**Interfaces:**
- Produces: `DrawGlyph({ name }: { name: string }): JSX.Element` (DrawIcons.tsx) — renders the mini TV-style glyph for a tool name, falling back to the trendline glyph for unknown names. `MagnetIcon` exported from `lib/menuIcons.tsx`. Task 4 consumes both.

- [ ] **Step 1: Create the glyphs**

Create `frontend/src/DrawIcons.tsx`. All glyphs: 20×20 viewBox, `stroke="currentColor"`, `fill="none"`, strokeWidth 1.4, hollow-circle anchor dots (r 1.6) — matching TV's visual language (see the Lines menu screenshot the design came from):

```tsx
// Mini TV-style glyphs for the drawing tools: a picture of each tool next to
// its name (sidebar family buttons, favorites zone, and flyout rows). One
// component keyed by klinecharts overlay name so callers never switch on it.

interface GlyphProps {
  name: string;
}

const S = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  "aria-hidden": true,
};

// Hollow anchor dot (TV's endpoint circles).
function Dot({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={1.6} />;
}

const GLYPHS: Record<string, () => JSX.Element> = {
  // Trend line: diagonal segment, both endpoints dotted.
  segment: () => (
    <svg {...S}>
      <line x1="5.2" y1="14.8" x2="14.8" y2="5.2" />
      <Dot x={4} y={16} />
      <Dot x={16} y={4} />
    </svg>
  ),
  // Ray: one dotted origin, line runs off the corner.
  rayLine: () => (
    <svg {...S}>
      <line x1="5.2" y1="14.8" x2="18" y2="2" />
      <Dot x={4} y={16} />
    </svg>
  ),
  // Extended line: runs off both corners, mid anchors dotted.
  straightLine: () => (
    <svg {...S}>
      <line x1="2" y1="18" x2="18" y2="2" />
      <Dot x={7} y={13} />
      <Dot x={13} y={7} />
    </svg>
  ),
  // Horizontal line: full-width line, center anchor dotted.
  horizontalStraightLine: () => (
    <svg {...S}>
      <line x1="2" y1="10" x2="18" y2="10" />
      <Dot x={10} y={10} />
    </svg>
  ),
  // Vertical line: full-height line, center anchor dotted.
  verticalStraightLine: () => (
    <svg {...S}>
      <line x1="10" y1="2" x2="10" y2="18" />
      <Dot x={10} y={10} />
    </svg>
  ),
  // Price line: horizontal ray from a dot + a little price tag on the right.
  priceLine: () => (
    <svg {...S}>
      <line x1="4" y1="10" x2="12" y2="10" />
      <Dot x={4} y={10} />
      <rect x="12.5" y="7.5" width="5.5" height="5" rx="1" />
    </svg>
  ),
  // Parallel channel: two parallel diagonals, anchors on the main one.
  priceChannelLine: () => (
    <svg {...S}>
      <line x1="3" y1="13" x2="14" y2="4" />
      <line x1="6" y1="17" x2="17" y2="8" />
      <Dot x={3} y={13} />
      <Dot x={14} y={4} />
    </svg>
  ),
  // Fib retracement: stacked horizontal levels, top+bottom anchored.
  fibonacciLine: () => (
    <svg {...S}>
      <line x1="3" y1="4.5" x2="17" y2="4.5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15.5" x2="17" y2="15.5" />
      <Dot x={5} y={4.5} />
      <Dot x={15} y={15.5} />
    </svg>
  ),
};

export default function DrawGlyph({ name }: GlyphProps) {
  const G = GLYPHS[name] ?? GLYPHS.segment;
  return <G />;
}
```

- [ ] **Step 2: Move MagnetIcon into menuIcons**

Cut the `MagnetIcon` function out of `frontend/src/Toolbar.tsx` (the horseshoe SVG, ~line 120-135) and paste it as a named export in `frontend/src/lib/menuIcons.tsx` (keep the SVG byte-identical; just add `export`). In Toolbar, add `MagnetIcon` to the existing `from "./lib/menuIcons"` import so the still-present magnet button keeps rendering until Task 5.

- [ ] **Step 3: Typecheck + lint**

Run: `cd frontend && npx tsc -b 2>&1 | grep -v "ChartCore.tsx\|historyPaging"`
Expected: no NEW errors (the two grep'd files carry pre-existing ones).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/DrawIcons.tsx frontend/src/lib/menuIcons.tsx frontend/src/Toolbar.tsx
git commit -m "feat(chart): TV-style drawing-tool glyphs + shared MagnetIcon"
```

---

### Task 4: DrawSidebar component + App mount + CSS

**Files:**
- Create: `frontend/src/DrawSidebar.tsx`
- Modify: `frontend/src/App.tsx` (import; mount inside `<main className="chart">`, line ~1239; wrap grid in `.chart-cells`)
- Modify: `frontend/src/App.css` (`.chart` rule line 30 + new sidebar styles)

**Interfaces:**
- Consumes: `DRAW_FAMILIES`/`toolLabel` (Task 1), persist prefs (Task 1), `DrawGlyph` + `MagnetIcon` (Task 3), OverlayManager bulk methods (Task 2), existing `controller.measureArmed` signal, `magnetSignal`/`toggleMagnet`/`setMagnetStrength` from `lib/magnet`, `getSupportedOverlays` from `klinecharts`.
- Produces: `<DrawSidebar controller={ChartController | null} />` — default export.

- [ ] **Step 1: Write the component**

Create `frontend/src/DrawSidebar.tsx`:

```tsx
// TV-style left drawing sidebar (one per tab, beside the chart grid). Drives
// the FOCUSED cell's OverlayManager — same contract as Toolbar. Top→bottom:
// favorites zone (starred tools, one-click), family buttons (click = arm the
// family's last-used tool; hover-caret = flyout to pick/star a variant),
// measure + magnet (relocated from the toolbar), then the bulk cluster
// (hide-all eye / lock-all padlock / delete-all).
import { useEffect, useRef, useState } from "react";
import { getSupportedOverlays } from "klinecharts";
import DrawGlyph from "./DrawIcons";
import InfoTip from "./components/InfoTip";
import { DRAW_FAMILIES, toolLabel, type DrawFamily } from "./lib/drawTools";
import {
  loadFavoriteDrawings,
  saveFavoriteDrawings,
  loadLastDrawTools,
  saveLastDrawTools,
} from "./lib/persist";
import { magnetSignal, toggleMagnet, setMagnetStrength } from "./lib/magnet";
import { MagnetIcon, RulerIcon } from "./lib/menuIcons";
import type { ChartController } from "./lib/chartController";

interface Props {
  controller: ChartController | null;
}

// Star (filled when on) — same path as IndicatorRow's.
function Star({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
      fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
      <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
    </svg>
  );
}

export default function DrawSidebar({ controller }: Props) {
  const overlays = controller?.overlays ?? null;

  // Which family's flyout is open (null = none). Outside-click closes it.
  const [openFly, setOpenFly] = useState<DrawFamily["key"] | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openFly) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenFly(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openFly]);

  // Starred tools (global, star order) + last-used per family (device-local).
  const [favs, setFavs] = useState<string[]>(loadFavoriteDrawings);
  const [lastUsed, setLastUsed] = useState<Record<string, string>>(loadLastDrawTools);

  // Magnet (global signal) + measure (focused controller's signal) mirrors —
  // moved verbatim from Toolbar.
  const [magnet, setMagnet] = useState(magnetSignal.value);
  useEffect(() => magnetSignal.subscribe(setMagnet), []);
  const [magnetOpen, setMagnetOpen] = useState(false);
  const magnetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!magnetOpen) return;
    const close = (e: MouseEvent) => {
      if (!magnetRef.current?.contains(e.target as Node)) setMagnetOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [magnetOpen]);
  const [measuring, setMeasuring] = useState(controller?.measureArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.measureArmed) return;
    setMeasuring(controller.measureArmed.value);
    return controller.measureArmed.subscribe(setMeasuring);
  }, [controller]);

  // Hide-all eye: session state lives on the manager; re-read when focus moves.
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(overlays?.getDrawingsHidden() ?? false), [overlays]);

  // Only tools klinecharts actually supports (same guard the old dropdown had).
  const supported = new Set(getSupportedOverlays());
  const families = DRAW_FAMILIES.map((f) => ({
    ...f,
    tools: f.tools.filter((t) => supported.has(t.name)),
  })).filter((f) => f.tools.length > 0);
  const favShown = favs.filter((n) => supported.has(n));

  function arm(name: string, familyKey: string) {
    overlays?.addDrawing(name);
    const next = { ...lastUsed, [familyKey]: name };
    setLastUsed(next);
    saveLastDrawTools(next);
    setOpenFly(null);
  }

  function toggleFav(name: string) {
    setFavs((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      saveFavoriteDrawings(next);
      return next;
    });
  }

  function toggleHidden() {
    if (!overlays) return;
    const next = !overlays.getDrawingsHidden();
    overlays.setDrawingsHidden(next);
    setHidden(next);
  }

  function toggleLockAll() {
    if (!overlays) return;
    if (overlays.allDrawingsLocked()) overlays.unlockAll();
    else overlays.lockAllDrawings();
  }

  function deleteAll() {
    if (!overlays) return;
    if (window.confirm("Delete all drawings on this chart?")) overlays.clearDrawings();
  }

  return (
    <aside className="draw-sidebar" ref={rootRef}>
      {/* Favorites zone: starred tools as direct buttons, star order. */}
      {favShown.map((name) => (
        <button
          key={name}
          className="ds-btn"
          title={toolLabel(name)}
          onClick={() => {
            const fam = DRAW_FAMILIES.find((f) => f.tools.some((t) => t.name === name));
            arm(name, fam?.key ?? "lines");
          }}
        >
          <DrawGlyph name={name} />
        </button>
      ))}
      {favShown.length > 0 && <span className="ds-div" aria-hidden="true" />}

      {/* Family buttons: icon = the family's last-used tool; caret = flyout. */}
      {families.map((f) => {
        const current =
          f.tools.find((t) => t.name === lastUsed[f.key])?.name ?? f.tools[0].name;
        return (
          <div key={f.key} className="ds-family">
            <button className="ds-btn" title={`${f.label} — ${toolLabel(current)}`}
              onClick={() => arm(current, f.key)}>
              <DrawGlyph name={current} />
            </button>
            <button
              className={"ds-caret" + (openFly === f.key ? " on" : "")}
              title={`${f.label}…`}
              aria-label={`Open ${f.label} menu`}
              onClick={() => setOpenFly((v) => (v === f.key ? null : f.key))}
            >
              <svg viewBox="0 0 24 24" width="8" height="8" fill="none"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
            {openFly === f.key && (
              <div className="ds-flyout">
                <div className="ds-fly-section">{f.label}</div>
                <ul>
                  {f.tools.map((t) => (
                    <li key={t.name} className="ds-row" onClick={() => arm(t.name, f.key)}>
                      <span className="ds-glyph"><DrawGlyph name={t.name} /></span>
                      <span className="ds-label">{t.label}</span>
                      <button
                        className={"ind-star" + (favs.includes(t.name) ? " on" : "")}
                        title={favs.includes(t.name) ? "Remove from favorites" : "Add to favorites"}
                        aria-pressed={favs.includes(t.name)}
                        onClick={(e) => { e.stopPropagation(); toggleFav(t.name); }}
                      >
                        <Star on={favs.includes(t.name)} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}

      <span className="ds-div" aria-hidden="true" />

      {/* Measure ruler (moved from the toolbar; same signal contract). */}
      <button
        className={"ds-btn measure-toggle" + (measuring ? " on" : "")}
        title="Measure — click start, then click end (or hold Shift)"
        disabled={!controller?.measureArmed}
        onClick={() => controller?.measureArmed?.set(!controller.measureArmed.value)}
      >
        <RulerIcon />
      </button>

      {/* Magnet (moved from the toolbar): icon toggles, caret picks strength. */}
      <div className="ds-family" ref={magnetRef}>
        <button
          className={"ds-btn magnet-toggle" + (magnet.on ? " on" : "")}
          title="Magnet mode — snap drawings to price bars (hold Ctrl/Cmd to invert)"
          onClick={() => toggleMagnet()}
        >
          <MagnetIcon />
        </button>
        <button
          className={"ds-caret" + (magnetOpen ? " on" : "")}
          title="Magnet strength"
          onClick={() => setMagnetOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="8" height="8" fill="none"
            stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        {magnetOpen && (
          <div className="ds-flyout">
            <ul>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("weak"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "weak" ? "✓" : ""}</span>
                <span className="ds-label">Weak Magnet</span>
                <InfoTip title="Weak Magnet"
                  desc="Snaps a drawing point to the nearest OHLC price only when the cursor is close to a price bar." />
              </li>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("strong"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "strong" ? "✓" : ""}</span>
                <span className="ds-label">Strong Magnet</span>
                <InfoTip title="Strong Magnet"
                  desc="Always snaps a drawing point to the nearest OHLC price of the bar under the cursor." />
              </li>
            </ul>
          </div>
        )}
      </div>

      <span className="ds-spacer" aria-hidden="true" />

      {/* Bulk cluster (focused cell): hide-all eye, lock-all, delete-all. */}
      <button className={"ds-btn ds-eye" + (hidden ? " on" : "")}
        title={hidden ? "Show all drawings" : "Hide all drawings"}
        disabled={!overlays} onClick={toggleHidden}>
        {hidden ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l18 18M10.6 10.7a2.5 2.5 0 0 0 3.5 3.5M7.4 7.5C4.9 8.9 3 12 3 12s3.5 6 9 6c1.6 0 3-.4 4.3-1.1M12 6c5.5 0 9 6 9 6s-.7 1.2-2 2.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
            <circle cx="12" cy="12" r="2.5" />
          </svg>
        )}
      </button>
      <button className="ds-btn" title="Lock / unlock all drawings"
        disabled={!overlays} onClick={toggleLockAll}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="1.5" />
          <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
        </svg>
      </button>
      <button className="ds-btn ds-trash" title="Delete all drawings"
        disabled={!overlays} onClick={deleteAll}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
        </svg>
      </button>
    </aside>
  );
}
```

Note for the implementer: `controller.overlays` — confirm the public accessor name on `ChartController` (Toolbar does `controller?.overlays ?? null` at Toolbar.tsx:148; copy exactly that).

- [ ] **Step 2: Mount in App**

In `frontend/src/App.tsx`:
- Add `import DrawSidebar from "./DrawSidebar";` next to the Toolbar import.
- Inside `<main className="chart">` (line ~1239), render the sidebar first, and wrap the existing `{active ? <ChartGrid…/> : <div className="empty-workspace">…}` block in a `<div className="chart-cells">`:

```tsx
        <main className="chart">
          {active && <DrawSidebar controller={focusedController} />}
          <div className="chart-cells">
            {/* …existing ChartGrid / empty-workspace ternary, unchanged… */}
          </div>
        </main>
```

- [ ] **Step 3: CSS**

In `frontend/src/App.css`, change line 30 and add sidebar styles (near it):

```css
/* .chart becomes a flex row: the draw sidebar + the cell grid. position:relative
   moves to .chart-cells so absolutely-positioned grid children keep working. */
.chart { flex: 1; min-width: 0; display: flex; }
.chart-cells { flex: 1; position: relative; min-width: 0; }

/* --- left drawing sidebar (TV-style) --- */
.draw-sidebar {
  flex: none; width: 38px; display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding: 6px 0; background: var(--bg); border-right: 1px solid var(--border);
}
.draw-sidebar .ds-btn {
  width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 4px; background: transparent; color: var(--text-dim);
  cursor: pointer; padding: 0;
}
.draw-sidebar .ds-btn:hover { background: var(--hover); color: var(--text); }
.draw-sidebar .ds-btn.on { background: var(--hover-strong); color: var(--accent); }
.draw-sidebar .ds-btn:disabled { opacity: 0.4; cursor: default; }
.draw-sidebar .ds-div { width: 22px; height: 1px; background: var(--border); margin: 4px 0; }
.draw-sidebar .ds-spacer { flex: 1; }
.draw-sidebar .ds-family { position: relative; display: flex; align-items: center; }
.draw-sidebar .ds-caret {
  position: absolute; right: -2px; bottom: 2px; width: 10px; height: 10px; padding: 0;
  border: none; background: transparent; color: var(--text-faint); cursor: pointer;
  opacity: 0; display: flex; align-items: center; justify-content: center;
}
.draw-sidebar .ds-family:hover .ds-caret, .draw-sidebar .ds-caret.on { opacity: 1; }
.draw-sidebar .ds-caret:hover { color: var(--text); }
.draw-sidebar .ds-flyout {
  position: absolute; left: calc(100% + 6px); top: -4px; z-index: 60;
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  min-width: 200px; padding: 4px 0;
}
.draw-sidebar .ds-fly-section {
  padding: 5px 12px 3px; font-size: 11px; color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.draw-sidebar .ds-flyout ul { list-style: none; margin: 0; padding: 0; }
.draw-sidebar .ds-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer;
  font-size: 13px; color: var(--text);
}
.draw-sidebar .ds-row:hover { background: var(--hover); }
.draw-sidebar .ds-glyph { display: flex; color: var(--text-dim); }
.draw-sidebar .ds-label { flex: 1; }
.draw-sidebar .ds-row .ind-star {
  border: none; background: transparent; padding: 0; cursor: pointer;
  color: var(--text-faint); opacity: 0; display: flex;
}
.draw-sidebar .ds-row:hover .ind-star { opacity: 1; }
.draw-sidebar .ds-row .ind-star.on { opacity: 1; color: #f5b301; }
.draw-sidebar .ds-row .check { width: 12px; font-size: 11px; color: var(--accent); }
.draw-sidebar .ds-trash:hover { color: #d33; }
```

Check `var(--accent)`, `var(--text-dim)`, `var(--text-faint)`, `var(--hover-strong)` exist in App.css `:root` — if a name differs (e.g. `--muted`), use the file's actual token; do NOT invent new tokens.

- [ ] **Step 4: Typecheck + eyeball**

Run: `cd frontend && npx tsc -b 2>&1 | grep -v "ChartCore.tsx\|historyPaging"` → no new errors.
Then verify in the running dev server (do NOT restart the user's HMR server; it hot-reloads): sidebar visible left of the chart, flyouts open/close, tools draw, light theme.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/DrawSidebar.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(chart): TV-style left drawing sidebar — favorites, family flyouts, bulk actions"
```

---

### Task 5: Remove the old toolbar Draw dropdown + magnet + measure

**Files:**
- Modify: `frontend/src/Toolbar.tsx`

**Interfaces:**
- Consumes: nothing new. The right-click drawing context menu (`drawMenuItems`, ~line 420-433) and everything else in Toolbar STAYS.

- [ ] **Step 1: Delete the moved UI**

In `frontend/src/Toolbar.tsx` remove:
- The Draw dropdown block (`{/* Drawing tools */}` `<div className="menu" ref={drawMenuRef}>` … `</div>`, ~line 603-627).
- The magnet menu block (~line 629-675) and the measure button block (~line 676-689). Keep the `<span className="tb-div" />` between measure and the bell ONLY if a divider is still needed between the remaining neighbors — check visually.
- Now-unused code: `DRAW_TOOLS` (~line 93-102), `addDrawing`/`clearDrawings`/`unlockAll` functions (~line 364-380), `drawOpen`/`drawMenuRef` state, `magnet`/`magnetOpen`/`magnetMenuRef` state + effect entries (lines ~178-183, and drop `magnetOpen` from the outside-click effect deps/branches at ~line 218-232), `measuring` state + its effect (~line 195-201).
- Now-unused imports: `getSupportedOverlays`, `magnetSignal`/`toggleMagnet`/`setMagnetStrength`, `MagnetIcon`, `RulerIcon` (keep `InfoTip`, `BellIcon`, `MenuIcons` — still used elsewhere). Let tsc/eslint be the judge: remove exactly what they flag as unused.

- [ ] **Step 2: Verify nothing else referenced the removed pieces**

Run: `cd frontend && npx tsc -b 2>&1 | grep -v "ChartCore.tsx\|historyPaging"` → no new errors.
Run: `rg -n "drawOpen|DRAW_TOOLS" src/` → no hits.

- [ ] **Step 3: Run the unit suite**

Run: `cd frontend && npx vitest run` → same failures as before this plan (the two known pre-existing ones), nothing new.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/Toolbar.tsx
git commit -m "refactor(chart): drop toolbar Draw dropdown + magnet + measure (moved to the draw sidebar)"
```

---

### Task 6: e2e coverage + full verification

**Files:**
- Create: `frontend/e2e/draw-sidebar.spec.ts`
- Possibly modify: existing e2e specs that clicked the toolbar's `.measure-toggle`/`.magnet-toggle` (e.g. `e2e/measure-tool.spec.ts`) — the buttons moved but kept their class names, so locators like `.measure-toggle` still resolve; only fix specs that anchored on `.toolbar` ancestry.

**Interfaces:**
- Consumes: `seedSingleChartDefault`, `stubStateApi` from `e2e/helpers.ts` (existing).

- [ ] **Step 1: Write the spec**

Create `frontend/e2e/draw-sidebar.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// The TV-style left drawing sidebar: family flyouts with glyphs + stars,
// favorites zone, last-used family arming, and the bulk cluster. Interactive
// draw-to-completion is NOT driven here (headless synthetic-click limitation,
// same as tab-drawings.spec.ts) — arming + state effects are.
test("draw sidebar: flyout, favorites, last-used, bulk buttons", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();

  const sidebar = page.locator(".draw-sidebar");
  await expect(sidebar).toBeVisible();

  // The old toolbar dropdown is gone.
  await expect(page.locator(".toolbar button", { hasText: "Draw" })).toHaveCount(0);

  // Lines family flyout opens; rows show glyph + label; outside click closes.
  const linesFamily = sidebar.locator(".ds-family").first();
  await linesFamily.hover();
  await linesFamily.locator(".ds-caret").click();
  const flyout = sidebar.locator(".ds-flyout");
  await expect(flyout).toBeVisible();
  await expect(flyout.locator(".ds-row")).toHaveCount(6);
  await expect(flyout.locator(".ds-row").first()).toContainText("Trend line");
  await expect(flyout.locator(".ds-row svg").first()).toBeVisible(); // glyph

  // Star "Ray" → favorites button appears at the sidebar top and persists.
  const rayRow = flyout.locator(".ds-row", { hasText: "Ray" });
  await rayRow.hover();
  await rayRow.locator(".ind-star").click();
  await expect(sidebar.locator("button[title='Ray']")).toBeVisible();
  const favs = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes("drawingFavorites"));
    return k ? JSON.parse(localStorage.getItem(k)!) : [];
  });
  expect(favs).toEqual(["rayLine"]);

  // Picking a tool records last-used: the family button now shows/arms it.
  await rayRow.click(); // arms Ray, closes flyout
  await expect(flyout).toHaveCount(0);
  await page.keyboard.press("Escape"); // cancel the armed draw
  const lastUsed = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes("lastDrawTools"));
    return k ? JSON.parse(localStorage.getItem(k)!) : {};
  });
  expect(lastUsed.lines).toBe("rayLine");
  await expect(linesFamily.locator(".ds-btn")).toHaveAttribute("title", /Ray/);

  // Favorites survive reload.
  await page.reload();
  await page.locator(".chart canvas").first().waitFor();
  await expect(page.locator(".draw-sidebar button[title='Ray']")).toBeVisible();

  // Measure + magnet live on the sidebar now.
  await expect(page.locator(".draw-sidebar .measure-toggle")).toBeVisible();
  await expect(page.locator(".draw-sidebar .magnet-toggle")).toBeVisible();

  // Bulk cluster renders enabled with a ready chart.
  await expect(page.locator(".draw-sidebar .ds-eye")).toBeEnabled();
  await expect(page.locator(".draw-sidebar .ds-trash")).toBeEnabled();

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run the new spec**

Run: `cd frontend && npx playwright test e2e/draw-sidebar.spec.ts`
Expected: PASS. If a locator mismatches the built DOM, fix the SPEC or the component — whichever is wrong — and note it in the commit.

- [ ] **Step 3: Run the whole e2e suite**

Run: `cd frontend && npx playwright test`
Expected: everything green that was green before (measure-tool.spec.ts especially — the `.measure-toggle` class was kept exactly so this spec keeps passing; if it anchored on toolbar ancestry, update its locator to `.draw-sidebar .measure-toggle`).

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/draw-sidebar.spec.ts
git commit -m "test(chart): e2e for the draw sidebar — flyout, favorites, last-used, bulk cluster"
```
