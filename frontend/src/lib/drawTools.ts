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
  { name: "fibChannel", label: "Fib channel" },
  { name: "timeRange", label: "Time range" },
  // Not a klinecharts overlay: the gesture appends a recurring-range window to
  // the cell's Time Highlight indicator (DrawSidebar arms a signal, like
  // timeRange, and bypasses the supported-overlay filter for this name).
  { name: "recurringRange", label: "Recurring highlight" },
  // The trade-planning tool (lib/tradeOverlay.ts). One entry for both
  // directions: drag the target above the entry for a long, below for a short.
  { name: "tradeBox", label: "Trade box" },
];

// Overlay names that are NOT sidebar tools but still show up in drawing lists,
// settings and the right-click menu — they need a label like everything else.
const EXTRA_LABELS: Record<string, string> = {
  patternGhost: "Pattern overlay",
};

const BY_NAME = new Map(DRAW_TOOLS.map((t) => [t.name, t]));

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.label ?? EXTRA_LABELS[name] ?? name;
}

// The two fib tools share one FibConfig on extendData.fib (levels/extend/reverse/
// trendLine/labels) and therefore one settings section. Every name gate that used
// to test `=== "fibonacciLine"` goes through here.
export function isFibOverlay(name: string): boolean {
  return name === "fibonacciLine" || name === "fibChannel";
}
