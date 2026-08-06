# Backtest Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give backtest presets a stable identity (one active preset, dirty tracking, a real update path) and turn the picker into a sortable, results-aware library with export/import.

**Architecture:** A new `lib/backtestPresets.ts` owns v3 storage (an envelope wrapping the config with metadata plus the last clean run) and the pure export/import serializers. A new `components/PresetsTab.tsx` owns the whole tab UI — identity bar, library table, inline dialogs — and subscribes to `backtestResultSignal` itself to record run summaries. `BacktestSettingsModal.tsx` shrinks: it renders `<PresetsTab/>` inside the existing Presets `<Section>` and drops its own preset state and handlers.

**Tech Stack:** React 19 + TypeScript, Vitest + @testing-library/react (jsdom), plain CSS in `frontend/src/App.css`. Storage is `localStorage` through the existing `lib/persist` helpers.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-backtest-presets-design.md`. Read it before Task 1.
- All commands run from `frontend/`. Tests: `npm run test:unit`. Types: `npx tsc -b`. Lint: `npm run lint`.
- The v2 key `…backtestPresets.v2` is **abandoned** — never read, never migrated. Do not write a migration.
- Preset identity appears **only inside the Presets tab**. Do not touch the panel header (the in-flight `2026-08-06-backtest-panel-overlay-design.md` owns panel chrome).
- The Live / **Go live →** row stays in the Presets tab with its current "send the panel's current config" semantics.
- Tooltips use the shared `Tooltip` / `InfoTip` components (see `CLAUDE.md`), never a native `title=`.
- Confirms use `window.confirm`, matching `DrawSidebar.tsx:250` and `OrderTicket.tsx:293`. Never use `window.prompt` — naming happens in an inline input.
- One run stored per preset (last wins). Sweep and WFO runs never record.
- Commit after every task with the message given in that task's final step.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/lib/backtestConfig.ts` (modify) | Add `backtestConfigEquals` — canonical, key-order-insensitive config comparison. |
| `frontend/src/lib/backtestConfig.test.ts` (modify) | Tests for the above. |
| `frontend/src/lib/backtestPresets.ts` (create) | v3 envelope type, CRUD over the v3 key, and the pure serialize/parse pair for export/import. No React. |
| `frontend/src/lib/backtestPresets.test.ts` (create) | Unit tests for storage + serialization. |
| `frontend/src/components/PresetsTab.tsx` (create) | The whole Presets tab UI: identity bar, library table, inline dialogs, export/import, run capture. |
| `frontend/src/components/PresetsTab.test.tsx` (create) | Component tests for the above. |
| `frontend/src/BacktestSettingsModal.tsx` (modify) | Render `<PresetsTab/>`; delete the old preset state, handlers, and markup. |
| `frontend/src/BacktestSettingsModal.test.tsx` (modify) | Drop the removed `saveBacktestPreset` import; use the v3 helper. |
| `frontend/src/lib/persist/defaults.ts` (modify) | Delete the v2 preset functions and key. `loadBacktestLastUsed` stays. |
| `frontend/src/App.css` (modify) | Replace the `.bt-presets` block with the identity-bar + table styles. |

---

### Task 1: Canonical config comparison

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (append after `normalizeBacktestConfig`, which ends around line 245)
- Test: `frontend/src/lib/backtestConfig.test.ts`

**Interfaces:**
- Consumes: `BacktestConfig`, `normalizeBacktestConfig` (both already in this file).
- Produces: `export function backtestConfigEquals(a: BacktestConfig, b: BacktestConfig): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/backtestConfig.test.ts`:

```ts
describe("backtestConfigEquals", () => {
  it("ignores key order", () => {
    const a = defaultBacktestConfig();
    // Rebuild the top level with the keys reversed — same data, different order.
    const b = Object.fromEntries(Object.entries(a).reverse()) as BacktestConfig;
    expect(backtestConfigEquals(a, b)).toBe(true);
  });

  it("treats an absent optional flag as its default", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), longEnabled: undefined };
    expect(backtestConfigEquals(a, b)).toBe(true);
  });

  it("sees a genuine difference in the range", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), range: { ...a.range, bars: 999 } };
    expect(backtestConfigEquals(a, b)).toBe(false);
  });

  it("sees a genuine difference in costs", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), costs: { ...a.costs, spread: 12.5 } };
    expect(backtestConfigEquals(a, b)).toBe(false);
  });

  it("sees a genuine difference in a rule group", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), longEnabled: false };
    expect(backtestConfigEquals(a, b)).toBe(false);
  });
});
```

Add `backtestConfigEquals` to the existing import from `./backtestConfig` at the top of that test file. If `range.bars` or `costs.spread` is not a field on the current types, `npx tsc -b` will say so — substitute the nearest scalar field on that object and keep the test's intent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- backtestConfig`
Expected: FAIL — `backtestConfigEquals is not a function` / not exported.

- [ ] **Step 3: Implement**

Append to `frontend/src/lib/backtestConfig.ts`:

```ts
/** Stable stringify: object keys are emitted sorted at every depth, and
 * `undefined` members are dropped, so two configs holding the same data compare
 * equal regardless of the order React state updates happened to build them in.
 * Arrays keep their order — rule order is meaningful. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Whether two configs describe the same strategy. Both sides are normalized
 * first, so an absent optional flag and its filled-in default compare equal —
 * that matters because a stored preset is normalized on read while the live
 * panel config may still carry the absent field. Backs the Presets tab's dirty
 * indicator. */
export function backtestConfigEquals(a: BacktestConfig, b: BacktestConfig): boolean {
  return canonical(normalizeBacktestConfig(a)) === canonical(normalizeBacktestConfig(b));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- backtestConfig`
Expected: PASS, all five new cases green.

If "treats an absent optional flag as its default" fails, `normalizeBacktestConfig` does not fill that particular flag. Do **not** special-case it in `canonical` — instead change the test to use a flag normalize does fill, and note in the test which one.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts
git commit -m "feat(backtest): canonical backtestConfigEquals for preset dirty state"
```

---

### Task 2: v3 preset storage and serialization

**Files:**
- Create: `frontend/src/lib/backtestPresets.ts`
- Test: `frontend/src/lib/backtestPresets.test.ts`

**Interfaces:**
- Consumes: `normalizeBacktestConfig`, `BacktestConfig` from `./backtestConfig`; `load` / `save` from `./persist/core` (check the actual module path used by `persist/defaults.ts` — copy its import line).
- Produces:

```ts
export type PresetRun = {
  at: number; symbol: string; timeframe: string;
  netPnl: number; trades: number; winRate: number; maxDd: number;
};
export type BacktestPreset = {
  name: string; cfg: BacktestConfig; createdAt: number; updatedAt: number;
  origin?: { symbol: string; timeframe: string };
  lastRun?: PresetRun;
};
export function loadPresets(): Record<string, BacktestPreset>;
export function putPreset(preset: BacktestPreset): void;
export function renamePreset(from: string, to: string): void;
export function deletePreset(name: string): void;
export function newPreset(name: string, cfg: BacktestConfig, origin: { symbol: string; timeframe: string }, now: number): BacktestPreset;
export function serializePresets(list: BacktestPreset[]): string;
export function parsePresets(json: string): { presets: BacktestPreset[]; rejected: number };
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/backtestPresets.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import {
  loadPresets, putPreset, renamePreset, deletePreset, newPreset,
  serializePresets, parsePresets, type BacktestPreset,
} from "./backtestPresets";
import { defaultBacktestConfig } from "./backtestConfig";

