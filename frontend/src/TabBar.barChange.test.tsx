// @vitest-environment jsdom
// Live-bar % change on the tab chips: per tab from the context menu
// (ChartTab.barChange), else the global default (Settings.tabBarChange, off).
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const liveCbs: Array<(k: { open: number; close: number }) => void> = [];
const closeLive = vi.fn();
vi.mock("./lib/feed", async () => {
  const actual = await vi.importActual<typeof import("./lib/feed")>("./lib/feed");
  return {
    ...actual,
    fetchRecent: vi.fn().mockResolvedValue([{ open: 100, close: 101 }]),
    openLive: vi.fn((_e: string, _r: string, cb: (k: { open: number; close: number }) => void) => {
      liveCbs.push(cb);
      return { close: closeLive };
    }),
  };
});

import TabBar from "./TabBar";
import { openLive } from "./lib/feed";
import { barChangePct, fmtBarChange } from "./lib/tabBarChange";
import type { ChartTab } from "./lib/persist";
import type { Period } from "./lib/feed";

beforeEach(() => {
  vi.useFakeTimers();
  liveCbs.length = 0;
  vi.mocked(openLive).mockClear();
  closeLive.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PERIOD = { label: "1h", resolution: "HOUR" } as Period;
const TABS: ChartTab[] = [
  {
    id: "t1",
    layout: "1",
    activeCellId: "c0",
    cells: [{ id: "c0", symbol: { epic: "GOLD", name: "Gold", status: null }, period: PERIOD, scope: "t1" }],
  },
];

function renderBar(props: Partial<React.ComponentProps<typeof TabBar>> = {}) {
  return render(
    <TabBar
      tabs={TABS}
      activeId="t1"
      closedEpics={{}}
      alertTabIds={new Set()}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      canMerge={() => false}
      onMerge={vi.fn()}
      onDragActive={vi.fn()}
      searchQuery=""
      onSearchQuery={vi.fn()}
      brokerId="capital"
      onOpenSymbol={vi.fn()}
      {...props}
    />,
  );
}

it("formats close vs open as a signed percent", () => {
  expect(barChangePct({ open: 100, close: 101.5 })).toBeCloseTo(1.5);
  expect(barChangePct({ open: 0, close: 1 })).toBeNull();
  expect(fmtBarChange(1.5)).toBe("+1.50%");
  expect(fmtBarChange(-0.25)).toBe("-0.25%");
  expect(fmtBarChange(-0.001)).toBe("0.00%");
});

it("off: no feeds, no chip value", () => {
  renderBar({ onToggleBarChange: vi.fn() });
  expect(openLive).not.toHaveBeenCalled();
  expect(document.querySelector(".tab-bar-change")).toBeNull();
});

it("the context menu offers the toggle even with one tab", () => {
  const onToggle = vi.fn();
  renderBar({ onToggleBarChange: onToggle });
  fireEvent.contextMenu(document.querySelector('[data-tab-id="t1"]')!);
  const item = screen.getByRole("menuitemcheckbox", { name: /show bar change/i });
  expect(item.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(item);
  expect(onToggle).toHaveBeenCalledWith("t1");
});

it("a tab's own flag beats the global default, both ways", () => {
  const two: ChartTab[] = [
    { ...TABS[0], barChange: true },
    { ...TABS[0], id: "t2", cells: [{ ...TABS[0].cells[0], symbol: { epic: "US100", name: "US100", status: null } }] },
  ];
  renderBar({ tabs: two, showBarChange: false });
  expect(vi.mocked(openLive).mock.calls.map((c) => c[0])).toEqual(["GOLD"]);
  cleanup();
  vi.mocked(openLive).mockClear();
  renderBar({ tabs: [{ ...two[0], barChange: false }, two[1]], showBarChange: true });
  expect(vi.mocked(openLive).mock.calls.map((c) => c[0])).toEqual(["US100"]);
});

it("on: seeds from the latest bar, then follows live ticks", async () => {
  renderBar({ showBarChange: true, onToggleBarChange: vi.fn() });
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
  });
  const el = () => document.querySelector(".tab-bar-change");
  expect(el()?.textContent).toBe("+1.00%");
  expect(el()?.classList.contains("up")).toBe(true);
  act(() => {
    liveCbs[0]({ open: 100, close: 98 });
    vi.advanceTimersByTime(1000);
  });
  expect(el()?.textContent).toBe("-2.00%");
  expect(el()?.classList.contains("down")).toBe(true);
});

it("toggling one tab opens or closes only that lead's feed", () => {
  const two: ChartTab[] = [
    { ...TABS[0], barChange: true },
    { ...TABS[0], id: "t2", barChange: true, cells: [{ ...TABS[0].cells[0], symbol: { epic: "US100", name: "US100", status: null } }] },
  ];
  const { rerender } = renderBar({ tabs: two });
  expect(openLive).toHaveBeenCalledTimes(2);
  const props = (tabs: ChartTab[]) => (
    <TabBar
      tabs={tabs}
      activeId="t1"
      closedEpics={{}}
      alertTabIds={new Set()}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      canMerge={() => false}
      onMerge={vi.fn()}
      onDragActive={vi.fn()}
      searchQuery=""
      onSearchQuery={vi.fn()}
      brokerId="capital"
      onOpenSymbol={vi.fn()}
    />
  );
  rerender(props([two[0], { ...two[1], barChange: false }]));
  expect(closeLive).toHaveBeenCalledOnce();
  expect(openLive).toHaveBeenCalledTimes(2);
  rerender(props(two));
  expect(openLive).toHaveBeenCalledTimes(3);
  expect(vi.mocked(openLive).mock.calls[2][0]).toBe("US100");
});

it("turning it off closes the feeds", () => {
  const { rerender } = renderBar({ showBarChange: true });
  expect(openLive).toHaveBeenCalledOnce();
  rerender(
    <TabBar
      tabs={TABS}
      activeId="t1"
      closedEpics={{}}
      alertTabIds={new Set()}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      canMerge={() => false}
      onMerge={vi.fn()}
      onDragActive={vi.fn()}
      searchQuery=""
      onSearchQuery={vi.fn()}
      brokerId="capital"
      onOpenSymbol={vi.fn()}
      showBarChange={false}
    />,
  );
  expect(closeLive).toHaveBeenCalled();
  expect(document.querySelector(".tab-bar-change")).toBeNull();
});

it("the chip has no tooltip, but its badges do", () => {
  const split: ChartTab = {
    ...TABS[0],
    cells: [TABS[0].cells[0], { ...TABS[0].cells[0], id: "c1", symbol: { epic: "US100", name: "US100", status: null } }],
  };
  renderBar({ tabs: [split], closedEpics: { GOLD: { closed: true, nextOpen: null } } });
  act(() => { vi.advanceTimersByTime(600); });
  const hoverTip = (el: Element) => {
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(150); });
    const text = screen.queryByRole("tooltip")?.textContent ?? null;
    fireEvent.mouseLeave(el);
    act(() => { vi.advanceTimersByTime(600); });
    return text;
  };
  expect(hoverTip(document.querySelector('[data-tab-id="t1"]')!)).toBeNull();
  expect(hoverTip(document.querySelector(".tab-closed-badge")!)).toBe("Market closed");
  expect(hoverTip(document.querySelector(".tab-count")!)).toContain("US100 · 1h");
});
