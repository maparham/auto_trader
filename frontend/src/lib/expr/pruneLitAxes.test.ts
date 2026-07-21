import { describe, expect, it } from "vitest";
import { pruneLitAxes } from "./sweepLiterals";
import type { RangeAxis, SweepAxis } from "../sweep";

function litAxis(target: string): RangeAxis {
  return { kind: "range", target, label: target, from: 0, to: 10, step: 1 };
}

describe("pruneLitAxes", () => {
  it("keeps a lit axis when its literal still exists", () => {
    const axes: SweepAxis[] = [litAxis("lit:long.entry.0.0")];
    const out = pruneLitAxes(axes, [
      { side: "long", group: "entry", exprs: ["EMA(9) > 0"] },
    ]);
    expect(out).toEqual(axes);
  });

  it("drops a lit axis whose ordinal vanished after an edit", () => {
    // "EMA(9) > candle.close" has only 1 literal (ordinal 0); ordinal 1 is gone.
    const axes: SweepAxis[] = [
      litAxis("lit:long.entry.0.0"),
      litAxis("lit:long.entry.0.1"),
    ];
    const out = pruneLitAxes(axes, [
      { side: "long", group: "entry", exprs: ["EMA(9) > candle.close"] },
    ]);
    expect(out.map((a) => a.target)).toEqual(["lit:long.entry.0.0"]);
  });

  it("drops a lit axis whose rowIdx exceeds the row count", () => {
    const axes: SweepAxis[] = [litAxis("lit:long.entry.3.0")];
    const out = pruneLitAxes(axes, [
      { side: "long", group: "entry", exprs: ["EMA(9) > 0"] },
    ]);
    expect(out).toEqual([]);
  });

  it("passes non-lit axes through unchanged", () => {
    const axes: SweepAxis[] = [
      litAxis("risk:long.stop.value"),
      litAxis("rule:long.entry.0.left.length"),
    ];
    const out = pruneLitAxes(axes, [
      { side: "long", group: "entry", exprs: [] },
    ]);
    expect(out).toEqual(axes);
  });
});
