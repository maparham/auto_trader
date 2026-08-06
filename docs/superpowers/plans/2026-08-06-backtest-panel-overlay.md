# Backtest Panel Overlay + Auto-Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The backtest config panel overlays the chart (chart canvas never resizes) and auto-hides on chart click, with a pin button that restores today's docked/shrinking layout.

**Architecture:** The two panel `<aside>`s (`.bt-results-col` + `.bt-cfg-panel`) get wrapped in a mode div: pinned → `display: contents` (today's flex-sibling docking, byte-identical layout); unpinned → absolutely positioned overlay inside `.workspace` that slides off-screen when hidden. Hidden state lives in a module signal (`backtestPanelHiddenSignal`) so App/toolbar can reveal it. While the overlay is visible, the focused chart's klinecharts right offset is bumped by the overlay width so the newest candles stay visible.

**Tech Stack:** React 18 + TypeScript, klinecharts 10 (`chart.getOffsetRightDistance()` / `setOffsetRightDistance()`), the app's `Signal` class (`frontend/src/lib/signals.ts`), vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-06-backtest-panel-overlay-design.md`

## Global Constraints

- All frontend commands run from `frontend/`: tests `npx vitest run <file>`, typecheck `npx tsc -b`, lint `npx eslint src/<file>`.
- Unpinned (overlay) is the **default**; pinned reproduces today's behaviour exactly.
- Only **chart mousedown** hides the panel — nothing hover-based.
- The panel component stays **mounted while hidden** (config/results/scroll state preserved).
- Tooltips use the shared `Tooltip` component (per CLAUDE.md), never `title=`.
- Comment style: match the file's dense explanatory comments (why, not what).

---

### Task 1: Pinned-mode persistence helper

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts` (after `saveBacktestResultsColWidth`, ~line 238)
- Test: `frontend/src/lib/persist.test.ts` (append near the existing backtest width tests, ~line 928)

**Interfaces:**
- Produces: `loadBacktestPanelPinned(): boolean` (default `false`), `saveBacktestPanelPinned(on: boolean): void` — exported from `frontend/src/lib/persist` (defaults.ts is re-exported by the persist barrel; verify with `grep -n "defaults" frontend/src/lib/persist/index.ts` and follow the same pattern as `loadBacktestResultsSideBySide` if a named re-export is needed).

- [ ] **Step 1: Write the failing test**

In `frontend/src/lib/persist.test.ts`, next to the results-col width tests (search for `loadBacktestResultsColWidth`), add:

```ts
it("backtest panel pinned: defaults to false (overlay) and round-trips", () => {
  expect(P.loadBacktestPanelPinned()).toBe(false);
  P.saveBacktestPanelPinned(true);
  expect(P.loadBacktestPanelPinned()).toBe(true);
  P.saveBacktestPanelPinned(false);
  expect(P.loadBacktestPanelPinned()).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts -t "pinned"`
Expected: FAIL — `loadBacktestPanelPinned is not a function`.

- [ ] **Step 3: Implement**

In `frontend/src/lib/persist/defaults.ts`, after `saveBacktestResultsColWidth` (~line 238):

```ts
// Backtest panel layout mode: pinned docks the panel beside the chart (the
// chart shrinks, pre-overlay behaviour); unpinned overlays the chart and
// auto-hides on chart click. Device-local view preference like the width above.
const BACKTEST_PANEL_PINNED_KEY = `${PREFIX}.backtestPanelPinned`;
export function loadBacktestPanelPinned(): boolean {
  return load<boolean>(BACKTEST_PANEL_PINNED_KEY, false);
}
export function saveBacktestPanelPinned(on: boolean): void {
  saveLocal(BACKTEST_PANEL_PINNED_KEY, on);
}
```

If the persist barrel (`frontend/src/lib/persist/index.ts` or `persist.ts`) re-exports named symbols rather than `export *`, add the two names there too.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: PASS (whole file — no regressions).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist/defaults.ts frontend/src/lib/persist.test.ts
git commit -m "feat(backtest): persist panel pinned/overlay layout mode"
```

---

### Task 2: Layout-mode wrapper + pin button + CSS

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (render root ~lines 1868–1930; state near `panelWidth` ~line 1149; imports ~line 126)
- Modify: `frontend/src/App.css` (`.workspace` rule line 29; new rules after the `.bt-cfg-panel` block ~line 1130)
- Test: create `frontend/src/BacktestSettingsModal.overlay.test.tsx`

**Interfaces:**
- Consumes: `loadBacktestPanelPinned` / `saveBacktestPanelPinned` from Task 1.
- Produces: DOM contract used by Tasks 3–5 and their tests — a wrapper `div.bt-dock` (pinned) or `div.bt-overlay` (unpinned, plus `.bt-hidden` when hidden) around both `<aside>`s; a header pin toggle `button.bt-pin-btn`; component state `pinned: boolean`.

- [ ] **Step 1: Create the test file with the shared preamble**

Create `frontend/src/BacktestSettingsModal.overlay.test.tsx`. Copy the mock preamble pattern from `BacktestSettingsModal.test.tsx` (that's the established per-topic-file pattern — `BacktestSettingsModal.exprSweep.test.tsx` does the same):

```tsx
// @vitest-environment jsdom
//
// Overlay / auto-hide layout mode for the backtest panel: pin toggle, hidden
// state, chart-click hide, peek-tab reveal, and chart right-offset compensation.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const mockStrategies = vi.fn().mockResolvedValue([]);
const mockComputeStatus = vi.fn().mockResolvedValue({ remoteConfigured: false });
const mockComputeHostState = vi.fn().mockResolvedValue({ state: "unconfigured", detail: null });
const brokerProfile = {
  epic: "TEST",
  spread: 0.8,
  slippage: { kind: "fixed" as const, value: 0.2, atrMult: 0 },
  finLongDailyPct: -0.01,
  finShortDailyPct: 0.01,
  source: "broker" as const,
  updatedAt: 123,
};
const mockGetCostProfile = vi.fn().mockResolvedValue(brokerProfile);
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchStrategies: (...args: unknown[]) => mockStrategies(...args),
    computeStatus: (...args: unknown[]) => mockComputeStatus(...args),
    computeHostState: (...args: unknown[]) => mockComputeHostState(...args),
    getCostProfile: (...args: unknown[]) => mockGetCostProfile(...args),
  };
});

import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import { resetCostProfileCache } from "./lib/costProfileCache";
import { saveBacktestPanelPinned, loadBacktestPanelPinned } from "./lib/persist";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  resetCostProfileCache();
});

function renderPanel(controller: import("./lib/chartController").ChartController | null = null) {
  return render(
    <BacktestSettingsModal
      initial={defaultBacktestConfig()}
      epic="TEST"
      brokerId="capital"
      resolution="MINUTE"
      controller={controller}
      chartTimezone="UTC"
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}
```

> Note: verify the `resetCostProfileCache` import path against `BacktestSettingsModal.test.tsx` (top of file) and copy whatever it actually imports — including any additional mocked api functions the modal now calls on mount. If rendering throws on a missing mock, add that function to the `./api` mock the same way the main test file does.

Then add the first tests:

```tsx
describe("backtest panel layout mode", () => {
  it("defaults to the overlay (unpinned) wrapper", () => {
    renderPanel();
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(document.querySelector(".bt-dock")).toBeNull();
  });

  it("respects a persisted pinned choice and toggles + persists via the pin button", () => {
    saveBacktestPanelPinned(true);
    renderPanel();
    expect(document.querySelector(".bt-dock")).toBeTruthy();
    expect(document.querySelector(".bt-overlay")).toBeNull();
    // Unpin → overlay mode, persisted.
    fireEvent.click(screen.getByRole("button", { name: /unpin panel/i }));
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(loadBacktestPanelPinned()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx`
Expected: FAIL — no `.bt-overlay` element, no pin button.

- [ ] **Step 3: Implement the wrapper + pin button**

In `frontend/src/BacktestSettingsModal.tsx`:

(a) Extend the persist import (~line 126) with `loadBacktestPanelPinned, saveBacktestPanelPinned`.

(b) Near the `panelWidth` state (~line 1149) add:

```tsx
  // Layout mode: pinned docks the panel beside the chart (the chart shrinks —
  // the pre-overlay behaviour); unpinned overlays the chart and auto-hides on
  // chart click. Device-local, like the width.
  const [pinned, setPinnedState] = useState<boolean>(loadBacktestPanelPinned);
  const setPinned = (on: boolean) => {
    setPinnedState(on);
    saveBacktestPanelPinned(on);
  };
```

(c) Wrap the render root. The current root (~line 1868) is a fragment holding the optional `.bt-results-col` aside and the `.bt-cfg-panel` aside. Replace the fragment with a wrapper div; `display: contents` in pinned mode keeps the docked flex layout byte-identical:

```tsx
  return (
    <>
    <div className={pinned ? "bt-dock" : "bt-overlay"}>
    {sideBySide && (
      <aside className={`bt-results-col bt-mode-${btMode}`} style={{ width: resultsColWidth }}>
        {/* ...unchanged... */}
      </aside>
    )}
    <aside className={`bt-cfg-panel bt-mode-${btMode}`} style={{ width: panelWidth }}>
        {/* ...unchanged... */}
    </aside>
    </div>
    </>
  );
```

(Keep the outer fragment — Task 3 adds the peek tab as a second child.)

(d) Add the pin toggle in `.bt-cfg-head` (~line 1924), left of `CloseButton`:

```tsx
        <div className="bt-cfg-head">
          <span className="bt-cfg-title">
            Backtest — <strong>{epic}</strong> <span className="bt-cfg-res">{effectiveRes}</span>
          </span>
          <span className="bt-cfg-head-actions">
            <Tooltip
              content={
                pinned
                  ? "Unpin: overlay the chart and hide on chart click"
                  : "Pin: dock beside the chart (chart shrinks)"
              }
            >
              <button
                className={`bt-pin-btn${pinned ? " on" : ""}`}
                aria-label={pinned ? "Unpin panel" : "Pin panel"}
                onClick={() => setPinned(!pinned)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M9.5 1.5l5 5-2.2.6-2.5 2.5.4 3.4-2-2-4.2 4.2-1-1L7.2 10l-2-2 3.4.4 2.5-2.5.4-2.4z"
                    fill={pinned ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </Tooltip>
            <CloseButton onClick={onClose} />
          </span>
        </div>
```

`Tooltip` is already imported in this file (verify; import from `./components/Tooltip` if not).

- [ ] **Step 4: Add the CSS**

In `frontend/src/App.css`:

(a) `.workspace` (line 29) becomes the overlay's positioning context:

```css
.workspace { flex: 1; display: flex; min-height: 0; position: relative; }
```

(b) After the `.bt-results-col` block (~line 1130):

```css
/* Backtest panel layout modes. Pinned: the wrapper dissolves (display:contents)
   so both asides stay flex siblings of .chart — the pre-overlay docked layout,
   unchanged. Unpinned: the wrapper overlays the chart's right edge inside
   .workspace; the chart canvas never resizes. Hidden slides it off-screen but
   keeps it mounted, preserving config/results state. */
.bt-dock { display: contents; }
.bt-overlay {
  position: absolute;
  top: 0; right: 0; bottom: 0;
  display: flex;
  z-index: 30;
  transition: transform 0.18s ease;
  box-shadow: -6px 0 18px rgba(0, 0, 0, 0.25);
}
.bt-overlay.bt-hidden {
  transform: translateX(100%);
  pointer-events: none;
  visibility: hidden;
  transition: transform 0.18s ease, visibility 0s 0.18s;
}
/* Right-pinned cluster in the config header: pin toggle + close. */
.bt-cfg-head-actions { display: inline-flex; align-items: center; gap: 6px; }
.bt-pin-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0;
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  cursor: pointer; border-radius: 4px;
}
.bt-pin-btn:hover { background: var(--hover); border-color: var(--text-faint); }
.bt-pin-btn.on { color: var(--accent); border-color: var(--accent); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 6: Check for regressions in the existing panel tests**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/BacktestSettingsModal.exprSweep.test.tsx`
Expected: PASS. (The wrapper div may break tests that assume the aside is the render root — fix any such selector by targeting `.bt-cfg-panel` directly, not by changing the component.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/App.css frontend/src/BacktestSettingsModal.overlay.test.tsx
git commit -m "feat(backtest): overlay layout mode with pin-to-dock toggle"
```

---

### Task 3: Hidden state — chart-click hide, peek-tab + toolbar reveal

**Files:**
- Modify: `frontend/src/lib/signals.ts` (after `backtestRunningSignal`, ~line 406)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (render root from Task 2; effects near the pinned state)
- Modify: `frontend/src/App.tsx` (the `backtestSettingsRequest` subscription, line 310)
- Test: `frontend/src/BacktestSettingsModal.overlay.test.tsx` (append)

**Interfaces:**
- Consumes: `.bt-overlay` / `.bt-hidden` classes and `pinned` state from Task 2.
- Produces: `backtestPanelHiddenSignal: Signal<boolean>` exported from `frontend/src/lib/signals.ts` (true = overlay slid off-screen); DOM: `button.bt-peek` (aria-label "Show backtest panel") rendered only when unpinned && hidden. Task 4 reads/writes the same signal.

- [ ] **Step 1: Write the failing tests**

Append to `BacktestSettingsModal.overlay.test.tsx`:

```tsx
import { backtestPanelHiddenSignal } from "./lib/signals";

// A stand-in for the chart area the panel overlays. The hide listener keys on
// .chart-cells (the grid container in App), which isn't rendered by the panel
// component itself — so the tests provide one.
function withChartCells(): HTMLElement {
  const cells = document.createElement("div");
  cells.className = "chart-cells";
  document.body.appendChild(cells);
  return cells;
}

describe("overlay auto-hide", () => {
  beforeEach(() => backtestPanelHiddenSignal.set(false));
  afterEach(() => {
    document.querySelectorAll(".chart-cells").forEach((n) => n.remove());
  });

  it("hides on chart mousedown, reveals via the peek tab, state preserved", () => {
    const cells = withChartCells();
    renderPanel();
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
    // Still mounted — the config body is in the DOM, just slid off.
    expect(document.querySelector(".bt-cfg-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show backtest panel/i }));
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
  });

  it("does not hide on mousedown outside the chart (e.g. inside the panel)", () => {
    withChartCells();
    renderPanel();
    fireEvent.mouseDown(document.querySelector(".bt-cfg-panel")!);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
  });

  it("pinned mode ignores chart clicks and renders no peek tab", () => {
    saveBacktestPanelPinned(true);
    const cells = withChartCells();
    renderPanel();
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-hidden")).toBeNull();
    expect(document.querySelector(".bt-peek")).toBeNull();
  });

  it("resets the hidden signal on unmount so a reopen starts revealed", () => {
    withChartCells();
    const { unmount } = renderPanel();
    backtestPanelHiddenSignal.set(true);
    unmount();
    expect(backtestPanelHiddenSignal.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx`
Expected: the new describe block FAILS (no signal export → import error first; after adding the signal in step 3 the behaviours fail).

- [ ] **Step 3: Implement**

(a) `frontend/src/lib/signals.ts`, after `backtestRunningSignal` (~line 406):

```ts
// True while the (unpinned) backtest overlay is slid off-screen. Lives here —
// not in panel state — so the toolbar/App can reveal a hidden panel instead of
// closing/reopening it. Reset by the panel on unmount.
export const backtestPanelHiddenSignal = new Signal<boolean>(false);
```

(b) `BacktestSettingsModal.tsx` — near the `pinned` state add hidden-state wiring:

```tsx
  // Overlay hidden state (module signal so the toolbar can reveal, see
  // signals.ts). Reset on unmount: a re-opened panel always starts revealed.
  const hidden = useSyncExternalStore(
    (cb) => backtestPanelHiddenSignal.subscribe(cb),
    () => backtestPanelHiddenSignal.value,
  );
  useEffect(() => () => backtestPanelHiddenSignal.set(false), []);
  // Chart mousedown → hide (unpinned only). Capture-phase document listener
  // keyed on .chart-cells: only real chart-area presses hide — panel clicks,
  // toolbar clicks, and portaled popovers never match, so nothing hover- or
  // focus-based can accidentally dismiss the panel.
  useEffect(() => {
    if (pinned || hidden) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".chart-cells")) backtestPanelHiddenSignal.set(true);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [pinned, hidden]);
```

(`useSyncExternalStore` is already imported in this file — line 362 uses it.)

(c) Render: the wrapper class from Task 2 gains the hidden flag, and the peek tab joins the fragment as a sibling of the wrapper (it must stay visible while the wrapper is off-screen):

```tsx
    <div className={pinned ? "bt-dock" : `bt-overlay${hidden ? " bt-hidden" : ""}`}>
      {/* ...both asides, unchanged from Task 2... */}
    </div>
    {!pinned && hidden && (
      <button
        className="bt-peek"
        aria-label="Show backtest panel"
        onClick={() => backtestPanelHiddenSignal.set(false)}
      >
        ◂ Backtest
      </button>
    )}
```

(d) `App.tsx` line 310 — a toolbar open-request also reveals a hidden panel:

```tsx
  useEffect(() => backtestSettingsRequest.subscribe(() => {
    openBacktestCfg(true);
    // An already-open-but-hidden overlay re-reveals rather than re-opening.
    backtestPanelHiddenSignal.set(false);
  }), []);
```

Add `backtestPanelHiddenSignal` to the existing `./lib/signals` import in App.tsx.

(e) `App.css` — peek tab, after the `.bt-pin-btn` rules:

```css
/* Peek tab: the only visible remnant of a hidden overlay — right edge,
   vertically centered, brings the panel back. */
.bt-peek {
  position: absolute;
  right: 0; top: 40%;
  z-index: 29;
  writing-mode: vertical-rl;
  padding: 10px 4px;
  border: 1px solid var(--border); border-right: none;
  border-radius: 6px 0 0 6px;
  background: var(--surface); color: var(--text-faint);
  font-size: 11px; cursor: pointer;
}
.bt-peek:hover { color: var(--text); background: var(--hover); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/signals.ts frontend/src/BacktestSettingsModal.tsx frontend/src/App.tsx frontend/src/App.css frontend/src/BacktestSettingsModal.overlay.test.tsx
git commit -m "feat(backtest): overlay hides on chart click, peek tab + toolbar reveal"
```

---

### Task 4: Interaction carve-outs — Pick Range duck, run-in-flight suppression

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (the two effects from Task 3; the `pickingRange` wiring ~line 428)
- Test: `frontend/src/BacktestSettingsModal.overlay.test.tsx` (append)

**Interfaces:**
- Consumes: `backtestPanelHiddenSignal` (Task 3); `pickingRange` state (existing, line 368); `backtestRunningSignal`, `sweepStateSignal`, `wfoStateSignal` from `./lib/signals` (existing exports, already imported in this file — verify and extend the import if `backtestRunningSignal` is missing).
- Produces: behaviour only — no new exports.

- [ ] **Step 1: Write the failing tests**

Append to the overlay test file. `ChartController` is a plain class (`new ChartController(cellId, scope)`, `frontend/src/lib/chartController.ts:161`) whose `rangePickArmed` is a real `Signal<boolean>` — no mocking needed:

```tsx
import { ChartController } from "./lib/chartController";
import { backtestRunningSignal } from "./lib/signals";
import { act } from "@testing-library/react";

describe("overlay carve-outs", () => {
  beforeEach(() => {
    backtestPanelHiddenSignal.set(false);
    backtestRunningSignal.set(false);
  });

  it("arming Pick Range ducks the panel; disarming brings it back", () => {
    const controller = new ChartController("cell-1", "scope-1");
    renderPanel(controller);
    act(() => controller.rangePickArmed.set(true));
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
    act(() => controller.rangePickArmed.set(false));
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
  });

  it("a run in flight suppresses hide-on-chart-click; completion restores it", () => {
    const cells = withChartCells();
    renderPanel();
    act(() => backtestRunningSignal.set(true));
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
    act(() => backtestRunningSignal.set(false));
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
  });
});
```

(Reuse the `withChartCells` helper and its `afterEach` cleanup from Task 3 — hoist them above both describes if needed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx -t "carve-outs"`
Expected: FAIL — pick-range doesn't duck; chart click hides mid-run.

- [ ] **Step 3: Implement**

In `BacktestSettingsModal.tsx`:

(a) Run-in-flight guard inside the Task 3 mousedown handler (signals are read at event time — no extra deps):

```tsx
    const onDown = (e: MouseEvent) => {
      // While a run streams you're watching results land — chart clicks
      // shouldn't dismiss them. Hide-on-click resumes when the run completes.
      const running =
        backtestRunningSignal.value ||
        !!sweepStateSignal.value?.running ||
        !!wfoStateSignal.value?.running;
      if (running) return;
      const t = e.target as Element | null;
      if (t?.closest(".chart-cells")) backtestPanelHiddenSignal.set(true);
    };
```

Extend the `./lib/signals` import with `backtestRunningSignal` if it isn't imported yet (`sweepStateSignal` / `wfoStateSignal` already are).

(b) Pick-Range duck — a new effect next to the hidden-state wiring. `pickingRange` already mirrors `controller.rangePickArmed` (line 428); track the previous value so only a true→false transition reveals (not the initial false):

```tsx
  // Pick Range is a chart drag by definition: arming it ducks the overlay out
  // of the way; disarming (picked or cancelled) brings it back. Pinned mode
  // needs no duck — the chart isn't covered.
  const prevPicking = useRef(false);
  useEffect(() => {
    if (!pinned) {
      if (pickingRange) backtestPanelHiddenSignal.set(true);
      else if (prevPicking.current) backtestPanelHiddenSignal.set(false);
    }
    prevPicking.current = pickingRange;
  }, [pickingRange, pinned]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.overlay.test.tsx
git commit -m "feat(backtest): overlay ducks for Pick Range, stays put mid-run"
```

---

### Task 5: Chart right-offset compensation

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (new effect next to the hidden-state wiring)
- Test: `frontend/src/BacktestSettingsModal.overlay.test.tsx` (append)

**Interfaces:**
- Consumes: `controller.chart` (klinecharts `Chart | null`, `frontend/src/lib/chartController.ts:135`) — `getOffsetRightDistance(): number` / `setOffsetRightDistance(distance: number): void` (klinecharts 10, `dist/index.d.ts:859-860`); `pinned`, `hidden`, `panelWidth`, `sideBySide`, `resultsColWidth` (existing state).
- Produces: behaviour only.

- [ ] **Step 1: Write the failing test**

```tsx
describe("chart offset compensation", () => {
  function stubChart() {
    let offset = 6; // klinecharts' default-ish base offset
    return {
      getOffsetRightDistance: vi.fn(() => offset),
      setOffsetRightDistance: vi.fn((d: number) => { offset = d; }),
    };
  }

  beforeEach(() => backtestPanelHiddenSignal.set(false));

  it("bumps the offset by the overlay width while visible, restores on hide", () => {
    const controller = new ChartController("cell-1", "scope-1");
    const chart = stubChart();
    controller.chart = chart as unknown as import("klinecharts").Chart;
    renderPanel(controller);
    // Visible overlay: base (6) + panel width (default 720).
    expect(chart.setOffsetRightDistance).toHaveBeenLastCalledWith(726);
    act(() => backtestPanelHiddenSignal.set(true));
    // Hidden: restored to the captured base.
    expect(chart.setOffsetRightDistance).toHaveBeenLastCalledWith(6);
  });

  it("pinned mode never touches the offset", () => {
    saveBacktestPanelPinned(true);
    const controller = new ChartController("cell-1", "scope-1");
    const chart = stubChart();
    controller.chart = chart as unknown as import("klinecharts").Chart;
    renderPanel(controller);
    expect(chart.setOffsetRightDistance).not.toHaveBeenCalled();
  });
});
```

> The 726 expectation assumes the default panel width (720, `BACKTEST_PANEL_DEFAULT_WIDTH`) — `localStorage.clear()` in `beforeEach` guarantees it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx -t "offset"`
Expected: FAIL — `setOffsetRightDistance` never called.

- [ ] **Step 3: Implement**

In `BacktestSettingsModal.tsx`, next to the hidden-state wiring:

```tsx
  // While the overlay is visible it covers the chart's right edge — exactly
  // where the newest candles sit. Compensate: bump the chart's right offset by
  // the overlay's total width so the latest bars slide left into view, and
  // restore the captured base on hide/close/pin. Width deps keep it live
  // during handle drags (cleanup restores base, next pass re-applies).
  useEffect(() => {
    if (pinned || hidden) return;
    const chart = controller?.chart;
    if (!chart) return;
    const base = chart.getOffsetRightDistance();
    const overlayWidth = panelWidth + (sideBySide ? resultsColWidth : 0);
    chart.setOffsetRightDistance(base + overlayWidth);
    return () => chart.setOffsetRightDistance(base);
  }, [pinned, hidden, controller, panelWidth, sideBySide, resultsColWidth]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.overlay.test.tsx`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.overlay.test.tsx
git commit -m "feat(backtest): shift chart right offset under the visible overlay"
```

---

### Task 6: Full verification + manual smoke test

**Files:**
- No new files — verification only.

- [ ] **Step 1: Typecheck, lint, full unit suite**

```bash
cd frontend
npx tsc -b
npx eslint src/BacktestSettingsModal.tsx src/BacktestSettingsModal.overlay.test.tsx src/App.tsx src/lib/signals.ts src/lib/persist/defaults.ts
npx vitest run
```

Expected: all clean. Fix anything that surfaces (types, unused imports, test fallout in files that render the panel).

- [ ] **Step 2: Manual smoke test (dev server)**

Run `npm run dev` in `frontend/` (backend running per the project's usual setup) and verify in a browser, ideally at a laptop-ish window width (~1280px):

1. Open the Backtest panel → it overlays the chart's right edge; the chart does **not** reflow; newest candles slide left of the panel.
2. Click the chart → panel slides away; peek tab ("◂ Backtest") appears on the right edge; click it → panel returns with config intact.
3. Toolbar Backtest gear while hidden → panel reveals (doesn't reset).
4. Pin (📌) → panel docks, chart shrinks (pre-change behaviour); chart clicks no longer hide it; reload → still pinned. Unpin → overlay returns; reload → still unpinned.
5. Pick Range → panel ducks during the drag, returns with the picked range filled in.
6. Run a backtest → while it streams, chart clicks don't hide the panel; after completion they do.
7. Side-by-side results column on → both columns slide as one surface; offset compensation covers the combined width.
8. Drag the width handle → offset compensation tracks live.

- [ ] **Step 3: Fix-and-commit anything the smoke test surfaces**

Each fix: smallest change that addresses the observed issue, re-verify, then

```bash
git add -A && git commit -m "fix(backtest): <observed issue>"
```

- [ ] **Step 4: Final commit / branch state**

Ensure the working tree is clean and all tests pass. The branch `feat/backtest-panel-overlay` is ready for review/merge.
