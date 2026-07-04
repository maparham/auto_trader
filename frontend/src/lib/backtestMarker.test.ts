import { describe, it, expect } from "vitest";
import { markerLabel } from "./backtest";

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
