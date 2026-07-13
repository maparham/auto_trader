# Analysis Sub-tabs and Collapsible Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the backtest Analysis tab into three sub-tabs (Placement / What-if / Context) and make every section header a collapsible toggle, with device-local persistence for both.

**Architecture:** Frontend-only restructuring of `BacktestAnalysisPanel.tsx`. A secondary `.seg` tablist picks one of three pages; each section header gains a chevron toggle. Active tab and collapsed-slug set persist via two new `saveLocal` flat keys registered in `DEVICE_LOCAL_FLAT_KEYS` (otherwise `hydrateFromBackend` prunes them on the second reload).

**Tech Stack:** React + TypeScript (Vite), vitest + @testing-library/react (jsdom), plain CSS in `App.css`.

**Spec:** `docs/superpowers/specs/2026-07-13-analysis-subtabs-design.md`

## Global Constraints

- Frontend only; formatting and layout, no analysis logic changes. No backend changes.
- Reuse shared components/classes (`.seg`, existing `bt-analysis-*` classes); no new one-off styling systems.
- No em dash or "--" as punctuation anywhere in copy or comments (rephrase with colon/comma/period).
- Typecheck via `npx tsc -b` from `frontend/`: 60 pre-existing errors, zero new.
- All work happens on `main` directly (1-person repo convention). Commit per task.
- Test command: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`

## Key codebase facts (read before starting)

- `frontend/src/BacktestAnalysisPanel.tsx` currently renders everything on one page: a "Stop & target placement check" section (readout bullets + three `Dist` blocks), `WhatIfSection`, "Exit reasons", and five context tables mapped from a `[key, label]` tuple array.
- The `.seg` segmented-control pattern (see `frontend/src/BacktestPanel.tsx:195-228`): `<div className="seg" role="tablist" aria-label="...">` containing `<button className={on ? "seg-on" : ""} role="tab" aria-selected={on} onClick=...>`. CSS at `App.css:1918-1925`.
- Persistence: `load<T>(key, fallback)` reads, `saveLocal<T>(key, value)` writes without backend mirroring. Import from `./lib/persist` (barrel). Device-local flat keys MUST be added to `DEVICE_LOCAL_FLAT_KEYS` in `frontend/src/lib/persist/core.ts:117-124`. Existing helper pattern: `loadBacktestSide`/`saveBacktestSide` in `frontend/src/lib/persist/defaults.ts:148-156`.
- `InfoTip` (`frontend/src/components/InfoTip.tsx`) already calls `e.preventDefault()` and `e.stopPropagation()` on click, so an InfoTip inside a clickable header will NOT toggle the section. No extra wrapping needed.
- `App.css:936` has selector `.bt-analysis-section h4 .ind-info` styling InfoTips inside section headers; keep InfoTips as descendants of the `h4` so this keeps matching (see memory: InfoTip outside a styled container renders as a black box).
- Tests: vitest without jest globals, so `afterEach(cleanup)` is manual. jsdom `localStorage` persists across renders within a test file, so tests must clear it between cases.
- The `Dist` component returns `null` when all buckets are empty; preserve that (collapsible header included: an empty Dist renders nothing at all).

## Section slugs (persistence identity, stable, not display labels)

| Slug | Section | Page |
| --- | --- | --- |
| `placement-readouts` | "Stop & target placement check" readout bullets (h4 toggles bullets only; the Dist blocks below have their own toggles) | Placement |
| `dist-winners-mae` | Winners: worst drawdown before profit | Placement |
| `dist-losers-mae` | Losers: worst drawdown | Placement |
| `dist-result-r` | Result distribution (R) | Placement |
| `whatif` | The whole What if section (bullets + both curve tables) | What-if |
| `exit-reasons` | Exit reasons table | Context |
| `ctx-trend` | Trend at entry | Context |
| `ctx-vol-regime` | Volatility regime | Context |
| `ctx-session` | Session | Context |
| `ctx-candle-pattern` | Entry-bar pattern | Context |
| `ctx-day-of-week` | Day of week | Context |

Unknown slugs in the stored array are ignored (membership test only); sections not listed are expanded.

---

### Task 1: Persistence keys and helpers

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts` (append after `saveBacktestPeriodsShown`, ~line 202)
- Modify: `frontend/src/lib/persist/core.ts:117-124` (`DEVICE_LOCAL_FLAT_KEYS`)

