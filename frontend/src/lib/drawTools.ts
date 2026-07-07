// Drawing-tool registry for the left sidebar (TV-style). Pure data — the
// glyph SVGs live in ../DrawIcons.tsx so this stays importable under the
// node test env. Names are klinecharts overlay names; labels follow TV
// ("Trend line" = the 2-point segment, extendable via the settings modal;
// "Extended line" = the infinite straightLine).
export interface DrawTool {
  name: string; // klinecharts overlay name (create/persist key)
  label: string;
}

// One flat list (user choice: a single "Drawing tools" menu, no family groups).
export const DRAW_TOOLS: DrawTool[] = [
  { name: "segment", label: "Trend line" },
  { name: "rayLine", label: "Ray" },
  { name: "straightLine", label: "Extended line" },
  { name: "horizontalStraightLine", label: "Horizontal line" },
  { name: "verticalStraightLine", label: "Vertical line" },
  { name: "rect", label: "Rectangle" },
  { name: "priceLine", label: "Price line" },
  { name: "priceChannelLine", label: "Parallel channel" },
  { name: "fibonacciLine", label: "Fib retracement" },
];

const BY_NAME = new Map(DRAW_TOOLS.map((t) => [t.name, t]));

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.label ?? name;
}
