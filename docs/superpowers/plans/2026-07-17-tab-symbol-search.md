# Tab Symbol Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A magnifier control in the tab bar (also Ctrl/Cmd+F) that highlights every tab containing a cell whose symbol matches the query, and on tab click jumps to and flashes the matching cells.

**Architecture:** A pure matcher module (`lib/tabSearch.ts`) computes matches. The query string is lifted to App (it drives both TabBar chip highlights and cell glow in ChartGrid); the open/collapsed state of the input is TabBar-local. App wraps tab selection to re-home `activeCellId` onto the first matching cell and flash a 2s glow on all matching cells.

**Tech Stack:** React 19 + TypeScript, vitest (`npm run test:unit` in `frontend/`), plain CSS in `App.css`.

**Spec:** `docs/superpowers/specs/2026-07-17-tab-symbol-search-design.md`

## Global Constraints

- Search state is transient: never persisted, per browser tab only.
- Case-insensitive substring match against `symbol.epic` and `symbol.name`; empty/whitespace query matches nothing.
- Ctrl+F / Cmd+F opens the search and `preventDefault()`s native find; suppressed while an editable element has focus; re-focuses/selects if already open.
- Non-matching tabs are NOT dimmed.
- Light theme is canonical; flat UI, no shadows (project UX convention).
- Commit directly to `main` (user convention, no branches).

---

### Task 1: Matcher module

**Files:**
- Create: `frontend/src/lib/tabSearch.ts`
- Test: `frontend/src/lib/tabSearch.test.ts`

**Interfaces:**
- Consumes: `ChartTab`, `ChartCell` from `./persist` (re-exported from `./persist/workspace`).
- Produces:
  - `matchingCellIds(tab: ChartTab, query: string): string[]`
  - `matchingTabIds(tabs: ChartTab[], query: string): Set<string>`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/tabSearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChartTab } from "./persist";
import { matchingCellIds, matchingTabIds } from "./tabSearch";

function cell(id: string, epic: string, name: string) {
  return {
    id,
    symbol: { epic, name, status: null },
    period: { label: "15m" } as ChartTab["cells"][number]["period"],
    scope: id,
  };
}

function tab(id: string, cells: ReturnType<typeof cell>[]): ChartTab {
  return { id, layout: "4", cells, activeCellId: cells[0].id };
}

const tabs: ChartTab[] = [
  tab("t1", [cell("c1", "EURUSD", "Euro / US Dollar")]),
  tab("t2", [
    cell("c2", "EURUSD", "Euro / US Dollar"),
    cell("c3", "GBPUSD", "Pound / US Dollar"),
    cell("c4", "GOLD", "Gold Spot"),
  ]),
  tab("t3", [cell("c5", "US500", "S&P 500")]),
];

describe("matchingCellIds", () => {
  it("matches epic substring case-insensitively", () => {
    expect(matchingCellIds(tabs[1], "eur")).toEqual(["c2"]);
  });

  it("matches display name too", () => {
    expect(matchingCellIds(tabs[1], "pound")).toEqual(["c3"]);
  });

  it("returns every matching cell in the tab", () => {
    expect(matchingCellIds(tabs[1], "usd")).toEqual(["c2", "c3"]);
  });

  it("empty and whitespace queries match nothing", () => {
    expect(matchingCellIds(tabs[1], "")).toEqual([]);
    expect(matchingCellIds(tabs[1], "   ")).toEqual([]);
  });

  it("no match returns empty", () => {
    expect(matchingCellIds(tabs[2], "gold")).toEqual([]);
  });
});

