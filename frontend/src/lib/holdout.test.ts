import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { loadHoldout, recordPeek, saveHoldoutPct, splitHoldout } from "./holdout";

describe("splitHoldout", () => {
  it("splits at the (1 - pct) point", () => {
    const { trainToMs, holdoutFromMs } = splitHoldout(0, 1000, 20);
    expect(trainToMs).toBe(800);
    expect(holdoutFromMs).toBe(800);
  });
  it("rounds to whole ms", () => {
    expect(splitHoldout(0, 1001, 33).trainToMs).toBe(Math.round(1001 * 0.67));
  });
});

describe("holdout store", () => {
  beforeEach(() => localStorage.clear());

  it("roundtrips pct and counts peeks", () => {
    saveHoldoutPct("stratA", 20);
    expect(loadHoldout("stratA")).toEqual({ pct: 20, peeks: 0 });
    expect(recordPeek("stratA")).toBe(1);
    expect(recordPeek("stratA")).toBe(2);
    expect(loadHoldout("stratA")!.peeks).toBe(2);
  });

  it("null pct disables the holdout (loadHoldout returns null)", () => {
    saveHoldoutPct("stratA", 20);
    saveHoldoutPct("stratA", null);
    expect(loadHoldout("stratA")).toBeNull();
  });

  it("preserves the peek count across disable and re-enable", () => {
    saveHoldoutPct("stratA", 20);
    recordPeek("stratA");
    recordPeek("stratA");
    saveHoldoutPct("stratA", null);
    saveHoldoutPct("stratA", 20);
    expect(loadHoldout("stratA")).toEqual({ pct: 20, peeks: 2 });
  });

  it("unknown strategy is null", () => {
    expect(loadHoldout("nope")).toBeNull();
  });
});