**Interfaces:**
- Consumes: existing `load`, `saveLocal`, `PREFIX` already imported in `defaults.ts`.
- Produces (Task 2/3 import these from `./lib/persist`):
  - `type BacktestAnalysisTab = "placement" | "whatif" | "context"`
  - `loadBacktestAnalysisTab(): BacktestAnalysisTab` (default `"placement"`)
  - `saveBacktestAnalysisTab(tab: BacktestAnalysisTab): void`
  - `loadBacktestAnalysisCollapsed(): string[]` (default `[]`)
  - `saveBacktestAnalysisCollapsed(slugs: string[]): void`

- [ ] **Step 1: Add the helpers to defaults.ts**

Append after `saveBacktestPeriodsShown` (after line 202) in `frontend/src/lib/persist/defaults.ts`:

```ts
// Which Analysis sub-tab is active, and which analysis sections are collapsed.
// Device-local view preferences (like the panel flags above): one preference for
// the whole app, not per cell. Both flat keys are registered in
// DEVICE_LOCAL_FLAT_KEYS in core.ts; without that, hydrateFromBackend prunes
// them a beat after each load, so the SECOND reload would lose them.
const BACKTEST_ANALYSIS_TAB_KEY = `${PREFIX}.backtestAnalysisTab`;
export type BacktestAnalysisTab = "placement" | "whatif" | "context";
export function loadBacktestAnalysisTab(): BacktestAnalysisTab {
  return load<BacktestAnalysisTab>(BACKTEST_ANALYSIS_TAB_KEY, "placement");
}
export function saveBacktestAnalysisTab(tab: BacktestAnalysisTab): void {
  saveLocal(BACKTEST_ANALYSIS_TAB_KEY, tab);
}

// Collapsed analysis sections, stored as an array of stable section slugs
// (e.g. "exit-reasons"), not display labels. Unknown slugs are ignored on read;
// sections not listed are expanded.
const BACKTEST_ANALYSIS_COLLAPSED_KEY = `${PREFIX}.backtestAnalysisCollapsed`;
export function loadBacktestAnalysisCollapsed(): string[] {
  return load<string[]>(BACKTEST_ANALYSIS_COLLAPSED_KEY, []);
}
export function saveBacktestAnalysisCollapsed(slugs: string[]): void {
  saveLocal(BACKTEST_ANALYSIS_COLLAPSED_KEY, slugs);
}
```

Note: `defaults.ts` already imports `load`, `saveLocal`, and `PREFIX` from `./core` (used by the neighboring backtest helpers). Verify at the top of the file; add to the existing import if missing.

- [ ] **Step 2: Register both keys in DEVICE_LOCAL_FLAT_KEYS**

In `frontend/src/lib/persist/core.ts`, extend the set (currently lines 117-124):

