// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, type Workspace } from "../lib/persist";
import MobileChartStrip from "./MobileChartStrip";
import { mobileSymbol, mobilePeriod, mobileChartScope } from "./mobileChartState";
import { bumpMobileWorkspace } from "./mobileWorkspace";
import { symbolSearchRequest } from "../lib/signals";

installMemStorage();
afterEach(cleanup);

const cell = (id: string, epic: string, scope: string, label = "5m") => ({
  id, symbol: { epic, name: epic }, period: { resolution: "MINUTE_5", label }, scope,
});
const ws = (tabs: unknown[]): Workspace => ({ tabs, activeTabId: "" }) as unknown as Workspace;

describe("MobileChartStrip", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileSymbol.set(null);
    mobilePeriod.set(null);
    mobileChartScope.set(null);
  });

  it("renders one chip per desktop cell and adopts the cell's exact scope on tap", async () => {
    saveLayout("l1", "main", ws([
      { id: "t1", layout: "2h", cells: [cell("c1", "US100", "tab.t1.cell.c1"), cell("c2", "GOLD", "tab.t1.cell.c2", "1H")], activeCellId: "c1" },
    ]));
    render(<MobileChartStrip />);
    await userEvent.click(screen.getByRole("button", { name: "GOLD 1H" }));
    expect(mobileSymbol.value?.epic).toBe("GOLD");
    expect(mobilePeriod.value?.resolution).toBe("MINUTE_5");
    expect(mobileChartScope.value).toEqual({ epic: "GOLD", scope: "tab.t1.cell.c2" });
  });

  it("renders nothing without a saved layout", () => {
    const { container } = render(<MobileChartStrip />);
    expect(container.firstChild).toBeNull();
  });

  it("re-reads the layout when the workspace version bumps", async () => {
    render(<MobileChartStrip />);
    expect(screen.queryByRole("button", { name: "IBM 5m" })).toBeNull();
    saveLayout("l1", "main", ws([
      { id: "t1", layout: "1", cells: [cell("c1", "IBM", "tab.t1.cell.c1")], activeCellId: "c1" },
    ]));
    act(() => bumpMobileWorkspace());
    expect(screen.getByRole("button", { name: "IBM 5m" })).toBeTruthy();
  });
  describe("find open chart", () => {
    const twoTabs = () =>
      saveLayout("l1", "main", ws([
        { id: "t1", layout: "2h", cells: [cell("c1", "US100", "tab.t1.cell.c1"), cell("c2", "GOLD", "tab.t1.cell.c2", "1H")], activeCellId: "c1" },
        { id: "t2", layout: "1", cells: [{ ...cell("c1", "AAPL", "tab.t2.cell.c1"), symbol: { epic: "AAPL", name: "Apple Inc" } }], activeCellId: "c1" },
      ]));

    it("filters the chips to cells whose epic or name matches", async () => {
      twoTabs();
      render(<MobileChartStrip />);
      await userEvent.click(screen.getByRole("button", { name: "Find open chart" }));
      await userEvent.type(screen.getByRole("searchbox"), "apple");
      expect(screen.getByRole("button", { name: "AAPL 5m" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "GOLD 1H" })).toBeNull();
      expect(screen.queryByRole("button", { name: "US100 5m" })).toBeNull();
    });

    it("Enter opens the first match and closes the search", async () => {
      twoTabs();
      render(<MobileChartStrip />);
      await userEvent.click(screen.getByRole("button", { name: "Find open chart" }));
      await userEvent.type(screen.getByRole("searchbox"), "gol{Enter}");
      expect(mobileChartScope.value).toEqual({ epic: "GOLD", scope: "tab.t1.cell.c2" });
      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(screen.getByRole("button", { name: "US100 5m" })).toBeTruthy();
    });

    it("tapping a filtered chip opens it and closes the search", async () => {
      twoTabs();
      render(<MobileChartStrip />);
      await userEvent.click(screen.getByRole("button", { name: "Find open chart" }));
      await userEvent.type(screen.getByRole("searchbox"), "us");
      await userEvent.click(screen.getByRole("button", { name: "US100 5m" }));
      expect(mobileChartScope.value).toEqual({ epic: "US100", scope: "tab.t1.cell.c1" });
      expect(screen.queryByRole("searchbox")).toBeNull();
    });

    it("no match offers the full symbol search", async () => {
      twoTabs();
      render(<MobileChartStrip />);
      await userEvent.click(screen.getByRole("button", { name: "Find open chart" }));
      await userEvent.type(screen.getByRole("searchbox"), "zzz");
      expect(screen.getByText("No open chart")).toBeTruthy();
      const before = symbolSearchRequest.value;
      await userEvent.click(screen.getByRole("button", { name: "Search all symbols" }));
      expect(symbolSearchRequest.value).toBe(before + 1);
      expect(screen.queryByRole("searchbox")).toBeNull();
    });

    it("the close button restores every chip", async () => {
      twoTabs();
      render(<MobileChartStrip />);
      await userEvent.click(screen.getByRole("button", { name: "Find open chart" }));
      await userEvent.type(screen.getByRole("searchbox"), "gold");
      await userEvent.click(screen.getByRole("button", { name: "Close search" }));
      expect(screen.getAllByRole("button", { name: /5m|1H/ })).toHaveLength(3);
    });

    it("hides the search with a single chart", () => {
      saveLayout("l1", "main", ws([
        { id: "t1", layout: "1", cells: [cell("c1", "IBM", "tab.t1.cell.c1")], activeCellId: "c1" },
      ]));
      render(<MobileChartStrip />);
      expect(screen.queryByRole("button", { name: "Find open chart" })).toBeNull();
    });
  });
});
