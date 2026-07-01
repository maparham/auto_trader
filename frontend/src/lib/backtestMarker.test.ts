import { describe, it, expect } from "vitest";
import { markerLabel } from "./backtest";

describe("markerLabel", () => {
  it("labels opens with + and closes with -, by leg", () => {
    expect(markerLabel("buy", "long")).toBe("B+");   // open long
    expect(markerLabel("sell", "long")).toBe("S-");  // close long
    expect(markerLabel("sell", "short")).toBe("S+"); // open short
    expect(markerLabel("buy", "short")).toBe("B-");  // close short
  });
});
