// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { alertFired } from "../lib/signals";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartTab } from "../lib/persist";
import { useUnseenAlertTabs } from "./useTabBadges";

const tab = (id: string, epic: string) =>
  ({ id, cells: [{ id: `${id}.c`, symbol: { epic }, period: {}, scope: id }] }) as unknown as ChartTab;

beforeEach(() => installMemStorage());

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as { visibilityState?: string }).visibilityState;
  alertFired.set(null);
});

describe("useUnseenAlertTabs", () => {
  it("re-syncs a badge the alert subscription finds in storage but not in state", () => {
    const home = tab("home", "B");
    const gold = tab("gold", "A");
    const gold2 = tab("gold2", "A");
    const tabs = [home, gold, gold2];
    const { result, rerender } = renderHook(({ active }) => useUnseenAlertTabs(tabs, active), {
      initialProps: { active: home },
    });

    act(() => alertFired.set({ epic: "A" }));
    expect([...result.current].sort()).toEqual(["gold", "gold2"]);

    // Visiting a tab that shows A marks it seen, but the storage write is
    // dropped (quota): state clears while storage still holds A.
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    rerender({ active: gold });
    expect([...result.current]).toEqual([]);
    vi.restoreAllMocks();

    // A second fire for A behind a hidden browser tab must bring the badge
    // back on the OTHER tab holding A, even though storage already had it.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => alertFired.set({ epic: "A" }));
    expect([...result.current]).toEqual(["gold2"]);
  });
});
