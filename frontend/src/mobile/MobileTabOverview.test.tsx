// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, loadLayout, type Workspace } from "../lib/persist";
import MobileTabOverview from "./MobileTabOverview";
import { mobileSymbol, mobilePeriod, mobileChartScope, symbolPickTarget } from "./mobileChartState";
import { bumpMobileWorkspace } from "./mobileWorkspace";
import { HOLD_MS } from "./useHoldDrag";

const toast = vi.fn();
vi.mock("../lib/notify", () => ({ toast: (...a: unknown[]) => toast(...a) }));

installMemStorage();
afterEach(cleanup);
// Two tests below stub document.elementFromPoint (jsdom doesn't implement
// it); restore the original so the stub doesn't leak into later tests.
const originalElementFromPoint = document.elementFromPoint;
afterEach(() => {
  document.elementFromPoint = originalElementFromPoint;
});
const P = { resolution: "HOUR", label: "1H" };
const tab = (id: string, ...epics: string[]) => ({
  id, layout: "1", activeCellId: `${id}-c0`,
  cells: epics.map((epic, i) => ({ id: `${id}-c${i}`, symbol: { epic, name: epic }, period: P, scope: i ? `tab.${id}.cell.${id}-c${i}` : `tab.${id}` })),
});
const seed = () => saveLayout("a", "Main", { tabs: [tab("t1", "US100"), tab("t2", "GOLD"), tab("t3", "EURUSD", "GBPUSD", "USDJPY")], activeTabId: "" } as unknown as Workspace);
const order = () => loadLayout("a")!.tabs.map((t) => t.id);
const chipOrder = () =>
  Array.from(document.querySelectorAll("[data-drag-id]")).map((el) => el.getAttribute("data-drag-id"));

describe("MobileTabOverview", () => {
  beforeEach(() => {
    localStorage.clear();
    toast.mockReset();
    mobileSymbol.set(null); mobilePeriod.set(null); mobileChartScope.set(null); symbolPickTarget.set(null);
    seed();
  });

  it("renders one chip per tab with a +N count for split tabs", () => {
    render(<MobileTabOverview open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "US100 1H" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "EURUSD 1H +2" })).toBeTruthy();
    expect(screen.getByText("3 tabs")).toBeTruthy();
  });

  it("marks the tab now shown as active", () => {
    mobileChartScope.set({ epic: "GOLD", scope: "tab.t2" });
    render(<MobileTabOverview open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "GOLD 1H" }).classList.contains("active")).toBe(true);
  });

  it("tap opens the tab's chart and closes the overview", async () => {
    const onClose = vi.fn();
    render(<MobileTabOverview open onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "GOLD 1H" }));
    expect(mobileChartScope.value).toEqual({ epic: "GOLD", scope: "tab.t2" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter on a focused chip opens the tab (keyboard access)", async () => {
    const onClose = vi.fn();
    render(<MobileTabOverview open onClose={onClose} />);
    screen.getByRole("button", { name: "GOLD 1H" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(mobileChartScope.value).toEqual({ epic: "GOLD", scope: "tab.t2" });
    expect(onClose).toHaveBeenCalled();
  });

  it("the filter narrows the chips and shows the empty state", async () => {
    render(<MobileTabOverview open onClose={() => {}} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Find tab" }), "gbp");
    expect(screen.getByRole("button", { name: "EURUSD 1H +2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "GOLD 1H" })).toBeNull();
    expect(screen.getByText("1 of 3 tabs")).toBeTruthy();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Find tab" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find tab" }), "zzz");
    expect(screen.getByText(/No tab has that symbol/)).toBeTruthy();
  });

  it("+ routes through symbol search and opens the new tab", async () => {
    mobilePeriod.set({ resolution: "HOUR_4", label: "4H" } as never);
    render(<MobileTabOverview open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "New tab" }));
    act(() => symbolPickTarget.value!({ epic: "NVDA", name: "NVDA", status: null, pricePrecision: 2 }));
    const tabs = loadLayout("a")!.tabs;
    expect(tabs).toHaveLength(4);
    expect(tabs[3].cells[0].period.label).toBe("4H");
    expect(mobileSymbol.value?.epic).toBe("NVDA");
  });

  describe("hold gestures", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const hold = (el: HTMLElement) => {
      fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(HOLD_MS); });
    };

    it("closing the shown tab moves the chart to its neighbour and offers undo", () => {
      mobileChartScope.set({ epic: "GOLD", scope: "tab.t2" });
      render(<MobileTabOverview open onClose={() => {}} />);
      hold(screen.getByRole("button", { name: "GOLD 1H" }));
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
      expect(order()).toEqual(["t1", "t3"]);
      expect(mobileChartScope.value?.scope).toBe("tab.t3");
      const [msg, opts] = toast.mock.calls[0] as [string, { onClick(): void }];
      expect(msg).toBe("Tab closed. Tap to undo");
      act(() => opts.onClick());
      expect(order()).toEqual(["t1", "t2", "t3"]);
    });

    it("Change symbol is offered only for single-chart tabs", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      hold(screen.getByRole("button", { name: "EURUSD 1H +2" }));
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(screen.queryByRole("button", { name: "Change symbol" })).toBeNull();
    });

    it("drag reorders and keeps tabs hidden by the filter in their slots", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      fireEvent.change(screen.getByRole("searchbox", { name: "Find tab" }), { target: { value: "u" } });
      // visible: US100 (t1), EURUSD (t3); hidden: GOLD (t2)
      const t3 = screen.getByRole("button", { name: "EURUSD 1H +2" });
      document.elementFromPoint = vi.fn(() => screen.getByRole("button", { name: "US100 1H" }));
      hold(t3);
      fireEvent.pointerMove(window, { clientX: 0, clientY: 40, pointerId: 1 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(order()).toEqual(["t3", "t2", "t1"]);
    });

    it("a backend push mid-drag that removes the dragged tab is ignored", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      document.elementFromPoint = vi.fn(() => screen.getByRole("button", { name: "US100 1H" }));
      hold(screen.getByRole("button", { name: "GOLD 1H" }));
      fireEvent.pointerMove(window, { clientX: 0, clientY: 40, pointerId: 1 });
      saveLayout("a", "Main", { tabs: [tab("t1", "US100"), tab("t3", "EURUSD")], activeTabId: "" } as unknown as Workspace);
      act(() => bumpMobileWorkspace());
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(order()).toEqual(["t1", "t3"]);
    });

    it("a cancelled drag (pointercancel) reverts the chip order to the layout's real order", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      document.elementFromPoint = vi.fn(() => screen.getByRole("button", { name: "US100 1H" }));
      hold(screen.getByRole("button", { name: "GOLD 1H" }));
      fireEvent.pointerMove(window, { clientX: 0, clientY: 40, pointerId: 1 });
      // The in-panel preview reordered GOLD ahead of US100 before the cancel.
      expect(chipOrder()).toEqual(["t2", "t1", "t3"]);
      fireEvent.pointerCancel(window, { pointerId: 1 });
      expect(chipOrder()).toEqual(["t1", "t2", "t3"]);
      expect(order()).toEqual(["t1", "t2", "t3"]);
    });
  });
});
