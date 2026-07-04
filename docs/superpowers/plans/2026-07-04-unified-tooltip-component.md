# Unified `<Tooltip>` Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one reusable, fast, styled `<Tooltip>` component and fold the two duplicate ⓘ `InfoTip` files onto it.

**Architecture:** A pure placement function (`computePlacement`, DOM-free, unit-testable) plus a `Tooltip` React component that portals a flat bubble to `<body>`, positions it collision-aware off the trigger's rect, and shows on hover (100ms delay + instant grace group) and focus with a quick fade+slide. The ⓘ `InfoTip` becomes a thin wrapper over `Tooltip`; the duplicate file is deleted and importers repointed.

**Tech Stack:** React + TypeScript, Vite, Vitest (`@vitest-environment jsdom`), `@testing-library/react`. No new dependencies.

## Global Constraints

- No new npm dependencies — hand-rolled positioning, no floating-ui/tippy/radix.
- Flat visuals: **no box-shadow** on the bubble (app-wide no-shadows convention).
- Default placement **top**; flip/shift to stay on screen.
- Animation **A**: ~120ms fade + 8px slide toward the anchor; fade-only under `prefers-reduced-motion`.
- Timing: `delay` prop defaults to **100ms** on first hover, instant within a ~400ms grace window; keyboard focus is always instant; `delay={0}` = always instant.
- CSS class names: `.tooltip`, `.tooltip-title`, `.tooltip-desc` (canonical; replace `.ind-tooltip*`).
- Tests: each test file starts with `// @vitest-environment jsdom` and registers `afterEach(cleanup)` (RTL auto-cleanup does not fire in this repo's vitest config).
- Scope: migrating the ~194 native `title=` sites is **follow-up work, not in this plan**. This plan ships the component + the InfoTip unification.

---

### Task 1: Pure placement function

A DOM-free function that decides where the bubble goes. Isolating it makes collision behavior unit-testable without a layout engine (jsdom reports zero-size rects).

**Files:**
- Create: `frontend/src/components/tooltipPosition.ts`
- Test: `frontend/src/components/tooltipPosition.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Placement = "top" | "bottom" | "left" | "right"`
  - `interface Box { left: number; top: number; width: number; height: number }`
  - `interface Placed { left: number; top: number; side: Placement }`
  - `function computePlacement(trigger: Box, bubble: { width: number; height: number }, preferred: Placement, viewport: { width: number; height: number }, gap?: number, margin?: number): Placed`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/tooltipPosition.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computePlacement } from "./tooltipPosition";

const VP = { width: 1000, height: 800 };
// a 40x20 trigger centred horizontally, mid-screen
const mid = { left: 480, top: 400, width: 40, height: 20 };
const bubble = { width: 120, height: 40 };

