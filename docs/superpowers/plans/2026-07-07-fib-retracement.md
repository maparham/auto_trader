# TV-style Fib Retracement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace klinecharts' full-chart-width built-in `fibonacciLine` with a TV-style fib retracement: level lines span only the two anchors (with an Extend option), an editable per-level list (toggle/value/color), labels, trend line, and Reverse — all editable in the drawing settings modal and covered by Defaults/templates.

**Architecture:** Re-register the built-in overlay name `fibonacciLine` in `customOverlays.ts` (the proven `segment`/`rect` override pattern) with a template driven by a `fib` config stored in the drawing's `extendData` (where `text`/`showMiddle`/`visibility` already live and persist). Pure geometry lives in a new `fibConfig.ts` module with unit tests. The settings modal grows a fib branch on its Style tab; `SavedDrawingConfig` grows a `fib` field so Defaults ▾ / templates / Cancel-restore work through the existing machinery.

**Tech Stack:** TypeScript, React, klinecharts, vitest.

Spec: `docs/superpowers/specs/2026-07-07-fib-retracement-design.md`

## Global Constraints

- Same overlay name (`fibonacciLine`) — no new overlay names, no persistence migration, no backward-compat shims (project rule: no legacy code).
- klinecharts overlay text figures MUST null out `backgroundColor`/`borderColor` (default paints a blue box) — see the existing `labelFigure` gotcha in `customOverlays.ts`.
- Light theme is canonical; colors below are the TV palette and work on light.
- Run all commands from `frontend/`.

---

### Task 1: Fib config + geometry module (`fibConfig.ts`)

