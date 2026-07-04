# Inline Leg Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the symbol-search box expression-aware so users compose a synthetic (e.g. `OIL_CRUDE/DXY`) by searching each leg by name and inserting it, TradingView-style.

**Architecture:** Two pure string helpers in `syntheticExpr.ts` (`activeLegFragment`, `insertLeg`) carry the tricky logic; `SymbolSearchModal.tsx` wires formula-mode search targeting, a per-row "+" insert button, an empty-fragment hint, and Enter-to-open. No backend/registry/chart changes.

**Tech Stack:** React + TypeScript + Vite + Vitest (+ RTL/jsdom for the modal).

## Global Constraints

- Formula mode = the box text contains an operator, detected by existing `isSyntheticExpr(text)`.
- Autocomplete targets the LAST token only (text after the last operator) — not cursor-aware in v1.
- A plain result click OUTSIDE formula mode still opens+closes (today's behavior); the "+" button always inserts and keeps the modal open.
- Opening a synthetic uses the existing `pickSynthetic(expr)` / `syntheticCandidate` validation. No new open-on-Enter for plain symbols.
- `npx tsc --noEmit` is a NO-OP here; use `npx tsc -b` (has ~20 pre-existing errors in unrelated test files — ignore, confirm no NEW ones). Component tests: RTL + `// @vitest-environment jsdom` + `afterEach(cleanup)` (see `VisibilityTab.test.tsx`).

---

## Task 1: Pure helpers `activeLegFragment` + `insertLeg`

**Files:**
- Modify: `frontend/src/lib/syntheticExpr.ts`
- Test: `frontend/src/lib/syntheticExpr.test.ts`

**Interfaces:**
- Produces: `activeLegFragment(text: string): string` — substring after the last `+-*/()` char, trimmed. `insertLeg(text: string, epic: string): string` — `text` with the active leg fragment replaced by `epic`, spacing normalized.

- [ ] **Step 1: Write failing tests**

```ts
// append to frontend/src/lib/syntheticExpr.test.ts
import { activeLegFragment, insertLeg } from "./syntheticExpr";

describe("activeLegFragment", () => {
  it("returns text after the last operator, trimmed", () => {
    expect(activeLegFragment("OIL_CRUDE / dx")).toBe("dx");
    expect(activeLegFragment("OIL_CRUDE /")).toBe("");
    expect(activeLegFragment("oil")).toBe("oil");
    expect(activeLegFragment("(AAPL+ms")).toBe("ms");
    expect(activeLegFragment("")).toBe("");
  });
});

describe("insertLeg", () => {
  it("empty box -> the epic", () => {
    expect(insertLeg("", "DXY")).toBe("DXY");
  });
  it("no operator -> replaces the whole fragment with the epic", () => {
    expect(insertLeg("oil", "OIL_CRUDE")).toBe("OIL_CRUDE");
  });
  it("ends in an operator -> appends with one space", () => {
    expect(insertLeg("OIL_CRUDE /", "DXY")).toBe("OIL_CRUDE / DXY");
    expect(insertLeg("OIL_CRUDE / ", "DXY")).toBe("OIL_CRUDE / DXY");
  });
  it("ends in a leg fragment -> replaces the fragment", () => {
    expect(insertLeg("OIL_CRUDE / dx", "DXY")).toBe("OIL_CRUDE / DXY");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/lib/syntheticExpr.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement in `syntheticExpr.ts`**

```ts
// append to frontend/src/lib/syntheticExpr.ts

const OPS = "+-*/()";

/** The leg the user is currently typing: text after the last operator/paren, trimmed. */
export function activeLegFragment(text: string): string {
  let last = -1;
  for (let i = 0; i < text.length; i++) if (OPS.includes(text[i])) last = i;
  return text.slice(last + 1).trim();
}

/** `text` with the active leg fragment replaced by `epic`, spacing normalized. */
export function insertLeg(text: string, epic: string): string {
  if (!text.trim()) return epic;
  let last = -1;
  for (let i = 0; i < text.length; i++) if (OPS.includes(text[i])) last = i;
  if (last < 0) return epic; // no operator yet: the box is one leg fragment
  const head = text.slice(0, last + 1).replace(/\s*$/, ""); // up to & incl the operator
  return `${head} ${epic}`;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npx vitest run src/lib/syntheticExpr.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/syntheticExpr.ts frontend/src/lib/syntheticExpr.test.ts
git commit -m "feat(synthetic): activeLegFragment + insertLeg helpers for leg autocomplete"
```

---

## Task 2: Wire the modal (formula-mode search, "+" insert, hint, Enter, CSS)

**Files:**
- Modify: `frontend/src/SymbolSearchModal.tsx`
- Modify: `frontend/src/App.css`
- Test: `frontend/src/SymbolSearchModal.test.tsx`

**Interfaces:**
- Consumes: `activeLegFragment`, `insertLeg`, `isSyntheticExpr` (Task 1 + existing) from `./lib/syntheticExpr`.

- [ ] **Step 1: Formula-mode search targeting**

Add `activeLegFragment` and `insertLeg` to the existing `./lib/syntheticExpr` import. Replace the debounced-search effect (currently searching the whole `query`) so it searches the active fragment in formula mode:

```tsx
  useEffect(() => {
    const formula = isSyntheticExpr(query);
    const term = (formula ? activeLegFragment(query) : query).trim();
    if (!term) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      const found = await searchInstruments(term, brokerId);
      if (id !== reqId.current) return;
      setSearchHits(found);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query, brokerId]);
```

- [ ] **Step 2: `addLeg` handler + Enter-to-open**

Add near `pickSynthetic`:

```tsx
  function addLeg(epic: string) {
    const next = insertLeg(query, epic);
    setQuery(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  }
```

Add `onKeyDown` to the `<input>` (the one with `ref={inputRef}`):

```tsx
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                syntheticCandidate &&
                syntheticCandidate.missing.length === 0
              ) {
                e.preventDefault();
                pickSynthetic(syntheticCandidate.expr);
              }
            }}