```ts
const DEVICE_LOCAL_FLAT_KEYS = new Set([
  `${PREFIX}.backtestOpen`,
  `${PREFIX}.liveOpen`,
  `${PREFIX}.backtestSide`,
  `${PREFIX}.backtestSplit`,
  `${PREFIX}.backtestPeriodsShown`,
  `${PREFIX}.backtestAnalysisTab`,
  `${PREFIX}.backtestAnalysisCollapsed`,
  `${PREFIX}.lastDrawTools`,
]);
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b 2>&1 | grep -c "error TS"`
Expected: `60` (the pre-existing count; zero new errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/persist/defaults.ts frontend/src/lib/persist/core.ts
git commit -m "feat(backtest): device-local persist keys for analysis sub-tab and collapsed sections"
```

---

### Task 2: Analysis sub-tabs

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx`
- Modify: `frontend/src/App.css` (after `.bt-analysis-section h4` block, ~line 3816)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `loadBacktestAnalysisTab`, `saveBacktestAnalysisTab`, `type BacktestAnalysisTab` from `./lib/persist` (Task 1).
- Produces: `BacktestAnalysisPanel` public props unchanged (`{ analysis: BacktestAnalysis | null | undefined }`). Internal helper `whatifHasContent(whatif: BacktestWhatif | null | undefined): boolean` that Task 3 keeps using. Three tab buttons rendered with `role="tab"` and accessible names `Placement`, `What-if`, `Context`.

- [ ] **Step 1: Update existing tests and add failing sub-tab tests**

Replace `frontend/src/BacktestAnalysisPanel.test.tsx` with the version below. Changes: import `fireEvent`, clear `localStorage` in `afterEach` (tab/collapse persistence would otherwise leak between tests), a `showTab` helper, existing assertions now activate the right sub-tab first, and a new `describe` block for sub-tab behavior. The `analysis` fixture object is unchanged, so it is elided here: keep lines 12-62 of the current file exactly as they are.

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

import type { BacktestAnalysis, BacktestWhatif } from "./api";
import { saveBacktestAnalysisTab } from "./lib/persist";
import BacktestAnalysisPanel from "./BacktestAnalysisPanel";

// vitest isn't run with jest-style globals, so RTL's automatic cleanup never
// registers (see BacktestSettingsModal.test.tsx). Without this each render leaks.
// localStorage is cleared too: the sub-tab and collapsed-set persistence would
// otherwise leak one test's UI state into the next.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const analysis: BacktestAnalysis = {
  // ... UNCHANGED: keep the existing fixture from the current file verbatim ...
};

// Click a sub-tab by its accessible name.
const showTab = (name: "Placement" | "What-if" | "Context") =>
  fireEvent.click(screen.getByRole("tab", { name }));

