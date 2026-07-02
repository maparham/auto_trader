// Drawing-tool registry for the left sidebar (TV-style). Pure data — the
// glyph SVGs live in ../DrawIcons.tsx so this stays importable under the
// node test env. Names are klinecharts overlay names; labels follow TV
// ("Trend line" = the 2-point segment, extendable via the settings modal;
// "Extended line" = the infinite straightLine).
export interface DrawTool {
  name: string; // klinecharts overlay name (create/persist key)
  label: string;
}

export interface DrawFamily {
  key: "lines" | "channels" | "fibs";
  label: string;
  tools: DrawTool[];
}

export const DRAW_FAMILIES: DrawFamily[] = [
  {
    key: "lines",
    label: "Lines",
    tools: [
      { name: "segment", label: "Trend line" },
      { name: "rayLine", label: "Ray" },
      { name: "straightLine", label: "Extended line" },
      { name: "horizontalStraightLine", label: "Horizontal line" },
      { name: "verticalStraightLine", label: "Vertical line" },
      { name: "priceLine", label: "Price line" },
    ],
  },
  {
    key: "channels",
    label: "Channels",
    tools: [{ name: "priceChannelLine", label: "Parallel channel" }],
  },
  {
    key: "fibs",
    label: "Fib / Projections",
    tools: [{ name: "fibonacciLine", label: "Fib retracement" }],
  },
];

const BY_NAME = new Map(
  DRAW_FAMILIES.flatMap((f) => f.tools.map((t) => [t.name, { tool: t, family: f }] as const)),
);

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.tool.label ?? name;
}

export function familyOf(name: string): DrawFamily | undefined {
  return BY_NAME.get(name)?.family;
}
