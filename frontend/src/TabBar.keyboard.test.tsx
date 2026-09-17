// @vitest-environment jsdom
// Keyboard navigation of the tab strip. The chips carry role="tab" inside a
// role="tablist", so the tablist contract is that they take focus and that
// Left/Right walk it; before the roving tabindex here they had no tabIndex at
// all, so the markup promised navigation the component never delivered. Bare
// [ / ] do the same walk from anywhere, because every conventional
// tab-cycling chord (Ctrl+Tab, Ctrl+PageUp/Down, Cmd+Alt+Arrow) is taken by
// the browser itself and cannot be intercepted by a page.
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

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

function renderBar(activeId = "t2") {
  const onSelect = vi.fn();
  render(
    <TabBar
      tabs={TABS}
      activeId={activeId}
      closedEpics={{}}
      alertTabIds={new Set()}
      onSelect={onSelect}
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
    />,
  );
  return { onSelect };
}

const chips = () => screen.getAllByRole("tab");

it("puts only the active chip in the tab order", () => {
  renderBar("t2");
  expect(chips().map((c) => c.tabIndex)).toEqual([-1, 0, -1]);
});

it("Right and Left arrows move the selection along the strip", () => {
  const { onSelect } = renderBar("t2");
  fireEvent.keyDown(chips()[1], { key: "ArrowRight" });
  expect(onSelect).toHaveBeenCalledWith("t3");
  onSelect.mockClear();
  fireEvent.keyDown(chips()[1], { key: "ArrowLeft" });
  expect(onSelect).toHaveBeenCalledWith("t1");
});

it("clamps at the ends instead of wrapping around", () => {
  const { onSelect } = renderBar("t3");
  fireEvent.keyDown(chips()[2], { key: "ArrowRight" });
  expect(onSelect).not.toHaveBeenCalled();
  cleanup();
  const first = renderBar("t1");
  fireEvent.keyDown(chips()[0], { key: "ArrowLeft" });
  expect(first.onSelect).not.toHaveBeenCalled();
});

it("Home and End jump to the first and last tab", () => {
  const { onSelect } = renderBar("t2");
  fireEvent.keyDown(chips()[1], { key: "End" });
  expect(onSelect).toHaveBeenCalledWith("t3");
  onSelect.mockClear();
  fireEvent.keyDown(chips()[1], { key: "Home" });
  expect(onSelect).toHaveBeenCalledWith("t1");
});

it("bare ] and [ step through tabs from anywhere on the page", () => {
  const { onSelect } = renderBar("t2");
  fireEvent.keyDown(document, { key: "]" });
  expect(onSelect).toHaveBeenCalledWith("t3");
  onSelect.mockClear();
  fireEvent.keyDown(document, { key: "[" });
  expect(onSelect).toHaveBeenCalledWith("t1");
});

// The bracket keys are bare, so anything the user types into a field would
// otherwise skip tabs out from under them.
it("leaves [ and ] alone while a text field has focus", () => {
  const { onSelect } = renderBar("t2");
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  fireEvent.keyDown(document, { key: "]" });
  expect(onSelect).not.toHaveBeenCalled();
  input.remove();
});

// A modifier means the user is reaching for a browser or OS shortcut.
it("ignores [ and ] carrying a modifier", () => {
  const { onSelect } = renderBar("t2");
  fireEvent.keyDown(document, { key: "]", metaKey: true });
  fireEvent.keyDown(document, { key: "[", ctrlKey: true });
  expect(onSelect).not.toHaveBeenCalled();
});

// Focus follows the selection, so a walk of several steps stays on the strip
// rather than stranding focus on a chip that is no longer selected.
it("moves focus onto the newly selected chip", async () => {
  const onSelect = vi.fn();
  const { rerender } = render(<Harness activeId="t2" onSelect={onSelect} />);
  chips()[1].focus();
  fireEvent.keyDown(chips()[1], { key: "ArrowRight" });
  rerender(<Harness activeId="t3" onSelect={onSelect} />);
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
  expect(document.activeElement).toBe(chips()[2]);
});

function Harness({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  return (
    <TabBar
      tabs={TABS}
      activeId={activeId}
      closedEpics={{}}
      alertTabIds={new Set()}
      onSelect={onSelect}
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
}
