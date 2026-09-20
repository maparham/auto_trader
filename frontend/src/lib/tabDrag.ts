// Pure geometry for the tab bar's drag-to-reorder: simulate the flex-wrap
// layout so chips can slide apart to preview an insertion, and hit-test the
// cursor to a drop target (insertion slot or merge chip). DOM-free so vitest
// covers it without a browser. All chip rects come in cached from dragstart —
// the preview transforms change getBoundingClientRect, so live measurement
// would feed back into itself.

import { arrayMove } from "./paneOrder";

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

// Where inline wrapping puts items of the given widths: x offset within the
// row and the row number. Mirrors .tab-bar-tabs (row wrap, fixed gap); an item
// wider than the container still gets a row to itself. `firstRowWidth` is the
// first row's narrower budget when the workspace actions float at its right
// edge (rows mode); every later row gets the full container.
export function flowPositions(
  widths: number[],
  containerWidth: number,
  gap: number,
  firstRowWidth: number = containerWidth,
): { x: number; row: number }[] {
  const out: { x: number; row: number }[] = [];
  let x = 0;
  let row = 0;
  for (const w of widths) {
    const limit = row === 0 ? firstRowWidth : containerWidth;
    if (x > 0 && x + w > limit) {
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
  return arrayMove(arr, from, from < to ? to - 1 : to);
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
  firstRowWidth: number = containerWidth,
): { dx: number; dy: number }[] {
  const widths = rects.map((r) => r.width);
  const orig = flowPositions(widths, containerWidth, gap, firstRowWidth);
  const order = moveItem(
    rects.map((_, i) => i),
    from,
    to,
  );
  const moved = flowPositions(
    order.map((i) => widths[i]),
    containerWidth,
    gap,
    firstRowWidth,
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

// A merge needs the dragged chip to sit almost exactly on top of the target:
// centers within this fraction of the target's width (enter), held until they
// drift past the looser one (exit, so a merge can't flicker off on one jittery
// dragover). Reordering sweeps the chip ACROSS its neighbours, so anything
// looser turns an ordinary pass over a chip into an accidental merge — which
// is worst right where the drag slows down near its destination.
const MERGE_ENTER = 0.14;
const MERGE_EXIT = 0.26;

// A cursor anywhere but dead center on a chip reads as "drop it beside this
// one", so a merge also needs the cursor in the chip's narrow central band:
// the middle tenth to enter, widening slightly to hold. Same enter/hold split
// as the alignment tolerance.
const CURSOR_ENTER = 0.45;
const CURSOR_HOLD = 0.39;

// Hit-test the drag against the cached chip rects. Row first (the row whose
// vertical center is nearest the cursor), then within that row: a merge when
// the dragged chip is aligned on a chip per the tolerance above, otherwise the
// nearest insertion gap by chip midpoint. "Past the last chip of a row" inserts
// before the next row's first chip.
//
// The merge test uses `drag` — the floating clone's rect, i.e. what the user
// sees themselves carrying — plus the cursor's own distance from the chip's
// borders, so alignment means what it looks like. Chips the slide-apart
// preview has translated are compared at their drawn position (`deltas`), for
// the same reason. Without a `drag` rect (no clone yet) nothing merges.
export function dropTarget(
  rects: Rect[],
  x: number,
  y: number,
  fromIdx: number,
  mergeOk: (chipIdx: number) => boolean,
  opts?: {
    // Rect of the floating dragged chip, in the same space as `rects`.
    drag?: Rect | null;
    // Per-chip transform currently applied on screen (previewDeltas output).
    deltas?: { dx: number; dy: number }[] | null;
    // The target this is refining, for the merge hold tolerance.
    current?: DragTarget | null;
  },
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
  const drag = opts?.drag ?? null;
  if (drag != null) {
    // Nearest aligned chip, so a drag between two chips can't pick the further
    // one just because it is scanned first.
    let pick = -1;
    let pickDist = Infinity;
    for (const i of row) {
      if (i === fromIdx || !mergeOk(i)) continue;
      const r = rects[i];
      const dx = opts?.deltas?.[i]?.dx ?? 0;
      const dy = opts?.deltas?.[i]?.dy ?? 0;
      const held = opts?.current?.kind === "merge" && opts.current.index === i;
      const tol = (held ? MERGE_EXIT : MERGE_ENTER) * r.width;
      const cdx = Math.abs(drag.left + drag.width / 2 - (r.left + dx + r.width / 2));
      const cdy = Math.abs(drag.top + drag.height / 2 - (r.top + dy + r.height / 2));
      const edge = held ? CURSOR_HOLD : CURSOR_ENTER;
      const frac = (x - (r.left + dx)) / r.width;
      if (cdx <= tol && cdy <= r.height / 2 && frac >= edge && frac <= 1 - edge && cdx < pickDist) {
        pick = i;
        pickDist = cdx;
      }
    }
    if (pick !== -1) return { kind: "merge", index: pick };
  }
  for (const i of row) {
    const r = rects[i];
    if (x < r.left + r.width / 2) return { kind: "insert", index: i };
  }
  return { kind: "insert", index: row[row.length - 1] + 1 };
}
