// The admin demo preview's boot decision and its key namespace. The namespace
// swap is the whole safety story (a preview seeds a curated layout over the
// workspace keys, in a tab whose owner has a real workspace on those keys),
// so it is asserted here rather than left to the boot wiring.
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { beforeEach, describe, expect, it } from "vitest";
import { exitDemoPreview, isDemoPreview, PREVIEW_PREFIX } from "./demoPreview";

beforeEach(() => {
  localStorage.clear();
});

describe("isDemoPreview", () => {
  it("is true only for ?demo=preview", () => {
    expect(isDemoPreview("?demo=preview")).toBe(true);
    expect(isDemoPreview("?foo=1&demo=preview")).toBe(true);
    expect(isDemoPreview("")).toBe(false);
    expect(isDemoPreview("?demo=1")).toBe(false);
    expect(isDemoPreview("?demo=previews")).toBe(false);
  });
});

describe("PREFIX selection", () => {
  it("gives the preview its own namespace, distinct from the real one", async () => {
    const { PREFIX } = await import("./workspaceKeys");
    // This test file boots without the param, so it must see the real one.
    expect(PREFIX).toBe("auto-trader");
    expect(PREVIEW_PREFIX).not.toBe(PREFIX);
  });
});

describe("exitDemoPreview", () => {
  it("drops preview keys and leaves the real workspace alone", () => {
    localStorage.setItem(`${PREVIEW_PREFIX}.b.dukascopy.layouts`, "[]");
    localStorage.setItem(`${PREVIEW_PREFIX}.tab.T1.indicators`, '["EMA"]');
    localStorage.setItem("auto-trader.b.dukascopy.layouts", '[{"id":"a"}]');
    localStorage.setItem("auto-trader.tab.T1.indicators", '["RSI"]');

    // jsdom is not in play here (node env), so stub the navigation away.
    const nav = { assign: () => {} };
    Object.defineProperty(globalThis, "window", {
      value: { location: nav, localStorage },
      configurable: true,
    });
    exitDemoPreview();

    expect(localStorage.getItem(`${PREVIEW_PREFIX}.b.dukascopy.layouts`)).toBeNull();
    expect(localStorage.getItem(`${PREVIEW_PREFIX}.tab.T1.indicators`)).toBeNull();
    expect(localStorage.getItem("auto-trader.b.dukascopy.layouts")).toBe('[{"id":"a"}]');
    expect(localStorage.getItem("auto-trader.tab.T1.indicators")).toBe('["RSI"]');
  });
});
