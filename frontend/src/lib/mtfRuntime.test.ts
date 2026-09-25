import { describe, it, expect } from "vitest";
import { stripMtfRuntime } from "./mtfRuntime";

describe("stripMtfRuntime", () => {
  it("drops the Auto Fib stash and keeps the pin", () => {
    const out = stripMtfRuntime({
      fib: { levels: [] },
      mtf: { timeframe: "HOUR_4", waitClose: false, htfStarts: [1], htfFibPairIdx: [0], htfFibPairs: [{}] },
    });
    expect(out.mtf).toEqual({ timeframe: "HOUR_4", waitClose: false });
    expect(out.fib).toEqual({ levels: [] });
  });
});
