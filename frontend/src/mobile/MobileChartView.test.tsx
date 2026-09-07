// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { brokerRoot } from "../lib/persist";

installMemStorage();
afterEach(cleanup);

vi.mock("../ChartCore", () => ({
  default: (p: { symbol: { epic: string }; theme: string }) => (
    <div data-testid="chartcore" data-epic={p.symbol.epic} data-theme={p.theme} />
  ),
}));

vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchFavorites: vi.fn().mockResolvedValue([]),
}));

import MobileChartView from "./MobileChartView";
import { mobileSymbol, mobilePeriod, mobileSettingsVersion, mobileChartCtx } from "./mobileChartState";
import { DEFAULT_BROKER, PERIODS } from "../lib/feed";
import { loadSettings, saveSettings } from "../theme";

describe("MobileChartView", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileSymbol.set(null);
    mobilePeriod.set(null);
    mobileChartCtx.set(null);
    localStorage.setItem(
      brokerRoot(DEFAULT_BROKER, "view.US100"),
      JSON.stringify({
        scope: "tab.t.cell.c", epic: "US100", broker: DEFAULT_BROKER,
        resolution: "MINUTE_5", symbol: { epic: "US100", name: "US 100" },
        barSpace: 8, width: 390, height: 500, updatedAt: Date.now(),
      }),
    );
  });

  it("boots on the freshest heartbeat and mounts the chart", async () => {
    render(<MobileChartView />);
    await waitFor(() => expect(screen.getByTestId("chartcore").dataset.epic).toBe("US100"));
    expect(screen.getByRole("button", { name: /US 100/ })).toBeTruthy();
  });

  it("changes period via the sheet", async () => {
    render(<MobileChartView />);
    await waitFor(() => screen.getByTestId("chartcore"));
    await userEvent.click(screen.getByRole("button", { name: PERIODS.find(p => p.resolution === "MINUTE_5")!.label }));
    const other = PERIODS.find((p) => p.resolution !== "MINUTE_5")!;
    await userEvent.click(screen.getByRole("button", { name: other.label }));
    expect(mobilePeriod.value?.resolution).toBe(other.resolution);
  });

  it("kicks a chart resize when the tab becomes visible again", async () => {
    const resize = vi.fn();
    mobileChartCtx.set({
      chart: { resize },
      controller: { overlays: { getSelectedDrawingId: () => null, addDrawing: () => {} } },
    } as never);
    const { rerender } = render(<MobileChartView active={false} />);
    await waitFor(() => screen.getByTestId("chartcore"));
    resize.mockClear(); // ignore any activation kick from initial props
    rerender(<MobileChartView active={true} />);
    await waitFor(() => expect(resize).toHaveBeenCalled());
  });

  it("re-themes the mounted chart when mobileSettingsVersion bumps (finding 4a)", async () => {
    render(<MobileChartView />);
    await waitFor(() => screen.getByTestId("chartcore"));
    const before = screen.getByTestId("chartcore").dataset.theme;
    const next = before === "dark" ? "light" : "dark";
    saveSettings({ ...loadSettings(), theme: next });
    mobileSettingsVersion.set(mobileSettingsVersion.value + 1);
    await waitFor(() => expect(screen.getByTestId("chartcore").dataset.theme).toBe(next));
  });
});