describe("BacktestAnalysisPanel", () => {
  it("renders SL/TP read-outs on Placement, exit reasons and context tables on Context", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    expect(screen.getByText(/25% of winners drew down 80% of the way to the stop before recovering/i)).toBeTruthy();
    expect(screen.getByText(/1.1R/)).toBeTruthy(); // left on the table
    showTab("Context");
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText("up")).toBeTruthy();
  });

  it("shows day names in calendar order for day_of_week buckets", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    showTab("Context");
    const mon = screen.getByText("Mon");
    const thu = screen.getByText("Thu"); // bucket "3", listed first by count
    expect(mon).toBeTruthy();
    expect(thu).toBeTruthy();
    // Mon must render before Thu despite Thu having more trades.
    expect(
      mon.compareDocumentPosition(thu) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the empty state when there are no trades", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, n_trades: 0 }} />);
    expect(screen.getByText(/no trades to analyse/i)).toBeTruthy();
  });

  it("renders nothing useful crash-free with no analysis (older stored runs)", () => {
    render(<BacktestAnalysisPanel analysis={null} />);
    expect(screen.getByText(/run a backtest/i)).toBeTruthy();
  });

  it("renders the what-if section with bullets and both curve tables", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    showTab("What-if");
    expect(screen.getByText(/What if/i)).toBeTruthy();
    expect(
      screen.getByText(/11 of 30 trades closed by "Sell to Close" would have gone on to hit the target/i),
    ).toBeTruthy();
    expect(screen.getByText(/target saved 9.1R net/i)).toBeTruthy();
    expect(screen.getByText(/fill delay costs 0.07R per trade/i)).toBeTruthy();
    expect(screen.getByText(/would have filled 62% of entries/i)).toBeTruthy();
    const whatIf = screen.getByText(/What if/i).closest("section")!;
    expect(within(whatIf).getByText("80%")).toBeTruthy(); // stop curve row
    expect(within(whatIf).getByText("2R")).toBeTruthy(); // target curve row
  });

  it("renders the negative-foregone limit-entry case as dodging losses, with a non-100% fill rate", () => {
    const negFore: BacktestAnalysis = {
      ...analysis,
      whatif: {
        ...(analysis.whatif as BacktestWhatif),
        limit_entry: {
          n: 37,
          fill_rate: 0.9968,
          filled_net_delta_r: 3.4,
          undecided: 2,
          unfilled_foregone_r: -1.0,
          unfilled_winners: 0,
          net_verdict_r: 4.4,
        },
      },
    };
    render(<BacktestAnalysisPanel analysis={negFore} />);
    showTab("What-if");
    expect(
      screen.getByText(/while dodging 1\.0R of losses on entries that never filled/i),
    ).toBeTruthy();
    expect(screen.queryByText(/would have filled 100% of entries/i)).toBeNull();
    expect(screen.getByText(/would have filled 99\.6% of entries/i)).toBeTruthy();
  });

  it("hides the What-if tab entirely when whatif is absent or all-None", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, whatif: undefined }} />);
    expect(screen.queryByRole("tab", { name: "What-if" })).toBeNull();
    expect(screen.queryByText(/What if/i)).toBeNull();
    cleanup();
    render(
      <BacktestAnalysisPanel
        analysis={{
          ...analysis,
          whatif: { rule_exit: null, no_target: null, stop_curve: null,
            target_curve: null, fill_delay: null, limit_entry: null },
        }}
      />,
    );
    expect(screen.queryByRole("tab", { name: "What-if" })).toBeNull();
    // The other two tabs still work.
    expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
    showTab("Context");
    expect(screen.getByText("target")).toBeTruthy();
  });

  describe("sub-tabs", () => {
    it("defaults to Placement and shows only that page's content", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      const placement = screen.getByRole("tab", { name: "Placement" });
      expect(placement.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
      // Context and What-if content is not mounted.
      expect(screen.queryByText("target")).toBeNull();
      expect(screen.queryByText(/fill delay/i)).toBeNull();
    });

    it("switching tabs swaps the content", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      expect(screen.getByText("target")).toBeTruthy();
      expect(screen.queryByText(/25% of winners drew down/i)).toBeNull();
      showTab("What-if");
      expect(screen.getByText(/fill delay costs/i)).toBeTruthy();
      expect(screen.queryByText("target")).toBeNull();
      showTab("Placement");
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
    });

    it("persists the active tab across remount", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      cleanup();
      render(<BacktestAnalysisPanel analysis={analysis} />);
      expect(
        screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText("target")).toBeTruthy();
    });

    it("falls back to Placement when the persisted tab is the hidden What-if tab", () => {
      saveBacktestAnalysisTab("whatif");
      render(<BacktestAnalysisPanel analysis={{ ...analysis, whatif: undefined }} />);
      expect(
        screen.getByRole("tab", { name: "Placement" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: FAIL. Every test calling `showTab` fails with "Unable to find an accessible element with the role tab" (no tablist exists yet).

- [ ] **Step 3: Restructure BacktestAnalysisPanel into sub-tabs**

In `frontend/src/BacktestAnalysisPanel.tsx`:

3a. Update imports at the top:

```tsx
import { useState } from "react";
import type { AnalysisHist, AnalysisRow, BacktestAnalysis, BacktestWhatif } from "./api";
import InfoTip from "./components/InfoTip";
import {
  loadBacktestAnalysisTab,
  saveBacktestAnalysisTab,
  type BacktestAnalysisTab,
} from "./lib/persist";
```

3b. Extract the has-content check that `WhatIfSection` currently does inline (its first six lines) into a module-level helper, placed right above `WhatIfSection`, and make `WhatIfSection` use it:

```tsx
// True when the whatif payload has at least one populated section. Drives both
// the What-if tab button visibility and the section render (old stored runs
// carry no whatif, or one with every section null).
export function whatifHasContent(whatif: BacktestWhatif | null | undefined): boolean {
  if (!whatif) return false;
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry } = whatif;
  return Boolean(rule_exit || no_target || stop_curve || target_curve || fill_delay || limit_entry);
}

function WhatIfSection({ whatif }: { whatif: BacktestWhatif | null | undefined }) {
  if (!whatifHasContent(whatif)) return null;
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry } = whatif!;
  const bullets: string[] = [];
  // ... rest of WhatIfSection unchanged ...
```

3c. Replace the default export with the tabbed version. The section JSX inside each page moves verbatim from the current single-page return; only the wrapping changes:

```tsx
export default function BacktestAnalysisPanel({
  analysis,
}: {
  analysis: BacktestAnalysis | null | undefined;
}) {
  const [tab, setTab] = useState<BacktestAnalysisTab>(loadBacktestAnalysisTab);
  if (!analysis) {
    return <div className="bt-analysis-empty">Run a backtest to see the analysis.</div>;
  }
  if (analysis.n_trades === 0) {
    return <div className="bt-analysis-empty">No trades to analyse.</div>;
  }
  const { sl, tp } = analysis;
  const runAvg =
    analysis.exit_reasons.reduce((s, r) => s + r.net_pnl, 0) / analysis.n_trades;

  const hasWhatif = whatifHasContent(analysis.whatif);
  // A persisted "whatif" tab can point at a hidden tab (old stored runs have no
  // whatif payload): fall back to Placement rather than an empty page.
  const active: BacktestAnalysisTab = tab === "whatif" && !hasWhatif ? "placement" : tab;
  const pick = (t: BacktestAnalysisTab) => {
    setTab(t);
    saveBacktestAnalysisTab(t);
  };

  const readouts: string[] = [];
  // ... the four readouts.push blocks, unchanged ...

  return (
    <div className="bt-analysis">
      <div className="seg bt-analysis-seg" role="tablist" aria-label="Analysis view">
        <button
          className={active === "placement" ? "seg-on" : ""}
          role="tab"
          aria-selected={active === "placement"}
          onClick={() => pick("placement")}
        >
          Placement
        </button>
        {hasWhatif && (
          <button
            className={active === "whatif" ? "seg-on" : ""}
            role="tab"
            aria-selected={active === "whatif"}
            onClick={() => pick("whatif")}
          >
            What-if
          </button>
        )}
        <button
          className={active === "context" ? "seg-on" : ""}
          role="tab"
          aria-selected={active === "context"}
          onClick={() => pick("context")}
        >
          Context
        </button>
      </div>

      {active === "placement" && (
        <section className="bt-analysis-section">
          {/* h4 + readouts ul + the .bt-analysis-dists div with the three Dist
              blocks, moved verbatim from the current single-page return */}
        </section>
      )}

      {active === "whatif" && <WhatIfSection whatif={analysis.whatif} />}

      {active === "context" && (
        <>
          <section className="bt-analysis-section">
            <h4>Exit reasons</h4>
            <RowsTable rows={analysis.exit_reasons} avg={runAvg} />
          </section>
          {/* the five-context-table .map, moved verbatim */}
        </>
      )}
    </div>
  );
}
```

Notes for the implementer:
- `useState` must be called before the two early returns (hooks run unconditionally). The initializer is the function reference `loadBacktestAnalysisTab` (lazy init), not a call.
- Move the JSX bodies verbatim; do not reword any copy or restructure tables.

3d. Add CSS in `frontend/src/App.css`, directly after the `.bt-analysis-section h4` rule (after line 3816):

```css
/* Analysis sub-tabs: same .seg pattern as the Overview/Trades row above, but
   visually secondary (smaller buttons). */
.bt-analysis-seg { align-self: flex-start; }
.bt-analysis-seg button { padding: 3px 10px; font-size: 12px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b 2>&1 | grep -c "error TS"`
Expected: `60`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx frontend/src/App.css
git commit -m "feat(backtest): split the Analysis tab into Placement/What-if/Context sub-tabs"
```

---

### Task 3: Collapsible sections

**Files:**
- Modify: `frontend/src/BacktestAnalysisPanel.tsx`
- Modify: `frontend/src/App.css` (same area as Task 2's addition)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `loadBacktestAnalysisCollapsed`, `saveBacktestAnalysisCollapsed` from `./lib/persist` (Task 1); the tabbed panel from Task 2.
- Produces: every section header is a `role="button"` toggle with `aria-expanded`; slugs per the table at the top of this plan. `Dist` gains required props `slug: string; collapsed: boolean; onToggle: (slug: string) => void`. `WhatIfSection` gains the same three props.

- [ ] **Step 1: Add failing collapse tests**

Append inside the top-level `describe("BacktestAnalysisPanel", ...)` block in `frontend/src/BacktestAnalysisPanel.test.tsx`:

```tsx
  describe("collapsible sections", () => {
    it("collapsing a section hides its body; header remains", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      expect(screen.getByText("target")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /exit reasons/i }));
      expect(screen.queryByText("target")).toBeNull(); // body hidden
      expect(screen.getByRole("button", { name: /exit reasons/i })).toBeTruthy(); // header stays
      // Re-expanding brings the body back.
      fireEvent.click(screen.getByRole("button", { name: /exit reasons/i }));
      expect(screen.getByText("target")).toBeTruthy();
    });

    it("persists the collapsed set across remount", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      fireEvent.click(screen.getByRole("button", { name: /exit reasons/i }));
      cleanup();
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      expect(screen.queryByText("target")).toBeNull(); // still collapsed
      expect(screen.getByText("up")).toBeTruthy(); // trend table unaffected
    });

    it("collapses an individual distribution block on Placement", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      fireEvent.click(
        screen.getByRole("button", { name: /winners: worst drawdown before profit/i }),
      );
      // The winners histogram bullets disappear; the losers block is untouched.
      expect(screen.queryByText(/2 trades reached ≤25% to stop/i)).toBeNull();
      expect(screen.getByText(/2 trades reached 75–100% to stop/i)).toBeTruthy();
    });

    it("ignores unknown slugs in the stored array; unlisted sections stay expanded", () => {
      localStorage.setItem(
        "auto-trader.backtestAnalysisCollapsed",
        JSON.stringify(["bogus-slug", "exit-reasons"]),
      );
      render(<BacktestAnalysisPanel analysis={analysis} />);
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy(); // expanded
      showTab("Context");
      expect(screen.queryByText("target")).toBeNull(); // exit-reasons collapsed
      expect(screen.getByText("up")).toBeTruthy(); // trend expanded
    });

    it("keeps the header InfoTip from toggling the section", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("What-if");
      expect(screen.getByText(/fill delay costs/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "About What if" }));
      // Clicking the InfoTip must not collapse the section.
      expect(screen.getByText(/fill delay costs/i)).toBeTruthy();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: FAIL. The new tests fail with "Unable to find an accessible element with the role button and name /exit reasons/i" (headers are plain h4s).

- [ ] **Step 3: Implement collapsible headers**

All in `frontend/src/BacktestAnalysisPanel.tsx`.

3a. Extend the persist import:

```tsx
import {
  loadBacktestAnalysisCollapsed,
  loadBacktestAnalysisTab,
  saveBacktestAnalysisCollapsed,
  saveBacktestAnalysisTab,
  type BacktestAnalysisTab,
} from "./lib/persist";
```

3b. Add a chevron glyph component and a collapsible h4, near the top of the file (after the formatters):

```tsx
function Chevron({ open }: { open: boolean }) {
  return (
    <span className="bt-analysis-chevron" aria-hidden="true">
      {open ? "▾" : "▸"}
    </span>
  );
}

// A section h4 that toggles its section body. InfoTips inside the header keep
// working: InfoTip stops click propagation itself, so tapping the icon never
// reaches this onClick.
function SectionH4({
  slug,
  open,
  onToggle,
  children,
}: {
  slug: string;
  open: boolean;
  onToggle: (slug: string) => void;
  children: React.ReactNode;
}) {
  return (
    <h4
      className="bt-analysis-htoggle"
      role="button"
      aria-expanded={open}
      onClick={() => onToggle(slug)}
    >
      <Chevron open={open} />
      {children}
    </h4>
  );
}
```

(Import `React` types via `import type { ReactNode } from "react"` and use `ReactNode` if the file's lint style prefers it; either compiles.)

3c. Give `Dist` a collapsible label. New props and render:

```tsx
function Dist({
  hist,
  label,
  slug,
  collapsed,
  onToggle,
  tip,
  pctOfStop,
}: {
  hist: AnalysisHist;
  label: string;
  slug: string;
  collapsed: boolean;
  onToggle: (slug: string) => void;
  tip?: string;
  pctOfStop?: boolean; // buckets are fractions of the stop distance: show "25% to stop"
}) {
  // ... names/items computation unchanged ...
  if (!items.length) return null;
  return (
    <div className="bt-analysis-dist">
      <div
        className="bt-analysis-dist-label bt-analysis-htoggle"
        role="button"
        aria-expanded={!collapsed}
        onClick={() => onToggle(slug)}
      >
        <Chevron open={!collapsed} />
        {label}
        {tip && <InfoTip title={label} text={tip} />}
      </div>
      {!collapsed && (
        <ul className="bt-analysis-dist-items">
          {items.map(({ c, name }, i) => (
            <li key={i} className="bt-analysis-dist-item">
              {c} {c === 1 ? "trade" : "trades"} {pctOfStop ? "reached" : "closed at"}{" "}
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

3d. `WhatIfSection` takes the collapse plumbing; its header becomes a `SectionH4` with slug `whatif` and the whole body (bullets + curve tables) hides when collapsed:

```tsx
function WhatIfSection({
  whatif,
  collapsed,
  onToggle,
}: {
  whatif: BacktestWhatif | null | undefined;
  collapsed: boolean;
  onToggle: (slug: string) => void;
}) {
  if (!whatifHasContent(whatif)) return null;
  // ... bullets computation unchanged ...
  return (
    <section className="bt-analysis-section">
      <SectionH4 slug="whatif" open={!collapsed} onToggle={onToggle}>
        What if
        <InfoTip title="What if" text={CAVEAT} />
      </SectionH4>
      {!collapsed && (
        <>
          {bullets.length > 0 && (
            <ul className="bt-analysis-readouts">...unchanged...</ul>
          )}
          {(stop_curve || target_curve) && (
            <div className="bt-analysis-dists">...unchanged...</div>
          )}
        </>
      )}
    </section>
  );
}
```

3e. In the main component, add collapse state next to the tab state:

```tsx
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(loadBacktestAnalysisCollapsed()),
  );
  const toggleSection = (slug: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      saveBacktestAnalysisCollapsed([...next]);
      return next;
    });
  };
