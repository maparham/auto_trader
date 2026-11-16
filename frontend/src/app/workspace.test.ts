import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_TAB_SESSION_KEY, rememberActiveTab, rememberedActiveTab } from "./workspace";

describe("per-broker active tab memory", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps each broker's last tab apart", () => {
    rememberActiveTab("capital", "tab-a");
    rememberActiveTab("dukascopy", "tab-b");
    expect(rememberedActiveTab("capital")).toBe("tab-a");
    expect(rememberedActiveTab("dukascopy")).toBe("tab-b");
    // The reload key still follows the latest selection.
    expect(sessionStorage.getItem(ACTIVE_TAB_SESSION_KEY)).toBe("tab-b");
  });

  it("is empty for a broker never visited", () => {
    expect(rememberedActiveTab("ig-demo")).toBe("");
  });
});
