// Placement of a trendline alert's bell (TrendlineAlertBells) around the
// Trendlines end tags; a separate module so the component file only exports
// components (fast refresh).

/** Half the height of a Trendlines end tag (10px text). */
const TL_TAG_HALF_H = 6;

/**
 * Where a bell of `size` px lands on its line, starting at `x`, once walked
 * right past every end tag it would cover. `yAt` is the line's y at an x;
 * `tags` are pane pixels (left x, middle y, width), offset by `paneTop` into
 * the bell's chart-absolute space. Bounded by the tag count, since each step
 * clears one tag.
 */
export function stepPastTags(
  x: number,
  yAt: (x: number) => number,
  tags: readonly { x: number; y: number; w: number }[],
  paneTop: number,
  size: number,
): { x: number; y: number } {
  const half = size / 2;
  let y = yAt(x);
  for (let pass = 0; pass < tags.length; pass++) {
    const hit = tags.find(
      (t) => x + half > t.x && x - half < t.x + t.w && Math.abs(t.y + paneTop - y) < half + TL_TAG_HALF_H,
    );
    if (!hit) break;
    x = hit.x + hit.w + half + 2;
    y = yAt(x);
  }
  return { x, y };
}