```

3f. Wire every section on the three pages:

Placement page. The h4 toggles ONLY the readout bullets (slug `placement-readouts`); each Dist block has its own toggle and stays visible when the bullets are collapsed:

```tsx
        <section className="bt-analysis-section">
          <SectionH4 slug="placement-readouts" open={!collapsed.has("placement-readouts")} onToggle={toggleSection}>
            Stop &amp; target placement check
          </SectionH4>
          {!collapsed.has("placement-readouts") && (
            <ul className="bt-analysis-readouts">
              {readouts.map((r, i) => (
                <li key={i} className="bt-analysis-readout">
                  {r}
                </li>
              ))}
            </ul>
          )}
          <div className="bt-analysis-dists">
            <Dist
              hist={sl.winners_mae_hist}
              label="Winners: worst drawdown before profit"
              slug="dist-winners-mae"
              collapsed={collapsed.has("dist-winners-mae")}
              onToggle={toggleSection}
              tip="...unchanged..."
              pctOfStop
            />
            <Dist
              hist={sl.losers_mae_hist}
              label="Losers: worst drawdown"
              slug="dist-losers-mae"
              collapsed={collapsed.has("dist-losers-mae")}
              onToggle={toggleSection}
              tip="...unchanged..."
              pctOfStop
            />
            <Dist
              hist={analysis.r_hist}
              label="Result distribution (R)"
              slug="dist-result-r"
              collapsed={collapsed.has("dist-result-r")}
              onToggle={toggleSection}
              tip="...unchanged..."
            />
          </div>
        </section>