const ORIGIN = { symbol: "TEST", timeframe: "MINUTE" };
const make = (name: string): BacktestPreset =>
  newPreset(name, defaultBacktestConfig(), ORIGIN, 1000);

beforeEach(() => localStorage.clear());

describe("backtestPresets storage", () => {
  it("round-trips a saved preset", () => {
    putPreset(make("Momentum"));
    const all = loadPresets();
    expect(Object.keys(all)).toEqual(["Momentum"]);
    expect(all.Momentum.origin).toEqual(ORIGIN);
    expect(all.Momentum.createdAt).toBe(1000);
  });

  it("renames without losing metadata", () => {
    const p = { ...make("Old"), lastRun: { at: 5, symbol: "TEST", timeframe: "MINUTE", netPnl: 10, trades: 3, winRate: 0.5, maxDd: 2 } };
    putPreset(p);
    renamePreset("Old", "New");
    const all = loadPresets();
    expect(Object.keys(all)).toEqual(["New"]);
    expect(all.New.name).toBe("New");
    expect(all.New.lastRun?.netPnl).toBe(10);
  });

  it("deletes", () => {
    putPreset(make("Gone"));
    deletePreset("Gone");
    expect(loadPresets()).toEqual({});
  });

  it("ignores the abandoned v2 key", () => {
    localStorage.setItem(
      "at.backtestPresets.v2",
      JSON.stringify({ Legacy: defaultBacktestConfig() }),
    );
    expect(loadPresets()).toEqual({});
  });
});

