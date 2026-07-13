import { describe, it, expect } from "vitest";
import { markerLabel, markerPlacement, entryDirection, markerPillLabel, aggPillLabel } from "./backtest";

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

describe("entryDirection", () => {
  it("returns the trade leg for opening fills", () => {
    expect(entryDirection("buy", "long")).toBe("long");   // open long
    expect(entryDirection("sell", "short")).toBe("short"); // open short
  });

  it("returns null for closing fills (exits carry no direction arrow)", () => {
    expect(entryDirection("sell", "long")).toBeNull();  // close long
    expect(entryDirection("buy", "short")).toBeNull();  // close short
  });
});

describe("markerPillLabel", () => {
  it("prefixes ▲/▼ on entries", () => {
    expect(markerPillLabel("buy", "long")).toBe("▲ B+");   // open long
    expect(markerPillLabel("sell", "short")).toBe("▼ S+"); // open short
  });

  it("leaves exits unprefixed", () => {
    expect(markerPillLabel("sell", "long")).toBe("S-");           // close long
    expect(markerPillLabel("buy", "short")).toBe("B-");           // close short
    expect(markerPillLabel("sell", "long", "stop")).toBe("SL");   // risk exit
    expect(markerPillLabel("buy", "short", "target")).toBe("TP"); // risk exit
  });
});

describe("aggPillLabel", () => {
  it("shows one glyph for a single-direction bar", () => {
    expect(aggPillLabel(1, 0, 8.34)).toBe("▲ +8.3");     // one long, small net → 1 dp
    expect(aggPillLabel(0, 1, -8.05)).toBe("▼ −8.1");    // one short, 1 dp
    expect(aggPillLabel(3, 0, 12.34)).toBe("▲ 3 · +12"); // |net| ≥ 10 → integer
    expect(aggPillLabel(0, 2, -8.2)).toBe("▼ 2 · −8.2"); // several shorts, 1 dp
  });

  it("splits the count inline for a mixed bar", () => {
    expect(aggPillLabel(2, 1, 4.5)).toBe("▲2 ▼1 · +4.5");   // small net → 1 dp
    expect(aggPillLabel(1, 3, -5)).toBe("▲1 ▼3 · −5.0");    // small net → 1 dp
    expect(aggPillLabel(5, 5, 23.7)).toBe("▲5 ▼5 · +24");   // |net| ≥ 10 → integer
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
