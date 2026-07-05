# Tooltip Migration Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 3 highest-leverage `title=` wrapper components (`SortHeader`, `Stat`, `ColorLineStylePicker`) and the standalone `IndicatorRow.tsx` onto the shared `<Tooltip>`/`InfoTip` components, with zero call-site changes.

**Architecture:** Each wrapper component keeps its exact prop signature; only its internal render swaps a native `title=` attribute for a `<Tooltip content={...}>` wrap. `IndicatorRow.tsx` deletes its hand-rolled portal/state and delegates to `InfoTip`.

**Tech Stack:** React + TypeScript, Vite, Vitest (`@vitest-environment jsdom`), `@testing-library/react`. No new dependencies.

## Global Constraints

- No new npm dependencies.
- Zero call-site changes: every existing caller of `SortHeader`, `Stat`, `ColorLineStylePicker`, and `IndicatorRow` keeps working unmodified.
- `SortHeader` and `Stat` are currently module-private functions (no `export` keyword) inside `frontend/src/PositionsPanel.tsx:733` and `:754`. Testing them via the full `PositionsPanel` component is impractical — it subscribes to live trade signals (`subscribeTrades`, `tradeLineUiSignal`, `draggingLineSignal`, `editTradeSignal`) and reads `localStorage` on mount. This plan adds the `export` keyword to both (visibility only, zero behavior change) so they can be unit-tested in isolation with real RTL rendering, matching this codebase's no-mocking test convention.
- Tests: each test file starts with `// @vitest-environment jsdom` and registers `afterEach(cleanup)` (this repo's vitest config does not auto-run RTL cleanup).
- This repo has NO `@testing-library/jest-dom` — use plain `.textContent`/`.length`/`.toBeNull()` assertions, not `toHaveTextContent`.
- Run `cd frontend && npx vitest run <path>` for focused runs, `cd frontend && npx tsc --noEmit` for typecheck.
- Scope: the ~126 standalone direct `title=` sites elsewhere in the app are explicitly **out of scope** — separate follow-up plan.

---

### Task 1: Export and wrap `SortHeader`

**Files:**
- Modify: `frontend/src/PositionsPanel.tsx:754-780` (add `export`, wrap the button)
- Test: `frontend/src/SortHeader.test.tsx` (new)

**Interfaces:**
- Consumes: `Tooltip` (default export) from `./components/Tooltip` — `<Tooltip content={string}>`.
- Produces: `export function SortHeader({ label, col, sort, onSort, title }: { label: string; col: SortKey; sort: { key: SortKey; dir: SortDir }; onSort: (key: SortKey) => void; title?: string })` — unchanged signature, now exported. `SortKey`/`SortDir` are types already defined earlier in `PositionsPanel.tsx`; the test imports `SortHeader` only (it constructs the `sort` object as a plain literal, no need to import the types).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/SortHeader.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SortHeader } from "./PositionsPanel";

afterEach(cleanup);

