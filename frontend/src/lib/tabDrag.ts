// Pure geometry for the tab bar's drag-to-reorder: simulate the flex-wrap
// layout so chips can slide apart to preview an insertion, and hit-test the
// cursor to an insertion slot. DOM-free so vitest
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

// Hit-test the cursor against the cached chip rects: the row whose vertical
// center is nearest the cursor, then the nearest insertion gap in that row by
// chip midpoint. "Past the last chip of a row" inserts before the next row's
// first chip. The slot is in ORIGINAL-array indexing, 0..n (n = past the last
// tab), matching App.reorderTab's remove-then-insert contract.
export function dropSlot(rects: Rect[], x: number, y: number): number {
  if (rects.length === 0) return 0;
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
    if (x < r.left + r.width / 2) return i;
  }
  return row[row.length - 1] + 1;
}
