import { describe, expect, it } from "vitest";
import { setSlotAnchors, slotAnchorsOf } from "./equalWidthDays";
import { slotAnchorsFor } from "./slotAnchorsFromPins";

describe("slotAnchorsFor", () => {
  it("DAY and WEEK pins give anchors, others none", () => {
    expect(slotAnchorsFor("DAY", [1, 2])).toEqual({ dayStarts: [1, 2] });
    expect(slotAnchorsFor("D", [1, 2])).toEqual({ dayStarts: [1, 2] });
    expect(slotAnchorsFor("WEEK", [3])).toEqual({ weekStarts: [3] });
    expect(slotAnchorsFor("HOUR_4", [1, 2])).toBeNull();
    expect(slotAnchorsFor("MONTH", [1, 2])).toBeNull();
    expect(slotAnchorsFor(null, [1, 2])).toBeNull();
    expect(slotAnchorsFor("DAY", [])).toBeNull();
    expect(slotAnchorsFor("DAY", undefined)).toBeNull();
    expect(slotAnchorsFor("nonsense", [1])).toBeNull();
  });
});

describe("anchors per chart", () => {
  it("a 1D and a 1W pin on one chart both apply", () => {
    const chart = {};
    setSlotAnchors(chart, "TL1", { dayStarts: [10, 20] });
    setSlotAnchors(chart, "TL2", { weekStarts: [5] });
    expect(slotAnchorsOf(chart)).toEqual({ dayStarts: [10, 20], weekStarts: [5] });
  });

  it("the first registered pin wins when two disagree", () => {
    const chart = {};
    setSlotAnchors(chart, "TL1", { dayStarts: [10] });
    setSlotAnchors(chart, "TL2", { dayStarts: [11] });
    expect(slotAnchorsOf(chart)?.dayStarts).toEqual([10]);
  });

  it("removing the last 1D pin drops back to inferred days", () => {
    const chart = {};
    setSlotAnchors(chart, "TL1", { dayStarts: [10] });
    setSlotAnchors(chart, "TL1", null);
    expect(slotAnchorsOf(chart)?.dayStarts).toBeUndefined();
  });
});