describe("matchingTabIds", () => {
  it("returns ids of tabs with at least one matching cell", () => {
    expect(matchingTabIds(tabs, "eurusd")).toEqual(new Set(["t1", "t2"]));
  });

  it("empty query matches no tabs", () => {
    expect(matchingTabIds(tabs, "")).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test:unit -- src/lib/tabSearch.test.ts`
Expected: FAIL — cannot resolve `./tabSearch`.

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/tabSearch.ts`:

```ts
// Matcher for the tab-bar "find open symbol" search: which open cells/tabs
// hold a symbol matching the query. Pure — UI state lives in TabBar/App.
import type { ChartCell, ChartTab } from "./persist";

function cellMatches(cell: ChartCell, q: string): boolean {
  return (
    cell.symbol.epic.toLowerCase().includes(q) ||
    (cell.symbol.name ?? "").toLowerCase().includes(q)
  );
}

// Ids of the tab's cells whose symbol epic or name contains the query
// (case-insensitive). Empty/whitespace query matches nothing.
export function matchingCellIds(tab: ChartTab, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return tab.cells.filter((c) => cellMatches(c, q)).map((c) => c.id);
}

// Ids of tabs containing at least one matching cell.
export function matchingTabIds(tabs: ChartTab[], query: string): Set<string> {
  return new Set(
    tabs.filter((t) => matchingCellIds(t, query).length > 0).map((t) => t.id),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test:unit -- src/lib/tabSearch.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/tabSearch.ts frontend/src/lib/tabSearch.test.ts
git commit -m "feat(tabs): matcher for find-open-symbol search"
```

---

### Task 2: TabBar search control + tab highlight

**Files:**
- Modify: `frontend/src/TabBar.tsx` (props ~line 81, chip className ~line 359, after the `+` button ~line 449)
- Modify: `frontend/src/App.css` (tab styles near `.tab-add`, ~line 367)

**Interfaces:**
- Consumes: `matchingTabIds` from `./lib/tabSearch` (Task 1).
- Produces: two new required TabBar props, wired by Task 3:
  - `searchQuery: string`
  - `onSearchQuery: (q: string) => void` (TabBar calls with `""` when the search closes)

- [ ] **Step 1: Add props and match set**

In `TabBar.tsx`, extend `Props` (after `trailing?: ReactNode;`):

```tsx
  // Find-open-symbol search (spec 2026-07-17-tab-symbol-search). The query is
  // lifted to App because it also drives cell glow in ChartGrid; the
  // open/collapsed state of the input is local to this component.
  searchQuery: string;
  onSearchQuery: (q: string) => void;
```

Destructure both in the component signature. Near the top of the body add:

```tsx
  const searchHits = matchingTabIds(tabs, searchQuery);
```

with import `import { matchingTabIds } from "./lib/tabSearch";`.

- [ ] **Step 2: Highlight matching chips**

In the chip `className` array (the one with `"tab"`, `"on"`, `"dragging"`, `"drop-merge"`), add:

```tsx
            searchHits.has(t.id) ? "search-hit" : "",
```

- [ ] **Step 3: Add the expand-on-click control**

Local state + ref near the other `useState` calls:

```tsx
  // Find-open-symbol search: collapsed magnifier ⇄ inline input.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    onSearchQuery("");
  }, [onSearchQuery]);
```

Render after the `+` button's `</Tooltip>`, still inside `.tab-bar-tabs`:

```tsx
      {searchOpen ? (
        <input
          ref={searchRef}
          className="tab-search-input"
          placeholder="Find symbol…"
          value={searchQuery}
          onChange={(e) => onSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeSearch();
          }}
          autoFocus
        />
      ) : (
        <Tooltip content="Find open symbol (Ctrl/Cmd+F)">
          <button className="tab-search" onClick={() => setSearchOpen(true)}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                 stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
        </Tooltip>
      )}
```

Do NOT close on input `onBlur`: clicking a highlighted tab blurs the input on
mousedown, which would clear the query BEFORE the tab's click handler runs and
break click-to-jump (the spec keeps the search open while hopping tabs).
Instead close on clicks outside the whole tab bar:

```tsx
  // Outside-click closes the search — but a click anywhere INSIDE the tab bar
  // (a tab chip, the input itself) keeps it open, so the user can hop between
  // matching tabs. Closing on input blur would clear the query on mousedown,
  // before the chip's click handler runs.
  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (e: MouseEvent) => {
      const bar = barRef.current?.closest(".tab-bar");
      if (bar != null && !bar.contains(e.target as Node)) closeSearch();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [searchOpen, closeSearch]);
```

- [ ] **Step 4: Ctrl/Cmd+F shortcut**

Effect in TabBar (fires only while the bar is mounted — in maximized view the
bar is hidden and the browser's native find stays available, which is fine):

```tsx
  // Ctrl/Cmd+F opens (or re-focuses) the search instead of the browser find.
  // Suppressed while another editable element has focus so in-app text fields
  // keep their native find/typing behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const el = document.activeElement as HTMLElement | null;
      const editable =
        el != null &&
        el !== searchRef.current &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (editable) return;
      e.preventDefault();
      if (searchOpen) searchRef.current?.select();
      else setSearchOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchOpen]);
```

- [ ] **Step 5: CSS**

In `App.css`, after the `.tab-add` rules (~line 371):

```css
/* Find-open-symbol search: collapsed magnifier at the end of the tab strip,
   expanding into an inline input. Matching chips get .search-hit below. */
.tab-search {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; flex: none;
  border: none; border-radius: 4px; background: none;
  color: var(--text-faint); cursor: pointer;
}
.tab-search:hover { color: var(--text); background: var(--hover); }
.tab-search-input {
  font: inherit; font-size: 12px; color: var(--text);
  background: var(--surface-2); border: 1px solid var(--accent);
  border-radius: 4px; padding: 3px 8px; width: 140px; flex: none;
  outline: none;
}
.tab-search-input::placeholder { color: var(--text-faint); }
.tab.search-hit {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  outline: 1px solid var(--accent); outline-offset: -1px;
}
```

(Check the variable names `--surface-2`, `--hover`, `--text-faint`, `--accent`
against neighboring rules in App.css and reuse whatever the tab styles there
actually use.)

- [ ] **Step 6: Make it compile in App**

Task 3 wires real state; for this commit, pass placeholders in `App.tsx` where `<TabBar` is rendered (~line 1615):

```tsx
        searchQuery={tabSearchQuery}
        onSearchQuery={setTabSearchQuery}
```

and add the state near App's other tab state:

```tsx
  // Find-open-symbol query (transient, never persisted). Lifted here because
  // it drives both TabBar chip highlights and cell glow in ChartGrid.
  const [tabSearchQuery, setTabSearchQuery] = useState("");
```

- [ ] **Step 7: Verify build + existing tests**

Run: `cd frontend && npx tsc -b && npm run test:unit -- src/lib/tabSearch.test.ts`
Expected: clean compile, tests PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/TabBar.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(tabs): find-open-symbol search control + tab highlight"
```

---

### Task 3: Click-to-jump + cell glow

**Files:**
- Modify: `frontend/src/App.tsx` (tab select handler; ChartGrid props ~line 1714)
- Modify: `frontend/src/ChartGrid.tsx` (props ~line 37; cell className ~line 197)
- Modify: `frontend/src/App.css` (near `.chart-cell.focused::after`, ~line 211)

**Interfaces:**
- Consumes: `matchingCellIds` from `./lib/tabSearch` (Task 1); `tabSearchQuery` state (Task 2).
- Produces: ChartGrid prop `searchGlowCellIds?: string[]` (cells to flash).

- [ ] **Step 1: Glow state + flash helper in App**

Near `tabSearchQuery`:

```tsx
  // Cells flashed by the symbol search (jump or live typing). Cleared after
  // ~2s; the CSS animation fades the outline over the same window.
  const [searchGlow, setSearchGlow] = useState<string[]>([]);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCells = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    if (glowTimer.current != null) clearTimeout(glowTimer.current);
    // Clear-then-set across a frame so re-flashing the same cells restarts
    // the CSS animation (same class on the same node never replays).
    setSearchGlow([]);
    requestAnimationFrame(() => {
      setSearchGlow(ids);
      glowTimer.current = setTimeout(() => setSearchGlow([]), 2000);
    });
  }, []);
```

- [ ] **Step 2: Jump on selecting a highlighted tab**

Replace `onSelect={setActiveId}` in the TabBar render with `onSelect={selectTabFromBar}` and add:

```tsx
  // Tab click from the bar. With a search active and the tab matching, also
  // re-home the focused cell onto the first match and flash all matches
  // (spec: click-to-jump).
  const selectTabFromBar = useCallback(
    (id: string) => {
      setActiveId(id);
      const tab = tabs.find((t) => t.id === id);
      if (tab == null) return;
      const hits = matchingCellIds(tab, tabSearchQuery);
      if (hits.length === 0) return;
      setTabs((ts) =>
        ts.map((t) => (t.id === id ? { ...t, activeCellId: hits[0] } : t)),
      );
      flashCells(hits);
    },
    [tabs, tabSearchQuery, flashCells, setTabs, setActiveId],
  );
```

(Adjust the state-setter names to whatever App actually uses for `tabs`/`activeId` — see the existing `onSelect={setActiveId}` wiring and the `setTabs` calls around line 750.)

- [ ] **Step 3: Flash the active tab's matches while typing**

```tsx
  // Typing in the search flashes the ACTIVE tab's matches immediately —
  // no tab click needed when the symbol is already in front of you.
  useEffect(() => {
    if (tabSearchQuery.trim() === "" || active == null) return;
    flashCells(matchingCellIds(active, tabSearchQuery));
    // Deliberately keyed on the query only: re-flashing on every tabs-array
    // identity change would loop (flash → activeCellId write → new tabs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabSearchQuery]);
```

- [ ] **Step 4: ChartGrid glow class**

Add to ChartGrid `Props`:

```tsx
  // Cells to flash with the search-glow outline (find-open-symbol jump).
  searchGlowCellIds?: string[];
```

In the cell div's className (~line 197):

```tsx
          className={`chart-cell${
            cell.id === focusedCellId && cells.length > 1 ? " focused" : ""
          }${searchGlowCellIds?.includes(cell.id) ? " search-glow" : ""}`}
```

Pass from App's ChartGrid render: `searchGlowCellIds={searchGlow}`.

- [ ] **Step 5: Glow CSS**

In `App.css` next to `.chart-cell.focused::after`:

```css
/* Search-jump flash: accent outline over the matched cell, fading out.
   App removes the class after ~2s; the animation does the visual fade. */
.chart-cell.search-glow::after {
  content: "";
  position: absolute; inset: 0; pointer-events: none; z-index: 50;
  outline: 2px solid var(--accent); outline-offset: -2px;
  animation: search-glow-fade 2s ease forwards;
}
@keyframes search-glow-fade {
  0%, 55% { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .chart-cell.search-glow::after { animation: none; }
}
```

(Mirror how `.chart-cell.focused::after` is written — if it uses a border/box
technique instead of outline, copy that technique with the accent color.)

- [ ] **Step 6: Verify build + tests**

Run: `cd frontend && npx tsc -b && npm run test:unit -- src/lib/tabSearch.test.ts`
Expected: clean compile, tests PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/src/App.css
git commit -m "feat(tabs): search click-to-jump + matching-cell glow"
```

---

### Task 4: End-to-end verification in the running app

**Files:** none (verification only). The dev server is already running under HMR — do NOT restart it.

- [ ] **Step 1: Drive the flow in the browser** (claude-in-chrome; set `document.title` on any tab you open; close what you open)

Setup: ensure at least three tabs exist, one of them a multi-cell layout with a symbol duplicated elsewhere (e.g. EURUSD alone in tab 1, EURUSD inside a 4-cell tab 2).

Verify:
1. Magnifier shows at the end of the tab strip; click expands to an input.
2. Typing `eur` highlights tab 1 and tab 2 chips; other chips unchanged (not dimmed); the active tab's matching cells flash.
3. Clicking highlighted tab 2 activates it, focuses the EURUSD cell (toolbar symbol switches to it), and its cell flashes an accent outline that fades.
4. Escape (and separately, clicking elsewhere) collapses the input and clears all highlights.
5. Cmd+F opens the search from the chart; Cmd+F while another app input is focused does NOT hijack it.
6. Query with no matches (`zzz`): nothing highlights, nothing breaks.

- [ ] **Step 2: Full test suite + lint**

Run: `cd frontend && npm run test:unit && npm run lint`
Expected: all PASS, no new lint errors.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A frontend/src && git commit -m "fix(tabs): symbol search polish from live verification"
```

(Skip if nothing changed.)
