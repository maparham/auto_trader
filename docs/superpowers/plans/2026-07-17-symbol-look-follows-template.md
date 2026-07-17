# Symbol Look Follows Template (replace-on-open) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a symbol anywhere makes the cell look exactly like that symbol's saved template, and the outgoing symbol's analysis is always captured first so nothing is ever lost.

**Architecture:** A new `replaceSymbolTemplate` (exact-look apply) joins the existing additive `applySymbolTemplate` in `lib/templates.ts`. `maybeAutoApplyTemplate` is replaced by `applyLookOnOpen` (fires on every epic open, not just fresh cells). `lib/templateAutosave.ts` gains an unconditional synchronous `flushTemplateCapture` (used at symbol switch) and `flushPendingAutoSaves` (used before scope purges on close). `chart/useLiveMarketData.ts` wires both into the symbol-switch effect.

**Tech Stack:** React + TypeScript frontend, vitest (node env, klinecharts mocked), klinecharts v10.

**Spec:** `docs/superpowers/specs/2026-07-17-symbol-look-follows-template-design.md`

## Global Constraints

- Manual "Apply template" menu action stays additive-merge (`applySymbolTemplate` unchanged).
- Empty template still means "open blank" (empty-saved-as-empty).
- Snapshot (read-only) tabs never write templates and never get the replace-apply.
- Capture-on-switch runs REGARDLESS of the `autoSaveTemplates` setting.
- No legacy/back-compat shims: `maybeAutoApplyTemplate` is deleted, not aliased.
- Tests: `cd frontend && npx vitest run src/lib/<file>.test.ts` (node env, klinecharts must stay mocked).

---

### Task 1: `replaceSymbolTemplate` in templates.ts

**Files:**
- Modify: `frontend/src/lib/templates.ts` (add function after `applySymbolTemplate`)
- Test: `frontend/src/lib/templates.test.ts`

**Interfaces:**
- Consumes: existing `savedIndicatorSignature`, `drawingSignature`, persist helpers, `removeIndicatorById` from `./indicators` (NEW import — must also be added to the `vi.mock("./indicators", ...)` stub in BOTH `templates.test.ts` and `templateAutosave.test.ts`).
- Produces: `replaceSymbolTemplate(chart: Chart, controller: ChartController, scope: string, epic: string, t: SymbolTemplate): void`

- [ ] **Step 1: Write failing tests** — append to `templates.test.ts`. The existing `stubChart` / `stubController` consts live INSIDE the `maybeAutoApplyTemplate gate` describe callback — hoist them to module level (below the `beforeEach`) so both describe blocks share them, and give `subPanesHidden` a no-op `set`. Add `removeIndicatorById: vi.fn()` and `isSubPaneIndicator: vi.fn(() => false)` to the `vi.mock("./indicators")` factory:

