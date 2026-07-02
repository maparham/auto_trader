# Modern Tab Drag-to-Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2px drop-indicator line in the chart tab bar with a floating dragged chip plus slide-apart gap preview, keeping the center-of-chip merge and drag-onto-chart merge exactly as they are.

**Architecture:** All drag geometry (flex-wrap flow simulation, nearest-gap hit-testing, per-chip translate preview) moves into a new pure module `frontend/src/lib/tabDrag.ts`, unit-tested with vitest. `TabBar.tsx` keeps HTML5 drag events but moves `dragover`/`drop` from the individual chips to the `.tab-bar-tabs` container, drives per-chip `transform` previews from cached rects, and renders a `position: fixed` floating clone of the grabbed chip. `App`'s callbacks (`onReorder`, `onMerge`, `canMerge`, `onDragActive`) are untouched.

**Tech Stack:** React 19, TypeScript, plain CSS (App.css), vitest for unit tests, Playwright for e2e. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-03-tab-reorder-drag-design.md`

## Global Constraints

- Never touch `App.tsx` — the `onReorder(from, to)` contract is original-array slot, remove-then-insert (`App.tsx:1128`): `to === length` means past the end; rightward moves land at `to - 1` after removal.
- The bar **wraps to multiple rows** (`.tab-bar-tabs` is `flex-wrap: wrap; gap: 6px`) — all geometry must be row-aware, never assume one row.
- Keep the CSS class name `.tab.dragging` on the drag-source chip — `e2e/merge-tabs.spec.ts:235,284` asserts `.tab.dragging` has count 0 after a merge-away gesture.
- Keep `.tab.drop-merge` and the middle-~40%-of-chip merge zone semantics — `e2e/merge-tabs.spec.ts:176` drops on a chip center to merge.
- Existing e2e must pass unchanged: `e2e/tab-reorder.spec.ts`, `e2e/merge-tabs.spec.ts`. The reorder test asserts the new order **synchronously after drop**, so the reorder must commit immediately on drop (no settle delay).
- Do not kill the user's running dev servers. Commit directly to `main` (no feature branch).
- UI rules: light theme is canonical; no shadows — with ONE approved exception: the floating drag chip carries a soft shadow (explicitly approved in the spec) because that is what reads as "lifted".
- Plan-level deviations from the spec (already accepted rationale, do not re-litigate): (1) drop settles instantly instead of a 120ms glide — the gap already tracks the cursor and the e2e asserts order synchronously; (2) on cancel, the chips slide back animated but the floating clone disappears immediately rather than flying home.

---

### Task 1: Pure drag-geometry module `tabDrag.ts`

**Files:**
- Create: `frontend/src/lib/tabDrag.ts`
- Test: `frontend/src/lib/tabDrag.test.ts`

**Interfaces:**
- Consumes: nothing (pure, DOM-free).
- Produces (Task 2/3 rely on these exact signatures):
  - `interface Rect { left: number; top: number; width: number; height: number }`
  - `type DragTarget = { kind: "insert"; index: number } | { kind: "merge"; index: number }`
  - `flowPositions(widths: number[], containerWidth: number, gap: number): { x: number; row: number }[]`
  - `moveItem<T>(arr: T[], from: number, to: number): T[]`
  - `previewDeltas(rects: Rect[], containerWidth: number, gap: number, from: number, to: number): { dx: number; dy: number }[]`
  - `dropTarget(rects: Rect[], x: number, y: number, fromIdx: number, mergeOk: (chipIdx: number) => boolean): DragTarget`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/tabDrag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  dropTarget,
  flowPositions,
  moveItem,
  previewDeltas,
  type Rect,
} from "./tabDrag";

const chip = (left: number, top: number, width = 60, height = 26): Rect => ({
  left,
  top,
  width,
  height,
});

describe("flowPositions", () => {
  it("lays a fitting row out at x offsets separated by the gap", () => {
    expect(flowPositions([60, 80, 40], 500, 6)).toEqual([
      { x: 0, row: 0 },
      { x: 66, row: 0 },
      { x: 152, row: 0 },
    ]);
  });

  it("wraps when the next chip would overflow the container", () => {
    // 60 + 6 + 80 = 146 > 140 → the second chip starts row 1.
    expect(flowPositions([60, 80], 140, 6)).toEqual([
      { x: 0, row: 0 },
      { x: 0, row: 1 },
    ]);
  });

  it("gives a chip wider than the container a row of its own", () => {
    expect(flowPositions([200, 60], 140, 6)).toEqual([
      { x: 0, row: 0 },
      { x: 0, row: 1 },
    ]);
  });
});

describe("moveItem", () => {
  it("moves rightward using original-array slots (App.reorderTab semantics)", () => {
    expect(moveItem(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "a", "c"]);
  });

  it("moves leftward", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("treats from and from+1 as no-op slots", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 2)).toEqual(["a", "b", "c"]);
  });
});

describe("previewDeltas", () => {
  // Three 60-wide chips in one row at x = 0 / 66 / 132 (gap 6).
  const rects = [chip(0, 0), chip(66, 0), chip(132, 0)];

  it("slides chips between the source and a rightward gap left by chip+gap", () => {
    // Move chip 0 past the end: chips 1 and 2 each slide left 66; the (hidden)
    // moved chip's own slot previews at the far right.
    expect(previewDeltas(rects, 500, 6, 0, 3)).toEqual([
      { dx: 132, dy: 0 },
      { dx: -66, dy: 0 },
      { dx: -66, dy: 0 },
    ]);
  });

  it("is all-zero for the no-op slots around the source chip", () => {
    expect(previewDeltas(rects, 500, 6, 1, 1)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
    expect(previewDeltas(rects, 500, 6, 1, 2)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });

  it("moves chips across a row boundary vertically by the row pitch", () => {
    // Container fits two 60-chips per row (60+6+60 = 126 ≤ 130); chip 2 sits
    // on row 1 at measured top 32 → row pitch = 26 + 6 = 32.
    const wrapped = [chip(0, 0), chip(66, 0), chip(0, 32)];
    // Move chip 2 to the front: chip 0 slides right, chip 1 wraps down.
    expect(previewDeltas(wrapped, 130, 6, 2, 0)).toEqual([
      { dx: 66, dy: 0 },
      { dx: -66, dy: 32 },
      { dx: 0, dy: -32 },
    ]);
  });
});

describe("dropTarget", () => {
  // Three 100-wide chips in one row at x = 0 / 106 / 212 (gap 6).
  const rects = [chip(0, 0, 100), chip(106, 0, 100), chip(212, 0, 100)];
  const never = () => false;
  const always = () => true;

  it("merges on the middle ~40% of another chip when allowed", () => {
    // x=156 is the exact center of chip 1 (frac 0.5).
    expect(dropTarget(rects, 156, 13, 0, always)).toEqual({ kind: "merge", index: 1 });
  });

  it("falls back to insertion when merge is not allowed", () => {
    // Center of chip 1 is at its midpoint → not left of it → insert after.
    expect(dropTarget(rects, 156, 13, 0, never)).toEqual({ kind: "insert", index: 2 });
  });

  it("never merges into the dragged chip itself", () => {
    // x=50 is the center of chip 0, which is the drag source.
    expect(dropTarget(rects, 50, 13, 0, always)).toEqual({ kind: "insert", index: 1 });
  });

  it("picks the nearest gap by chip midpoints, including past the last chip", () => {
    expect(dropTarget(rects, 10, 13, 2, never)).toEqual({ kind: "insert", index: 0 });
    expect(dropTarget(rects, 300, 13, 0, never)).toEqual({ kind: "insert", index: 3 });
  });

  it("targets the row under the cursor when the bar wraps", () => {
    const wrapped = [chip(0, 0, 100), chip(106, 0, 100), chip(0, 32, 100)];
    // y=45 is row 1's vertical center; x=200 is past chip 2's midpoint →
    // insert after the last chip of that row (slot 3 = the very end).
    expect(dropTarget(wrapped, 200, 45, 0, never)).toEqual({ kind: "insert", index: 3 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/tabDrag.test.ts`
