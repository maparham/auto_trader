# Symbol-template Auto-save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-symbol chart templates auto-save in the background (global toggle, ON by default); the Template menu is trimmed to a toggle + Apply; and "Save as default template" becomes a modal that lets the user pick which indicators to save.

**Architecture:** A persist-layer change emitter (`emitLayoutChanged(scope)`) fires from the six per-cell layout writers. A per-cell subscriber in ChartCore debounces those events and, if auto-save is on, captures the symbol template and writes it only when it differs from the stored one (raw deep-equal excluding `savedAt`). The emitter is suppressed inside `applySymbolTemplate` so the merge-apply paths (auto-apply, manual apply, default apply) — the only writers that mint new instance ids — never trigger a save. Mount/symbol-change hydration is read-only for persistence, so no spurious saves occur there. The default-template save is gated behind a new selectable modal wired through a request signal, mirroring `ConfirmDialog`.

**Tech Stack:** TypeScript, React, Vite, Vitest (unit), Playwright (e2e), klinecharts. Frontend root: `frontend/`.

## Global Constraints

- Per-symbol template key: `auto-trader.b.<broker>.template.<epic>` (`SymbolTemplate`). Default template key: `auto-trader.defaultTemplate` (`DefaultTemplate`, indicators only — no drawings/anchors). Both persist via `save()` = localStorage + fire-and-forget backend mirror `PUT /api/state/<key>`. **No new backend endpoint.**
- Auto-save is a single **global** preference `autoSaveTemplates`, default `true` when absent, backend-mirrored (use `save()`, not `saveLocal()`).
- Debounce auto-save ~800ms; skip the write when captured content equals the stored template (compare all of `indicators`/`indicatorConfigs`/`drawings`/`avwapAnchors`, excluding `savedAt`).
- **Empty capture is saved as an empty template, never deleted** (makes "clear the chart to start fresh" open fresh cells blank).
- Do NOT modify additive-merge `applySymbolTemplate` semantics or the `maybeAutoApplyTemplate` fresh-cell gate. No live cross-open-cell mirroring.
- UI copy: plain, standard trading terms OK. Use the shared `Tooltip`/`InfoTip` and existing `modal-backdrop`/`modal` chrome, `CloseButton`, `useCloseOnEscape`. Light theme is canonical.
- Commit directly to `main`. Every commit message ends with the Co-Authored-By / Claude-Session trailer used elsewhere in this repo's history.

---

## File Structure

- Create `frontend/src/lib/persist/layoutEvents.ts` — the change emitter + suppression scope.
- Create `frontend/src/lib/templateAutosave.ts` — `sameTemplate`, `maybeAutoSaveTemplate`, debounced `scheduleAutoSave`.
- Create `frontend/src/lib/persist/layoutEvents.test.ts`, `frontend/src/lib/templateAutosave.test.ts`.
- Create `frontend/src/SaveDefaultTemplateModal.tsx` — the selectable default-save modal.
- Modify `frontend/src/lib/persist/artifacts.ts` — emit from the six writers.
- Modify `frontend/src/lib/templates.ts` — suppress inside `applySymbolTemplate`; add `includeIds` to `captureDefaultTemplate`.
- Modify `frontend/src/lib/persist/defaults.ts` — `loadAutoSaveTemplates` / `saveAutoSaveTemplates`.
- Modify `frontend/src/lib/signals.ts` — `saveDefaultTemplateRequest` signal.
- Modify `frontend/src/ChartCore.tsx` — subscribe per cell, schedule auto-save.
- Modify `frontend/src/Toolbar.tsx` — trim menu (drop Save/Delete GOLD), add Auto-save toggle, route Save-as-default through the modal.
- Modify `frontend/src/App.tsx` — render `SaveDefaultTemplateModal`.
- Modify `frontend/e2e/symbol-template.spec.ts` (path per repo) — auto-save e2e.

---

## Task 1: Layout-change emitter + suppression

**Files:**
- Create: `frontend/src/lib/persist/layoutEvents.ts`
- Test: `frontend/src/lib/persist/layoutEvents.test.ts`
- Modify: `frontend/src/lib/persist/artifacts.ts` (emit from writers)
- Modify: `frontend/src/lib/templates.ts` (suppress in `applySymbolTemplate`)

