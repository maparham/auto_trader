import { describe, it, expect } from "vitest";
import { markerLabel, markerPlacement } from "./backtest";

describe("markerLabel", () => {
  it("labels opens with + and closes with -, by leg", () => {
    expect(markerLabel("buy", "long")).toBe("B+");   // open long
    expect(markerLabel("sell", "long")).toBe("S-");  // close long
    expect(markerLabel("sell", "short")).toBe("S+"); // open short
    expect(markerLabel("buy", "short")).toBe("B-");  // close short
  });

  it("labels risk exits SL / TP by reason", () => {
    expect(markerLabel("sell", "long", "stop")).toBe("SL");
    expect(markerLabel("sell", "long", "trail")).toBe("SL");
    expect(markerLabel("sell", "long", "target")).toBe("TP");
    expect(markerLabel("buy", "short", "stop")).toBe("SL");
    expect(markerLabel("buy", "short", "target")).toBe("TP");
  });

  it("still labels rule-driven fills by side/leg", () => {
    expect(markerLabel("buy", "long", "EMA_9 crossesAbove EMA_21")).toBe("B+");
    expect(markerLabel("sell", "long", "")).toBe("S-");
  });
});

describe("markerPlacement", () => {
  it("hangs below when the fill is in the lower half of the candle", () => {
    // Short opened at a bullish candle's open (== its low) -> pill drops below.
    expect(markerPlacement(10, 20, 10)).toBe("below");
    expect(markerPlacement(12, 20, 10)).toBe("below");
  });

  it("hangs above when the fill is in the upper half", () => {
    expect(markerPlacement(20, 20, 10)).toBe("above");
    expect(markerPlacement(18, 20, 10)).toBe("above");
  });

  it("breaks the exact-midpoint tie to above", () => {
    expect(markerPlacement(15, 20, 10)).toBe("above");
  });

  it("defaults to above on a flat bar (no body to clear)", () => {
    expect(markerPlacement(10, 10, 10)).toBe("above");
  });
});