```ts
describe("replaceSymbolTemplate", () => {
  it("keeps signature-matched instances, removes extras, adds missing", () => {
    // Cell: EMA(9) [matches template] + SLOPE [not in template].
    P.saveIndicators(SCOPE, [
      { id: "EMA", type: "EMA" },
      { id: "SLOPE", type: "SLOPE" },
    ]);
    P.saveIndicatorConfig(SCOPE, "EMA", { calcParams: [9] });
    const t: import("./persist").SymbolTemplate = {
      epic: EPIC,
      indicators: [
        { id: "EMA#t", type: "EMA" },
        { id: "VOL#t", type: "VOL" },
      ],
      indicatorConfigs: { "EMA#t": { calcParams: [9] } },
      drawings: [],
      avwapAnchors: {},
      savedAt: 1,
    };
    T.replaceSymbolTemplate(stubChart, stubController, SCOPE, EPIC, t);
    const full = P.loadIndicators(SCOPE);
    // EMA kept under its ORIGINAL id (untouched), SLOPE removed, VOL added.
    expect(full.map((i) => i.type).sort()).toEqual(["EMA", "VOL"]);
    expect(full.find((i) => i.type === "EMA")!.id).toBe("EMA");
    expect(vi.mocked(I.removeIndicatorById)).toHaveBeenCalledWith(stubChart, SCOPE, "SLOPE");
  });

  it("empty template wipes indicators and drawings (exact blank look)", () => {
    P.saveIndicators(SCOPE, [{ id: "EMA", type: "EMA" }]);
    P.saveDrawings(SCOPE, EPIC, [{ name: "segment", points: [{ value: 1 }] }]);
    const t: import("./persist").SymbolTemplate = {
      epic: EPIC, indicators: [], indicatorConfigs: {}, drawings: [], avwapAnchors: {}, savedAt: 1,
    };
    T.replaceSymbolTemplate(stubChart, stubController, SCOPE, EPIC, t);
    expect(P.loadIndicators(SCOPE)).toEqual([]);
    expect(P.loadDrawings(SCOPE, EPIC)).toEqual([]);
  });

  it("drawings become exactly the template's; identical set is not rewritten", () => {
    const d1 = { name: "segment", points: [{ value: 1 }] };
    const d2 = { name: "fibonacciLine", points: [{ value: 2 }] };
    P.saveDrawings(SCOPE, EPIC, [d1]);
    const t: import("./persist").SymbolTemplate = {
      epic: EPIC, indicators: [], indicatorConfigs: {}, drawings: [d1, d2], avwapAnchors: {}, savedAt: 1,
    };
    let rehydrated = 0;
    const ctrl = {
      ...(stubController as object),
      indicators: { value: [], set: () => {} },
      indicatorsHidden: { value: false },
      subPanesHidden: { value: false, set: () => {} },
      overlays: { rehydrate: () => rehydrated++ },
    } as unknown as import("./chartController").ChartController;
    T.replaceSymbolTemplate(stubChart, ctrl, SCOPE, EPIC, t);
    expect(P.loadDrawings(SCOPE, EPIC)).toHaveLength(2);
    expect(rehydrated).toBe(1);
    // Second apply: already exact — no rewrite, no rehydrate churn.
    T.replaceSymbolTemplate(stubChart, ctrl, SCOPE, EPIC, t);
    expect(rehydrated).toBe(1);
  });

  it("AVWAP: adds with anchor pre-written, removes stale instance's anchor", () => {
    P.saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }]);
    P.saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 111); // does NOT match template's 222
    const t: import("./persist").SymbolTemplate = {
      epic: EPIC,
      indicators: [{ id: "AVWAP#t", type: "AVWAP" }],
      indicatorConfigs: {},
      drawings: [],
      avwapAnchors: { "AVWAP#t": 222 },
      savedAt: 1,
    };
    T.replaceSymbolTemplate(stubChart, stubController, SCOPE, EPIC, t);
    const full = P.loadIndicators(SCOPE);
    expect(full).toHaveLength(1);
    expect(P.loadAvwapAnchor(SCOPE, EPIC, full[0].id)).toBe(222);
    expect(P.loadAvwapAnchor(SCOPE, EPIC, "AVWAP")).toBe(0); // zeroed on removal
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/templates.test.ts`
Expected: FAIL — `T.replaceSymbolTemplate is not a function`.

- [ ] **Step 3: Implement** — in `templates.ts`, extend the `./indicators` import with `removeIndicatorById`, then add after `applySymbolTemplate`:

```ts
// Apply a template onto a cell as its EXACT look — the replace-on-open path
// (spec: docs/superpowers/specs/2026-07-17-symbol-look-follows-template-design.md).
// Unlike the additive applySymbolTemplate (manual Apply, never destroys), this
// makes the cell end up exactly like the template: signature-matched existing
// instances are KEPT untouched (no id/config/styling churn), unmatched ones are
// removed, missing ones added, and the epic's drawings become the template's
// drawings verbatim. Safe because the caller has already captured the outgoing
// look into ITS template (flushTemplateCapture) — nothing is destroyed, it
// travels with its own symbol.
export function replaceSymbolTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: SymbolTemplate,
): void {
  withLayoutEventsSuppressed(() => {
    // --- indicators: keep matched, remove extra, add missing ---------------
    const existing = loadIndicators(scope);
    const existingCfgs = loadIndicatorConfigs(scope);
    // Multiset of wanted looks: signature -> template instances not yet matched
    // (two identical template rows need two live instances).
    const want = new Map<string, IndicatorInstance[]>();
    for (const inst of t.indicators) {
      const sig = savedIndicatorSignature(inst, t.indicatorConfigs[inst.id], t.avwapAnchors[inst.id]);
      const q = want.get(sig) ?? [];
      q.push(inst);
      want.set(sig, q);
    }
    const kept: IndicatorInstance[] = [];
    for (const inst of existing) {
      const sig = savedIndicatorSignature(inst, existingCfgs[inst.id], loadAvwapAnchor(scope, epic, inst.id));
      const q = want.get(sig);
      if (q && q.length > 0) {
        q.shift();
        kept.push(inst);
      } else {
        removeIndicatorById(chart, scope, inst.id);
        // Don't leave a placed anchor behind under a dead id for this epic.
        if (inst.type === "AVWAP") saveAvwapAnchor(scope, epic, inst.id, 0);
      }
    }
    // Same per-add ordering rules as the merge path: anchor before applyIndicator
    // (rehydrate:true reads it), config after success, failed adds roll back.
    const added: IndicatorInstance[] = [];
    for (const q of want.values()) {
      for (const inst of q) {
        const id = mintInstanceId(chart, inst.type);
        const anchor = t.avwapAnchors[inst.id];
        if (anchor) saveAvwapAnchor(scope, epic, id, anchor);
        const cfg = t.indicatorConfigs[inst.id];
        const ok = applyIndicator(chart, scope, epic, { id, type: inst.type }, {
          rehydrate: true,
          config: cfg,
          forceHidden: controller.indicatorsHidden.value,
        });
        if (!ok) {
          if (anchor) saveAvwapAnchor(scope, epic, id, 0);
          continue;
        }
        if (cfg) saveIndicatorConfig(scope, id, cfg);
        added.push({ id, type: inst.type });
      }
    }
    const full = [...kept, ...added];
    saveIndicators(scope, full);
    controller.indicators.set(full);
    if (controller.subPanesHidden.value && added.some((a) => isSubPaneIndicator(a.type)))
      controller.subPanesHidden.set(false);

    // --- drawings: the epic's set becomes exactly the template's ------------
    // Order-sensitive signature compare skips the rewrite (and the id-minting
    // rehydrate, which would drop selection) when the look is already exact.
    const existingDrawings = loadDrawings(scope, epic);
    const same =
      existingDrawings.length === t.drawings.length &&
      existingDrawings.every((d, i) => drawingSignature(d) === drawingSignature(t.drawings[i]));
    if (!same) {
      saveDrawings(scope, epic, t.drawings);
      controller.overlays.rehydrate();
      controller.coverDrawingAnchors?.();
    }
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/templates.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/templates.ts frontend/src/lib/templates.test.ts
git commit -m "feat(templates): replaceSymbolTemplate exact-look apply"
```

---

### Task 2: `applyLookOnOpen` replaces `maybeAutoApplyTemplate`

**Files:**
- Modify: `frontend/src/lib/templates.ts` (rewrite `maybeAutoApplyTemplate` → `applyLookOnOpen`)
- Test: `frontend/src/lib/templates.test.ts` (rewrite the `maybeAutoApplyTemplate gate` describe block)

**Interfaces:**
- Consumes: Task 1's `replaceSymbolTemplate`; existing `loadSymbolTemplate`, `loadDefaultTemplate`, `applyDefaultTemplate`.
- Produces: `applyLookOnOpen(chart: Chart, controller: ChartController, scope: string, epic: string): boolean` (true if any template applied). `maybeAutoApplyTemplate` is DELETED.

- [ ] **Step 1: Rewrite the gate tests** — replace the `maybeAutoApplyTemplate gate` describe block's calls with `applyLookOnOpen` and these behaviors:

