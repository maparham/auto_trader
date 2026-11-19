export const PILL_H = 22; // .trade-pill height (App.css)
export const ROW = 24; // vertical pitch inside a spread column

type PillRect = { left: number; right: number; top: number; bottom: number };

// The pill key under a viewport point. A spread column must hold the hover
// across the whole column: rows sit ROW apart (a 2px gap between 22px faces)
// and only the hovered pill shows its wide face, so a straight move down the
// column would otherwise cross a gap or the empty space beside a narrow
// compact neighbour, drop the hover and fold the column back up. So rows
// stretch over half the gap, and a row counts from its column's left edge.
export function pillKeyAt(rects: Map<string, PillRect>, x: number, y: number): string | null {
  for (const [key, r] of rects) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return key;
  }
  const GAP = ROW - PILL_H;
  const rows = [...rects].sort((a, b) => a[1].top - b[1].top);
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i][1].top - rows[i - 1][1].bottom <= GAP + 1) continue;
    const col = rows.slice(start, i);
    start = i;
    if (col.length < 2) continue;
    const left = Math.min(...col.map(([, r]) => r.left));
    for (const [key, r] of col) {
      if (x >= left && x <= r.right && y >= r.top - GAP / 2 && y <= r.bottom + GAP / 2) return key;
    }
  }
  return null;
}