```

What-if page:

```tsx
      {active === "whatif" && (
        <WhatIfSection
          whatif={analysis.whatif}
          collapsed={collapsed.has("whatif")}
          onToggle={toggleSection}
        />
      )}
```

Context page. Exit reasons plus the mapped tables; the tuple array gains a slug column:

```tsx
          <section className="bt-analysis-section">
            <SectionH4 slug="exit-reasons" open={!collapsed.has("exit-reasons")} onToggle={toggleSection}>
              Exit reasons
            </SectionH4>
            {!collapsed.has("exit-reasons") && (
              <RowsTable rows={analysis.exit_reasons} avg={runAvg} />
            )}
          </section>

          {(
            [
              ["trend", "Trend at entry", "ctx-trend"],
              ["vol_regime", "Volatility regime", "ctx-vol-regime"],
              ["session", "Session", "ctx-session"],
              ["candle_pattern", "Entry-bar pattern", "ctx-candle-pattern"],
              ["day_of_week", "Day of week", "ctx-day-of-week"],
            ] as const
          ).map(([key, label, slug]) => (
            <section key={key} className="bt-analysis-section">
              <SectionH4 slug={slug} open={!collapsed.has(slug)} onToggle={toggleSection}>
                {label}
              </SectionH4>
              {!collapsed.has(slug) && (
                <RowsTable
                  rows={
                    key === "day_of_week"
                      ? dayOfWeekRows(analysis.context[key] ?? [])
                      : analysis.context[key] ?? []
                  }
                  avg={runAvg}
                />
              )}
            </section>
          ))}