```ts
describe("applyLookOnOpen", () => {
  it("replace-applies the per-symbol template even when the cell already has indicators", () => {
    P.saveIndicators(SCOPE, [{ id: "SLOPE", type: "SLOPE" }]); // birth-symbol leftovers
    P.saveSymbolTemplate({
      epic: EPIC,
      indicators: [{ id: "VOL#t", type: "VOL" }],
      indicatorConfigs: {}, drawings: [], avwapAnchors: {}, savedAt: 1,
    });
    expect(T.applyLookOnOpen(stubChart, stubController, SCOPE, EPIC)).toBe(true);
    expect(P.loadIndicators(SCOPE).map((i) => i.type)).toEqual(["VOL"]);
  });

  it("no per-symbol template + populated cell: keeps the cell as-is", () => {
    P.saveIndicators(SCOPE, [{ id: "EMA", type: "EMA" }]);
    P.saveDefaultTemplate({ indicators: [{ id: "VOL#d", type: "VOL" }], indicatorConfigs: {}, savedAt: 1 });
    expect(T.applyLookOnOpen(stubChart, stubController, SCOPE, EPIC)).toBe(false);
    expect(P.loadIndicators(SCOPE).map((i) => i.id)).toEqual(["EMA"]);
  });

  it("no per-symbol template + fresh cell: falls back to the global default (additive)", () => {
    P.saveDefaultTemplate({ indicators: [{ id: "VOL#d", type: "VOL" }], indicatorConfigs: {}, savedAt: 1 });
    expect(T.applyLookOnOpen(stubChart, stubController, SCOPE, EPIC)).toBe(true);
    expect(P.loadIndicators(SCOPE).map((i) => i.type)).toEqual(["VOL"]);
  });

  it("nothing saved anywhere: no-op", () => {
    expect(T.applyLookOnOpen(stubChart, stubController, SCOPE, EPIC)).toBe(false);
  });
});
```