**Interfaces:**
- Produces:
  - `emitLayoutChanged(scope: string): void`
  - `onLayoutChanged(cb: (scope: string) => void): () => void` (returns unsubscribe)
  - `withLayoutEventsSuppressed<T>(fn: () => T): T`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/persist/layoutEvents.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  emitLayoutChanged,
  onLayoutChanged,
  withLayoutEventsSuppressed,
} from "./layoutEvents";

describe("layoutEvents", () => {
  it("notifies subscribers with the scope", () => {
    const cb = vi.fn();
    const off = onLayoutChanged(cb);
    emitLayoutChanged("cell-1");
    expect(cb).toHaveBeenCalledWith("cell-1");
    off();
    emitLayoutChanged("cell-1");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("suppresses emits inside withLayoutEventsSuppressed (incl. nested)", () => {
    const cb = vi.fn();
    onLayoutChanged(cb);
    withLayoutEventsSuppressed(() => {
      withLayoutEventsSuppressed(() => emitLayoutChanged("cell-1"));
      emitLayoutChanged("cell-1");
    });
    expect(cb).not.toHaveBeenCalled();
    emitLayoutChanged("cell-1");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist/layoutEvents.test.ts`
Expected: FAIL — cannot find module `./layoutEvents`.

- [ ] **Step 3: Implement the emitter**

Create `frontend/src/lib/persist/layoutEvents.ts`:

```ts
// A tiny synchronous pub/sub for "a cell's persisted layout (indicators / drawings
// / configs / anchors) just changed", keyed by cell scope. Fired by the per-cell
// persist writers in artifacts.ts; consumed by ChartCore's per-cell auto-save.
//
// withLayoutEventsSuppressed wraps the programmatic merge writes in
// applySymbolTemplate so auto-apply / manual-apply / default-apply — which mint
// NEW instance ids — never look like a user edit and never trigger an auto-save.
// It's a DEPTH COUNTER (not a boolean) so nested applies compose.

type Listener = (scope: string) => void;

const listeners = new Set<Listener>();
let suppressDepth = 0;

export function onLayoutChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitLayoutChanged(scope: string): void {
  if (suppressDepth > 0) return;
  for (const l of listeners) l(scope);
}

export function withLayoutEventsSuppressed<T>(fn: () => T): T {
  suppressDepth++;
  try {
    return fn();
  } finally {
    suppressDepth--;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/persist/layoutEvents.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Emit from the six per-cell layout writers**

In `frontend/src/lib/persist/artifacts.ts`, add the import near the top (after the existing `./core` import):

```ts
import { emitLayoutChanged } from "./layoutEvents";
```

Add `emitLayoutChanged(scope);` as the LAST line of each of these functions' bodies:

- `saveDrawings(scope, epic, list)` (~L31) — after `save(drawingsKey(scope, epic), list);`
- `saveIndicators(scope, list)` (~L101) — after `save(indicatorsKey(scope), list);`
- `saveIndicatorConfig(scope, id, cfg)` (~L245) — after its `save(indicatorCfgKey(scope), all);`
- `saveIndicatorVisible(scope, id, visible)` (~L257) — after its `save(indicatorCfgKey(scope), all);`
- `deleteIndicatorConfig(scope, id)` (~L265) — after its final `save(...)`
- `saveAvwapAnchor(scope, epic, id, anchorMs)` (~L289) — after its `save(...)`

Example (saveIndicators):

```ts
export function saveIndicators(scope: string, list: IndicatorInstance[]): void {
  save(indicatorsKey(scope), list);
  emitLayoutChanged(scope);
}
```

- [ ] **Step 6: Suppress emits inside applySymbolTemplate**

In `frontend/src/lib/templates.ts`, add to the imports:

```ts
import { withLayoutEventsSuppressed } from "./persist/layoutEvents";
```

Wrap the entire body of `applySymbolTemplate` (the function starting ~L99) in `withLayoutEventsSuppressed(() => { ... })`. Concretely, change the signature body from:

```ts
): void {
  // ...existing body...
}
```

to:

```ts
): void {
  withLayoutEventsSuppressed(() => {
    // ...existing body verbatim...
  });
}
```

(`applyDefaultTemplate` delegates to `applySymbolTemplate`, and `maybeAutoApplyTemplate` calls both, so this single wrap covers every merge-apply path.)

- [ ] **Step 7: Run the affected unit suites**

Run: `cd frontend && npx vitest run src/lib/persist/layoutEvents.test.ts src/lib/templates.test.ts`
Expected: PASS (existing `templates.test.ts` unaffected; new suite green).

- [ ] **Step 8: Commit**

```bash
cd frontend && git add src/lib/persist/layoutEvents.ts src/lib/persist/layoutEvents.test.ts src/lib/persist/artifacts.ts src/lib/templates.ts
git commit -m "feat(templates): layout-change emitter + apply-path suppression

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 2: `autoSaveTemplates` global preference

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts`
- Test: `frontend/src/lib/persist/defaults.test.ts` (append; create if absent using the MemStorage shim from `persist.test.ts`)

**Interfaces:**
- Produces:
  - `loadAutoSaveTemplates(): boolean` (default `true`)
  - `saveAutoSaveTemplates(on: boolean): void` (backend-mirrored)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/persist/defaults.test.ts` (import the two new fns at the top of the file's existing import from `./defaults`):

```ts
import { loadAutoSaveTemplates, saveAutoSaveTemplates } from "./defaults";

describe("autoSaveTemplates preference", () => {
  it("defaults to true when unset", () => {
    expect(loadAutoSaveTemplates()).toBe(true);
  });
  it("round-trips false", () => {
    saveAutoSaveTemplates(false);
    expect(loadAutoSaveTemplates()).toBe(false);
    saveAutoSaveTemplates(true);
    expect(loadAutoSaveTemplates()).toBe(true);
  });
});
```

If `defaults.test.ts` does not exist, create it copying the `MemStorage` + `globalThis.localStorage` `beforeEach` setup verbatim from `src/lib/persist/persist.test.ts`, then add the block above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist/defaults.test.ts`
Expected: FAIL — `loadAutoSaveTemplates` is not exported.

- [ ] **Step 3: Implement the preference**

In `frontend/src/lib/persist/defaults.ts`, after the `saveBacktestPeriodsShown` block (~L202) add:

```ts
// Whether per-symbol templates auto-save on every layout edit. GLOBAL (not
// per-epic), default ON, backend-mirrored via save() so the choice follows the
// user across tabs/devices. Toggled from the Template menu.
const AUTO_SAVE_TEMPLATES_KEY = `${PREFIX}.autoSaveTemplates`;
export function loadAutoSaveTemplates(): boolean {
  return load<boolean>(AUTO_SAVE_TEMPLATES_KEY, true);
}
export function saveAutoSaveTemplates(on: boolean): void {
  save(AUTO_SAVE_TEMPLATES_KEY, on);
}
```

Confirm `save` and `load` are already imported at the top of `defaults.ts` (they are — used by the template functions below). No barrel edit is needed: `frontend/src/lib/persist.ts` does `export * from "./persist/defaults"`, so the two new functions are re-exported automatically (import them from `./persist`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/persist/defaults.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/persist/defaults.ts src/lib/persist/defaults.test.ts src/lib/persist/index.ts
git commit -m "feat(templates): autoSaveTemplates global preference (default on)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 3: Auto-save engine (compare + debounce)

**Files:**
- Create: `frontend/src/lib/templateAutosave.ts`
- Test: `frontend/src/lib/templateAutosave.test.ts`

**Interfaces:**
- Consumes: `captureSymbolTemplate` (templates.ts), `loadSymbolTemplate`/`saveSymbolTemplate` (persist), `loadAutoSaveTemplates` (Task 2).
- Produces:
  - `sameTemplate(a: SymbolTemplate | null, b: SymbolTemplate | null): boolean` (compares everything except `savedAt`)
  - `maybeAutoSaveTemplate(scope: string, epic: string): void` (synchronous: gate on toggle, capture, compare, write)
  - `scheduleAutoSave(scope: string, epic: string): void` (debounced wrapper, ~800ms per scope)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/templateAutosave.test.ts`. Reuse the `vi.mock("./indicators", …)` stub and `MemStorage` shim from `templates.test.ts` (copy them verbatim — templateAutosave imports templates.ts which imports indicators).

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./indicators", () => {
  let seq = 0;
  return {
    applyIndicator: vi.fn(() => "pane_x"),
    mintInstanceId: vi.fn((_c: unknown, t: string) => `${t}#m${++seq}`),
    effectiveCalcParams: vi.fn((_t: string, saved?: number[]) => saved),
    isSubPaneIndicator: vi.fn(() => false),
  };
});

// ...paste the MemStorage class + beforeEach(() => { globalThis.localStorage = new MemStorage(); }) from templates.test.ts...

import { sameTemplate, maybeAutoSaveTemplate } from "./templateAutosave";
import {
  saveIndicators,
  saveDrawings,
  loadSymbolTemplate,
  saveSymbolTemplate,
} from "./persist";
import { saveAutoSaveTemplates } from "./persist";

const SCOPE = "cell-1";
const EPIC = "GOLD";

describe("sameTemplate", () => {
  it("ignores savedAt", () => {
    const base = { epic: EPIC, indicators: [{ id: "EMA#1", type: "EMA" }], indicatorConfigs: {}, drawings: [], avwapAnchors: {}, savedAt: 1 };
    expect(sameTemplate(base, { ...base, savedAt: 999 })).toBe(true);
  });
  it("detects an added indicator", () => {
    const a = { epic: EPIC, indicators: [], indicatorConfigs: {}, drawings: [], avwapAnchors: {}, savedAt: 1 };
    const b = { ...a, indicators: [{ id: "EMA#1", type: "EMA" }] };
    expect(sameTemplate(a, b)).toBe(false);
  });
});

describe("maybeAutoSaveTemplate", () => {
  beforeEach(() => saveAutoSaveTemplates(true));

  it("writes the captured template when none is stored", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)?.indicators).toEqual([{ id: "EMA#1", type: "EMA" }]);
  });

  it("does not rewrite when content is unchanged", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    const firstAt = loadSymbolTemplate(EPIC)!.savedAt;
    maybeAutoSaveTemplate(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)!.savedAt).toBe(firstAt);
  });

  it("saves an EMPTY template when the cell is cleared (not delete)", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    saveIndicators(SCOPE, []); // user removed everything
    maybeAutoSaveTemplate(SCOPE, EPIC);
    const t = loadSymbolTemplate(EPIC);
    expect(t).not.toBeNull();
    expect(t!.indicators).toEqual([]);
  });

  it("does nothing when auto-save is off", () => {
    saveAutoSaveTemplates(false);
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/templateAutosave.test.ts`
Expected: FAIL — cannot find module `./templateAutosave`.

- [ ] **Step 3: Implement the engine**

Create `frontend/src/lib/templateAutosave.ts`:

```ts
// Per-symbol template AUTO-SAVE. Driven by layoutEvents: when a cell's persisted
// layout changes (a real user edit — merge-applies are suppressed at the emitter),
// ChartCore calls scheduleAutoSave(scope, epic). After a short debounce we capture
// the cell's layout into a SymbolTemplate and write it — but only if it actually
// differs from what's stored (styling edits count; savedAt does not), to avoid
// spraying redundant backend PUTs. An EMPTY capture is saved as an empty template
// (NOT deleted) so clearing a chart makes fresh cells of that symbol open blank.
import { captureSymbolTemplate } from "./templates";
import {
  loadSymbolTemplate,
  saveSymbolTemplate,
  loadAutoSaveTemplates,
  type SymbolTemplate,
} from "./persist";

// Content equality ignoring savedAt. Both sides are built by captureSymbolTemplate
// (or a prior capture round-tripped through JSON), so a stable stringify of the
// content fields is a sound comparison — instance ids are stable across genuine
// edits (only merge-apply mints new ids, and those writes are suppressed).
export function sameTemplate(
  a: SymbolTemplate | null,
  b: SymbolTemplate | null,
): boolean {
  if (!a || !b) return a === b;
  const norm = (t: SymbolTemplate) =>
    JSON.stringify({
      indicators: t.indicators,
      indicatorConfigs: t.indicatorConfigs,
      drawings: t.drawings,
      avwapAnchors: t.avwapAnchors,
    });
  return norm(a) === norm(b);
}

export function maybeAutoSaveTemplate(scope: string, epic: string): void {
  if (!loadAutoSaveTemplates()) return;
  const next = captureSymbolTemplate(scope, epic);
  const prev = loadSymbolTemplate(epic);
  if (sameTemplate(prev, next)) return;
  saveSymbolTemplate(next);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 800;

// Debounced per (scope+epic). Coalesces a drag / multi-step edit into one write.
export function scheduleAutoSave(scope: string, epic: string): void {
  const key = `${scope} ${epic}`;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      maybeAutoSaveTemplate(scope, epic);
    }, DEBOUNCE_MS),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/templateAutosave.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/templateAutosave.ts src/lib/templateAutosave.test.ts
git commit -m "feat(templates): auto-save engine (debounced capture + deep-equal skip)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 4: Wire the per-cell subscription in ChartCore

**Files:**
- Modify: `frontend/src/ChartCore.tsx`

**Interfaces:**
- Consumes: `onLayoutChanged` (Task 1), `scheduleAutoSave` (Task 3). Uses in-scope `controller.scope` and `symbol.epic`.

**Rationale:** Mount/symbol-change hydration is read-only for persistence and merge-applies are suppressed, so the subscription only fires on genuine user edits. The subscription re-binds when `symbol.epic` changes so it always schedules against the current epic.

- [ ] **Step 1: Add the imports**

Near ChartCore's other `lib/` imports add:

```ts
import { onLayoutChanged } from "./lib/persist/layoutEvents";
import { scheduleAutoSave } from "./lib/templateAutosave";
```

- [ ] **Step 2: Add the subscription effect**

Add this effect in the ChartCore component body, alongside the other `useEffect` subscriptions (place it after the symbol-change effect region so `controller`/`symbol` are in scope):

```tsx
// Auto-save this cell's per-symbol template on real layout edits. layoutEvents
// fires only for genuine edits (merge-applies are suppressed at the emitter, and
// mount/symbol hydration doesn't persist), so this never fights hydration. The
// engine itself no-ops when auto-save is off or the content is unchanged.
useEffect(() => {
  if (!controller || !symbol) return;
  const myScope = controller.scope;
  const epic = symbol.epic;
  return onLayoutChanged((changedScope) => {
    if (changedScope === myScope) scheduleAutoSave(myScope, epic);
  });
}, [controller, symbol?.epic]);
```

(Match the exact names ChartCore uses for the controller instance and the current symbol object — adjust `controller`/`symbol` to the real identifiers in that file. `controller.scope` and `symbol.epic` are the same expressions used by `maybeAutoApplyTemplate` at ChartCore.tsx:3658.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/ChartCore.tsx
git commit -m "feat(templates): per-cell auto-save subscription

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 5: Trim the Template menu + add the Auto-save toggle

**Files:**
- Modify: `frontend/src/Toolbar.tsx`

**Interfaces:**
- Consumes: `loadAutoSaveTemplates`/`saveAutoSaveTemplates` (Task 2).

- [ ] **Step 1: Add imports + toggle state**

In `Toolbar.tsx` add to the persist import block:

```ts
loadAutoSaveTemplates,
saveAutoSaveTemplates,
```

Inside the component, near the other `useState` hooks, add:

```tsx
const [autoSave, setAutoSave] = useState(loadAutoSaveTemplates());
function toggleAutoSave() {
  const next = !autoSave;
  setAutoSave(next);
  saveAutoSaveTemplates(next);
}
```

- [ ] **Step 2: Delete the now-unused handlers**

Remove `saveTemplate` (Toolbar.tsx ~L308) and `deleteTemplate` (~L324) function definitions. Keep `applyTemplate`, `saveDefault`, `applyDefault`, `clearDefault`. Remove the now-unused imports `captureSymbolTemplate`, `saveSymbolTemplate`, `deleteSymbolTemplate` from the import list (leave `loadSymbolTemplate`, `applySymbolTemplate`, and the default-template imports).

- [ ] **Step 3: Rewrite the per-symbol section of the dropdown**

Replace the JSX block from `<li onClick={saveTemplate}>` through the `) : ( <li className="empty">no saved template</li> )}` (Toolbar.tsx L698–L727) with:

```tsx
<li onClick={toggleAutoSave}>
  <span className="tmpl-ic">{autoSave ? MenuIcons.apply : MenuIcons.blank ?? null}</span>
  <span className="ind-name">Auto-save templates</span>
  <InfoTip
    title="Auto-save templates"
    text={`When on, each chart's indicators and drawings are saved to that symbol's template automatically as you edit — no need to save by hand. Fresh charts of a symbol open with its latest layout. Turn off to stop tracking edits.`}
  />
</li>
{loadSymbolTemplate(symbol.epic) ? (
  <li onClick={applyTemplate}>
    <span className="tmpl-ic">{MenuIcons.apply}</span>
    <span className="ind-name">Apply {symbol.epic} template</span>
    <InfoTip
      title={`Apply ${symbol.epic} template`}
      text="Adds the template's indicators and drawings that are missing from this chart. What's already here is never changed or removed."
    />
  </li>
) : (
  <li className="empty">no saved template</li>
)}
```

If `MenuIcons.blank` does not exist, render the check conditionally instead: `{autoSave ? MenuIcons.apply : null}` and add `className={autoSave ? "tmpl-ic" : "tmpl-ic tmpl-ic-off"}` to reserve the gutter (the existing `.tmpl-ic` fixed width keeps rows aligned). No new CSS is required if the span is always present.

The default-template section (`<li className="sep" />` onward, L728–L761) is unchanged in this task except Task 7 swaps `saveDefault`'s behavior.

- [ ] **Step 4: Typecheck + run the app**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (no dangling references to `saveTemplate`/`deleteTemplate`).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/Toolbar.tsx
git commit -m "feat(templates): trim menu to Auto-save toggle + Apply; drop manual Save/Delete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 6: `captureDefaultTemplate` selectable capture

**Files:**
- Modify: `frontend/src/lib/templates.ts`
- Test: `frontend/src/lib/templates.test.ts` (append)

**Interfaces:**
- Produces: `captureDefaultTemplate(scope: string, includeIds?: Set<string>): DefaultTemplate` — when `includeIds` is given, only those instance ids are captured (still AVWAP-filtered). Omitting it preserves current behavior.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/templates.test.ts`:

```ts
import { captureDefaultTemplate } from "./templates";
import { saveIndicators } from "./persist";

describe("captureDefaultTemplate includeIds", () => {
  it("captures only the selected instance ids", () => {
    const scope = "cell-def";
    saveIndicators(scope, [
      { id: "EMA#1", type: "EMA" },
      { id: "RSI#1", type: "RSI" },
    ]);
    const only = captureDefaultTemplate(scope, new Set(["EMA#1"]));
    expect(only.indicators.map((i) => i.id)).toEqual(["EMA#1"]);
  });
  it("captures all symbol-agnostic indicators when includeIds omitted", () => {
    const scope = "cell-def2";
    saveIndicators(scope, [
      { id: "EMA#1", type: "EMA" },
      { id: "AVWAP#1", type: "AVWAP" },
    ]);
    const all = captureDefaultTemplate(scope);
    expect(all.indicators.map((i) => i.id)).toEqual(["EMA#1"]); // AVWAP filtered
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/templates.test.ts -t "captureDefaultTemplate includeIds"`
Expected: FAIL — `captureDefaultTemplate` takes 1 arg / selection not honored.

- [ ] **Step 3: Add the `includeIds` parameter**

In `frontend/src/lib/templates.ts`, change `captureDefaultTemplate` (~L180) to:

```ts
export function captureDefaultTemplate(
  scope: string,
  includeIds?: Set<string>,
): DefaultTemplate {
  const indicators = loadIndicators(scope)
    .filter((inst) => inst.type !== "AVWAP")
    .filter((inst) => !includeIds || includeIds.has(inst.id));
  const allConfigs = loadIndicatorConfigs(scope);
  const indicatorConfigs: Record<string, SavedIndicatorConfig> = {};
  for (const inst of indicators) {
    if (allConfigs[inst.id]) indicatorConfigs[inst.id] = allConfigs[inst.id];
  }
  return { indicators, indicatorConfigs, savedAt: Date.now() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/templates.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/templates.ts src/lib/templates.test.ts
git commit -m "feat(templates): captureDefaultTemplate accepts an includeIds selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 7: "Save as default template" selectable modal

**Files:**
- Create: `frontend/src/SaveDefaultTemplateModal.tsx`
- Modify: `frontend/src/lib/signals.ts` (new request signal)
- Modify: `frontend/src/App.tsx` (render the modal)
- Modify: `frontend/src/Toolbar.tsx` (`saveDefault` opens the modal)

**Interfaces:**
- Produces (signals.ts):
  ```ts
  export interface SaveDefaultTemplateRequest {
    candidates: Array<{ id: string; label: string; params: string }>;
    onConfirm: (selectedIds: string[]) => void;
  }
  export const saveDefaultTemplateRequest: Signal<SaveDefaultTemplateRequest | null>;
  ```
- Consumes: `captureDefaultTemplate(scope, includeIds)` (Task 6), `saveDefaultTemplate` (persist).

- [ ] **Step 1: Add the request signal**

In `frontend/src/lib/signals.ts`, after the `confirmRequest` block (~L65) add:

```ts
// Request to open the "Save as default template" picker. Toolbar sets it with the
// current chart's symbol-agnostic indicators as candidates; App renders one modal.
// onConfirm gets the checked instance ids. null = closed.
export interface SaveDefaultTemplateRequest {
  candidates: Array<{ id: string; label: string; params: string }>;
  onConfirm: (selectedIds: string[]) => void;
}
export const saveDefaultTemplateRequest =
  new Signal<SaveDefaultTemplateRequest | null>(null);
```

- [ ] **Step 2: Write the modal component**

Create `frontend/src/SaveDefaultTemplateModal.tsx`:

```tsx
// Selectable "Save as default template" modal. Lists the current chart's
// symbol-agnostic indicators (AVWAP already excluded upstream), all checked by
// default; confirming saves only the checked ones as the global default. Reuses
// the shared modal chrome (modal-backdrop / modal), CloseButton, useCloseOnEscape
// — same primitives as ConfirmDialog, but with a checkbox list.
import { useState } from "react";
import CloseButton from "./CloseButton";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import type { SaveDefaultTemplateRequest } from "./lib/signals";

interface Props {
  req: SaveDefaultTemplateRequest;
  onClose: () => void;
}

export default function SaveDefaultTemplateModal({ req, onClose }: Props) {
  useCloseOnEscape(onClose);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(req.candidates.map((c) => c.id)),
  );
  const empty = req.candidates.length === 0;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head confirm-head">
          <span>Save default template</span>
          <CloseButton onClick={onClose} label="Cancel" />
        </div>
        <div className="confirm-body">
          {empty ? (
            "This chart has no indicators to save."
          ) : (
            <>
              New charts of any symbol inherit the checked indicators. Drawings and
              AVWAP anchors are never included.
              <ul className="sdt-list">
                {req.candidates.map((c) => (
                  <li key={c.id} className="sdt-row" onClick={() => toggle(c.id)}>
                    <input
                      type="checkbox"
                      checked={checked.has(c.id)}
                      readOnly
                    />
                    <span className="ind-name">{c.label}</span>
                    <span className="sdt-params">{c.params}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {!empty && (
            <button
              className="confirm-danger"
              disabled={checked.size === 0}
              autoFocus
              onClick={() => {
                req.onConfirm([...checked]);
                onClose();
              }}
            >
              Save as default
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

Add minimal CSS to the same stylesheet that defines `.confirm-details`/`.confirm-body` (search for `.confirm-body {` and add nearby):

```css
.sdt-list { list-style: none; margin: 8px 0 0; padding: 0; }
.sdt-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
.sdt-params { margin-left: auto; opacity: 0.6; }
```

- [ ] **Step 3: Render the modal in App**

In `frontend/src/App.tsx`: import the component and signal, add subscription state next to the `confirm` one (~L287):

```tsx
import SaveDefaultTemplateModal from "./SaveDefaultTemplateModal";
import { saveDefaultTemplateRequest } from "./lib/signals";
// ...
const [saveDefaultReq, setSaveDefaultReq] = useState(saveDefaultTemplateRequest.value);
useEffect(() => saveDefaultTemplateRequest.subscribe(setSaveDefaultReq), []);
```

Render it next to the `ConfirmDialog` block (~L1841):

```tsx
{saveDefaultReq && (
  <SaveDefaultTemplateModal
    req={saveDefaultReq}
    onClose={() => saveDefaultTemplateRequest.set(null)}
  />
)}
```

- [ ] **Step 4: Route Toolbar `saveDefault` through the modal**

In `frontend/src/Toolbar.tsx`, add imports:

```ts
import { saveDefaultTemplateRequest } from "./lib/signals";
import { loadIndicators, loadIndicatorConfigs } from "./lib/persist";
```

Replace the `saveDefault` function (Toolbar.tsx ~L334) with:

```tsx
function saveDefault() {
  if (!controller) return;
  const scope = controller.scope;
  const configs = loadIndicatorConfigs(scope);
  const candidates = loadIndicators(scope)
    .filter((inst) => inst.type !== "AVWAP")
    .map((inst) => {
      const params = (configs[inst.id]?.calcParams ?? []) as unknown[];
      return {
        id: inst.id,
        label: inst.type,
        params: params.length ? params.join(", ") : "—",
      };
    });
  setTmplOpen(false);
  saveDefaultTemplateRequest.set({
    candidates,
    onConfirm: (ids) => {
      saveDefaultTemplate(captureDefaultTemplate(scope, new Set(ids)));
      toast("Saved default template");
    },
  });
}
```

Confirm `captureDefaultTemplate` and `saveDefaultTemplate` are still imported in Toolbar (they are). Ensure `SavedIndicatorConfig.calcParams` exists — if the field is named differently, read the params from the same place the legend does (`ChartLegend.tsx:695` joins `ind.calcParams`); adjust the accessor to match the stored config shape.

- [ ] **Step 5: Typecheck + run the app**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/SaveDefaultTemplateModal.tsx src/lib/signals.ts src/App.tsx src/Toolbar.tsx
git commit -m "feat(templates): selectable Save-as-default modal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Task 8: E2E + full verification

**Files:**
- Modify: `frontend/e2e/symbol-template.spec.ts` (locate exact path with `git ls-files e2e/symbol-template.spec.ts`)

- [ ] **Step 1: Read the existing e2e to match helpers/selectors**

Run: `cd frontend && git ls-files e2e/symbol-template.spec.ts` then open the file. Reuse its existing helpers for adding an indicator, opening a tab, and asserting an indicator's presence.

- [ ] **Step 2: Add an auto-save e2e test**

Append a test mirroring the existing spec's style (adapt selector helpers to the ones already in the file):

```ts
test("per-symbol template auto-saves and applies to a fresh same-symbol cell", async ({ page }) => {
  // ...open app, ensure a known symbol (e.g. the default epic)...
  // 1. Add an EMA on the first cell.
  // 2. Wait > debounce (900ms) for the auto-save to land.
  await page.waitForTimeout(900);
  // 3. Open a second tab/cell on the SAME symbol.
  // 4. Assert the EMA auto-applied (same assertion the existing spec uses).
  // 5. Remove the EMA on the first cell; wait > 900ms.
  // 6. Open another fresh same-symbol cell; assert it opens WITHOUT the EMA (empty template).
});
```

Keep the assertions concrete using the file's existing indicator-presence check.

- [ ] **Step 3: Run the e2e**

Run: `cd frontend && npx playwright test symbol-template`
Expected: PASS (existing test that still applies + the new auto-save test). If the old spec asserted the now-removed "Save GOLD template" menu item, update it to drive auto-save instead (add an indicator + wait) rather than clicking Save.

- [ ] **Step 4: Full unit suite + typecheck + lint**

Run:
```bash
cd frontend && npx tsc --noEmit && npx vitest run && npx eslint src --max-warnings=0
```
Expected: all green.

- [ ] **Step 5: Manual smoke (per superpowers:verification-before-completion)**

Start the app, then verify by observation:
1. Template menu shows `✓ Auto-save templates` (checked) + `Apply <epic> template`; no Save/Delete GOLD items.
2. Add an indicator → wait ~1s → reload → open a fresh same-symbol cell → indicator is there (auto-saved).
3. Toggle Auto-save off → add another indicator → wait → fresh cell does NOT gain it.
4. "Save as default template" opens the picker; unchecking all disables the button; saving a subset then "Apply default template" on a blank chart adds only the chosen indicators.
5. Clear a chart's indicators/drawings with auto-save on → fresh same-symbol cell opens blank.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add tests
git commit -m "test(templates): e2e for per-symbol auto-save + fresh-cell blanking

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PQBJzutLSirWpTeFCRNi7B"
```

---

## Self-Review Notes (spec coverage)

- Auto-save trigger/emitter → Task 1. Loop-guard (suppress applies; hydration read-only) → Task 1 Step 6 + Task 4 rationale. Debounce + deep-equal skip + empty-saved-as-empty → Task 3. Backend path reuse → inherent (uses `save()`), no new endpoint.
- Global toggle default ON → Task 2 + Task 5.
- Menu trimmed (drop Save/Delete GOLD) + toggle at top → Task 5.
- Save-as-default selectable modal listing exact indicators, all-checked, disable-when-none, empty-state → Task 6 + Task 7.
- Untouched additive-merge apply + fresh-cell gate + no cross-cell mirroring → honored (no edits to those).
- Testing: unit (Tasks 1–3, 6), e2e + manual smoke (Task 8).

## Implementation note (scope)

The e2e was rewritten to drive **auto-save** (no manual Save) for the core
auto-save→auto-apply path, and to toggle auto-save **off** to preserve the
merge-test intent. The "clear chart → fresh cell opens blank" case is covered by
the `templateAutosave` unit test ("saves an EMPTY template when the cell is
cleared") rather than a separate e2e — the storage-level assertion is exact and
avoids brittle indicator-removal UI driving. Browser smoke confirmed the trimmed
menu (✓ Auto-save templates + Apply, no Save/Delete), the selectable picker
modal, and the disable-when-none-checked state.