Expected: FAIL — cannot resolve `./tabDrag`.

- [ ] **Step 3: Implement `tabDrag.ts`**

Create `frontend/src/lib/tabDrag.ts`:

```ts
// Pure geometry for the tab bar's drag-to-reorder: simulate the flex-wrap
// layout so chips can slide apart to preview an insertion, and hit-test the
// cursor to a drop target (insertion slot or merge chip). DOM-free so vitest
// covers it without a browser. All chip rects come in cached from dragstart —
// the preview transforms change getBoundingClientRect, so live measurement
// would feed back into itself.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DragTarget =
  // Insertion slot in ORIGINAL-array indexing, 0..n (n = past the last tab),
  // matching App.reorderTab's remove-then-insert contract.
  | { kind: "insert"; index: number }
  // Chip index to merge the dragged tab into.
  | { kind: "merge"; index: number };

// Where flex-wrap puts items of the given widths: x offset within the row and
// the row number. Mirrors .tab-bar-tabs (row wrap, fixed gap); an item wider
// than the container still gets a row to itself.
export function flowPositions(
  widths: number[],
  containerWidth: number,
  gap: number,
): { x: number; row: number }[] {
  const out: { x: number; row: number }[] = [];
  let x = 0;
  let row = 0;
  for (const w of widths) {
    if (x > 0 && x + w > containerWidth) {
      x = 0;
      row++;
    }
    out.push({ x, row });
    x += w + gap;
  }
  return out;
}

// Remove-then-insert move matching App.reorderTab: `to` is a slot in the
// ORIGINAL array, so rightward moves land at to - 1 after the removal shifts
// everything down. to === from and to === from + 1 are both no-ops.
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, moved);
  return next;
}

// Per-chip translate that previews moveItem(chips, from, to) without touching
// the real layout: simulate the flow for both orders and diff them. Deltas are
// simulation-vs-simulation, so a small mismatch with the real flexbox cancels
// out instead of showing up as a visible jump.
export function previewDeltas(
  rects: Rect[],
  containerWidth: number,
  gap: number,
  from: number,
  to: number,
): { dx: number; dy: number }[] {
  const widths = rects.map((r) => r.width);
  const orig = flowPositions(widths, containerWidth, gap);
  const order = moveItem(
    rects.map((_, i) => i),
    from,
    to,
  );
  const moved = flowPositions(
    order.map((i) => widths[i]),
    containerWidth,
    gap,
  );
  const rowPitch = (rects[0]?.height ?? 26) + gap;
  const deltas = rects.map(() => ({ dx: 0, dy: 0 }));
  order.forEach((origIdx, pos) => {
    deltas[origIdx] = {
      dx: moved[pos].x - orig[origIdx].x,
      dy: (moved[pos].row - orig[origIdx].row) * rowPitch,
    };
  });
  return deltas;
}

// Hit-test the cursor against the cached chip rects. Row first (the row whose
// vertical center is nearest the cursor), then within that row: the middle
// ~40% of a chip is a merge drop when allowed; otherwise the nearest insertion
// gap by chip midpoint. "Past the last chip of a row" inserts before the next
// row's first chip.
export function dropTarget(
  rects: Rect[],
  x: number,
  y: number,
  fromIdx: number,
  mergeOk: (chipIdx: number) => boolean,
): DragTarget {
  if (rects.length === 0) return { kind: "insert", index: 0 };
  // Chips arrive in DOM order, so tops are non-decreasing: cut a new row
  // whenever the top steps down (1px tolerance for subpixel layout).
  const rows: number[][] = [];
  let lastTop = -Infinity;
  rects.forEach((r, i) => {
    if (r.top > lastTop + 1) {
      rows.push([]);
      lastTop = r.top;
    }
    rows[rows.length - 1].push(i);
  });
  let row = rows[0];
  let best = Infinity;
  for (const candidate of rows) {
    const r = rects[candidate[0]];
    const d = Math.abs(y - (r.top + r.height / 2));
    if (d < best) {
      best = d;
      row = candidate;
    }
  }
  for (const i of row) {
    const r = rects[i];
    const frac = (x - r.left) / r.width;
    if (frac >= 0.3 && frac <= 0.7 && i !== fromIdx && mergeOk(i)) {
      return { kind: "merge", index: i };
    }
  }
  for (const i of row) {
    const r = rects[i];
    if (x < r.left + r.width / 2) return { kind: "insert", index: i };
  }
  return { kind: "insert", index: row[row.length - 1] + 1 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/tabDrag.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/tabDrag.ts frontend/src/lib/tabDrag.test.ts
git commit -m "feat(tab-drag): pure geometry for slide-apart reorder preview"
```