(If the old describe block's stubController lacks `subPanesHidden.set` or `coverDrawingAnchors`, extend the stub — `coverDrawingAnchors` is optional-chained so omitting it is fine.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/templates.test.ts`
Expected: FAIL — `T.applyLookOnOpen is not a function`.

- [ ] **Step 3: Implement** — replace `maybeAutoApplyTemplate` entirely with:

```ts
// Make a cell LOOK like `epic`'s saved template on open (any open: new tab,
// symbol switch, mount). Per-symbol template exists → exact-look replace.
// No per-symbol template → the cell keeps whatever it has; only a completely
// fresh cell (no indicators, no drawings for this epic) gets the GLOBAL default
// (symbol-agnostic staples), additively as before. Returns true if applied.
// Caller contract: the OUTGOING symbol's look was already captured
// (flushTemplateCapture) before this runs — replace never destroys analysis.
export function applyLookOnOpen(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
): boolean {
  const t = loadSymbolTemplate(epic);
  if (t) {
    replaceSymbolTemplate(chart, controller, scope, epic, t);
    return true;
  }
  if (loadIndicators(scope).length > 0 || loadDrawings(scope, epic).length > 0) return false;
  const d = loadDefaultTemplate();
  if (d) {
    applyDefaultTemplate(chart, controller, scope, epic, d);
    return true;
  }
  return false;
}
```

Grep for other `maybeAutoApplyTemplate` references (`useLiveMarketData.ts` is updated in Task 4; leave it failing typecheck is NOT ok — update its import+call in this task minimally to `applyLookOnOpen` at the same call site, full wiring lands in Task 4).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/templates.test.ts && npx tsc --noEmit -p .` (adjust to the repo's typecheck script if different)
Expected: PASS / no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/templates.ts frontend/src/lib/templates.test.ts frontend/src/chart/useLiveMarketData.ts
git commit -m "feat(templates): applyLookOnOpen replace-on-open gate"
```

---

### Task 3: `flushTemplateCapture` + `flushPendingAutoSaves` in templateAutosave.ts

**Files:**
- Modify: `frontend/src/lib/templateAutosave.ts`
- Test: `frontend/src/lib/templateAutosave.test.ts`

**Interfaces:**
- Consumes: existing `captureSymbolTemplate`, `sameTemplate`, persist load/save.
- Produces: `flushTemplateCapture(scope: string, epic: string): void` (synchronous capture, IGNORES the autoSaveTemplates setting); `flushPendingAutoSaves(): void` (fires all pending debounced saves now — these keep the setting gate).

- [ ] **Step 1: Write failing tests** — append to `templateAutosave.test.ts`:

```ts
describe("flushTemplateCapture", () => {
  it("captures immediately even with autoSaveTemplates OFF", () => {
    setAutoSave(false);
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    flushTemplateCapture(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
  });

  it("cancels a pending debounced save for the same scope+epic", () => {
    vi.useFakeTimers();
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    flushTemplateCapture(SCOPE, EPIC);
    saveIndicators(SCOPE, []); // storage changes after flush...
    vi.runAllTimers(); // ...a surviving timer would capture the empty layout
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("flushPendingAutoSaves", () => {
  it("fires every pending debounced save immediately", () => {
    vi.useFakeTimers();
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    flushPendingAutoSaves();
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
    vi.runAllTimers(); // nothing left pending
    vi.useRealTimers();
  });

  it("pending saves keep the setting gate (OFF → no write)", () => {
    vi.useFakeTimers();
    setAutoSave(false);
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    flushPendingAutoSaves();
    expect(loadSymbolTemplate(EPIC)).toBeNull();
    vi.useRealTimers();
  });
});
```

(Import the two new functions in the test file's import block.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/templateAutosave.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement** — change the `timers` map to carry its key parts, add the two functions:

```ts
const timers = new Map<string, { scope: string; epic: string; timer: ReturnType<typeof setTimeout> }>();
const DEBOUNCE_MS = 800;

export function scheduleAutoSave(scope: string, epic: string): void {
  const key = `${scope} ${epic}`;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing.timer);
  timers.set(key, {
    scope,
    epic,
    timer: setTimeout(() => {
      timers.delete(key);
      maybeAutoSaveTemplate(scope, epic);
    }, DEBOUNCE_MS),
  });
}

export function cancelAutoSave(scope: string, epic: string): void {
  const key = `${scope} ${epic}`;
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    timers.delete(key);
  }
}

// Capture `scope`'s current look into `epic`'s template RIGHT NOW, regardless
// of the autoSaveTemplates setting. Used at symbol switch, BEFORE the incoming
// symbol's replace-apply: preservation of on-chart analysis is non-negotiable,
// so this must not depend on a user preference or a debounce timer.
export function flushTemplateCapture(scope: string, epic: string): void {
  cancelAutoSave(scope, epic); // the pending capture is superseded by this one
  const next = captureSymbolTemplate(scope, epic);
  if (sameTemplate(loadSymbolTemplate(epic), next)) return;
  saveSymbolTemplate(next);
}

// Fire every pending debounced save immediately. Called before purgeScope on
// cell/tab close so the last <800ms of edits aren't lost with the timer
// (cancelAutoSave alone drops them). Setting gate preserved: these are the
// ordinary autosaves, just early.
export function flushPendingAutoSaves(): void {
  for (const { scope, epic, timer } of [...timers.values()]) {
    clearTimeout(timer);
    maybeAutoSaveTemplate(scope, epic);
  }
  timers.clear();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/templateAutosave.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/templateAutosave.ts frontend/src/lib/templateAutosave.test.ts
git commit -m "feat(templates): synchronous capture flush helpers"
```

---

### Task 4: Wire capture-on-switch + replace-on-open into useLiveMarketData; flush before purge in App.tsx

**Files:**
- Modify: `frontend/src/chart/useLiveMarketData.ts` (symbol/period effect, ~lines 94-142 and ~304-314)
- Modify: `frontend/src/App.tsx` (three `purgeScope` close paths: ~1042, ~1203, ~1285)

**Interfaces:**
- Consumes: Task 2's `applyLookOnOpen`, Task 3's `flushTemplateCapture` / `flushPendingAutoSaves`; existing `loadSnapshotMeta` (already imported in useLiveMarketData).
- Produces: behavior only; no new exports.

- [ ] **Step 1: useLiveMarketData — capture the outgoing symbol.** Next to `prevEpicRef` (~line 94) add:

```ts
// Epic whose look (template) this cell last applied — gates replace-on-open to
// actual symbol opens: a TF-only effect re-run must NOT re-apply the template
// (it would revert the last <800ms of not-yet-autosaved edits).
const lookEpicRef = useRef<string | null>(null);
```

Immediately after `const epicChanged = prevEpicRef.current !== symbol.epic;` (~line 135), BEFORE `prevEpicRef.current = symbol.epic;`:

```ts
// Preserve the outgoing symbol's analysis BEFORE anything of the incoming
// symbol is written: capture it into its own template now, unconditionally
// (flushTemplateCapture ignores the autoSaveTemplates setting — the
// replace-on-open below would otherwise destroy un-captured work). Snapshot
// tabs are study copies and must never write the symbol's template.
if (epicChanged && !loadSnapshotMeta(scope)) {
  flushTemplateCapture(scope, prevEpicRef.current);
}
```

- [ ] **Step 2: useLiveMarketData — replace-on-open.** Replace the `maybeAutoApplyTemplate` block (~line 304-314, adjusted in Task 2) with:

```ts
// Make the cell LOOK like this symbol's saved template (replace-on-open).
// Runs once per epic open (lookEpicRef), after rehydrate so it sees final
// state. A snapshot tab marks the epic handled WITHOUT applying — and must
// keep doing so through Unlock, or the freshly unlocked study copy would be
// stomped by the symbol's template on the next effect re-run.
if (lookEpicRef.current !== symbol.epic) {
  lookEpicRef.current = symbol.epic;
  if (!markerMeta) {
    applyLookOnOpen(handle.chartRef.current, controller, scope, symbol.epic);
  }
}
```

Update imports: `applyLookOnOpen` from `../lib/templates`, `flushTemplateCapture` from `../lib/templateAutosave`.

- [ ] **Step 3: App.tsx — flush pending autosaves before purging scopes.** In each of the three close/copy paths that call `purgeScope` (~1042 tab close, ~1203 merge-move, ~1285 cell close), call `flushPendingAutoSaves()` once BEFORE the first `purgeScope` in that handler. Import it from `./lib/templateAutosave`. (This closes the pre-existing lose-last-800ms-of-edits window on close; a timer surviving into post-purge would capture an empty layout, which `cancelAutoSave` in ChartCore's cleanup only partially prevents.)

- [ ] **Step 4: Typecheck + full test run**

Run: `cd frontend && npx tsc --noEmit -p . && npx vitest run src/lib/`
Expected: clean typecheck, all lib tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/useLiveMarketData.ts frontend/src/App.tsx
git commit -m "feat(chart): symbol look follows template on open + capture-on-switch"
```

---

### Task 5: Live verification (browser)

**Files:** none (verification only)

- [ ] **Step 1:** In the dev app (Capital.com live): open a new chart tab, pick GOLD. Expected: full GOLD look appears — EMA, VOL, AVWAP curves, 3 segments, fib; the birth-symbol's SLOPE indicator is gone.
- [ ] **Step 2:** On GOLD, add a drawing (segment). Switch the same cell to US100, then back to GOLD. Expected: the new segment is still there (capture-on-switch), US100 showed ITS exact look meanwhile.
- [ ] **Step 3:** TF switch on GOLD immediately after dragging a drawing (within ~1s). Expected: the drag survives (TF-only re-run does not re-apply the template).
- [ ] **Step 4:** Open a restored snapshot tab. Expected: unchanged saved state, no template graft; after Unlock, still no graft.
- [ ] **Step 5:** Report results with screenshots; fix anything that fails before claiming done.
