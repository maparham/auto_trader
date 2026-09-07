// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, type Workspace } from "../lib/persist";
import MobileChartStrip from "./MobileChartStrip";
import { mobileSymbol, mobilePeriod, mobileChartScope } from "./mobileChartState";
import { bumpMobileWorkspace } from "./mobileWorkspace";

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
});