---

### Task 2: Container-level drag targeting + slide-apart preview in TabBar

**Files:**
- Modify: `frontend/src/TabBar.tsx` (drag state, container handlers, chip transforms; lines 66–108 and 130–208 in the current file)
- Modify: `frontend/src/App.css:310-322` (delete the drop-line CSS, add the transition)

**Interfaces:**
- Consumes from Task 1: `dropTarget`, `previewDeltas`, `type DragTarget`, `type Rect` from `./lib/tabDrag`.
- Produces for Task 3: `dragGeom` ref shaped `{ rects: Rect[]; containerWidth: number } | null`, `endDrag(committed: boolean)`, state `dragId` / `target` / `anim`, ref `barRef` on `.tab-bar-tabs`. Task 3 extends `dragGeom` with `grabDx`/`grabDy`.

Behavior delivered: dragging a chip opens a real animated gap at the nearest insertion point (chips slide, 150ms); center-of-chip = merge highlight exactly as before; drop commits immediately. The grabbed chip still shows the browser's native drag ghost (replaced in Task 3) and still dims via `.dragging`.

- [ ] **Step 1: Rewrite the drag logic in `TabBar.tsx`**

1a. Replace the import line 6 and add the tabDrag import after line 7:

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChartTab } from "./lib/persist";
import { dropTarget, previewDeltas, type DragTarget, type Rect } from "./lib/tabDrag";
```

1b. Add after the imports (module scope, above `fmtNextOpen`):

```tsx
// Must match .tab-bar-tabs { gap } in App.css — the flow simulation that
// slides chips apart uses it to predict where each chip lands.
const TAB_GAP = 6;
```

1c. Replace the whole drag-state block (current lines 66–108: the `DropZone` type, `dragId`/`overIdx`/`overSide` state, `draggedTab`, the merged-away effect, and `endDrag` — keep the `ctxMenu`/`mergePick` lines in place) with:

```tsx
  // Drag-to-reorder state. The dragged tab is tracked by ID, not index (see
  // the effect below); `target` is where a drop right now would land — an
  // insertion slot (chips slide apart to preview it) or a merge into a chip
  // (highlight, middle ~40% of the chip, exactly the old zone). Geometry is
  // measured ONCE at dragstart into dragGeom: the preview transforms change
  // getBoundingClientRect, so live measurement would feed back into itself.
  // `anim` gates the transform transition, so a committed drop can apply the
  // real new order without every chip animating its transform back to zero.
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<DragTarget | null>(null);
  const [anim, setAnim] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragGeom = useRef<{ rects: Rect[]; containerWidth: number } | null>(null);
  const draggedTab = dragId != null ? (tabs.find((t) => t.id === dragId) ?? null) : null;
  const fromIdx = dragId != null ? tabs.findIndex((t) => t.id === dragId) : -1;

  useEffect(() => {
    // The dragged tab merged away mid-gesture (its chip unmounted before
    // dragend, which Chrome swallows on a detached node) — drop the stranded
    // state and tell App the drag is over.
    if (dragId != null && draggedTab == null) {
      setDragId(null);
      setTarget(null);
      dragGeom.current = null;
      onDragActive(null);
    }
  }, [dragId, draggedTab, onDragActive]);
