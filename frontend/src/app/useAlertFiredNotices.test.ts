import { describe, it, expect } from "vitest";
import { firedDetail } from "./useAlertFiredNotices";

describe("firedDetail", () => {
  it("price alerts keep the level", () => {
    expect(firedDetail({ level: 100, message: "", condition: "crossing" } as never, 2)).toBe("@ 100.00");
  });
  it("indicator alerts name the indicator", () => {
    expect(firedDetail({ level: 70, message: "", condition: "greater", label: "RSI 14 (1H)", target: "value" } as never, 2))
      .toBe("RSI 14 (1H) Greater Than 70");
    // fmtPrice groups thousands (priceFormat.ts), same as every other price
    // readout on the chart - "21400.0" (ungrouped) would be the one price
    // display in the app that doesn't match the axis/tags (F3).
    expect(firedDetail({ level: 21400, message: "", condition: "crossing_up", label: "EMA 50 (1H)", target: "price" } as never, 1))
      .toBe("Crossing Up EMA 50 (1H) 21,400.0");
  });
  it("value levels use the panel's 6 significant digit format", () => {
    expect(firedDetail({ level: 0.00005, message: "", condition: "greater", label: "ATR 14 (1m)", target: "value" } as never, 6))
      .toBe("ATR 14 (1m) Greater Than 0.00005");
  });
  it("a custom message wins", () => {
    expect(firedDetail({ level: 70, message: "rsi hot", label: "RSI 14 (1H)" } as never, 2)).toBe("rsi hot");
  });
});