describe("backtestPresets serialization", () => {
  it("round-trips through export and import", () => {
    const p = make("Momentum");
    const { presets, rejected } = parsePresets(serializePresets([p]));
    expect(rejected).toBe(0);
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe("Momentum");
  });

  it("keeps lastRun through the round trip", () => {
    const p = { ...make("Momentum"), lastRun: { at: 5, symbol: "TEST", timeframe: "MINUTE", netPnl: -3, trades: 1, winRate: 0, maxDd: 4 } };
    const { presets } = parsePresets(serializePresets([p]));
    expect(presets[0].lastRun?.netPnl).toBe(-3);
  });

  it("counts entries it cannot use instead of throwing", () => {
    const good = make("Good");
    const json = JSON.stringify({ version: 3, presets: [good, { name: "Bad" }, 42] });
    const { presets, rejected } = parsePresets(json);
    expect(presets.map((p) => p.name)).toEqual(["Good"]);
    expect(rejected).toBe(2);
  });

  it("reports malformed JSON as fully rejected", () => {
    const { presets, rejected } = parsePresets("not json at all");
    expect(presets).toEqual([]);
    expect(rejected).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- backtestPresets`
Expected: FAIL — cannot resolve `./backtestPresets`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/backtestPresets.ts`:

```ts
// Named backtest presets (global, not per-symbol — a strategy you built is
// useful on any chart). v3 wraps the config in an envelope carrying metadata:
// when it was saved, which chart it was built on, and the summary of its last
// CLEAN run, so the Presets tab can show a comparison table instead of a list
// of bare names.
//
// v2 (a plain Record<name, BacktestConfig>) is abandoned, not migrated — the
// same call v2 made about v1. Nothing here ever reads the v2 key.
import { load, save } from "./persist/core";
import { normalizeBacktestConfig, type BacktestConfig } from "./backtestConfig";

/** The summary of one completed single backtest, as shown in the library table. */
export type PresetRun = {
  at: number;
  symbol: string;
  timeframe: string;
  netPnl: number;
  trades: number;
  winRate: number; // 0..1, as the backend reports it
  maxDd: number;
};

export type BacktestPreset = {
  /** Duplicated from the record key so an exported file round-trips standalone. */
  name: string;
  cfg: BacktestConfig;
  createdAt: number;
  updatedAt: number;
  /** The chart this was saved from. Optional because an imported or
   *  hand-edited file may not carry one. */
  origin?: { symbol: string; timeframe: string };
  lastRun?: PresetRun;
};

const PREFIX = "at";
const KEY = `${PREFIX}.backtestPresets.v3`;

export function newPreset(
  name: string,
  cfg: BacktestConfig,
  origin: { symbol: string; timeframe: string },
  now: number,
): BacktestPreset {
  return { name, cfg, createdAt: now, updatedAt: now, origin };
}

export function loadPresets(): Record<string, BacktestPreset> {
  const all = load<Record<string, BacktestPreset>>(KEY, {});
  // Config shape drift is still folded forward inside the envelope — the
  // envelope itself is metadata only and never needed normalizing.
  return Object.fromEntries(
    Object.entries(all).map(([name, p]) => [
      name,
      { ...p, name, cfg: normalizeBacktestConfig(p.cfg) },
    ]),
  );
}

export function putPreset(preset: BacktestPreset): void {
  const all = loadPresets();
  all[preset.name] = preset;
  save(KEY, all);
}

export function renamePreset(from: string, to: string): void {
  const all = loadPresets();
  const p = all[from];
  if (!p || from === to) return;
  delete all[from];
  all[to] = { ...p, name: to };
  save(KEY, all);
}

export function deletePreset(name: string): void {
  const all = loadPresets();
  if (name in all) {
    delete all[name];
    save(KEY, all);
  }
}

type ExportFile = { version: 3; presets: BacktestPreset[] };

export function serializePresets(list: BacktestPreset[]): string {
  const file: ExportFile = { version: 3, presets: list };
  return JSON.stringify(file, null, 2);
}

function isPreset(v: unknown): v is BacktestPreset {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<BacktestPreset>;
  return typeof p.name === "string" && p.name.length > 0 && !!p.cfg && typeof p.cfg === "object";
}

/** Parse an exported file, keeping every usable entry and counting the rest.
 * Never throws: import must tell the user what it dropped rather than failing
 * the whole file (or, worse, silently). Malformed JSON counts as one rejection. */
export function parsePresets(json: string): { presets: BacktestPreset[]; rejected: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { presets: [], rejected: 1 };
  }
  const raw = (parsed as Partial<ExportFile>)?.presets;
  if (!Array.isArray(raw)) return { presets: [], rejected: 1 };
  const presets: BacktestPreset[] = [];
  let rejected = 0;
  for (const entry of raw) {
    if (!isPreset(entry)) {
      rejected += 1;
      continue;
    }
    presets.push({
      ...entry,
      cfg: normalizeBacktestConfig(entry.cfg),
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    });
  }
  return { presets, rejected };
}
```

Before running, open `frontend/src/lib/persist/defaults.ts` and copy its exact `load`/`save`/`PREFIX` import and prefix value — if `PREFIX` is exported from a shared module, import it instead of redeclaring it here, and fix the v2-key string in the test to match the real prefix.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- backtestPresets`
Expected: PASS, all nine cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestPresets.ts frontend/src/lib/backtestPresets.test.ts
git commit -m "feat(backtest): v3 preset storage envelope with metadata and import/export"
```

---

### Task 3: PresetsTab — identity bar (Save / Save as / Revert)

**Files:**
- Create: `frontend/src/components/PresetsTab.tsx`
- Test: `frontend/src/components/PresetsTab.test.tsx`

**Interfaces:**
- Consumes: everything Task 2 produced; `backtestConfigEquals` from Task 1; `Tooltip` from `./Tooltip`.
- Produces:

```tsx
export type PresetsTabProps = {
  cfg: BacktestConfig;              // the panel's live config
  onLoad: (cfg: BacktestConfig) => void;  // modal applies applyRiskSync before setState
  activeName: string | null;
  onActiveChange: (name: string | null) => void;
  chartSymbol: string;              // the modal's `epic`
  chartTimeframe: string;           // the modal's `effectiveRes`
  captureRuns: boolean;             // true only in single-backtest mode
  onGoLive: () => void;
};
export default function PresetsTab(props: PresetsTabProps): JSX.Element;
```

Later tasks add the table (Task 4), export/import (Task 5), and run capture (Task 7) to this same component. Build the file so those slot in: keep `presets` in one `useState`, and reload it through a single `refresh()` helper after every mutation.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/PresetsTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { installMemStorage } from "../lib/testMemStorage";
installMemStorage();

import PresetsTab from "./PresetsTab";
import { defaultBacktestConfig, type BacktestConfig } from "../lib/backtestConfig";
import { loadPresets } from "../lib/backtestPresets";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function setup(over: Partial<ComponentProps<typeof PresetsTab>> = {}) {
  const onLoad = vi.fn();
  const onActiveChange = vi.fn();
  const props = {
    cfg: defaultBacktestConfig(),
    onLoad,
    activeName: null as string | null,
    onActiveChange,
    chartSymbol: "TEST",
    chartTimeframe: "MINUTE",
    captureRuns: true,
    onGoLive: vi.fn(),
    ...over,
  };
  const view = render(<PresetsTab {...props} />);
  return { ...view, onLoad, onActiveChange, props };
}

// "Save as…" reveals an inline name field — no window.prompt anywhere.
function saveAs(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
  fireEvent.change(screen.getByPlaceholderText("Strategy name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

const dirtyCfg = (): BacktestConfig => ({ ...defaultBacktestConfig(), longEnabled: false });

describe("PresetsTab identity bar", () => {
  it("shows 'Unsaved strategy' with Save and Revert disabled", () => {
    setup();
    expect(screen.getByText("Unsaved strategy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save as…" }).hasAttribute("disabled")).toBe(false);
  });

  it("Save as… stores the preset and makes it active", () => {
    const { onActiveChange } = setup();
    saveAs("Momentum");
    expect(Object.keys(loadPresets())).toEqual(["Momentum"]);
    expect(loadPresets().Momentum.origin).toEqual({ symbol: "TEST", timeframe: "MINUTE" });
    expect(onActiveChange).toHaveBeenCalledWith("Momentum");
  });
});

describe("PresetsTab dirty state", () => {
  // Save a clean preset, then re-mount with it active and a config to compare
  // against — the component reads storage once on mount, so the remount is what
  // makes the seeded preset visible to it.
  function seeded(cfg: BacktestConfig, activeName = "Momentum") {
    setup();
    saveAs("Momentum");
    cleanup();
    return setup({ activeName, cfg });
  }

  it("is clean right after Save as…", () => {
    setup();
    saveAs("Momentum");
    expect(screen.queryByText("edited")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows 'edited' and enables Save once the config diverges", () => {
    seeded(dirtyCfg());
    expect(screen.getByText("edited")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("Save writes the current config and clears the edited flag", () => {
    seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(screen.queryByText("edited")).toBeNull();
  });

  it("Revert asks first, then hands the saved config back", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onLoad } = seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onLoad).toHaveBeenCalled();
    expect(onLoad.mock.calls[0][0].longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });

  it("Revert does nothing when the confirm is declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onLoad } = seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onLoad).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Save as… onto an existing name confirms, and cancelling leaves it alone", () => {
    setup();
    saveAs("Momentum");
    cleanup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    setup({ cfg: dirtyCfg() });
    saveAs("Momentum");
    expect(loadPresets().Momentum.cfg.longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });
});

describe("PresetsTab go live", () => {
  it("calls onGoLive with no argument", () => {
    const onGoLive = vi.fn();
    setup({ onGoLive });
    fireEvent.click(screen.getByRole("button", { name: /Go live/ }));
    expect(onGoLive).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- PresetsTab`
Expected: FAIL — cannot resolve `./PresetsTab`.

- [ ] **Step 3: Implement**

Create `frontend/src/components/PresetsTab.tsx`:

```tsx
// The backtest panel's Presets tab. Owns one ACTIVE preset: Save updates it in
// place, Save as… creates a new one, Revert throws away the panel's edits. The
// dirty dot compares the live config against the stored one canonically, so a
// reordered state update never reads as an edit.
//
// Preset identity deliberately lives here and not in the panel header — the
// header belongs to the overlay/auto-hide work.
import { useState } from "react";
import Tooltip from "./Tooltip";
import { backtestConfigEquals, type BacktestConfig } from "../lib/backtestConfig";
import {
  loadPresets, putPreset, newPreset,
  type BacktestPreset,
} from "../lib/backtestPresets";

export type PresetsTabProps = {
  cfg: BacktestConfig;
  onLoad: (cfg: BacktestConfig) => void;
  activeName: string | null;
  onActiveChange: (name: string | null) => void;
  chartSymbol: string;
  chartTimeframe: string;
  captureRuns: boolean;
  onGoLive: () => void;
};

export default function PresetsTab({
  cfg, onLoad, activeName, onActiveChange, chartSymbol, chartTimeframe, onGoLive,
}: PresetsTabProps) {
  const [presets, setPresets] = useState<Record<string, BacktestPreset>>(() => loadPresets());
  const refresh = () => setPresets(loadPresets());
  // Naming is inline, never window.prompt: the panel is already a surface, and
  // a browser prompt cannot be styled, tested, or cancelled predictably.
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const active = activeName ? presets[activeName] : undefined;
  const dirty = !!active && !backtestConfigEquals(cfg, active.cfg);
  const origin = { symbol: chartSymbol, timeframe: chartTimeframe };

  function save() {
    if (!active) return;
    putPreset({ ...active, cfg, updatedAt: Date.now() });
    refresh();
  }

  function createNamed() {
    const name = draftName.trim();
    if (!name) return;
    if (presets[name] && !window.confirm(`Replace the saved preset "${name}"?`)) return;
    const existing = presets[name];
    putPreset(
      existing
        ? { ...existing, cfg, updatedAt: Date.now(), origin }
        : newPreset(name, cfg, origin, Date.now()),
    );
    refresh();
    setNaming(false);
    setDraftName("");
    onActiveChange(name);
  }

  function revert() {
    if (!active || !dirty) return;
    if (!window.confirm(`Discard your changes to "${active.name}"?`)) return;
    onLoad(active.cfg);
  }

  return (
    <div className="bt-presets">
      <div className="bt-preset-bar">
        <span className="bt-preset-id">
          {active ? (
            <>
              <span className={`bt-preset-dot${dirty ? " dirty" : ""}`} aria-hidden="true" />
              <span className="bt-preset-name">{active.name}</span>
              {dirty && <span className="bt-preset-edited">edited</span>}
            </>
          ) : (
            <span className="bt-preset-name muted">Unsaved strategy</span>
          )}
        </span>
        <span className="bt-preset-actions">
          <button className="ghost" onClick={save} disabled={!active || !dirty}>
            Save
          </button>
          <button className="ghost" onClick={() => setNaming(true)}>
            Save as…
          </button>
          <button className="ghost" onClick={revert} disabled={!dirty}>
            Revert
          </button>
        </span>
      </div>

      {naming && (
        <div className="bt-preset-naming">
          <input
            autoFocus
            value={draftName}
            placeholder="Strategy name"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createNamed();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button className="ghost" onClick={createNamed} disabled={!draftName.trim()}>
            Create
          </button>
          <button className="ghost" onClick={() => { setNaming(false); setDraftName(""); }}>
            Cancel
          </button>
        </div>
      )}

      {/* Go live acts on the CURRENT config, not on any preset — its own row,
          deliberately not folded into a preset's actions. */}
      <div className="bt-preset-golive">
        <span>Live</span>
        <Tooltip content="Copy this strategy into the Live panel to trade a demo/live account">
          <button className="ghost bt-golive" onClick={onGoLive}>
            Go live →
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- PresetsTab`
Expected: PASS. Then `npx tsc -b` — expect no errors (the component is not yet imported anywhere).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PresetsTab.tsx frontend/src/components/PresetsTab.test.tsx
git commit -m "feat(backtest): PresetsTab identity bar with Save/Save as/Revert"
```

---

### Task 4: PresetsTab — the library table

**Files:**
- Modify: `frontend/src/components/PresetsTab.tsx`
- Modify: `frontend/src/components/PresetsTab.test.tsx`
- Modify: `frontend/src/App.css` (replace the `.bt-presets` block at lines 1749–1759)

**Interfaces:**
- Consumes: `loadPresets`, `putPreset`, `renamePreset`, `deletePreset` from `../lib/backtestPresets`.
- Produces: no new exports — the table is internal to `PresetsTab`.

Columns, in order: **Name · Symbol/TF · Net P&L · Trades · Win% · Max DD · Modified**, then a `⋯` actions cell. Default sort: Modified, descending. Result cells read `—` when `lastRun` is absent.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/PresetsTab.test.tsx`:

```tsx
import { putPreset, newPreset } from "../lib/backtestPresets";

function seedPreset(name: string, over: Partial<import("../lib/backtestPresets").BacktestPreset> = {}) {
  putPreset({
    ...newPreset(name, defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 1000),
    ...over,
  });
}

const run = (netPnl: number, over = {}) => ({
  at: 2000, symbol: "TEST", timeframe: "MINUTE",
  netPnl, trades: 4, winRate: 0.5, maxDd: 7, ...over,
});

function rowNames(): string[] {
  return [...document.querySelectorAll(".bt-preset-row .bt-preset-cell-name")].map(
    (el) => el.textContent ?? "",
  );
}

describe("PresetsTab library table", () => {
  it("shows an empty state instead of a dead dropdown", () => {
    setup();
    expect(screen.getByText(/No saved strategies yet/)).toBeTruthy();
    expect(document.querySelector(".bt-preset-row")).toBeNull();
  });

  it("renders one row per preset with its last-run summary", () => {
    seedPreset("Momentum", { lastRun: run(123.45) });
    setup();
    const row = document.querySelector(".bt-preset-row") as HTMLElement;
    expect(row.textContent).toContain("Momentum");
    expect(row.textContent).toContain("TEST");
    expect(row.textContent).toContain("123.45");
    expect(row.textContent).toContain("50%");
  });

  it("shows dashes for a preset that never recorded a run", () => {
    seedPreset("Fresh");
    setup();
    const row = document.querySelector(".bt-preset-row") as HTMLElement;
    expect(row.textContent).toContain("—");
  });

  it("filters by name", () => {
    seedPreset("Momentum");
    seedPreset("Mean reversion");
    setup();
    fireEvent.change(screen.getByPlaceholderText("Filter…"), { target: { value: "mean" } });
    expect(rowNames()).toEqual(["Mean reversion"]);
  });

  it("sorts by net P&L when that header is clicked", () => {
    seedPreset("Loser", { lastRun: run(-50) });
    seedPreset("Winner", { lastRun: run(200) });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Net P&L" }));
    expect(rowNames()).toEqual(["Winner", "Loser"]);
    fireEvent.click(screen.getByRole("button", { name: "Net P&L" }));
    expect(rowNames()).toEqual(["Loser", "Winner"]);
  });

  it("marks a preset built on a different chart", () => {
    seedPreset("Daily thing", { origin: { symbol: "OTHER", timeframe: "DAY" } });
    setup();
    expect(document.querySelector(".bt-preset-mismatch")).not.toBeNull();
  });

  it("does not mark a preset matching the current chart", () => {
    seedPreset("Same chart");
    setup();
    expect(document.querySelector(".bt-preset-mismatch")).toBeNull();
  });
});

describe("PresetsTab row actions", () => {
  function openMenu(name: string) {
    const row = [...document.querySelectorAll(".bt-preset-row")].find((r) =>
      r.textContent?.includes(name),
    ) as HTMLElement;
    fireEvent.click(row.querySelector(".bt-preset-menu-btn") as HTMLElement);
  }

  it("Load hands the stored config back and sets it active", () => {
    seedPreset("Momentum", { cfg: { ...defaultBacktestConfig(), longEnabled: false } });
    const { onLoad, onActiveChange } = setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad.mock.calls[0][0].longEnabled).toBe(false);
    expect(onActiveChange).toHaveBeenCalledWith("Momentum");
  });

  it("Load while dirty offers Save & load / Discard & load / Cancel", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save & load" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard & load" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("Save & load writes the edits before switching", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad, onActiveChange } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & load" }));
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(onLoad).toHaveBeenCalled();
    expect(onActiveChange).toHaveBeenCalledWith("Other");
  });

  it("Discard & load switches without writing", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard & load" }));
    expect(loadPresets().Momentum.cfg.longEnabled).not.toBe(false);
    expect(onLoad).toHaveBeenCalled();
  });

  it("Duplicate creates a copy", () => {
    seedPreset("Momentum");
    setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(Object.keys(loadPresets()).sort()).toEqual(["Momentum", "Momentum copy"]);
  });

  it("Rename keeps the metadata and moves the active pointer", () => {
    seedPreset("Old", { lastRun: run(10) });
    const { onActiveChange } = setup({ activeName: "Old" });
    openMenu("Old");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByPlaceholderText("Strategy name"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(loadPresets().New.lastRun?.netPnl).toBe(10);
    expect(onActiveChange).toHaveBeenCalledWith("New");
  });

  it("Delete confirms, and clears the active pointer when it was active", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    seedPreset("Momentum");
    const { onActiveChange } = setup({ activeName: "Momentum" });
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(loadPresets()).toEqual({});
    expect(onActiveChange).toHaveBeenCalledWith(null);
    confirmSpy.mockRestore();
  });

  it("Delete leaves the preset alone when the confirm is declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    seedPreset("Momentum");
    setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(Object.keys(loadPresets())).toEqual(["Momentum"]);
    confirmSpy.mockRestore();
  });
});
```

The Rename case clicks a button named "Rename" twice — the menu item, then the confirm button of the inline field. Reuse the Task 3 naming row for renaming (same `naming`/`draftName` state, a `namingMode: "create" | "rename"` discriminator) so the field, placeholder, and Escape handling stay in one place; the confirm button's label is "Create" in create mode and "Rename" in rename mode.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- PresetsTab`
Expected: FAIL — no `.bt-preset-row` elements, no "Filter…" input.

- [ ] **Step 3: Implement**

In `PresetsTab.tsx`, extend the imports:

```tsx
import { useMemo, useState } from "react";
import {
  loadPresets, putPreset, renamePreset, deletePreset, newPreset,
  type BacktestPreset,
} from "../lib/backtestPresets";
```

Add above the component:

```tsx
type SortKey = "name" | "origin" | "netPnl" | "trades" | "winRate" | "maxDd" | "updatedAt";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "origin", label: "Symbol/TF" },
  { key: "netPnl", label: "Net P&L" },
  { key: "trades", label: "Trades" },
  { key: "winRate", label: "Win%" },
  { key: "maxDd", label: "Max DD" },
  { key: "updatedAt", label: "Modified" },
];

// Text sorts A→Z on first click; numbers and dates most-significant-first,
// matching BacktestPanel's trade table.
const TEXT_KEYS: SortKey[] = ["name", "origin"];
const defaultDir = (key: SortKey): SortDir => (TEXT_KEYS.includes(key) ? "asc" : "desc");

const DASH = "—";
const fmtMoney = (n: number | undefined): string =>
  n == null ? DASH : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const fmtPct = (n: number | undefined): string =>
  n == null ? DASH : `${Math.round(n * 100)}%`;
const fmtNum = (n: number | undefined): string => (n == null ? DASH : String(n));
const fmtDd = (n: number | undefined): string => (n == null ? DASH : n.toFixed(2));
const fmtDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : DASH;
const originLabel = (p: BacktestPreset): string =>
  p.origin ? `${p.origin.symbol} · ${p.origin.timeframe}` : DASH;

function sortValue(p: BacktestPreset, key: SortKey): string | number {
  switch (key) {
    case "name": return p.name.toLowerCase();
    case "origin": return originLabel(p).toLowerCase();
    case "updatedAt": return p.updatedAt;
    // A preset with no recorded run sorts to the bottom of every result column
    // in either direction would be nicer, but it costs a second comparator —
    // -Infinity keeps it at the bottom descending, which is the default view.
    case "netPnl": return p.lastRun?.netPnl ?? -Infinity;
    case "trades": return p.lastRun?.trades ?? -Infinity;
    case "winRate": return p.lastRun?.winRate ?? -Infinity;
    case "maxDd": return p.lastRun?.maxDd ?? -Infinity;
  }
}
```

Inside the component, add state and the derived rows:

```tsx
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [namingMode, setNamingMode] = useState<"create" | "rename">("create");
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  // A load blocked on unsaved edits: the target preset, awaiting the user's
  // three-way answer. Null when no such prompt is up.
  const [pendingLoad, setPendingLoad] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = Object.values(presets).filter((p) => !q || p.name.toLowerCase().includes(q));
    const dir = sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === bv) return a.name.localeCompare(b.name);
      return av < bv ? -dir : dir;
    });
  }, [presets, filter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(defaultDir(key)); }
  }

  function doLoad(name: string) {
    const p = presets[name];
    if (!p) return;
    setPendingLoad(null);
    setMenuFor(null);
    onLoad(p.cfg);
    onActiveChange(name);
  }

  function requestLoad(name: string) {
    setMenuFor(null);
    if (dirty) setPendingLoad(name);
    else doLoad(name);
  }

  function duplicate(name: string) {
    const p = presets[name];
    if (!p) return;
    let copy = `${name} copy`;
    for (let i = 2; presets[copy]; i += 1) copy = `${name} copy ${i}`;
    putPreset({ ...p, name: copy, createdAt: Date.now(), updatedAt: Date.now() });
    refresh();
    setMenuFor(null);
  }

  function startRename(name: string) {
    setMenuFor(null);
    setNamingMode("rename");
    setRenameFrom(name);
    setDraftName(name);
    setNaming(true);
  }

  function commitRename() {
    const to = draftName.trim();
    if (!renameFrom || !to || to === renameFrom) { setNaming(false); return; }
    if (presets[to] && !window.confirm(`Replace the saved preset "${to}"?`)) return;
    renamePreset(renameFrom, to);
    refresh();
    setNaming(false);
    setDraftName("");
    if (activeName === renameFrom) onActiveChange(to);
    setRenameFrom(null);
  }

  function remove(name: string) {
    setMenuFor(null);
    if (!window.confirm(`Delete the preset "${name}"?`)) return;
    deletePreset(name);
    refresh();
    if (activeName === name) onActiveChange(null);
  }
```

Change the `Save as…` button's handler to `() => { setNamingMode("create"); setDraftName(""); setNaming(true); }`, and make the naming row's confirm button dispatch on mode:

```tsx
          <button
            className="ghost"
            onClick={namingMode === "rename" ? commitRename : createNamed}
            disabled={!draftName.trim()}
          >
            {namingMode === "rename" ? "Rename" : "Create"}
          </button>
```

Render the three-way load prompt and the table between the naming row and the Go live row:

```tsx
      {pendingLoad && (
        <div className="bt-preset-prompt">
          <span>
            “{activeName}” has unsaved changes.
          </span>
          <button className="ghost" onClick={() => { save(); doLoad(pendingLoad); }}>
            Save &amp; load
          </button>
          <button className="ghost" onClick={() => doLoad(pendingLoad)}>
            Discard &amp; load
          </button>
          <button className="ghost" onClick={() => setPendingLoad(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="bt-preset-library">
        <input
          className="bt-preset-filter"
          value={filter}
          placeholder="Filter…"
          onChange={(e) => setFilter(e.target.value)}
        />
        {rows.length === 0 ? (
          <div className="bt-preset-empty">
            {Object.keys(presets).length === 0
              ? "No saved strategies yet — configure a strategy and press Save as…"
              : "No preset matches this filter."}
          </div>
        ) : (
          <div className="bt-preset-table" role="table">
            <div className="bt-preset-head" role="row">
              {COLUMNS.map((c) => (
                <button
                  key={c.key}
                  className={`bt-preset-th${sortKey === c.key ? " sorted" : ""}`}
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label}
                </button>
              ))}
              <span className="bt-preset-th spacer" />
            </div>
            {rows.map((p) => {
              const mismatch =
                !!p.origin &&
                (p.origin.symbol !== chartSymbol || p.origin.timeframe !== chartTimeframe);
              return (
                <div
                  key={p.name}
                  role="row"
                  className={`bt-preset-row${p.name === activeName ? " active" : ""}`}
                >
                  <span className="bt-preset-cell-name">{p.name}</span>
                  <span className={`bt-preset-cell${mismatch ? " bt-preset-mismatch" : ""}`}>
                    {mismatch ? (
                      <Tooltip content="Built on a different chart than the one you're on">
                        <span>{originLabel(p)}</span>
                      </Tooltip>
                    ) : (
                      originLabel(p)
                    )}
                  </span>
                  <span className="bt-preset-cell num">{fmtMoney(p.lastRun?.netPnl)}</span>
                  <span className="bt-preset-cell num">{fmtNum(p.lastRun?.trades)}</span>
                  <span className="bt-preset-cell num">{fmtPct(p.lastRun?.winRate)}</span>
                  <span className="bt-preset-cell num">{fmtDd(p.lastRun?.maxDd)}</span>
                  <span className="bt-preset-cell">{fmtDate(p.updatedAt)}</span>
                  <span className="bt-preset-cell actions">
                    <button
                      className="ghost bt-preset-menu-btn"
                      aria-label={`Actions for ${p.name}`}
                      onClick={() => setMenuFor(menuFor === p.name ? null : p.name)}
                    >
                      ⋯
                    </button>
                    {menuFor === p.name && (
                      <span className="bt-preset-menu">
                        <button className="ghost" onClick={() => requestLoad(p.name)}>Load</button>
                        <button className="ghost" onClick={() => duplicate(p.name)}>Duplicate</button>
                        <button className="ghost" onClick={() => startRename(p.name)}>Rename</button>
                        <button className="ghost" onClick={() => remove(p.name)}>Delete</button>
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- PresetsTab`
Expected: PASS, including the Task 3 cases.

The Rename test clicks `{ name: "Rename" }` while both the menu item and the confirm button could match. If it fails as ambiguous, close the menu on `startRename` (already done above) — if it still matches two nodes, give the menu item `aria-label="Rename preset"` and update the test's first click to that name.

- [ ] **Step 5: Style the tab**

In `frontend/src/App.css`, replace the block at lines 1749–1759 (from the `/* Presets: Save-as and Load share one line… */` comment through the `.bt-presets-golive` rule) with:

```css
/* Presets: an identity bar over a library table. The bar names the preset you
   are editing and whether it diverged; the table is the strategy comparison. */
.bt-presets { display: flex; flex-direction: column; gap: 12px; }
.bt-preset-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bt-preset-id { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bt-preset-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-preset-name.muted { font-weight: 400; color: var(--muted); }
.bt-preset-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.bt-preset-dot.dirty { background: var(--warn, #d08700); }
.bt-preset-edited { font-size: 11px; color: var(--muted); }
.bt-preset-actions { display: flex; gap: 6px; flex: none; }
.bt-preset-naming, .bt-preset-prompt { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.bt-preset-naming > input { flex: 1 1 180px; min-width: 0; }
.bt-preset-prompt > span { flex: 1 1 100%; font-size: 12px; color: var(--muted); }
.bt-preset-library { display: flex; flex-direction: column; gap: 8px; }
.bt-preset-filter { width: 100%; }
.bt-preset-empty { padding: 14px 0; font-size: 12px; color: var(--muted); }
/* 7 columns + the actions cell. Name flexes; the rest size to content. */
.bt-preset-head, .bt-preset-row {
  display: grid;
  grid-template-columns: minmax(80px, 1.6fr) minmax(70px, 1fr) repeat(4, minmax(52px, auto)) minmax(52px, auto) 28px;
  align-items: center; gap: 8px;
}
.bt-preset-head { border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.bt-preset-th {
  background: none; border: 0; padding: 0; text-align: left; cursor: pointer;
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
}
.bt-preset-th.sorted { color: var(--text); }
.bt-preset-row { padding: 5px 0; border-bottom: 1px solid var(--border-faint, var(--border)); font-size: 12px; }
.bt-preset-row.active { background: var(--hover, rgba(127,127,127,.08)); }
.bt-preset-cell, .bt-preset-cell-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-preset-cell.num { text-align: right; font-variant-numeric: tabular-nums; }
.bt-preset-mismatch { color: var(--muted); font-style: italic; }
.bt-preset-cell.actions { position: relative; text-align: right; }
.bt-preset-menu {
  position: absolute; right: 0; top: 100%; z-index: 5;
  display: flex; flex-direction: column; align-items: stretch;
  background: var(--panel, var(--bg)); border: 1px solid var(--border); border-radius: 6px;
}
.bt-preset-menu > button { text-align: left; white-space: nowrap; }
/* Go live acts on the current config, not on any preset, so it keeps its own
   row below the library rather than becoming a row action. */
.bt-preset-golive { display: flex; align-items: center; gap: 10px; }
```

Check the CSS variables against neighbouring rules in `App.css` and substitute the project's actual names where a fallback is guessed (`--warn`, `--panel`, `--hover`, `--border-faint`, `--text`, `--muted`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PresetsTab.tsx frontend/src/components/PresetsTab.test.tsx frontend/src/App.css
git commit -m "feat(backtest): searchable preset library table with row actions"
```

---

### Task 5: PresetsTab — export and import

**Files:**
- Modify: `frontend/src/components/PresetsTab.tsx`
- Modify: `frontend/src/components/PresetsTab.test.tsx`

**Interfaces:**
- Consumes: `serializePresets`, `parsePresets` from `../lib/backtestPresets` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/PresetsTab.test.tsx`:

```tsx
import { serializePresets } from "../lib/backtestPresets";
// `newPreset`, `seedPreset`, `loadPresets`, `setup` and `dirtyCfg` are already
// in scope from the Task 2–4 blocks above in this same file.

// The file input is read through File.text(); jsdom's File does not implement
// it in every version, so stub the method on the instance we hand to the input.
function fakeFile(contents: string): File {
  const f = new File([contents], "presets.json", { type: "application/json" });
  Object.defineProperty(f, "text", { value: () => Promise.resolve(contents) });
  return f;
}

describe("PresetsTab import", () => {
  it("adds presets from a valid file", async () => {
    setup();
    const json = serializePresets([
      newPreset("Imported", defaultBacktestConfig(), { symbol: "OTHER", timeframe: "HOUR" }, 500),
    ]);
    const input = document.querySelector(".bt-preset-import-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fakeFile(json)] } });
    await screen.findByText("Imported");
    expect(Object.keys(loadPresets())).toEqual(["Imported"]);
  });

  it("reports what it rejected and leaves good entries in place", async () => {
    setup();
    const json = JSON.stringify({ version: 3, presets: [{ name: "Bad" }] });
    const input = document.querySelector(".bt-preset-import-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fakeFile(json)] } });
    await screen.findByText(/Skipped 1/);
    expect(loadPresets()).toEqual({});
  });

  it("confirms before overwriting an existing name", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    seedPreset("Momentum");
    setup();
    const json = serializePresets([
      newPreset("Momentum", { ...defaultBacktestConfig(), longEnabled: false }, { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    const input = document.querySelector(".bt-preset-import-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fakeFile(json)] } });
    await screen.findByText(/Imported 0/);
    expect(loadPresets().Momentum.cfg.longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- PresetsTab`
Expected: FAIL — no `.bt-preset-import-input` element.

- [ ] **Step 3: Implement**

Add to the imports in `PresetsTab.tsx`:

```tsx
import { useRef } from "react";
import { serializePresets, parsePresets } from "../lib/backtestPresets";
```

Add state and handlers inside the component:

```tsx
  const fileRef = useRef<HTMLInputElement | null>(null);
  // One-line result of the last import, so a partially-bad file says what it
  // dropped instead of failing silently.
  const [importNote, setImportNote] = useState<string | null>(null);

  function download(filename: string, json: string) {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportOne(name: string) {
    const p = presets[name];
    if (!p) return;
    setMenuFor(null);
    download(`${name}.json`, serializePresets([p]));
  }

  function exportAll() {
    download("backtest-presets.json", serializePresets(Object.values(presets)));
  }

  async function importFile(file: File) {
    const { presets: incoming, rejected } = parsePresets(await file.text());
    const existing = loadPresets();
    let added = 0;
    let skipped = rejected;
    for (const p of incoming) {
      if (existing[p.name] && !window.confirm(`Replace the saved preset "${p.name}"?`)) {
        skipped += 1;
        continue;
      }
      putPreset(p);
      added += 1;
    }
    refresh();
    setImportNote(`Imported ${added}${skipped ? ` · Skipped ${skipped}` : ""}`);
  }
```

Add an `Export` item to the row menu, next to Delete:

```tsx
                        <button className="ghost" onClick={() => exportOne(p.name)}>Export</button>
```

And render the footer inside `.bt-preset-library`, after the table/empty state:

```tsx
        <div className="bt-preset-footer">
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Import JSON…
          </button>
          <button
            className="ghost"
            onClick={exportAll}
            disabled={Object.keys(presets).length === 0}
          >
            Export all
          </button>
          {importNote && <span className="bt-preset-note">{importNote}</span>}
          <input
            ref={fileRef}
            className="bt-preset-import-input"
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // re-importing the same file must re-fire change
              if (file) void importFile(file);
            }}
          />
        </div>
```

Append to `App.css`, after the `.bt-preset-golive` rule:

```css
.bt-preset-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bt-preset-note { font-size: 11px; color: var(--muted); }
```

Note: the hidden `<input>` uses `hidden`, but the test queries it by class and fires `change` directly, which works regardless of visibility.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- PresetsTab`
Expected: PASS, all cases. jsdom does not implement `HTMLAnchorElement.click()` navigation or `URL.createObjectURL` in every version — if an *export* path is ever exercised by a test and throws, stub `URL.createObjectURL` in that test rather than changing `download`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PresetsTab.tsx frontend/src/components/PresetsTab.test.tsx frontend/src/App.css
git commit -m "feat(backtest): export and import preset JSON"
```

---

### Task 6: Wire PresetsTab into the modal and delete the v2 storage

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (imports at 102–104; state at 371–373; handlers at 1560–1575; markup at 2811–2857)
- Modify: `frontend/src/lib/persist/defaults.ts` (delete `BACKTEST_PRESETS_KEY`, `loadBacktestPresets`, `saveBacktestPreset`, `deleteBacktestPreset` — around lines 118–144)
- Modify: `frontend/src/BacktestSettingsModal.test.tsx` (import at line 68; use at line 463)

**Interfaces:**
- Consumes: `PresetsTab` and its props from Task 3/4/5.
- Produces: the modal holds `activePreset: string | null` and passes it down. `loadBacktestLastUsed` / `saveBacktestLastUsed` in `persist/defaults.ts` are untouched.

- [ ] **Step 1: Update the existing modal test that used the v2 API**

In `frontend/src/BacktestSettingsModal.test.tsx`:

- Change line 68 to `import { loadBacktestLastUsed } from "./lib/persist/defaults";`
- Add `import { putPreset, newPreset } from "./lib/backtestPresets";`
- Replace the call at line 463, `saveBacktestPreset("session-preset", sessionCfg);`, with:

```ts
    putPreset(newPreset("session-preset", sessionCfg, { symbol: "TEST", timeframe: "MINUTE" }, 1000));
```

That test then loads the preset through the UI. Its old path used the `<select>` + Load button, which no longer exist — update it to open the row menu and click Load:

```ts
    const row = [...document.querySelectorAll(".bt-preset-row")].find((r) =>
      r.textContent?.includes("session-preset"),
    ) as HTMLElement;
    fireEvent.click(row.querySelector(".bt-preset-menu-btn") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
```

Read the surrounding test first (`frontend/src/BacktestSettingsModal.test.tsx:454-480`) and keep its assertions unchanged — only the mechanics of loading change.

- [ ] **Step 2: Run the modal tests to verify the failure is the expected one**

Run: `npm run test:unit -- BacktestSettingsModal`
Expected: FAIL — the updated test cannot find `.bt-preset-row` (the modal still renders the old UI). Other modal tests still pass.

- [ ] **Step 3: Swap the markup and state in the modal**

Replace the imports at `BacktestSettingsModal.tsx:102-104` (`loadBacktestPresets`, `saveBacktestPreset`, `deleteBacktestPreset`) — delete those three lines and add, with the other component imports near line 73:

```tsx
import PresetsTab from "./components/PresetsTab";
```

Replace the state at lines 371–373:

```tsx
  const [presets, setPresets] = useState(() => loadBacktestPresets());
  const [presetName, setPresetName] = useState("");
  const [loadName, setLoadName] = useState("");
```

with:

```tsx
  // Which saved preset the panel is editing. Not persisted across opens — a
  // fresh open starts from the last-used config with no active preset.
  const [activePreset, setActivePreset] = useState<string | null>(null);
```

Delete `savePreset`, `applyPreset`, and `removePreset` (lines 1560–1575) entirely.

Replace the whole `<div className="bt-presets">…</div>` block inside the Presets `<Section>` (lines 2816–2856) with:

```tsx
            <PresetsTab
              cfg={cfg}
              onLoad={(next) => setCfg(applyRiskSync(next, side))}
              activeName={activePreset}
              onActiveChange={setActivePreset}
              chartSymbol={epic}
              chartTimeframe={effectiveRes}
              captureRuns={btMode === "backtest"}
              onGoLive={() => requestGoLive(cfg)}
            />
```

Leave the surrounding `<section className="bt-scroll-section" ref={setRef("presets")}>` and `<Section title="Presets" info=…>` exactly as they are — the scroll-spy depends on them.

`effectiveRes` is declared at line 1328, well above the render, so it is in scope. `btMode` is the existing Backtest/Sweep/Walk-fwd mode state; confirm its variable name by grepping `btMode ===` before using it.

- [ ] **Step 4: Delete the v2 storage functions**

In `frontend/src/lib/persist/defaults.ts`, delete `BACKTEST_PRESETS_KEY`, `loadBacktestPresets`, `saveBacktestPreset`, and `deleteBacktestPreset`, and update the section comment above them to say presets moved to `lib/backtestPresets.ts` (v3) and that the v2 key is abandoned. Keep `BACKTEST_LAST_USED_KEY`, `loadBacktestLastUsed`, and `saveBacktestLastUsed`.

- [ ] **Step 5: Run everything**

```bash
npx tsc -b && npm run lint && npm run test:unit
```

Expected: types clean, lint clean, all tests pass. `tsc` is the check that nothing else imported the deleted functions — the barrel `persist.ts` re-exports `./persist/defaults` with `export *`, so a stale importer surfaces here.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx frontend/src/lib/persist/defaults.ts
git commit -m "feat(backtest): render PresetsTab in the modal, drop v2 preset storage"
```

---

### Task 7: Record the last clean run on the active preset

**Files:**
- Modify: `frontend/src/components/PresetsTab.tsx`
- Modify: `frontend/src/components/PresetsTab.test.tsx`

**Interfaces:**
- Consumes: `backtestResultSignal` from `../lib/signals` (a `Signal<StoredBacktestResult | null>` with `.value`, `.set()`, `.subscribe()`); `result.summary` provides `net_pnl`, `n_trades`, `win_rate`, `max_drawdown`.
- Produces: writes `lastRun` onto the active preset. No new exports.

Rule: record only when `captureRuns` is true, an active preset exists, and the config is **not** dirty. Otherwise the numbers would describe a config the user has since edited.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/PresetsTab.test.tsx`:

```tsx
import { act } from "@testing-library/react";
import { backtestResultSignal } from "../lib/signals";

// Only the fields PresetsTab reads; the rest of StoredBacktestResult is irrelevant here.
const fakeResult = (netPnl: number) =>
  ({
    trades: [],
    summary: { net_pnl: netPnl, n_trades: 4, win_rate: 0.5, max_drawdown: 7 },
  }) as unknown as NonNullable<typeof backtestResultSignal.value>;

describe("PresetsTab run capture", () => {
  beforeEach(() => backtestResultSignal.set(null));

  it("records the summary on a clean active preset", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum" });
    act(() => backtestResultSignal.set(fakeResult(88.5)));
    const run = loadPresets().Momentum.lastRun;
    expect(run?.netPnl).toBe(88.5);
    expect(run?.trades).toBe(4);
    expect(run?.winRate).toBe(0.5);
    expect(run?.maxDd).toBe(7);
    expect(run?.symbol).toBe("TEST");
    expect(run?.timeframe).toBe("MINUTE");
  });

  it("records nothing when the config is dirty", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum", cfg: dirtyCfg() });
    act(() => backtestResultSignal.set(fakeResult(88.5)));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("records nothing when no preset is active", () => {
    seedPreset("Momentum");
    setup();
    act(() => backtestResultSignal.set(fakeResult(88.5)));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("records nothing outside single-backtest mode", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum", captureRuns: false });
    act(() => backtestResultSignal.set(fakeResult(88.5)));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("does not re-record the same result object twice", () => {
    seedPreset("Momentum");
    const r = fakeResult(10);
    setup({ activeName: "Momentum" });
    act(() => backtestResultSignal.set(r));
    const first = loadPresets().Momentum.lastRun?.at;
    act(() => backtestResultSignal.set(r));
    expect(loadPresets().Momentum.lastRun?.at).toBe(first);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- PresetsTab`
Expected: FAIL — `lastRun` stays undefined in the first case.

- [ ] **Step 3: Implement**

Add to `PresetsTab.tsx`:

```tsx
import { useEffect, useRef, useState, useMemo, useSyncExternalStore } from "react";
import { backtestResultSignal } from "../lib/signals";
```

```tsx
// Module-singleton signal — memoize subscribe so the store isn't resubscribed
// on every render (same pattern as BacktestPanel).
const subscribeResult = (cb: () => void) => backtestResultSignal.subscribe(cb);
```

Inside the component:

```tsx
  const result = useSyncExternalStore(subscribeResult, () => backtestResultSignal.value);
  // The result object already folded into a preset. Identity, not a deep
  // compare: BacktestButton publishes a fresh object per run, and a re-publish
  // of the SAME object (a chart switch rehydrating the stored result) is not a
  // new run and must not restamp `at`.
  const recorded = useRef<unknown>(null);

  useEffect(() => {
    if (!result || recorded.current === result) return;
    recorded.current = result;
    if (!captureRuns || !active || dirty) return;
    const s = result.summary;
    putPreset({
      ...active,
      lastRun: {
        at: Date.now(),
        symbol: chartSymbol,
        timeframe: chartTimeframe,
        netPnl: s.net_pnl,
        trades: s.n_trades,
        winRate: s.win_rate,
        maxDd: s.max_drawdown,
      },
    });
    refresh();
    // `active`/`dirty` are read at publish time on purpose — a later edit must
    // not retroactively attach or detach this run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
```

Add `captureRuns` to the destructured props in the function signature.

Note the effect marks `recorded.current` **before** the guards, so a result that arrives while dirty is not recorded later if the user reverts — that run belonged to the edited config, and re-attaching it after a revert would be a lie.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- PresetsTab`
Expected: PASS, all cases including the earlier tasks'.

- [ ] **Step 5: Full verification**

```bash
npx tsc -b && npm run lint && npm run test:unit
```

Expected: all clean. Then run the app (`npm run dev`), open the backtest panel's Presets tab, and confirm by hand: Save as… a strategy, run a backtest, see its row fill with P&L / trades / win% / max DD; edit a rule and see "edited" appear and the next run *not* overwrite the stored numbers.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PresetsTab.tsx frontend/src/components/PresetsTab.test.tsx
git commit -m "feat(backtest): record each preset's last clean run for the library table"
```

---

## Notes for the implementer

- **Do not** add preset identity to the panel header, however tempting. That surface belongs to the overlay/auto-hide design.
- **Do not** migrate the v2 key. Its abandonment is a deliberate, user-confirmed call recorded in the spec.
- The date range is part of `BacktestConfig` and therefore counts toward dirtiness. If that feels noisy while testing by hand, raise it rather than quietly excluding `range` from `backtestConfigEquals` — Save persists the range, so hiding range edits from the indicator would make Save write something the user was never warned about.
