import { describe, expect, it } from "vitest";
import { lineEndX } from "./lineAlertBellPlace";

describe("lineEndX", () => {
  it("a straight alert line ends at the newest candle's center", () => {
    expect(lineEndX(500, 20, false)).toBe(500);
  });

  it("a stepped alert line ends at the newest candle's right edge", () => {
    // Zoomed in, halfBar is wide: measuring the bell's gap from the center
    // would put the bell on the line's tip.
    expect(lineEndX(500, 20, true)).toBe(520);
  });
});