```

3g. Add CSS next to Task 2's `.bt-analysis-seg` rules in `frontend/src/App.css`:

```css
/* Collapsible section headers: the whole header row is the toggle. The chevron
   is fixed-width so headers stay aligned when it flips. */
.bt-analysis-htoggle { cursor: pointer; user-select: none; }
.bt-analysis-chevron {
  width: 10px; flex: 0 0 auto; font-size: 9px; color: var(--text-faint);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: PASS (all tests, including the Task 2 suite).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b 2>&1 | grep -c "error TS"`
Expected: `60`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx frontend/src/App.css
git commit -m "feat(backtest): collapsible analysis sections with persisted collapsed set"
```

---

### Task 4: Visual verification in the running app

**Files:** none (verification only; fix anything found and amend the relevant commit).

- [ ] **Step 1: Check the dev server and view the Analysis tab**

The user runs an HMR dev server (do NOT kill or restart it). Open the app in the browser (claude-in-chrome), open the backtest panel, run or reuse a stored backtest, switch to the Analysis tab. Verify in the light theme:
- The sub-tab row renders as a smaller `.seg` under the main Overview/Trades row; Placement is active by default.
- Each header shows a chevron; clicking collapses/expands; clicking an ⓘ InfoTip opens the tooltip without toggling.
- Reload the page twice: active tab and collapsed sections survive BOTH reloads (the second reload is the DEVICE_LOCAL_FLAT_KEYS regression case).
- A stored run without whatif shows no What-if tab.

- [ ] **Step 2: Close any browser tabs opened during verification**