describe("SortHeader", () => {
  it("shows the title as a tooltip on focus", () => {
    render(
      <SortHeader
        label="Qty"
        col="quantity"
        sort={{ key: "openedAt", dir: "desc" }}
        onSort={() => {}}
        title="Position size (number of contracts / shares)"
      />,
    );
    fireEvent.focus(screen.getByRole("button", { name: /Qty/ }));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Position size (number of contracts / shares)",
    );
  });

  it("renders inertly with no tooltip when title is omitted", () => {
    render(
      <SortHeader
        label="Symbol"
        col="epic"
        sort={{ key: "openedAt", dir: "desc" }}
        onSort={() => {}}
      />,
    );
    fireEvent.focus(screen.getByRole("button", { name: /Symbol/ }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("still calls onSort when clicked", () => {
    let sorted: string | null = null;
    render(
      <SortHeader
        label="Qty"
        col="quantity"
        sort={{ key: "openedAt", dir: "desc" }}
        onSort={(key) => { sorted = key; }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Qty/ }));
    expect(sorted).toBe("quantity");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/SortHeader.test.tsx`
Expected: FAIL — `SortHeader` is not exported from `./PositionsPanel` (no matching export).

- [ ] **Step 3: Export and wrap `SortHeader`**

In `frontend/src/PositionsPanel.tsx`, find the `SortHeader` function (currently
starting at line 754 as `function SortHeader({`) and the top of the file's
imports. First add the `Tooltip` import near the other local imports (e.g. next
to any existing `import ... from "./components/..."` line, or near the top
import block):

```tsx
import Tooltip from "./components/Tooltip";
```

Then change the function declaration and its render. Before:
```tsx
function SortHeader({
  label,
  col,
  sort,
  onSort,
  title,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  title?: string;
}) {
  const active = sort.key === col;
  return (
    <button
      className={`pp-sort${active ? " on" : ""}`}
      onClick={() => onSort(col)}
      title={title}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span>{label}</span>
      <span className="pp-sort-caret" aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
      </span>
    </button>
  );
}
```

After:
```tsx
export function SortHeader({
  label,
  col,
  sort,
  onSort,
  title,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  title?: string;
}) {
  const active = sort.key === col;
  return (
    <Tooltip content={title}>
      <button
        className={`pp-sort${active ? " on" : ""}`}
        onClick={() => onSort(col)}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <span>{label}</span>
        <span className="pp-sort-caret" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </Tooltip>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/SortHeader.test.tsx`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/PositionsPanel.tsx frontend/src/SortHeader.test.tsx
git commit -m "refactor(tooltip): SortHeader renders its title through Tooltip"
```

---

### Task 2: Export and wrap `Stat`

**Files:**
- Modify: `frontend/src/PositionsPanel.tsx:733-750` (add `export`, wrap the div)
- Test: `frontend/src/Stat.test.tsx` (new)

**Interfaces:**
- Consumes: `Tooltip` (default export) from `./components/Tooltip` (already imported into `PositionsPanel.tsx` by Task 1 — do not re-add the import).
- Produces: `export function Stat({ label, value, tone, title }: { label: string; value: string; tone?: "pos" | "neg"; title?: string })` — unchanged signature, now exported.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/Stat.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Stat } from "./PositionsPanel";

afterEach(cleanup);

describe("Stat", () => {
  it("shows the title as a tooltip on hover", () => {
    render(
      <Stat
        label="Margin"
        value="$1,234"
        title="Total deposit currently tied up by open positions"
      />,
    );
    const stat = screen.getByText("Margin").closest(".pp-stat")!;
    fireEvent.mouseEnter(stat.parentElement!);
    fireEvent.focus(stat.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Total deposit currently tied up by open positions",
    );
  });

  it("renders inertly with no tooltip when title is omitted", () => {
    render(<Stat label="Balance" value="$5,000" />);
    const stat = screen.getByText("Balance").closest(".pp-stat")!;
    fireEvent.focus(stat.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("applies the pos/neg tone class to the value", () => {
    render(<Stat label="P&L" value="+$50" tone="pos" />);
    expect(screen.getByText("+$50").className).toContain("pp-pos");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/Stat.test.tsx`
Expected: FAIL — `Stat` is not exported from `./PositionsPanel`.

- [ ] **Step 3: Export and wrap `Stat`**

In `frontend/src/PositionsPanel.tsx`, change the `Stat` function. Before:
```tsx
function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
  title?: string;
}) {
  return (
    <div className="pp-stat" title={title}>
      <span className="pp-stat-label">{label}</span>
      <span className={`pp-stat-val num${tone ? ` pp-${tone}` : ""}`}>{value}</span>
    </div>
  );
}
```

After:
```tsx
export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
  title?: string;
}) {
  return (
    <Tooltip content={title}>
      <div className="pp-stat">
        <span className="pp-stat-label">{label}</span>
        <span className={`pp-stat-val num${tone ? ` pp-${tone}` : ""}`}>{value}</span>
      </div>
    </Tooltip>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/Stat.test.tsx`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/PositionsPanel.tsx frontend/src/Stat.test.tsx
git commit -m "refactor(tooltip): Stat renders its title through Tooltip"
```

---

### Task 3: Wrap all 5 native titles in `ColorLineStylePicker`

**Files:**
- Modify: `frontend/src/ColorLineStylePicker.tsx` (5 locations: lines 146, 190, 202, 244, 265 in the pre-task file)
- Test: `frontend/src/ColorLineStylePicker.test.tsx` (new)

**Interfaces:**
- Consumes: `Tooltip` (default export) from `./components/Tooltip`.
- Produces: no signature change — `ColorLineStylePicker`'s `Props` interface (`color`, `onColor`, `opacity?`, `onOpacity?`, `size?`, `onSize?`, `lineStyle?`, `onLineStyle?`, `lineStyleOptions?`, `disabled?`, `title?`) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ColorLineStylePicker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ColorLineStylePicker from "./ColorLineStylePicker";

afterEach(cleanup);

describe("ColorLineStylePicker", () => {
  it("shows the explicit title as a tooltip on the swatch trigger", () => {
    render(<ColorLineStylePicker color="#ff0000" onColor={() => {}} title="Bid line" />);
    fireEvent.focus(screen.getByRole("button", { name: "" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Bid line");
  });

  it("falls back to the default title when none is passed", () => {
    render(<ColorLineStylePicker color="#ff0000" onColor={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Color & line style");
  });

  it("shows a tooltip with the hex code on a palette cell once the popover is open", () => {
    render(<ColorLineStylePicker color="#ffffff" onColor={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "" }));
    // PALETTE's first entry is "#ffffff" (top-left of the greyscale row) — a
    // stable index, unlike matching on the cell's serialized inline style.
    const firstCell = document.querySelectorAll(".clsp-cell")[0] as HTMLElement;
    fireEvent.focus(firstCell);
    expect(screen.getByRole("tooltip").textContent).toContain("#ffffff");
  });

  it("shows a tooltip on a thickness preset when size is supplied", () => {
    render(
      <ColorLineStylePicker color="#000000" onColor={() => {}} size={2} onSize={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "" }));
    const presets = document.querySelectorAll(".clsp-preset");
    fireEvent.focus(presets[0]);
    expect(screen.getByRole("tooltip").textContent).toContain("1px");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/ColorLineStylePicker.test.tsx`
Expected: FAIL — no `role="tooltip"` exists yet (native `title=` produces no such role).

- [ ] **Step 3: Wrap all 5 native titles**

In `frontend/src/ColorLineStylePicker.tsx`, add the import near the top (after
the existing `import { useEffect, useRef, useState } from "react";` /
`import { createPortal } from "react-dom";` lines):

```tsx
import Tooltip from "./components/Tooltip";
```

Then apply these 5 wraps.

**(a) Main swatch trigger (was line 141-173):** wrap the `<button>` in
`<Tooltip content={title ?? "Color & line style"}>` and remove the `title={...}`
attribute from the button itself:

```tsx
<Tooltip content={title ?? "Color & line style"}>
  <button
    ref={triggerRef}
    type="button"
    className={`clsp-swatch${showLinePreview ? " clsp-swatch--line" : ""}${open ? " on" : ""}`}
    disabled={disabled}
    onClick={toggle}
  >
    <span
      className="clsp-swatch-fill"
      style={{ background: color, opacity: swatchAlpha }}
    />
    {showLinePreview && (
      <svg
        className="clsp-swatch-line"
        viewBox="0 0 40 16"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1="2"
          y1="8"
          x2="38"
          y2="8"
          stroke={color}
          strokeOpacity={swatchAlpha}
          strokeWidth={size ?? 2}
          strokeDasharray={lineStyle ? LINE_STYLE_DASH[lineStyle] : undefined}
          strokeLinecap={lineStyle === "dotted" ? "round" : "butt"}
        />
      </svg>
    )}
  </button>
</Tooltip>
```

**(b) Palette cell (was line 184-192):** wrap in `<Tooltip content={c}>`, remove
`title={c}`:

```tsx
{PALETTE.map((c) => (
  <Tooltip key={c} content={c}>
    <button
      type="button"
      className={`clsp-cell${sameColor(c, color) ? " sel" : ""}`}
      style={{ background: c }}
      onClick={() => onColor(c)}
    />
  </Tooltip>
))}
```

**(c) Custom-color tile (was line 199-215):** wrap in
`<Tooltip content="Custom color">`, remove `title="Custom color"`:

```tsx
<Tooltip content="Custom color">
  <button
    type="button"
    className="clsp-add"
    onClick={() => nativeRef.current?.click()}
  >
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
    <input
      ref={nativeRef}
      type="color"
      value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#000000"}
      onChange={(e) => onColor(e.target.value)}
    />
  </button>
</Tooltip>
```

**(d) Thickness preset (was line 240-251):** wrap in
`<Tooltip content={`${s}px`}>`, remove `title={`${s}px`}`:

```tsx
{SIZES.map((s) => (
  <Tooltip key={s} content={`${s}px`}>
    <button
      type="button"
      className={`clsp-preset${s === size ? " sel" : ""}`}
      onClick={() => onSize(s)}
    >
      <svg viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
        <line x1="3" y1="8" x2="37" y2="8" strokeWidth={s} />
      </svg>
    </button>
  </Tooltip>
))}
```

**(e) Line-style preset (was line 261-267):** wrap in
`<Tooltip content={LINE_STYLE_LABEL[opt]}>`, remove
`title={LINE_STYLE_LABEL[opt]}`:

```tsx
{lineStyleOptions.map((opt) => (
  <Tooltip key={opt} content={LINE_STYLE_LABEL[opt]}>
    <button
      type="button"
      className={`clsp-preset${opt === lineStyle ? " sel" : ""}`}
      onClick={() => onLineStyle(opt)}
    >
      <svg viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
        <line
          x1="3"
          y1="8"
          x2="37"
          y2="8"
          strokeWidth={2}
          strokeDasharray={LINE_STYLE_DASH[opt]}
          strokeLinecap={opt === "dotted" ? "round" : "butt"}
        />
      </svg>
    </button>
  </Tooltip>
))}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/ColorLineStylePicker.test.tsx`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ColorLineStylePicker.tsx frontend/src/ColorLineStylePicker.test.tsx
git commit -m "refactor(tooltip): ColorLineStylePicker renders all 5 titles through Tooltip"
```

---

### Task 4: Fold `IndicatorRow.tsx` onto `InfoTip`, wrap the star button

**Files:**
- Modify: `frontend/src/IndicatorRow.tsx` (full rewrite — removes local tooltip state/portal, adds `InfoTip` + `Tooltip`)
- Test: `frontend/src/IndicatorRow.test.tsx` (new)

**Interfaces:**
- Consumes: `InfoTip` (default export) from `./components/InfoTip` — `<InfoTip title={string} text={string}>`; `Tooltip` (default export) from `./components/Tooltip`; `indicatorInfo` from `./lib/indicatorMeta` (unchanged, already imported).
- Produces: `export default function IndicatorRow({ name, favorite, onAdd, onToggleFavorite }: Props)` — unchanged signature.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/IndicatorRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import IndicatorRow from "./IndicatorRow";

afterEach(cleanup);

describe("IndicatorRow", () => {
  it("shows the indicator's description via InfoTip when one exists", () => {
    render(<IndicatorRow name="RSI" favorite={false} onAdd={() => {}} onToggleFavorite={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "About Relative Strength Index" }));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Momentum oscillator (0–100) measuring the speed of gains vs losses",
    );
  });

  it("renders no info button for an indicator with no catalogued description", () => {
    render(<IndicatorRow name="NOT_A_REAL_INDICATOR" favorite={false} onAdd={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.queryByRole("button", { name: "About NOT_A_REAL_INDICATOR" })).toBeNull();
  });

  it("shows a tooltip on the favorite star reflecting its current state", () => {
    render(<IndicatorRow name="RSI" favorite={false} onAdd={() => {}} onToggleFavorite={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "Add to favorites" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Add to favorites");
  });

  it("clicking the row (not the star or info button) calls onAdd", () => {
    let added = false;
    render(<IndicatorRow name="RSI" favorite={false} onAdd={() => { added = true; }} onToggleFavorite={() => {}} />);
    fireEvent.click(screen.getByText(/Relative Strength|RSI/));
    expect(added).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/IndicatorRow.test.tsx`
Expected: FAIL — no `role="tooltip"` from the current hand-rolled implementation (it renders a raw `.ind-tooltip` div with `role="tooltip"` only while `tip` state is set via mouse-position-tracking `showTip`, which `fireEvent.focus` alone does trigger in the OLD code too — but the "About RSI" test will fail because `desc` interpolation differs, and the "no info button for uncatalogued indicator" test passes trivially; the deciding failure is the row-click test's text query and the exact tooltip content wording match. Confirm at least one assertion fails before proceeding — if all 4 pass unexpectedly, inspect why before writing new code.)

- [ ] **Step 3: Rewrite `IndicatorRow.tsx`**

Replace the entire contents of `frontend/src/IndicatorRow.tsx`:

```tsx
// One row in the indicator menu: the indicator name (click adds an instance),
// a leading favourite star, and a trailing ⓘ that reveals a description tooltip
// via the shared InfoTip component.

import { indicatorInfo } from "./lib/indicatorMeta";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";

interface Props {
  name: string;
  favorite: boolean;
  onAdd: () => void;
  onToggleFavorite: () => void;
}

export default function IndicatorRow({ name, favorite, onAdd, onToggleFavorite }: Props) {
  const { title, desc } = indicatorInfo(name);

  return (
    <li className="ind-row" onClick={onAdd}>
      <Tooltip content={favorite ? "Remove from favorites" : "Add to favorites"}>
        <button
          className={"ind-star" + (favorite ? " on" : "")}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
          onClick={(e) => {
            e.stopPropagation(); // don't add an instance
            onToggleFavorite();
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
          </svg>
        </button>
      </Tooltip>

      {/* Full name with the abbreviation in parens, e.g. "Relative Strength
          Index (RSI)". Uncatalogued indicators fall back to just the code. */}
      <span className="ind-name">
        {title === name ? name : `${title} (${name})`}
      </span>

      {desc && <InfoTip title={title} text={desc} />}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/IndicatorRow.test.tsx`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all tests pass (including `Toolbar.tsx`'s existing tests, if any, since it's `IndicatorRow`'s only caller — confirm no regressions).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/IndicatorRow.tsx frontend/src/IndicatorRow.test.tsx
git commit -m "refactor(tooltip): fold IndicatorRow onto InfoTip, wrap favorite-star title"
```

---

## Self-Review

**Spec coverage:**
- `SortHeader` wrap, zero call-site changes → Task 1. ✓
- `Stat` wrap, zero call-site changes → Task 2. ✓
- All 5 `ColorLineStylePicker` native titles wrapped in the same task → Task 3. ✓
- `IndicatorRow.tsx` folded onto `InfoTip`, favorite-star wrapped, obsolete file-header comment addressed (the new file header in Task 4 drops the stale portal-clipping explanation since the workaround is now inherited from `InfoTip`) → Task 4. ✓
- `export` added to `SortHeader`/`Stat` for testability, justified in Global Constraints → Task 1 & 2. ✓
- Visual layout check for `SortHeader`/`Stat` noted in spec as a manual verification step — not automatable in a unit test; flagged here for the developer to check in the running app after Tasks 1–2 (position table header row, account stats strip) before considering the phase done.
- Out-of-scope ~126 standalone sites — correctly excluded, no task touches them.

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every step shows complete code or exact commands.

**Type consistency:** `Tooltip`'s `content` prop (`string | string[] | ReactNode`) accepts a plain `string | undefined` from `title` in all 3 wrapper tasks — consistent with `Tooltip.tsx`'s existing `isEmpty()` check treating `undefined`/`""` as inert. `InfoTip`'s `{ title, text }` props match its Task-3-of-the-original-plan signature (`text: string | string[]`, `title?: string`) exactly. No renamed exports or mismatched signatures across tasks.