describe("computePlacement", () => {
  it("places on the preferred side (top) with the gap, horizontally centred", () => {
    const p = computePlacement(mid, bubble, "top", VP, 8);
    expect(p.side).toBe("top");
    // top = trigger.top - bubble.height - gap
    expect(p.top).toBe(400 - 40 - 8);
    // left = trigger centre - half bubble width = 500 - 60
    expect(p.left).toBe(440);
  });

  it("flips top->bottom when there is no room above", () => {
    const nearTop = { left: 480, top: 4, width: 40, height: 20 };
    const p = computePlacement(nearTop, bubble, "top", VP, 8);
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(4 + 20 + 8);
  });

  it("shifts inward on the cross axis instead of overflowing the right edge", () => {
    const nearRight = { left: 970, top: 400, width: 40, height: 20 };
    const p = computePlacement(nearRight, bubble, "top", VP, 8, 4);
    // would be centred at 990 -> left 930, overflows (930+120=1050>996); clamp
    expect(p.left).toBe(VP.width - bubble.width - 4); // 876
  });

  it("flips right->left when there is no room to the right", () => {
    const nearRight = { left: 900, top: 400, width: 40, height: 20 };
    const p = computePlacement(nearRight, bubble, "right", VP, 8);
    expect(p.side).toBe("left");
    expect(p.left).toBe(900 - bubble.width - 8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/tooltipPosition.test.ts`
Expected: FAIL — "computePlacement is not a function" / module not found.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/tooltipPosition.ts`:

```ts
export type Placement = "top" | "bottom" | "left" | "right";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placed {
  left: number;
  top: number;
  side: Placement;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Decide where a tooltip bubble goes relative to its trigger.
 * Pure and DOM-free so it can be unit-tested without a layout engine.
 * - vertical placements (top/bottom) flip to the opposite side if there's no
 *   room, then centre + clamp horizontally.
 * - horizontal placements (left/right) mirror that on the other axis.
 */
export function computePlacement(
  trigger: Box,
  bubble: { width: number; height: number },
  preferred: Placement,
  viewport: { width: number; height: number },
  gap = 8,
  margin = 4,
): Placed {
  const cx = trigger.left + trigger.width / 2;
  const cy = trigger.top + trigger.height / 2;

  if (preferred === "top" || preferred === "bottom") {
    const roomAbove = trigger.top - gap - bubble.height >= margin;
    const roomBelow = trigger.top + trigger.height + gap + bubble.height <= viewport.height - margin;
    let side: Placement = preferred;
    if (preferred === "top" && !roomAbove && roomBelow) side = "bottom";
    if (preferred === "bottom" && !roomBelow && roomAbove) side = "top";
    const top = side === "top"
      ? trigger.top - bubble.height - gap
      : trigger.top + trigger.height + gap;
    const left = clamp(cx - bubble.width / 2, margin, viewport.width - bubble.width - margin);
    return { left, top, side };
  }

  const roomLeft = trigger.left - gap - bubble.width >= margin;
  const roomRight = trigger.left + trigger.width + gap + bubble.width <= viewport.width - margin;
  let side: Placement = preferred;
  if (preferred === "right" && !roomRight && roomLeft) side = "left";
  if (preferred === "left" && !roomLeft && roomRight) side = "right";
  const left = side === "left"
    ? trigger.left - bubble.width - gap
    : trigger.left + trigger.width + gap;
  const top = clamp(cy - bubble.height / 2, margin, viewport.height - bubble.height - margin);
  return { left, top, side };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/tooltipPosition.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/tooltipPosition.ts frontend/src/components/tooltipPosition.test.ts
git commit -m "feat(tooltip): pure collision-aware placement function"
```

---

### Task 2: The `Tooltip` component + CSS

The portaled bubble, hover/focus triggering with delay + grace group, and the flat fade+slide styling.

**Files:**
- Create: `frontend/src/components/Tooltip.tsx`
- Modify: `frontend/src/App.css` (add `.tooltip*` rules near the existing `.ind-tooltip` block at ~line 2033)
- Test: `frontend/src/components/Tooltip.test.tsx`

**Interfaces:**
- Consumes: `computePlacement`, `Placement`, `Placed` from `./tooltipPosition`.
- Produces (default export):
  ```ts
  interface TooltipProps {
    content: string | string[] | React.ReactNode;
    title?: string;
    placement?: Placement;   // default "top"
    delay?: number;          // default 100 (ms)
    disabled?: boolean;
    children: React.ReactNode;
  }
  export default function Tooltip(props: TooltipProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Tooltip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import Tooltip from "./Tooltip";

afterEach(cleanup);
beforeEach(() => { vi.useRealTimers(); });

describe("Tooltip", () => {
  it("shows after the delay on hover, hides on mouse leave", () => {
    vi.useFakeTimers();
    render(<Tooltip content="Close book"><button>x</button></Tooltip>);
    // expire any grace window left by a previous test
    act(() => { vi.advanceTimersByTime(600); });

    fireEvent.mouseEnter(screen.getByText("x").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();      // still within delay
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByRole("tooltip").textContent).toContain("Close book");

    fireEvent.mouseLeave(screen.getByText("x").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows instantly on keyboard focus", () => {
    render(<Tooltip content="Hi"><button>btn</button></Tooltip>);
    fireEvent.focus(screen.getByText("btn").parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain("Hi");
  });

  it("renders a string array as separate description lines, plus a title", () => {
    render(
      <Tooltip title="Margin" content={["Line one.", "Line two."]}>
        <span>m</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText("m").parentElement!);
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector(".tooltip-title")?.textContent).toBe("Margin");
    expect(tip.querySelectorAll(".tooltip-desc").length).toBe(2);
  });

  it("renders nothing and stays inert when content is empty", () => {
    render(<Tooltip content=""><button>bare</button></Tooltip>);
    fireEvent.focus(screen.getByText("bare").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("does not show when disabled", () => {
    render(<Tooltip content="nope" disabled><button>d</button></Tooltip>);
    fireEvent.focus(screen.getByText("d").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Tooltip.test.tsx`
Expected: FAIL — cannot find module `./Tooltip`.

- [ ] **Step 3: Write the component**

Create `frontend/src/components/Tooltip.tsx`:

```tsx
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computePlacement, type Placed, type Placement } from "./tooltipPosition";

interface TooltipProps {
  content: string | string[] | ReactNode;
  title?: string;
  placement?: Placement;
  delay?: number;
  disabled?: boolean;
  children: ReactNode;
}

// Module-level grace window: after any tooltip hides, the next one shown within
// GRACE_MS skips its delay. This is what makes sweeping across a toolbar snappy —
// you wait once, not on every icon.
const GRACE_MS = 400;
let lastHideAt = -Infinity;

function isEmpty(content: TooltipProps["content"]): boolean {
  return (
    content == null ||
    content === "" ||
    (Array.isArray(content) && content.length === 0)
  );
}

export default function Tooltip({
  content,
  title,
  placement = "top",
  delay = 100,
  disabled,
  children,
}: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false); // toggles .show for the enter transition
  const [placed, setPlaced] = useState<Placed | null>(null);
  const id = useId();

  const off = disabled || isEmpty(content);

  function clearTimer() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function hoverShow() {
    if (off) return;
    clearTimer();
    const instant = delay <= 0 || Date.now() - lastHideAt < GRACE_MS;
    if (instant) setOpen(true);
    else timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }

  function focusShow() {
    if (off) return;
    clearTimer();
    setOpen(true); // keyboard focus is always instant
  }

  function hide() {
    clearTimer();
    setOpen((wasOpen) => {
      if (wasOpen) lastHideAt = Date.now();
      return false;
    });
    setShown(false);
  }

  // Measure + position once the bubble is in the DOM, then flip on .show next frame.
  useLayoutEffect(() => {
    if (!open) return;
    const tr = triggerRef.current?.getBoundingClientRect();
    const b = bubbleRef.current;
    if (!tr || !b) return;
    const p = computePlacement(
      { left: tr.left, top: tr.top, width: tr.width, height: tr.height },
      { width: b.offsetWidth, height: b.offsetHeight },
      placement,
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlaced(p);
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open, placement, content, title]);

  // Hide on scroll (capture, so nested scrollers count), resize, and Escape.
  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const lines = Array.isArray(content) ? content : [content];

  return (
    <>
      <span
        ref={triggerRef}
        className="tooltip-trigger"
        aria-describedby={open ? id : undefined}
        onMouseEnter={hoverShow}
        onMouseLeave={hide}
        onFocus={focusShow}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        !off &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={`tooltip${shown ? " show" : ""}`}
            data-side={placed?.side ?? placement}
            style={{ left: placed?.left ?? 0, top: placed?.top ?? 0 }}
          >
            {title && <div className="tooltip-title">{title}</div>}
            {lines.map((line, i) =>
              typeof line === "string" || typeof line === "number" ? (
                <div className="tooltip-desc" key={i}>
                  {line}
                </div>
              ) : (
                <div key={i}>{line}</div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
```

- [ ] **Step 4: Add the CSS**

In `frontend/src/App.css`, replace the existing `.ind-tooltip` block (currently at ~lines 2033-2042) with the canonical `.tooltip` rules. Keep the three `.ind-tooltip*` aliases pointing at the same styles for now so any not-yet-migrated caller of the raw class still renders (they are removed when the last raw usage is gone):

```css
.tooltip {
  position: fixed; z-index: 2500; /* above the modal (2000) */
  max-width: 260px; padding: 8px 10px;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px;
  pointer-events: none;
  /* animation A: quick fade + 8px slide toward the anchor */
  opacity: 0;
  transition: opacity .12s ease, transform .12s cubic-bezier(.2,.7,.3,1);
}
.tooltip[data-side="top"]    { transform: translateY(8px); }
.tooltip[data-side="bottom"] { transform: translateY(-8px); }
.tooltip[data-side="left"]   { transform: translateX(8px); }
.tooltip[data-side="right"]  { transform: translateX(-8px); }
.tooltip.show { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
  .tooltip { transition: opacity .12s ease; }
  .tooltip[data-side] { transform: none; }
}
.tooltip-title { font-weight: 600; font-size: 12px; margin-bottom: 3px; }
.tooltip-desc  { font-size: 12px; color: var(--text-dim); line-height: 1.45; }
.tooltip-desc + .tooltip-desc { margin-top: 6px; }

/* the invisible inline wrapper around a trigger — must have a box so its
   getBoundingClientRect() anchors the bubble; adds no visual footprint. */
.tooltip-trigger { display: inline-flex; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/Tooltip.test.tsx`
Expected: PASS (5 passed).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Tooltip.tsx frontend/src/components/Tooltip.test.tsx frontend/src/App.css
git commit -m "feat(tooltip): portaled Tooltip component with delay + grace group and fade/slide"
```

---

### Task 3: Fold the two `InfoTip` files onto `Tooltip`

Unify the two ⓘ components into one that renders `Tooltip` around the info glyph. Standardize on the richer `text` prop and delete the duplicate.

**Files:**
- Rewrite: `frontend/src/components/InfoTip.tsx`
- Delete: `frontend/src/InfoTip.tsx`
- Modify (repoint import path `./InfoTip` → `./components/InfoTip`): `frontend/src/ChartLegend.tsx:17`, `frontend/src/IndicatorSettings.tsx:68`, `frontend/src/DrawingSettings.tsx:25`
- Modify (rename prop `desc=` → `text=`, 9 sites): `frontend/src/Toolbar.tsx` (6), `frontend/src/BacktestSettingsModal.tsx` (1), `frontend/src/DrawSidebar.tsx` (2)
- Test: `frontend/src/components/InfoTip.test.tsx`

**Interfaces:**
- Consumes: `Tooltip` (default export) from `./Tooltip`.
- Produces (default export), the union of both old APIs:
  ```ts
  interface InfoTipProps {
    text: string | string[];       // was `text` (src/) / `desc` (components/)
    title?: string;
    children?: React.ReactNode;    // custom trigger; defaults to the ⓘ glyph
    className?: string;            // trigger button class; default "ind-info"
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/InfoTip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import InfoTip from "./InfoTip";

afterEach(cleanup);

describe("InfoTip", () => {
  it("shows the title and text on hover of the ⓘ glyph", () => {
    render(<InfoTip title="Margin" text={["Deposit required.", "= notional ÷ leverage."]} />);
    fireEvent.focus(screen.getByRole("button", { name: "About Margin" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector(".tooltip-title")?.textContent).toBe("Margin");
    expect(tip.querySelectorAll(".tooltip-desc").length).toBe(2);
  });

  it("swallows clicks so it never toggles a wrapping row/label", () => {
    let outer = 0;
    render(
      <div onClick={() => { outer += 1; }}>
        <InfoTip text="hi" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More info" }));
    expect(outer).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/InfoTip.test.tsx`
Expected: FAIL — the current `components/InfoTip.tsx` has props `{ title, desc }`, no `text`; `aria-label` "About Margin" exists but the `text`/array assertions and the "More info" label (no title) fail.

- [ ] **Step 3: Rewrite `components/InfoTip.tsx`**

Replace the entire contents of `frontend/src/components/InfoTip.tsx`:

```tsx
import type { ReactNode } from "react";
import Tooltip from "./Tooltip";

interface InfoTipProps {
  // One string, or several — each rendered as its own description line.
  text: string | string[];
  title?: string;
  // Optional custom trigger (e.g. a ⚠ badge); defaults to the ⓘ glyph.
  children?: ReactNode;
  // Overrides the trigger button's class (default "ind-info").
  className?: string;
}

// A trailing ⓘ that reveals a description tooltip on hover/focus. The tooltip
// mechanics (portal, positioning, timing, animation) all live in <Tooltip>; this
// component only owns the icon trigger and swallows its click so tapping the icon
// inside a menu row / label never triggers the row's action.
export default function InfoTip({ text, title, children, className }: InfoTipProps) {
  return (
    <Tooltip title={title} content={text}>
      <button
        type="button"
        className={className ?? "ind-info"}
        aria-label={title ? `About ${title}` : "More info"}
        tabIndex={-1}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {children ?? (
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>
    </Tooltip>
  );
}
```

- [ ] **Step 4: Run the InfoTip test to verify it passes**

Run: `cd frontend && npx vitest run src/components/InfoTip.test.tsx`
Expected: PASS (2 passed).

- [ ] **Step 5: Repoint the three `./InfoTip` importers**

In each file, change the import to the unified path:

- `frontend/src/ChartLegend.tsx:17` — `import InfoTip from "./InfoTip";` → `import InfoTip from "./components/InfoTip";`
- `frontend/src/IndicatorSettings.tsx:68` — same change.
- `frontend/src/DrawingSettings.tsx:25` — same change.

(These three already use the `text=` prop, so no call-site prop changes are needed.)

- [ ] **Step 6: Rename `desc=` → `text=` at the 9 `components/InfoTip` call sites**

These files already import from `./components/InfoTip`; only the prop name changes. Replace every `desc=` with `text=` on an `<InfoTip …>` in:

- `frontend/src/Toolbar.tsx` — 6 occurrences (e.g. `desc={\`Saves this chart's…\`}` → `text={\`Saves this chart's…\`}`, and the `desc="Adds the template's…"` etc.).
- `frontend/src/BacktestSettingsModal.tsx` — 1 occurrence: `<InfoTip title={o.label} desc={o.tip} />` → `<InfoTip title={o.label} text={o.tip} />`.
- `frontend/src/DrawSidebar.tsx` — 2 occurrences: the `desc="Snaps a drawing point…"` and `desc="Always snaps…"` become `text=…`.

Verify none remain:

Run: `cd frontend && grep -rn 'desc=' src/Toolbar.tsx src/BacktestSettingsModal.tsx src/DrawSidebar.tsx`
Expected: no output.

- [ ] **Step 7: Delete the duplicate and confirm nothing imports it**

```bash
git rm frontend/src/InfoTip.tsx
cd frontend && grep -rn 'from "\./InfoTip"' src ; echo "exit: $?"
```
Expected: `grep` prints nothing (exit 1 from grep = no matches) — no remaining `./InfoTip` imports.

- [ ] **Step 8: Run the full unit suite + typecheck**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all tests pass (including the pre-existing `SymbolSearchModal` / `VisibilityTab` suites).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(tooltip): fold both InfoTip files onto Tooltip, unify text prop"
```

---

## Self-Review

**Spec coverage:**
- Component API (`content`/`title`/`placement`/`delay`/`disabled`) → Task 2 interface + props. ✓
- Portal to `<body>`, `position: fixed` → Task 2 component + CSS. ✓
- Collision-aware placement, default top → Task 1 (`computePlacement`) + tests. ✓
- Hover + focus triggers, hide on leave/blur/Escape/scroll/resize → Task 2 component + tests. ✓
- Delay 100ms + grace group, focus instant, `delay={0}` → Task 2 `hoverShow`/`focusShow` + test. ✓
- Animation A (fade + 8px slide, reduced-motion fade-only) → Task 2 CSS. ✓
- Flat, border-only, no shadow → Task 2 CSS. ✓
- `role="tooltip"` + `aria-describedby` → Task 2 component. ✓
- InfoTip becomes composition, both files collapse into one, `text` prop union → Task 3. ✓
- `inline-flex` trigger wrapper with a real box → Task 2 `.tooltip-trigger` CSS + note. ✓
- 194 `title=` migration explicitly out of scope → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every step shows complete code or exact commands. ✓

**Type consistency:** `computePlacement` signature and the `Placement`/`Placed`/`Box` types are identical between Task 1 (produced) and Task 2 (consumed). `Tooltip` prop names (`content`, `title`, `placement`, `delay`, `disabled`) match between Task 2's interface and Task 3's usage. `InfoTip` prop `text` (not `desc`) is consistent across the rewrite (Step 3) and the call-site rename (Step 6). ✓
