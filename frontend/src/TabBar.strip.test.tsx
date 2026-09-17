// @vitest-environment jsdom
// The two tab-strip layouts (theme.ts TabStrip, picked in Appearance > Tabs):
// wrapping rows (default) and one scrolling row. The + / Find symbol tail
// rides inside the strip in rows mode and after it in scroll mode, and a
// search query scrolls its first matching chip into view.
import { it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import TabBar from "./TabBar";
import type { ChartTab } from "./lib/persist";
import type { Period } from "./lib/feed";

afterEach(cleanup);

const PERIOD = { label: "1h" } as Period;

function tab(id: string, epic: string): ChartTab {
  return {
    id,
    layout: "1",
    activeCellId: `${id}-c0`,
    cells: [{ id: `${id}-c0`, symbol: { epic, name: epic, status: null }, period: PERIOD, scope: id }],
  };
}

const TABS: ChartTab[] = [tab("t1", "EURUSD"), tab("t2", "GOLD"), tab("t3", "US100")];

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

it("defaults to rows, with + and search inside the wrapping strip", () => {
  renderBar();
  const bar = document.querySelector(".tab-bar");
  expect(bar?.classList.contains("strip-rows")).toBe(true);
  const tail = document.querySelector(".tab-bar-tail");
  expect(tail?.parentElement?.classList.contains("tab-bar-tabs")).toBe(true);
});

it("in scroll mode the tail sits after the scroller, not inside it", () => {
  renderBar({ strip: "scroll" });
  const bar = document.querySelector(".tab-bar");
  expect(bar?.classList.contains("strip-scroll")).toBe(true);
  const tail = document.querySelector(".tab-bar-tail");
  expect(tail?.parentElement).toBe(bar);
  expect(document.querySelector(".tab-bar-tabs .tab-bar-tail")).toBeNull();
});

// jsdom has no layout, so scrollIntoView is the observable: the first chip
// matching the query must be asked to come into view when the query lands.
it("a search query scrolls the first matching tab into view", () => {
  const calls: string[] = [];
  const orig = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    calls.push(this.dataset.tabId ?? "?");
  };
  try {
    const { rerender } = renderBar({ strip: "scroll" });
    calls.length = 0; // drop the mount-time active-tab scroll
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
        searchQuery="gold"
        onSearchQuery={vi.fn()}
        brokerId="capital"
        onOpenSymbol={vi.fn()}
        strip="scroll"
      />,
    );
    expect(calls).toEqual(["t2"]);
  } finally {
    HTMLElement.prototype.scrollIntoView = orig;
  }
});
