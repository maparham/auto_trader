// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/candle_patterns_pane.json:
// the gated per-output 0/1 series over the existing detector fixture's bars,
// plus the defs' toggle and label tables the Python port copies.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { CANDLE_PATTERN_DEFS, type PatternBar } from "./candlePatterns";
import { candlePatternSeries, candlePatternsOutputs } from "./candlePatternsOutputs";

const BARS = new URL("../../../../backend/tests/fixtures/candle_patterns_golden.json", import.meta.url);
const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/candle_patterns_pane.json", import.meta.url);

const CASES: Array<Record<string, unknown>> = [
  {},
  { disabled: { engulfing: true } },
  { disabled: { engulfing: true, harami: true, soldiers: true, doji: true }, showLabels: false, bullColor: "#000" },
];

function build() {
  const bars = (JSON.parse(readFileSync(BARS, "utf8")) as { bars: PatternBar[] }).bars;
  return {
    defs: CANDLE_PATTERN_DEFS.map((d) => ({ id: d.id, toggle: d.toggle, label: d.label })),
    cases: CASES.map((ext) => {
      const values: Record<string, number[]> = {};
      for (const o of candlePatternsOutputs(ext)) values[o] = candlePatternSeries(bars, ext, o);
      return { extendData: ext, values };
    }),
  };
}

describe("CANDLE_PATTERNS pane parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