```

And replace `endDrag` (keep it below the `ctxMenu`/`mergePick` state) with:

```tsx
  // committed = the drop landed and the real order is about to change: kill
  // the transition in the same commit, otherwise every chip animates its
  // transform back to 0 while the layout also jumps. A cancelled drag keeps
  // the transition on so the preview gap visibly slides closed.
  const endDrag = (committed: boolean) => {
    setDragId(null);
    setTarget(null);
    if (committed) setAnim(false);
    dragGeom.current = null;
    onDragActive(null);
  };

  // Slide-apart preview: for an insertion target, each chip's translate to
  // where it would sit with the dragged chip moved there. null = no shifts
  // (no drag, or hovering a merge target).
  const deltas =
    fromIdx !== -1 && target?.kind === "insert" && dragGeom.current != null
      ? previewDeltas(
          dragGeom.current.rects,
          dragGeom.current.containerWidth,
          TAB_GAP,
          fromIdx,
          target.index,
        )
      : null;
```

1d. Replace the container opening tag (current line 113 `<div className="tab-bar-tabs" role="tablist">`) with the container-level handlers:

```tsx
      <div
        className={"tab-bar-tabs" + (anim ? " drag-anim" : "")}
        role="tablist"
        ref={barRef}
        onDragOver={(e) => {
          // Track where a drop would land, working entirely off the rects
          // cached at dragstart. A foreign drag (no chip dragstart happened
          // in this bar, so draggedTab is null) is not a drop target at all.
          const g = dragGeom.current;
          if (draggedTab == null || g == null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const next = dropTarget(g.rects, e.clientX, e.clientY, fromIdx, (i) =>
            tabs[i] != null && canMerge(draggedTab.id, tabs[i].id),
          );
          setTarget((cur) =>
            cur != null && cur.kind === next.kind && cur.index === next.index
              ? cur
              : next,
          );
        }}
        onDragLeave={(e) => {
          // Cursor left the strip (e.g. heading for the chart's merge
          // overlay): close the preview gap. relatedTarget is null when the
          // cursor leaves the window entirely.
          const rt = e.relatedTarget as Node | null;
          if (barRef.current != null && (rt == null || !barRef.current.contains(rt)))
            setTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          // A drop can only fire here after our own dragover preventDefault,
          // so `target` is always current. Foreign drags never get that far.
          if (draggedTab != null && target != null) {
            if (target.kind === "merge") {
              onMerge(tabs[target.index].id, [draggedTab.id]);
            } else if (
              fromIdx !== -1 &&
              // from and from+1 are the two slots around the chip's own spot —
              // both are no-op moves.
              target.index !== fromIdx &&
              target.index !== fromIdx + 1
            ) {
              onReorder(fromIdx, target.index);
            }
          }
          endDrag(true);
        }}
      >
```

1e. In the chip element (current lines 130–208): replace the `className` drop-zone logic, add the transform `style`, replace `onDragStart`, DELETE the per-chip `onDragOver` and `onDrop` entirely, and change `onDragEnd`:

```tsx
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={[
            "tab",
            t.id === activeId ? "on" : "",
            dragId === t.id ? "dragging" : "",
            target?.kind === "merge" && target.index === i && dragId !== t.id
              ? "drop-merge"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={
            deltas != null && (deltas[i].dx !== 0 || deltas[i].dy !== 0)
              ? { transform: `translate(${deltas[i].dx}px, ${deltas[i].dy}px)` }
              : undefined
          }
          onClick={() => onSelect(t.id)}
          title={closedTip ? `${titleText} — ${closedTip}` : titleText}
          draggable
          onDragStart={(e) => {
            // Cache every chip's rect NOW — the preview transforms change
            // getBoundingClientRect, so all later hit-testing works off this
            // snapshot (chip order can't change mid-drag except the
            // merged-away case, which the effect above resets).
            const bar = barRef.current;
            if (bar == null) return;
            const rects: Rect[] = Array.from(
              bar.querySelectorAll<HTMLElement>(":scope > .tab"),
            ).map((c) => {
              const r = c.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            });
            dragGeom.current = { rects, containerWidth: bar.clientWidth };
            // Firefox refuses to start an HTML5 drag when no drag data is set;
            // the payload itself is unused (state carries the dragged id).
            e.dataTransfer.setData("text/plain", t.id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(t.id);
            setAnim(true);
            onDragActive(t.id);
          }}
          onDragEnd={() => endDrag(false)}
          onContextMenu={(e) => {
```

(The `onContextMenu` body and everything inside the chip stay exactly as they are.)

- [ ] **Step 2: Replace the indicator CSS in `App.css`**

Replace lines 310–322 (the drag block: `.tab.dragging`, `.tab.drop-before::before`, `.tab.drop-after::after`, their comments, and `.tab.drop-merge`) with:

```css
/* Drag-to-reorder: the grabbed chip dims; the other chips carry translate()
   previews of the insertion gap (computed in tabDrag.ts), transitioned only
   while .drag-anim is on so a committed drop can swap the real order without
   a transform flash. */
.tab.dragging { opacity: 0.4; }
.tab-bar-tabs.drag-anim .tab { transition: transform 150ms ease; }
/* Whole-chip highlight while hovering a merge drop (center zone of the chip). */
.tab.drop-merge { outline: 2px solid var(--accent); outline-offset: -2px; }
```

- [ ] **Step 3: Type-check and unit tests**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b && npm run test:unit`
Expected: no type errors; all unit tests pass.

- [ ] **Step 4: Run the existing e2e regression**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx playwright test e2e/tab-reorder.spec.ts e2e/merge-tabs.spec.ts`
Expected: PASS. These cover: drop on left/right halves reorders correctly (including past-the-last-tab), order persists across reload, chip-center drop merges, drag-onto-chart merges, and no stranded `.dragging` chip after a merge-away gesture.

If the reorder test fails on drop position: check that `dropTarget`'s insertion slots match the old before/after semantics — left half of chip i → slot i, right half → slot i+1 — for the chip widths in play (they do by midpoint math when the cursor is inside a chip).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/TabBar.tsx frontend/src/App.css
git commit -m "feat(tab-drag): slide-apart gap preview replaces the 2px drop line"
```

---

### Task 3: Floating drag chip

**Files:**
- Modify: `frontend/src/TabBar.tsx` (empty drag image, grab offset, floating clone portal, document-level tracking)
- Modify: `frontend/src/App.css` (`.tab.dragging` → invisible, new `.tab-float`)
- Test: `frontend/e2e/tab-reorder.spec.ts` (new test appended)

**Interfaces:**
- Consumes from Task 2: `dragGeom`, `barRef`, `endDrag`, `dragId`, `fromIdx`, `draggedTab`, `TAB_GAP`.
- Produces: `.tab-float` DOM element (portaled to `document.body`) — the e2e test selects it by that class.

- [ ] **Step 1: Add the floating chip to `TabBar.tsx`**

1a. Add `createPortal` to the imports:

```tsx
import { createPortal } from "react-dom";
```

1b. Add at module scope, below `const TAB_GAP = 6;`:

```tsx
// 1x1 transparent GIF handed to setDragImage so the browser's faded chip
// snapshot never shows — the .tab-float clone below is the visible drag image.
const emptyImg = typeof Image === "undefined" ? null : new Image();
if (emptyImg != null)
  emptyImg.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
```

1c. Extend `dragGeom` with the grab point (where inside the chip the user grabbed, so the clone holds that point under the cursor). Change the ref type and add a `floatRef`:

```tsx
  const floatRef = useRef<HTMLDivElement | null>(null);
  const dragGeom = useRef<{
    rects: Rect[];
    containerWidth: number;
    grabDx: number;
    grabDy: number;
  } | null>(null);
```

And in `onDragStart`, replace the `dragGeom.current = { rects, containerWidth: bar.clientWidth };` line with:

```tsx
            dragGeom.current = {
              rects,
              containerWidth: bar.clientWidth,
              grabDx: e.clientX - rects[i].left,
              grabDy: e.clientY - rects[i].top,
            };
            if (emptyImg != null) e.dataTransfer.setDragImage(emptyImg, 0, 0);
```

1d. Add the cursor-tracking effect after the merged-away effect:

```tsx
  useEffect(() => {
    // The floating clone follows the cursor for the whole gesture — including
    // over the chart (ChartGrid's merge overlay) — so listen at the document.
    // It's positioned via style.transform directly: dragover fires roughly
    // per frame, and a React state update per event would re-render the bar.
    if (dragId == null) return;
    const move = (e: DragEvent) => {
      const g = dragGeom.current;
      const el = floatRef.current;
      if (g == null || el == null) return;
      el.style.transform = `translate(${e.clientX - g.grabDx}px, ${e.clientY - g.grabDy}px) scale(1.05)`;
    };
    document.addEventListener("dragover", move);
    return () => document.removeEventListener("dragover", move);
  }, [dragId]);
```

1e. Compute the clone's lead cell next to `deltas` (same pattern as the chips' `lead`):

```tsx
  const floatLead =
    draggedTab != null
      ? (draggedTab.cells.find((c) => c.id === draggedTab.activeCellId) ??
        draggedTab.cells[0])
      : null;
```

1f. Render the portal just before the closing `</div>` of `.tab-bar` (after the `mergePick` block):

```tsx
      {/* The cursor-following clone of the grabbed chip. Starts on the chip's
          own rect; the document dragover listener above steers it. */}
      {draggedTab != null &&
        floatLead != null &&
        dragGeom.current != null &&
        fromIdx !== -1 &&
        createPortal(
          <div
            className="tab tab-float"
            ref={floatRef}
            style={{
              transform: `translate(${dragGeom.current.rects[fromIdx].left}px, ${dragGeom.current.rects[fromIdx].top}px) scale(1.05)`,
            }}
          >
            <SymbolIcon
              epic={floatLead.symbol.epic}
              type={floatLead.symbol.type}
              className="tab-icon"
            />
            <span className="tab-symbol">{floatLead.symbol.epic}</span>
            <span className="tab-period">{floatLead.period.label}</span>
            {draggedTab.cells.length > 1 && (
              <span className="tab-count">{draggedTab.cells.length}</span>
            )}
          </div>,
          document.body,
        )}
```

- [ ] **Step 2: CSS — blank the source chip, style the clone**

In `App.css`, change the `.tab.dragging` rule from Task 2 to fully blank the chip (the clone replaces it visually; `opacity: 0` rather than `visibility: hidden` because hiding a drag source mid-gesture can abort HTML5 drags in some engines, while opacity is inert):

```css
.tab.dragging { opacity: 0; }
```

Add after the `.tab.drop-merge` rule:

```css
/* The cursor-following clone of the grabbed chip. Fixed at the viewport
   origin and moved by transform (cheap to update per dragover event); the
   slight scale + shadow read as "lifted off the bar". The shadow is a
   deliberate, approved exception to the no-shadow rule. */
.tab-float {
  position: fixed; left: 0; top: 0; z-index: 1000;
  pointer-events: none; transform-origin: top left;
  background: var(--surface-2);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
```

- [ ] **Step 3: Write the e2e test for the new visuals**

Append to `frontend/e2e/tab-reorder.spec.ts`:

```ts
// The modern drag look: grabbing a chip lifts a floating clone that follows
// the cursor, blanks the source chip, and slides the other chips apart to
// hold open the insertion gap; dropping commits the order and cleans all of
// it up. Uses manual mouse steps (not dragTo) so we can assert MID-drag.
test("dragging lifts a floating chip and slides a gap open", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");

  // Second, distinguishable tab (1D). Order: [1H, 1D].
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await page.locator(".periods button", { hasText: /^1D$/ }).click();

  const tabs = page.locator(".tab-bar .tab");
  const src = (await tabs.nth(1).boundingBox())!;
  const dst = (await tabs.nth(0).boundingBox())!;

  // Manual HTML5 drag: press on the 1D chip, then move in steps so Chromium
  // starts a native drag, onto the far-left edge of the 1H chip.
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2 - 15, src.y + src.height / 2, { steps: 4 });
  await page.mouse.move(dst.x + dst.width * 0.1, dst.y + dst.height / 2, { steps: 8 });

  // Mid-drag: floating clone exists, source chip is blanked (class), and the
  // hovered chip slid RIGHT to open the gap (non-zero translate matrix).
  await expect(page.locator(".tab-float")).toBeVisible();
  await expect(tabs.nth(1)).toHaveClass(/dragging/);
  await expect(tabs.nth(0)).toHaveCSS("transform", /matrix\(1, 0, 0, 1, [1-9]/);

  await page.mouse.up();

  // Drop landed: order flipped, clone gone, transforms cleared.
  await expect(page.locator(".tab-float")).toHaveCount(0);
  await expect(page.locator(".tab-bar .tab").first()).not.toHaveCSS(
    "transform",
    /matrix\(1, 0, 0, 1, [1-9]/,
  );
  expect(await page.locator(".tab-bar .tab .tab-period").allTextContents()).toEqual([
    "1D",
    "1H",
  ]);
});
```

Note: if the native drag does not start under manual mouse control, increase the intermediate `steps` / add one more small `page.mouse.move` right after `mouse.down()` — Chromium needs a few real mousemoves over a `draggable` before it fires `dragstart`.

- [ ] **Step 4: Type-check, unit, and e2e**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b && npm run test:unit`
Expected: clean.

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx playwright test e2e/tab-reorder.spec.ts e2e/merge-tabs.spec.ts`
Expected: PASS — the two pre-existing suites plus the new floating-chip test.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/TabBar.tsx frontend/src/App.css frontend/e2e/tab-reorder.spec.ts
git commit -m "feat(tab-drag): floating drag chip replaces the native ghost"
```
