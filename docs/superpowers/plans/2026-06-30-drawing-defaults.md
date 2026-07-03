# Drawing Defaults + Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give drawing tools a per-type "set as default" + named-templates capability, mirroring the indicator defaults menu.

**Architecture:** Three layers, copied from the indicator pattern. (1) `persist.ts` gains a `SavedDrawingConfig` type and six storage functions keyed by overlay name, backend-mirrored. (2) `overlays.ts` seeds freshly-drawn shapes from the saved default at create time, and exposes read/apply helpers for the modal. (3) `DrawingSettings.tsx` gains a "Defaults ▾" footer dropdown identical in structure to the indicator one.

**Tech Stack:** React + TypeScript, klinecharts 9.x overlays, vitest (unit), Playwright (e2e). localStorage with a backend mirror.

## Global Constraints

- Defaults/templates are keyed by klinecharts overlay **name** (`segment`, `rayLine`, `straightLine`, `horizontalStraightLine`, `verticalStraightLine`, `priceLine`, `priceChannelLine`, `fibonacciLine`). A default seeds only new drawings of the SAME name.
- Storage is **global** (not per-cell, not per-symbol), like indicator defaults.
- Stored fields: line `{color,size,style}`, `showMiddle`, `priceLabels`, `visibility` (the per-timeframe `VisibilityModel` from `lib/visibility.ts` — the Visibility tab's `units`+`autoHide` object; this REPLACED the old flat `intervals: string[]`). NEVER store `text` content, `userVisible`, points/coordinates, or an explicit "extend" field (extend is captured by which trend tool you save under).
- Storage functions MUST mirror to the backend identically to the indicator block: writes via `save()`, clears via `localStorage.removeItem` + `mirrorDelete(key)`.
- The footer dropdown is labeled **"Defaults ▾"** (consistency with the indicator modal), not "Template".
- `localStorage` key prefix is `auto-trader` (the `PREFIX` const). Keys: `auto-trader.drawingDefault.<name>` and `auto-trader.drawingPresets.<name>`.
- Run unit tests with `npm run test:unit` from `frontend/`.

---

### Task 1: Storage layer in `persist.ts`

**Files:**
- Modify: `frontend/src/lib/persist.ts` (add after the indicator preset block — `deleteIndicatorPreset` is now ~line 1028)
- Test: `frontend/src/lib/persist.test.ts` (add a new `describe` block)

**Interfaces:**
- Produces:
  - `interface SavedDrawingConfig { line?: { color?: string; size?: number; style?: LineType }; showMiddle?: boolean; priceLabels?: boolean; visibility?: VisibilityModel }`
  - `loadDrawingDefault(name: string): SavedDrawingConfig | null`
  - `saveDrawingDefault(name: string, cfg: SavedDrawingConfig): void`
  - `clearDrawingDefault(name: string): void`
  - `loadDrawingPresets(name: string): Record<string, SavedDrawingConfig>`
  - `saveDrawingPreset(name: string, presetName: string, cfg: SavedDrawingConfig): void`
  - `deleteDrawingPreset(name: string, presetName: string): void`
- Consumes: existing module-private `save`, `load`, `mirrorDelete`, `PREFIX` (all already in `persist.ts`); `LineType` type from `klinecharts`; `VisibilityModel` type from `./visibility`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/persist.test.ts` (after the existing `describe("per-indicator presets …")` block near line 180):

```ts
describe("per-drawing defaults + templates (global, keyed by overlay name)", () => {
  it("stores ONE default per overlay name, isolated across names", () => {
    const cfg = { line: { color: "#ff0000", size: 2 }, priceLabels: false };
    P.saveDrawingDefault("segment", cfg);
    expect(P.loadDrawingDefault("segment")).toEqual(cfg);
    // A different overlay name has its own (absent) default.
    expect(P.loadDrawingDefault("rayLine")).toBeNull();
    expect(localStorage.getItem("auto-trader.drawingDefault.segment")).not.toBeNull();
    P.clearDrawingDefault("segment");
    expect(P.loadDrawingDefault("segment")).toBeNull();
  });

  it("stores named templates per overlay name and deletes them", () => {
    P.saveDrawingPreset("segment", "Red", { line: { color: "#ff0000" } });
    P.saveDrawingPreset("segment", "Blue", { line: { color: "#0000ff" } });
    expect(Object.keys(P.loadDrawingPresets("segment")).sort()).toEqual(["Blue", "Red"]);
    expect(P.loadDrawingPresets("segment").Red).toEqual({ line: { color: "#ff0000" } });
    // Scoped to the name — rayLine sees none.
    expect(P.loadDrawingPresets("rayLine")).toEqual({});
    P.deleteDrawingPreset("segment", "Red");
    expect(Object.keys(P.loadDrawingPresets("segment"))).toEqual(["Blue"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit -- persist`
Expected: FAIL — `P.saveDrawingDefault is not a function` (and the others).

- [ ] **Step 3: Implement the storage functions**

In `frontend/src/lib/persist.ts`, immediately after `deleteIndicatorPreset` (~line 1028), add:

```ts
// --- per-drawing defaults + templates (global, keyed by overlay NAME) --------
//
// The drawing analogue of the indicator "Defaults" menu above. GLOBAL (not
// per-cell, not per-symbol) — a personal style preference — keyed by the
// klinecharts overlay NAME (segment/rayLine/straightLine/…). Two layers holding
// the SAME SavedDrawingConfig the drawing settings modal produces:
//  - default : ONE config per name. Freshly-DRAWN overlays of that name seed from
//              it (see OverlayManager.addDrawing). Never touches rehydrated draws.
//  - presets : named configs per name ("Red", …), applied on demand.
// Extend is NOT a stored field: the trend family (segment/rayLine/straightLine)
// is three separate names, so extend is captured by which name you save under.
const drawingDefaultKey = (name: string) => `${PREFIX}.drawingDefault.${name}`;
const drawingPresetsKey = (name: string) => `${PREFIX}.drawingPresets.${name}`;

export function loadDrawingDefault(name: string): SavedDrawingConfig | null {
  return load<SavedDrawingConfig | null>(drawingDefaultKey(name), null);
}
export function saveDrawingDefault(name: string, cfg: SavedDrawingConfig): void {
  save(drawingDefaultKey(name), cfg);
}
export function clearDrawingDefault(name: string): void {
  const key = drawingDefaultKey(name);
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key);
}

export function loadDrawingPresets(name: string): Record<string, SavedDrawingConfig> {
  return load<Record<string, SavedDrawingConfig>>(drawingPresetsKey(name), {});
}
export function saveDrawingPreset(name: string, presetName: string, cfg: SavedDrawingConfig): void {
  const all = loadDrawingPresets(name);
  all[presetName] = cfg;
  save(drawingPresetsKey(name), all);
}
export function deleteDrawingPreset(name: string, presetName: string): void {
  const all = loadDrawingPresets(name);
  if (presetName in all) {
    delete all[presetName];
    save(drawingPresetsKey(name), all);
  }
}
```

Then add the type next to `SavedIndicatorConfig` (the interface is now ~line 1161). Imports at the top of `persist.ts` currently read `import type { DeepPartial, OverlayStyle } from "klinecharts";` (line 15) — `LineType` is NOT imported, so add `import type { LineType } from "klinecharts";`. `VisibilityModel` is also not imported here — add `import type { VisibilityModel } from "./visibility";`:

```ts
// The drawing settings modal's reusable style snapshot (no points/text/extend —
// see the per-drawing defaults block). `visibility` absent = show on all intervals
// (the VisibilityModel default). This is the same per-timeframe model the Visibility
// tab edits (lib/visibility.ts) — a plain JSON object, safe to persist.
export interface SavedDrawingConfig {
  line?: { color?: string; size?: number; style?: LineType };
  showMiddle?: boolean;
  priceLabels?: boolean;
  visibility?: VisibilityModel;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit -- persist`
Expected: PASS (all, including the two new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist.ts frontend/src/lib/persist.test.ts
git commit -m "feat: per-drawing default + template storage (keyed by overlay name)"
```

---

### Task 2: Seed new draws + modal read/apply helpers in `overlays.ts`

**Files:**
- Modify: `frontend/src/lib/overlays.ts` (`addDrawing` is now ~849; add two methods near the other drawing edits, after `updatePoints` ~1124; add visibility enforcement in `create()`'s `onDrawEnd` ~685)
- Test: `frontend/src/lib/overlays.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes (from Task 1): `loadDrawingDefault`, `SavedDrawingConfig` from `./persist`.
- Produces (used by Task 3):
  - `OverlayManager.getDrawingConfig(id: string): SavedDrawingConfig | null` — build a config from the LIVE overlay (post-extend-morph name).
  - `OverlayManager.applyDrawingConfig(id: string, cfg: SavedDrawingConfig): void` — push a config onto an existing drawing via the existing setters.
- Internal: `addDrawing` now seeds styles+extendData from the default at create time.

**Background facts (re-verified against current code — line numbers are approximate, anchors are by-name):**
- `addDrawing` (~line 849) is the ONLY interactive-draw entry point; rehydrate and paste/clone (`placeDrawing`, ~889) call `create()` directly. So seeding here is fresh-draw-only and needs NO rehydrate guard.
- **DRIFT — do not blind-replace `addDrawing`.** Since the plan was first written it gained two behaviors that MUST be preserved: `if (!points) this.cancelDrawing();` (cancels a stranded in-progress tool on re-arm) and `else if (id && !points) this.pendingDrawId = id;` (remembers the id for `cancelDrawing`/Esc). Merge the seed in; keep both.
- `create()` (~line 649) forwards `styles` and `extendData` to `chart.createOverlay` even for point-less interactive draws (`styles: styles ?? undefined`, line ~664), and `needDefaultYAxisFigure` (~678) already reads `asDrawingExtra(extra?.extendData).priceLabels`. So seeding at create time both styles the in-progress draw and sets the y-axis tag correctly.
- **`create()`'s `onDrawEnd` (~685) calls `this.persist()` but NOT `applyDisplay`.** `color`/`showMiddle`/`priceLabels` are paint-time/create-time reads and apply immediately, but `visibility` is ENFORCED by `applyDisplay` (hides the overlay off its configured intervals). A seeded `visibility` stashed only in `extendData` won't take effect until the next interval switch or reload. So the completion path must run `applyDisplay` — see Step 3b.
- Existing setters to reuse in `applyDrawingConfig`: `setStyle(id, {line})` (~1397), `setShowMiddle(id, bool)` (~1091), `setPriceLabels(id, bool)` (~1065), `setVisibilityModel(id, VisibilityModel)` (~1052 — this REPLACED `setVisibleIntervals`; it calls `applyDisplay` + `persist` internally).
- `getDrawing(id)` (~518) returns `{ name, points, styles, ..., extendData }`; `asDrawingExtra(v)` (~110) narrows `extendData` to `DrawingExtra`. `DrawingExtra` (~97) now carries `visibility?: VisibilityModel` (NOT `intervals`).
- `LineType` is already imported as a VALUE at the top of `overlays.ts` (`import { LineType } from "klinecharts";`, line 14) — usable in type position, so no import change needed for it. `VisibilityModel` is already imported (line ~33). `SavedDrawingConfig` still needs adding to the `./persist` type import.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/overlays.test.ts` a new `describe` block (the file already constructs an `OverlayManager` against a `FakeChart` — mirror the setup used by the existing drawing tests in that file; inspect a nearby `describe` to see how a manager is built and an epic set):

```ts
describe("drawing defaults seeding + config round-trip", () => {
  it("seeds a freshly-drawn overlay from the saved default (styles + extendData)", () => {
    // Build a manager bound to a FakeChart + epic the same way the other drawing
    // tests in this file do (construct OverlayManager, setChart, setEpic).
    const { mgr, chart } = makeManager(); // <- use this file's existing helper/pattern
    // A visibility model that hides on all intervals, to prove it's both stored AND
    // enforced. Build from defaultVisibility() (import from "./visibility") and flip
    // every unit off so applyDisplay would hide the overlay at any resolution.
    const hidden = defaultVisibility();
    for (const u of Object.values(hidden.units)) u.on = false;
    P.saveDrawingDefault("segment", {
      line: { color: "#ff0000", size: 3 },
      showMiddle: true,
      priceLabels: false,
      visibility: hidden,
    });
    const id = mgr.addDrawing("segment"); // interactive: no points
    expect(id).not.toBeNull();
    const ov = chart.getOverlayById(id!)!;
    expect((ov.styles as { line?: { color?: string } }).line?.color).toBe("#ff0000");
    expect(asDrawingExtra(ov.extendData).showMiddle).toBe(true);
    expect(asDrawingExtra(ov.extendData).priceLabels).toBe(false);
    expect(ov.needDefaultYAxisFigure).toBe(false); // priceLabels:false ⇒ no y-axis tag
    // Seeded visibility is stored in extendData…
    expect(asDrawingExtra(ov.extendData).visibility).toEqual(hidden);
  });

  it("draws with no extra styling when there is no default", () => {
    const { mgr, chart } = makeManager();
    const id = mgr.addDrawing("rayLine");
    const ov = chart.getOverlayById(id!)!;
    expect(ov.styles).toBeUndefined(); // create() passes styles ?? undefined
  });

  it("getDrawingConfig reads the live overlay; applyDrawingConfig writes it back (incl. visibility)", () => {
    const { mgr } = makeManager();
    const id = mgr.addDrawing("segment", [{ value: 10 }, { value: 20 }])!;
    const hidden = defaultVisibility();
    hidden.units.days.on = false;
    mgr.applyDrawingConfig(id, {
      line: { color: "#00ff00" },
      priceLabels: false,
      visibility: hidden,
    });
    const cfg = mgr.getDrawingConfig(id)!;
    expect(cfg.line?.color).toBe("#00ff00");
    expect(cfg.priceLabels).toBe(false);
    // applyDrawingConfig routes visibility through setVisibilityModel (which runs
    // applyDisplay + stores it); getDrawingConfig reads it straight back.
    expect(cfg.visibility?.units.days.on).toBe(false);
  });
});
```

NOTE on enforcement (Step 3b): `applyDisplay` runs inside `create()`'s `onDrawEnd`, which fires only when a klinecharts interactive draw *completes* — FakeChart does not drive that completion, so the seeding test above asserts visibility is STORED, and the round-trip test asserts the apply path (via `setVisibilityModel`) works. The full seed-then-enforce effect (a fresh drawing hidden immediately on the seeded interval) is verified in the manual smoke (Task 3, Step 4).

NOTE: if `overlays.test.ts` has no shared `makeManager()` helper, add a small one at the top of this `describe` that constructs the manager exactly as the existing drawing tests do (same `new OverlayManager(...)`, `setChart(new FakeChart())`, epic-set calls). Keep it local to this block.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit -- overlays`
Expected: FAIL — `mgr.getDrawingConfig is not a function` and the seeding assertions (color undefined).

- [ ] **Step 3: Implement seeding in `addDrawing`**

Add the import at the top of `overlays.ts` (extend the existing `from "./persist"` import to include the new names, and `SavedDrawingConfig` to the type import):

```ts
import { /* …existing… */ loadDrawingDefault } from "./persist";
import type { /* …existing… */ SavedDrawingConfig } from "./persist";
```
(Match the file's existing import grouping — `SavedOverlay` is already imported from persist around line 23.)

**MERGE the seed into the current `addDrawing` (~849) — do NOT paste over it, or you drop `cancelDrawing()` and `pendingDrawId`.** The only additions are the `seedFromDefault` call and threading `seed?.styles` + `{extendData: seed?.extendData}` into `create()`. Result:

```ts
addDrawing(name: string, points?: SavedOverlay["points"]): string | null {
  // Re-arming replaces the in-progress tool: klinecharts keeps ONE progress slot and
  // silently overwrites it WITHOUT firing onRemoved, stranding the previous id. Cancel
  // it properly first. (Preserved — pre-existing behavior.)
  if (!points) this.cancelDrawing();
  // No points = interactive draw (klinecharts collects clicks until the figure is
  // complete). Flag it so a lock click-to-align doesn't fire on those clicks; the
  // onDrawEnd in create() clears it.
  if (!points) this.drawingInProgress = true;
  // Seed from this overlay-name's saved default (set as default / TV-style). Only
  // fresh draws route through addDrawing — rehydrate/paste call create() directly —
  // so existing drawings are never restyled. extendData also drives the y-axis tag
  // (needDefaultYAxisFigure reads priceLabels in create()).
  const seed = this.seedFromDefault(name);
  const id = this.create("drawing", name, points, seed?.styles, undefined, {
    extendData: seed?.extendData,
  });
  if (id && points) this.persist(); // interactive draws persist via onDrawEnd
  else if (id && !points) this.pendingDrawId = id; // remember it for cancelDrawing() (preserved)
  else if (!id) {
    // creation failed → don't get stuck
    this.drawingInProgress = false;
    this.pendingDrawId = null;
  }
  return id;
}

// Translate a saved default for `name` into create()'s styles + extendData, or
// undefined when there's no default. extendData carries only the appearance flags
// (showMiddle/priceLabels/visibility) — never points or text.
private seedFromDefault(
  name: string,
): { styles?: DeepPartial<OverlayStyle>; extendData?: DrawingExtra } | undefined {
  const def = loadDrawingDefault(name);
  if (!def) return undefined;
  const extendData: DrawingExtra = {};
  if (def.showMiddle !== undefined) extendData.showMiddle = def.showMiddle;
  if (def.priceLabels !== undefined) extendData.priceLabels = def.priceLabels;
  if (def.visibility !== undefined) extendData.visibility = def.visibility;
  return {
    styles: def.line ? ({ line: def.line } as DeepPartial<OverlayStyle>) : undefined,
    extendData: Object.keys(extendData).length ? extendData : undefined,
  };
}
```

- [ ] **Step 3b: Enforce seeded visibility on draw completion**

`create()`'s `onDrawEnd` (~685) persists but never runs `applyDisplay`, so a seeded `visibility` would be stored yet not enforced until the next interval switch/reload. Add an `applyDisplay` call for the drawing kind so a freshly-completed drawing immediately honors its seeded visibility. In `create()`, inside `onDrawEnd`, after `this.persist();` and before `if (isAlert) this.notifyAlerts();`, add:

```ts
// A seeded default may carry per-interval visibility; enforce it now (persist alone
// doesn't). Harmless when none is seeded — empty visibility ⇒ show on all intervals.
// `id` is closed over and assigned by the time onDrawEnd fires.
if (isDrawing) {
  const ov = this.chart?.getOverlayById(id);
  if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
}
```

- [ ] **Step 4: Implement `getDrawingConfig` + `applyDrawingConfig`**

Add these two methods near the other drawing edits (after `updatePoints`, ~line 1124):

```ts
// Read the LIVE overlay into a reusable SavedDrawingConfig (no points/text). Used
// by the settings modal's "Save as default/preset" — reading the live overlay (not
// stale React state) is what makes the extend-via-name model correct: an extended
// line resolves to name `straightLine` and saves under that key.
getDrawingConfig(id: string): SavedDrawingConfig | null {
  const live = this.getDrawing(id);
  if (!live) return null;
  const line = (live.styles?.line ?? {}) as { color?: string; size?: number; style?: LineType };
  const extra = asDrawingExtra(live.extendData);
  return {
    line: { color: line.color, size: line.size, style: line.style },
    showMiddle: extra.showMiddle,
    priceLabels: extra.priceLabels,
    visibility: extra.visibility,
  };
}

// Push a SavedDrawingConfig onto an EXISTING drawing (Reset settings / apply
// template). Reuses the per-field setters so each persists; never changes the
// overlay name, so no recreate is needed.
applyDrawingConfig(id: string, cfg: SavedDrawingConfig): void {
  if (cfg.line) this.setStyle(id, { line: cfg.line } as DeepPartial<OverlayStyle>);
  if (cfg.showMiddle !== undefined) this.setShowMiddle(id, cfg.showMiddle);
  if (cfg.priceLabels !== undefined) this.setPriceLabels(id, cfg.priceLabels);
  if (cfg.visibility !== undefined) this.setVisibilityModel(id, cfg.visibility);
}
```

`LineType` is already imported as a value at the top of `overlays.ts` (line 14) — fine for this type position, no change needed. `VisibilityModel` is already imported (~line 33).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit -- overlays`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays.test.ts
git commit -m "feat: seed new drawings from saved default + config read/apply helpers"
```

---

### Task 3: "Defaults ▾" dropdown in `DrawingSettings.tsx`

**Files:**
- Modify: `frontend/src/DrawingSettings.tsx` (imports, new state/handlers, footer JSX)
- Test: `frontend/e2e/drawing-defaults.spec.ts` (new — mirror `e2e/indicator-presets.spec.ts`)

**Interfaces:**
- Consumes (Task 1): `loadDrawingDefault`, `saveDrawingDefault`, `clearDrawingDefault`, `loadDrawingPresets`, `saveDrawingPreset`, `deleteDrawingPreset` from `./lib/persist`.
- Consumes (Task 2): `overlays.getDrawingConfig(curId)`, `overlays.applyDrawingConfig(curId, cfg)`.
- Consumes (existing): `toast` from `./lib/notify`; `InfoTip` from `./InfoTip`.

- [ ] **Step 1: Add imports + menu state**

In `DrawingSettings.tsx`, add to the imports:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "./lib/notify";
import InfoTip from "./InfoTip";
import {
  loadDrawingDefault,
  saveDrawingDefault,
  clearDrawingDefault,
  loadDrawingPresets,
  saveDrawingPreset,
  deleteDrawingPreset,
} from "./lib/persist";
```
(`useEffect`/`useRef` are new; `useMemo`/`useState` are already imported — merge, don't duplicate the React import.)

Inside the component, after the existing `useState` hooks (the last one, `vis`/`setVis`, is ~line 89), add the menu state + outside-click close (copied from the indicator modal's Defaults menu):

```ts
const [defOpen, setDefOpen] = useState(false);
const [naming, setNaming] = useState(false); // inline "Save as template…" field
const [presetName, setPresetName] = useState("");
const defMenuRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!defOpen) return;
  const onDown = (e: MouseEvent) => {
    if (defMenuRef.current && !defMenuRef.current.contains(e.target as Node)) {
      setDefOpen(false);
      setNaming(false);
    }
  };
  // Capture phase: the modal body stops mousedown propagation, so a document
  // listener must capture to see clicks inside the modal.
  document.addEventListener("mousedown", onDown, true);
  return () => document.removeEventListener("mousedown", onDown, true);
}, [defOpen]);
```

- [ ] **Step 2: Add the handlers**

Add these handlers inside the component (after `applyPointValue`, ~line 155, before `cancel`). They route through Task 2's `overlays` helpers and re-sync the modal's local React state so the open drawing visibly updates. NOTE the state setters: `setStyle` is the LOCAL line-style state hook (line 78), and the visibility state hook is `vis`/`setVis` (line 89) — there is no `setIntervals`:

```ts
// Apply a config to the open drawing AND refresh local state so the controls
// reflect it. `null` = this name's default (or no-op if none saved).
function applyConfigHere(cfg: SavedDrawingConfig | null) {
  if (!cfg) return;
  overlays.applyDrawingConfig(curId, cfg);
  if (cfg.line?.color !== undefined) setColor(cfg.line.color);
  if (cfg.line?.size !== undefined) setSize(cfg.line.size);
  if (cfg.line?.style !== undefined) setStyle(cfg.line.style);
  if (cfg.showMiddle !== undefined) setShowMiddle(cfg.showMiddle);
  if (cfg.priceLabels !== undefined) setPriceLabels(cfg.priceLabels);
  if (cfg.visibility !== undefined) setVis(cfg.visibility);
}

function resetToDefault() {
  applyConfigHere(loadDrawingDefault(name));
  setDefOpen(false);
}
function saveAsDefault() {
  const cfg = overlays.getDrawingConfig(curId); // LIVE overlay → correct name key
  if (cfg) saveDrawingDefault(name, cfg);
  setDefOpen(false);
  toast(`Saved ${title} default`);
}
function commitPreset() {
  const nm = presetName.trim();
  if (!nm) return;
  const cfg = overlays.getDrawingConfig(curId);
  if (cfg) saveDrawingPreset(name, nm, cfg);
  setNaming(false);
  setPresetName("");
  setDefOpen(false);
  toast(`Saved template "${nm}"`);
}
function applyPreset(nm: string) {
  const cfg = loadDrawingPresets(name)[nm];
  if (cfg) applyConfigHere(cfg);
  setDefOpen(false);
}
function removePreset(nm: string) {
  deleteDrawingPreset(name, nm);
  // Re-read by toggling the menu (same idiom as the indicator menu).
  setDefOpen(false);
  setTimeout(() => setDefOpen(true), 0);
}
```

Add `SavedDrawingConfig` to the `./lib/overlays` type import (it's re-exported there via Task 2 use) OR import from `./lib/persist`:
```ts
import type { SavedDrawingConfig } from "./lib/persist";
```

- [ ] **Step 3: Add the footer dropdown JSX**

Replace the footer (now lines 333-338 — `<div className="modal-foot">` … Cancel/Ok) with the indicator-menu structure, keeping the existing Cancel/Ok:

```tsx
<div className="modal-foot">
  {/* TV-style "Defaults" menu: this drawing type's default + named templates,
      all global. Pinned left opposite Cancel/Ok. */}
  <div className="menu ind-def-menu" ref={defMenuRef}>
    <span className="ind-row-head">
      <button className={`ghost ${defOpen ? "on" : ""}`} onClick={() => setDefOpen((v) => !v)}>
        Defaults ▾
      </button>
      <InfoTip
        title="Defaults"
        text="Save these settings as the default for this drawing type, or store named templates."
      />
    </span>
    {defOpen && (
      <div className="dropdown ind-def-dropdown">
        <ul>
          <li onClick={resetToDefault}>Reset settings</li>
          <li onClick={saveAsDefault}>Save as default</li>
          {loadDrawingDefault(name) && (
            <li
              onClick={() => {
                clearDrawingDefault(name);
                setDefOpen(false);
                toast(`Cleared ${title} default`);
              }}
            >
              Clear default
            </li>
          )}
          <li className="sep" />
          {Object.keys(loadDrawingPresets(name)).map((nm) => (
            <li key={nm} className="ind-def-preset">
              <span onClick={() => applyPreset(nm)} title={`Apply "${nm}"`}>
                {nm}
              </span>
              <button
                className="ind-def-del"
                title={`Delete "${nm}"`}
                onClick={(e) => {
                  e.stopPropagation();
                  removePreset(nm);
                }}
              >
                ✕
              </button>
            </li>
          ))}
          {naming ? (
            <li className="ind-def-name">
              <input
                autoFocus
                placeholder="Template name…"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitPreset();
                  if (e.key === "Escape") {
                    setNaming(false);
                    setPresetName("");
                  }
                }}
              />
              <button onClick={commitPreset}>Save</button>
            </li>
          ) : (
            <li onClick={() => setNaming(true)}>Save as template…</li>
          )}
        </ul>
      </div>
    )}
  </div>
  <button className="ghost" onClick={cancel}>
    Cancel
  </button>
  <button onClick={onClose}>Ok</button>
</div>
```

The `.ind-def-*`, `.ind-def-menu`, `.dropdown`, `.sep`, `.ind-row-head` classes already exist (shared with the indicator modal) — no new CSS needed.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

Manual smoke (dev server already running per the dev-environment note — do NOT restart it; open a browser tab against it):
1. Draw a Segment, double-click it → modal opens.
2. Set color red, dashed; open **Defaults ▾** → **Save as default**; see the toast.
3. Draw another Segment → it appears red/dashed. Draw a Ray → it is NOT red/dashed.
4. **Defaults ▾** → **Save as template…**, name it "Red", Save. Reopen menu → "Red" listed with ✕.
5. Change color to blue; **Defaults ▾** → click "Red" → reverts to red. ✕ deletes it.
6. **Clear default** removes the auto-seed (new Segments draw plain again).

- [ ] **Step 5: Write the e2e test**

Create `frontend/e2e/drawing-defaults.spec.ts`, mirroring the structure of `e2e/indicator-presets.spec.ts` (reuse its app-boot, `/api/state` stub, and chart-ready helpers verbatim — read that file first and copy its setup). The test must:

1. Boot the app with the same stubs as `indicator-presets.spec.ts`.
2. Draw a segment (use the existing drawing-tool interaction the `tab-drawings.spec.ts` suite uses — read it for the exact toolbar + canvas-click sequence).
3. Open the drawing settings modal, set a distinct color, open **Defaults ▾**, click **Save as default**.
4. Assert `localStorage` got `auto-trader.drawingDefault.segment`:
   ```ts
   const stored = await page.evaluate(() => localStorage.getItem("auto-trader.drawingDefault.segment"));
   expect(stored).not.toBeNull();
   ```
5. Draw a second segment and assert its persisted style matches the default (read back via the `auto-trader.tab.*.drawings.*` key, the same way `tab-drawings.spec.ts` inspects saved drawings).

- [ ] **Step 6: Run the e2e test**

Run: `cd frontend && npx playwright test drawing-defaults`
Expected: PASS. (If the drawing-interaction helper differs from what you copied, fix the selectors to match `tab-drawings.spec.ts` — do not change app code to fit the test.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/DrawingSettings.tsx frontend/e2e/drawing-defaults.spec.ts
git commit -m "feat: Defaults menu (set-as-default + named templates) in drawing settings"
```

---

## Self-Review

**Spec coverage:**
- Per-type default + named templates → Task 1 (storage), Task 3 (UI). ✓
- Keyed by overlay name; isolated across names → Task 1 tests. ✓
- Stored fields = line/showMiddle/priceLabels/visibility (`VisibilityModel`, replacing the old `intervals: string[]`); excludes text/userVisible/points/extend → `SavedDrawingConfig` (Task 1) + `getDrawingConfig` (Task 2). ✓
- Seeded `visibility` is enforced at draw completion, not just stored → Task 2 Step 3b `applyDisplay` in `onDrawEnd`. ✓
- `addDrawing` merge preserves `cancelDrawing()` + `pendingDrawId` (post-plan drift) → Task 2 Step 3 merge note. ✓
- Backend mirror → `save`/`mirrorDelete` in Task 1. ✓
- Seed fresh draws only, no rehydrate guard → Task 2 `addDrawing`/`seedFromDefault` + the verified create-path facts. ✓
- Save-as-default reads the LIVE overlay (extend-via-name correctness) → `getDrawingConfig(curId)` in Tasks 2-3. ✓
- "Defaults ▾" label, footer placement, mirror indicator menu → Task 3. ✓
- klinecharts honors styles/extendData on in-progress draw (Check 1) → resolved: `create()` forwards both; Task 2 seeds at create. ✓
- `addDrawing` is interactive-only (Check 2) → resolved: rehydrate/paste call `create()`/`placeDrawing` directly. ✓

**Placeholder scan:** No TBD/TODO; the two e2e "read that file and copy its setup" notes point at concrete existing files (`indicator-presets.spec.ts`, `tab-drawings.spec.ts`) because their boot/stub boilerplate is long and must be reused verbatim rather than guessed. The unit tests carry full code.

**Type consistency:** `SavedDrawingConfig` shape is identical across Tasks 1-3. `getDrawingConfig`/`applyDrawingConfig`/`seedFromDefault`/`loadDrawingDefault` names match between producer (Task 2) and consumer (Task 3). Storage fn names match between Task 1 and Task 3.