```

- [ ] **Step 3: Per-row "+" button**

In the results `<li>` (the `shown.map(...)` block), add a "+" button next to the existing `ss-star` button (before or after it):

```tsx
              <button
                className="ss-add"
                title="Add to a synthetic formula"
                aria-label={`Add ${m.epic} to formula`}
                onClick={(e) => {
                  e.stopPropagation(); // don't open + close the modal
                  addLeg(m.epic);
                }}
              >
                +
              </button>
```

- [ ] **Step 4: Empty-fragment hint**

In the results `<ul>`, add a hint when in formula mode with an empty active fragment (place it alongside the existing empty/loading `<li>`s):

```tsx
          {isSyntheticExpr(query) && activeLegFragment(query) === "" && (
            <li className="symsearch-empty">Type to search the next leg…</li>
          )}
```

Ensure this doesn't double with the existing `!loading && shown.length === 0` empty row — guard that existing row with `!(isSyntheticExpr(query) && activeLegFragment(query) === "")` so only one shows.

- [ ] **Step 5: CSS for the "+" button**

In `frontend/src/App.css`, add a rule mirroring `.ss-star` (find `.ss-star` first and match its size/opacity/hover pattern):

```css
.ss-add {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  padding: 0 4px;
}
.symsearch-results li:hover .ss-add { opacity: 1; }
.ss-add:hover { color: var(--text); }
```
(Adjust variable names to match the real `.ss-star` rule you find.)

- [ ] **Step 6: Write component tests**

```tsx
// frontend/src/SymbolSearchModal.test.tsx — add cases (follow the file's existing
// setup: installMemStorage(), vi.mock("./lib/feed"), afterEach(cleanup), jsdom pragma)

it("the + button inserts a leg and keeps the modal open", async () => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<SymbolSearchModal current={CURRENT} brokerId="capital" onPick={onPick} onClose={onClose} />);
  await screen.findByText("OIL_CRUDE");
  fireEvent.click(screen.getByLabelText("Add OIL_CRUDE to formula"));
  expect(onPick).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByPlaceholderText(/symbol or name/i) as HTMLInputElement).value).toBe("OIL_CRUDE");
});

it("formula-mode search targets the active leg fragment", async () => {
  render(<SymbolSearchModal current={CURRENT} brokerId="capital" onPick={vi.fn()} onClose={vi.fn()} />);
  const input = screen.getByPlaceholderText(/symbol or name/i);
  fireEvent.change(input, { target: { value: "OIL_CRUDE / dx" } });
  await waitFor(() =>
    expect(searchInstrumentsMock).toHaveBeenCalledWith("dx", "capital"),
  );
});

it("Enter on a valid expression opens the synthetic", async () => {
  const onPick = vi.fn();
  render(<SymbolSearchModal current={CURRENT} brokerId="capital" onPick={onPick} onClose={vi.fn()} />);
  const input = screen.getByPlaceholderText(/symbol or name/i);
  fireEvent.change(input, { target: { value: "OIL_CRUDE/DXY" } });
  await screen.findByText(/= OIL_CRUDE\/DXY/);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({ epic: expect.stringMatching(/^SYN_/), type: "SYNTHETIC" }),
  );
});
```

Adjust `CURRENT`, the `./lib/feed` mock (must expose `searchInstruments` as `searchInstrumentsMock` returning `[{epic:"DXY",...}]` for `"dx"` and the catalogue `[OIL_CRUDE, DXY]` via `fetchAllMarkets`), and imports to match the existing test file's harness.

- [ ] **Step 7: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/SymbolSearchModal.test.tsx src/lib/syntheticExpr.test.ts`
Expected: PASS. Then `cd frontend && npx vitest run` (full suite green) and `npx tsc -b` (no NEW errors).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/SymbolSearchModal.tsx frontend/src/SymbolSearchModal.test.tsx frontend/src/App.css
git commit -m "feat(synthetic): inline leg autocomplete in symbol search (+ button, formula-mode search, Enter-to-open)"
```

---

## Self-Review Notes (coverage)

- Formula mode + fragment search → Task 2 Step 1. Per-row "+" → Steps 2-3. Empty-fragment hint → Step 4. Enter-to-open → Step 2. CSS → Step 5. Pure helpers → Task 1.
- Names consistent: `activeLegFragment`, `insertLeg`, `addLeg`, `pickSynthetic`, `syntheticCandidate` used identically across tasks.