**Files:**
- Create: `frontend/src/lib/fibConfig.ts`
- Test: `frontend/src/lib/fibConfig.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2–4):

```ts
export interface FibLevel { value: number; enabled: boolean; color: string }
export type FibExtend = "none" | "left" | "right" | "both";
export interface FibConfig {
  levels: FibLevel[];
  extend: FibExtend;
  reverse: boolean;
  trendLine: boolean;
  labels: boolean;
}
export function defaultFibConfig(): FibConfig;         // fresh deep copy
export function asFibConfig(v: unknown): FibConfig;    // normalize unknown extendData.fib
export interface FibSegment {
  level: number; y: number; x1: number; x2: number; color: string; label: string;
}
export function fibLevelSegments(args: {
  cfg: FibConfig;
  coordinates: ReadonlyArray<{ x: number; y: number }>; // the 2 anchor coords
  values: readonly [number, number];                    // anchor prices [point0, point1]
  boundingWidth: number;
  precision: number;                                    // price decimals for the label
}): FibSegment[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/fibConfig.test.ts
import { describe, it, expect } from "vitest";
import { asFibConfig, defaultFibConfig, fibLevelSegments, type FibConfig } from "./fibConfig";

// Anchors: point0 first click at (x:100, y:200, price 90), point1 at (x:300, y:0, price 110).
// Like the built-in, level 0 sits at point1 (the second click) and level 1 at point0.
const coords = [{ x: 100, y: 200 }, { x: 300, y: 0 }] as const;
const values = [90, 110] as const;
const base = (over: Partial<FibConfig> = {}): FibConfig => ({ ...defaultFibConfig(), ...over });
const seg = (cfg: FibConfig) =>
  fibLevelSegments({ cfg, coordinates: [...coords], values, boundingWidth: 400, precision: 2 });

describe("asFibConfig", () => {
  it("returns defaults for missing/garbage input", () => {
    expect(asFibConfig(undefined)).toEqual(defaultFibConfig());
    expect(asFibConfig("nope")).toEqual(defaultFibConfig());
    // defaults: classic 7 enabled + 3 disabled extensions
    const d = asFibConfig(null);
    expect(d.levels.filter((l) => l.enabled).map((l) => l.value)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(d.extend).toBe("none");
    expect(d.reverse).toBe(false);
    expect(d.trendLine).toBe(true);
    expect(d.labels).toBe(true);
  });
  it("keeps a valid stored config verbatim and fills missing flags", () => {
    const stored = { levels: [{ value: 0.5, enabled: true, color: "#123456" }], reverse: true };
    const c = asFibConfig(stored);
    expect(c.levels).toEqual(stored.levels);
    expect(c.reverse).toBe(true);
    expect(c.extend).toBe("none"); // filled default
  });
});

describe("fibLevelSegments", () => {
  it("spans only the anchors' x-range and interpolates y from level 0 at point1", () => {
    const segs = seg(base());
    const l0 = segs.find((s) => s.level === 0)!;
    const l1 = segs.find((s) => s.level === 1)!;
    const l05 = segs.find((s) => s.level === 0.5)!;
    expect([l0.x1, l0.x2]).toEqual([100, 300]);
    expect(l0.y).toBe(0);    // point1's y
    expect(l1.y).toBe(200);  // point0's y
    expect(l05.y).toBe(100);
  });
  it("labels carry ratio and interpolated price at the given precision", () => {
    const segs = seg(base());
    expect(segs.find((s) => s.level === 0)!.label).toBe("0 (110.00)");
    expect(segs.find((s) => s.level === 0.618)!.label).toBe("0.618 (97.64)"); // 110 - 0.618*20
  });
  it("skips disabled levels", () => {
    const cfg = base();
    cfg.levels = cfg.levels.map((l) => (l.value === 0.5 ? { ...l, enabled: false } : l));
    expect(seg(cfg).some((s) => s.level === 0.5)).toBe(false);
  });
  it("reverse swaps which anchor is level 0", () => {
    const segs = seg(base({ reverse: true }));
    expect(segs.find((s) => s.level === 0)!.y).toBe(200); // now point0's y
    expect(segs.find((s) => s.level === 0)!.label).toBe("0 (90.00)");
    expect(segs.find((s) => s.level === 1)!.y).toBe(0);
  });
  it("extend widens the span to the pane edges", () => {
    const l = (cfg: FibConfig) => seg(cfg).find((s) => s.level === 0)!;
    expect([l(base({ extend: "left" })).x1, l(base({ extend: "left" })).x2]).toEqual([0, 300]);
    expect([l(base({ extend: "right" })).x1, l(base({ extend: "right" })).x2]).toEqual([100, 400]);
    expect([l(base({ extend: "both" })).x1, l(base({ extend: "both" })).x2]).toEqual([0, 400]);
  });
  it("extrapolates levels outside [0,1]", () => {
    const cfg = base();
    cfg.levels = [{ value: 1.618, enabled: true, color: "#2962ff" }];
    const s = seg(cfg)[0];
    expect(s.y).toBeCloseTo(0 + (200 - 0) * 1.618); // beyond point0
    expect(s.label).toBe("1.618 (77.64)");           // 110 - 1.618*20
  });
  it("returns [] when fewer than 2 coordinates", () => {
    expect(fibLevelSegments({ cfg: base(), coordinates: [{ x: 1, y: 1 }], values, boundingWidth: 400, precision: 2 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/fibConfig.test.ts`
Expected: FAIL — module `./fibConfig` not found.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/fibConfig.ts
// Fib retracement config + pure geometry. The config lives on the drawing's
// extendData.fib (persisted with the drawing); the geometry feeds the custom
// fibonacciLine overlay template. Level 0 sits at the SECOND anchor (point1) and
// level 1 at the first, matching both the old built-in and TV; `reverse` swaps them.

export interface FibLevel {
  value: number;
  enabled: boolean;
  color: string;
}
export type FibExtend = "none" | "left" | "right" | "both";
export interface FibConfig {
  levels: FibLevel[];
  extend: FibExtend;
  reverse: boolean;
  trendLine: boolean;
  labels: boolean;
}

// TV's default palette: greys for the 0/1 bounds, distinct hues between, and the
// common extensions present but off until the user enables them.
const DEFAULT_LEVELS: ReadonlyArray<FibLevel> = [
  { value: 0, enabled: true, color: "#787b86" },
  { value: 0.236, enabled: true, color: "#f23645" },
  { value: 0.382, enabled: true, color: "#ff9800" },
  { value: 0.5, enabled: true, color: "#4caf50" },
  { value: 0.618, enabled: true, color: "#089981" },
  { value: 0.786, enabled: true, color: "#00bcd4" },
  { value: 1, enabled: true, color: "#787b86" },
  { value: 1.618, enabled: false, color: "#2962ff" },
  { value: 2.618, enabled: false, color: "#f23645" },
  { value: -0.236, enabled: false, color: "#e91e63" },
];

export function defaultFibConfig(): FibConfig {
  return {
    levels: DEFAULT_LEVELS.map((l) => ({ ...l })),
    extend: "none",
    reverse: false,
    trendLine: true,
    labels: true,
  };
}

// Narrow unknown extendData.fib to a full FibConfig (never throws; anything
// malformed falls back field-by-field to the defaults).
export function asFibConfig(v: unknown): FibConfig {
  const d = defaultFibConfig();
  if (!v || typeof v !== "object") return d;
  const o = v as Partial<FibConfig>;
  const levels = Array.isArray(o.levels)
    ? o.levels.filter(
        (l): l is FibLevel =>
          !!l && typeof l === "object" &&
          typeof l.value === "number" && Number.isFinite(l.value) &&
          typeof l.enabled === "boolean" && typeof l.color === "string",
      )
    : d.levels;
  return {
    levels: levels.length ? levels : d.levels,
    extend: o.extend === "left" || o.extend === "right" || o.extend === "both" ? o.extend : "none",
    reverse: o.reverse === true,
    trendLine: o.trendLine !== false,
    labels: o.labels !== false,
  };
}

export interface FibSegment {
  level: number;
  y: number;
  x1: number;
  x2: number;
  color: string;
  label: string;
}

// Trim trailing zeros off a ratio (0.5 not 0.500) — matches TV's level text.
function ratioText(v: number): string {
  return String(v);
}

export function fibLevelSegments(args: {
  cfg: FibConfig;
  coordinates: ReadonlyArray<{ x: number; y: number }>;
  values: readonly [number, number];
  boundingWidth: number;
  precision: number;
}): FibSegment[] {
  const { cfg, coordinates, values, boundingWidth, precision } = args;
  if (coordinates.length < 2) return [];
  const [c0, c1] = coordinates;
  // Level 0 anchor / level 1 anchor (reverse swaps).
  const [zero, one] = cfg.reverse ? [c0, c1] : [c1, c0];
  const [vZero, vOne] = cfg.reverse ? [values[0], values[1]] : [values[1], values[0]];
  const spanLeft = Math.min(c0.x, c1.x);
  const spanRight = Math.max(c0.x, c1.x);
  const x1 = cfg.extend === "left" || cfg.extend === "both" ? 0 : spanLeft;
  const x2 = cfg.extend === "right" || cfg.extend === "both" ? boundingWidth : spanRight;
  return cfg.levels
    .filter((l) => l.enabled)
    .map((l) => {
      const price = vZero + (vOne - vZero) * l.value;
      return {
        level: l.value,
        y: zero.y + (one.y - zero.y) * l.value,
        x1,
        x2,
        color: l.color,
        label: `${ratioText(l.value)} (${price.toFixed(precision)})`,
      };
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/fibConfig.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/fibConfig.ts frontend/src/lib/fibConfig.test.ts
git commit -m "feat(fib): fib config normalizer + level-segment geometry"
```

---

### Task 2: Override the `fibonacciLine` overlay template

**Files:**
- Modify: `frontend/src/lib/customOverlays.ts` (add template + register; import from `./fibConfig`)

**Interfaces:**
- Consumes: `asFibConfig`, `fibLevelSegments` from Task 1; existing `asDrawingExtra` (its `DrawingExtra` gains `fib?` in Task 3, but until then read `extendData` loosely).
- Produces: the re-registered `fibonacciLine` overlay (rendering only; no new exports).

**Notes for the implementer:**
- Follow the file's existing style: template `const fibonacciLine: OverlayTemplate = {...}` placed after `rect`, registered inside `registerCustomOverlays()`.
- `createPointFigures` receives `{ overlay, coordinates, bounding, precision }`. Prices come from `overlay.points[i].value`; anchor pixel coords from `coordinates`.
- Read the config as `asFibConfig((overlay.extendData as { fib?: unknown } | undefined)?.fib)` — do NOT wait for Task 3's typed field.
- Line width + solid/dashed come from `overlay.styles?.line` (`size`, `style`, `dashedValue`) so the modal's existing Line control keeps working; color is per-level. Resolve: `const line = (overlay.styles?.line ?? {}) as { size?: number; style?: string; dashedValue?: number[] }`, then per-figure styles `{ color: s.color, size: line.size ?? 1, style: line.style ?? "solid", dashedValue: line.dashedValue ?? [4, 4] }`.
- While drawing (only 1 coordinate so far) return `[]` — the default point figure still shows the first anchor, matching how `segment` behaves pre-second-click.

- [ ] **Step 1: Add the template**

```ts
// import at top of customOverlays.ts:
import { asFibConfig, fibLevelSegments } from "./fibConfig";

// fibonacciLine: TV-style fib retracement OVERRIDING klinecharts' built-in, which
// paints every level across the full chart width. Levels/extend/reverse/labels
// live in extendData.fib (asFibConfig defaults when absent — including for fibs
// saved before this existed). Level lines span the anchors' x-range unless
// extended; width/dash come from styles.line, color is per-level.
const fibonacciLine: OverlayTemplate = {
  name: "fibonacciLine",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (params) => {
    const { overlay, coordinates, bounding, precision } = params;
    if (coordinates.length < 2) return [];
    const cfg = asFibConfig((overlay.extendData as { fib?: unknown } | undefined)?.fib);
    const p0 = overlay.points?.[0]?.value;
    const p1 = overlay.points?.[1]?.value;
    if (typeof p0 !== "number" || typeof p1 !== "number") return [];
    const segs = fibLevelSegments({
      cfg,
      coordinates,
      values: [p0, p1],
      boundingWidth: bounding.width,
      precision: precision.price,
    });
    const line = (overlay.styles?.line ?? {}) as { size?: number; style?: string; dashedValue?: number[] };
    const figures: OverlayFigure[] = [];
    if (cfg.trendLine) {
      figures.push({
        type: "line",
        attrs: { coordinates: [coordinates[0], coordinates[1]] },
        styles: { color: "#787b86", size: 1, style: "dashed", dashedValue: [4, 4] },
        ignoreEvent: true, // the level lines + handles are the drag targets
      });
    }
    for (const s of segs) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: s.x1, y: s.y }, { x: s.x2, y: s.y }] },
        styles: {
          color: s.color,
          size: line.size ?? 1,
          style: line.style ?? "solid",
          dashedValue: line.dashedValue ?? [4, 4],
        },
      });
      if (cfg.labels) {
        // Label at the right end, just above the line; hug the pane edge when the
        // span is extended to it so the text never clips off-screen.
        const atEdge = s.x2 >= bounding.width - 1;
        figures.push({
          type: "text",
          attrs: {
            x: atEdge ? bounding.width - 2 : s.x2 + 4,
            y: s.y - 2,
            text: s.label,
            align: atEdge ? "right" : "left",
            baseline: "bottom",
          },
          styles: {
            color: s.color,
            size: 12,
            family: "-apple-system, system-ui, sans-serif",
            backgroundColor: "transparent",
            borderColor: "transparent",
            borderSize: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
          },
          ignoreEvent: true,
        });
      }
    }
    return figures;
  },
};
```

And in `registerCustomOverlays()` add `registerOverlay(fibonacciLine);` after `registerOverlay(rect);`.

- [ ] **Step 2: Type-check and run the existing suites**

Run: `cd frontend && npx tsc --noEmit; npx vitest run src/lib`
Expected: no NEW tsc errors (23 pre-existing per baseline); vitest green.

- [ ] **Step 3: Visual smoke check**

Start/attach to the dev server (do not kill the user's HMR server), draw a fib on a chart: levels span only between the two clicks, labels on the right, dashed trend line, y-axis tags + anchor handles still present, drag still works.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/customOverlays.ts
git commit -m "feat(fib): TV-style fibonacciLine override — anchored spans, per-level colors, labels, trend line"
```

---

### Task 3: Config plumbing — `extendData.fib`, `setFibConfig`, defaults/templates

**Files:**
- Modify: `frontend/src/lib/overlays.ts` (`DrawingExtra`, new `setFibConfig`, `getDrawingConfig`, `applyDrawingConfig`, `seedFromDefault`)
- Modify: `frontend/src/lib/persist/artifacts.ts` (`SavedDrawingConfig`)

**Interfaces:**
- Consumes: `FibConfig`, `asFibConfig` from Task 1.
- Produces (used by Task 4):
  - `DrawingExtra.fib?: FibConfig`
  - `OverlayManager.setFibConfig(id: string, fib: FibConfig): void` — live-updates + persists, same shape as `setText`.
  - `SavedDrawingConfig.fib?: FibConfig`
  - `getDrawingConfig` returns `fib` for `fibonacciLine` drawings; `applyDrawingConfig` applies `cfg.fib`; `seedFromDefault` seeds `extendData.fib` on fresh draws.

- [ ] **Step 1: Add the fields and setter**

In `overlays.ts`:

```ts
// DrawingExtra gains (with a doc line matching the neighbors):
//   fib — fib retracement config (levels/extend/reverse/…); fibonacciLine only.
import { type FibConfig, asFibConfig } from "./fibConfig";
export interface DrawingExtra {
  /* existing fields unchanged */
  fib?: FibConfig;
}

// Next to setShowMiddle:
// Replace a fib drawing's level/extend/… config (custom-overlay feature). Same
// extendData path as setText — overrideOverlay re-invokes createPointFigures.
setFibConfig(id: string, fib: FibConfig): void {
  if (this.entries.get(id) !== "drawing") return;
  const ov = this.chart?.getOverlayById(id);
  if (!ov) return;
  const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), fib };
  this.chart?.overrideOverlay({ id, extendData: extra });
  this.persist();
}
```

In `persist/artifacts.ts` (import the type from `../fibConfig`):

```ts
export interface SavedDrawingConfig {
  line?: { color?: string; size?: number; style?: LineType };
  polygon?: { color?: string; borderColor?: string; borderSize?: number };
  // Fib retracement level/extend/… config. Only fibonacciLine drawings set it.
  fib?: FibConfig;
  showMiddle?: boolean;
  priceLabels?: boolean;
  visibility?: VisibilityModel;
}
```

- [ ] **Step 2: Wire defaults/templates round-trip**

In `getDrawingConfig` (the generic return after the `rect` branch), include fib only for fib drawings:

```ts
return {
  line: { /* existing resolved line */ },
  ...(live.name === "fibonacciLine" ? { fib: asFibConfig(extra.fib) } : {}),
  showMiddle: extra.showMiddle,
  priceLabels: extra.priceLabels,
  visibility: extra.visibility,
};
```

In `applyDrawingConfig` add:

```ts
if (cfg.fib !== undefined) this.setFibConfig(id, cfg.fib);
```

In `seedFromDefault` add (with the other extendData fields):

```ts
if (def.fib !== undefined) extendData.fib = def.fib;
```

- [ ] **Step 3: Type-check + run suites**

Run: `cd frontend && npx tsc --noEmit; npx vitest run src/lib`
Expected: no new tsc errors; vitest green.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/persist/artifacts.ts
git commit -m "feat(fib): persist fib config on extendData + defaults/template round-trip"
```

---

### Task 4: Settings modal — fib Style tab

**Files:**
- Modify: `frontend/src/DrawingSettings.tsx`
- Modify: `frontend/src/App.css` (level-grid styles)

**Interfaces:**
- Consumes: `OverlayManager.setFibConfig`, `SavedDrawingConfig.fib` (Task 3); `FibConfig`, `asFibConfig`, `defaultFibConfig` (Task 1); existing `ColorLineStylePicker` (all props optional — pass only what's needed).
- Produces: UI only.

- [ ] **Step 1: Add fib state + apply helper**

In `DrawingSettings.tsx`:

```tsx
import { type FibConfig, asFibConfig } from "./lib/fibConfig";

const isFib = name === "fibonacciLine";
// near the other useState hooks:
const [fib, setFib] = useState<FibConfig>(() => asFibConfig(extra0.fib));

function applyFib(next: FibConfig) {
  setFib(next);
  overlays.setFibConfig(curId, next);
}
```

- [ ] **Step 2: Render the fib Style branch**

In the Style tab, add an `isFib` branch alongside `isRect` (the generic Line row must NOT also render for fib — make the ternary three-way: `isRect ? … : isFib ? … : …`). Fib branch:

```tsx
<>
  {/* Shared width + dash for every level line; colors are per-level below. */}
  <div className="ind-row ind-style-row">
    <label>Lines</label>
    <div className="ind-line-controls">
      <ColorLineStylePicker
        size={size}
        onSize={(s) => applyStyle({ size: s })}
        lineStyle={style === LineType.Dashed ? "dashed" : "solid"}
        onLineStyle={(s) =>
          applyStyle({ style: s === "dashed" ? LineType.Dashed : LineType.Solid })
        }
        lineStyleOptions={["solid", "dashed"] as LineStyleOpt[]}
      />
    </div>
  </div>
  <div className="ind-row">
    <label>Extend</label>
    <select
      value={fib.extend}
      onChange={(e) => applyFib({ ...fib, extend: e.target.value as FibConfig["extend"] })}
    >
      <option value="none">Don't extend</option>
      <option value="left">Extend left</option>
      <option value="right">Extend right</option>
      <option value="both">Extend both</option>
    </select>
  </div>
  <div className="fib-levels">
    {fib.levels.map((l, i) => (
      <div className="fib-level" key={i}>
        <input
          type="checkbox"
          checked={l.enabled}
          onChange={(e) =>
            applyFib({
              ...fib,
              levels: fib.levels.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)),
            })
          }
        />
        <input
          type="number"
          step="any"
          value={l.value}
          onChange={(e) =>
            applyFib({
              ...fib,
              levels: fib.levels.map((x, j) =>
                j === i ? { ...x, value: Number(e.target.value) } : x,
              ),
            })
          }
        />
        <ColorLineStylePicker
          color={l.color}
          onColor={(c) =>
            applyFib({
              ...fib,
              levels: fib.levels.map((x, j) => (j === i ? { ...x, color: c } : x)),
            })
          }
        />
        <button
          className="ind-def-del"
          title="Remove level"
          onClick={() => applyFib({ ...fib, levels: fib.levels.filter((_, j) => j !== i) })}
        >
          ✕
        </button>
      </div>
    ))}
    <button
      className="ghost fib-add-level"
      onClick={() =>
        applyFib({ ...fib, levels: [...fib.levels, { value: 0, enabled: true, color: "#787b86" }] })
      }
    >
      + Add level
    </button>
  </div>
  <label className="ind-check">
    <input
      type="checkbox"
      checked={fib.trendLine}
      onChange={(e) => applyFib({ ...fib, trendLine: e.target.checked })}
    />
    <span>Trend line</span>
  </label>
  <label className="ind-check">
    <input
      type="checkbox"
      checked={fib.reverse}
      onChange={(e) => applyFib({ ...fib, reverse: e.target.checked })}
    />
    <span>Reverse</span>
  </label>
  <label className="ind-check">
    <input
      type="checkbox"
      checked={fib.labels}
      onChange={(e) => applyFib({ ...fib, labels: e.target.checked })}
    />
    <span>Levels</span>
  </label>
</>
```

App.css (near the other `.ind-*` modal rules):

```css
/* Fib settings: two-column level grid — checkbox · value · color · remove. */
.fib-levels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
  margin: 8px 0;
}
.fib-level {
  display: flex;
  align-items: center;
  gap: 6px;
}
.fib-level input[type="number"] {
  width: 64px;
}
.fib-add-level {
  justify-self: start;
}
```

- [ ] **Step 3: Cancel restore + template apply**

In `cancel()`'s same-name branch add (after the `setShowMiddle` line):

```ts
if (o.name === "fibonacciLine") overlays.setFibConfig(curId, asFibConfig(oExtra.fib));
```

In `applyConfigHere` add:

```ts
if (cfg.fib !== undefined) setFib(cfg.fib);
```

- [ ] **Step 4: Type-check + suites + manual check**

Run: `cd frontend && npx tsc --noEmit; npx vitest run src`
Expected: no new tsc errors; vitest green (baseline 534 passed / 50 skipped).

Manual: open a fib's settings (double-click it) — toggling levels/extend/reverse/trend line/labels live-previews; Cancel restores; Defaults ▾ save/apply works; fresh fib after "Save as default" seeds it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/DrawingSettings.tsx frontend/src/App.css
git commit -m "feat(fib): TV-style fib settings — level grid, extend, reverse, trend line, labels"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Full frontend suite + type-check**

Run: `cd frontend && npx vitest run; npx tsc --noEmit`
Expected: vitest ≥ 534 passed / 50 skipped (plus the new fibConfig tests); tsc shows only the 23 pre-existing errors.

- [ ] **Step 2: Browser verification (claude-in-chrome)**

On the dev app: draw a fib low→high; confirm (a) lines span only the anchors, (b) labels `ratio (price)` on the right, (c) settings edits live-preview + persist across reload, (d) an OLD previously-saved fib renders with the new anchored style, (e) drag/select/delete still work, (f) Extend right reaches the pane edge.

- [ ] **Step 3: Update memory + commit anything outstanding**
