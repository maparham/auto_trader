// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { brokerRoot } from "../lib/persist";
import { mobileViewMode, setScreenAdapter } from "./mobileViewMode";

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
import { mobileSymbol, mobilePeriod, mobileSettingsVersion, mobileChartCtx, setMobileSymbol } from "./mobileChartState";
import { flushViewHeartbeat } from "../lib/viewHeartbeat";
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

  it("remembers the timeframe per symbol across reopen", async () => {
    render(<MobileChartView />);
    await waitFor(() => screen.getByTestId("chartcore"));
    act(() => {
      mobileChartCtx.set({
        chart: { getBarSpace: () => ({ bar: 8 }), getDom: () => null } as never,
        controller: { overlays: { getSelectedDrawingId: () => null, addDrawing: () => {} } } as never,
      });
    });
    const hour = PERIODS.find((p) => p.resolution === "HOUR")!;
    act(() => mobilePeriod.set(hour));
    flushViewHeartbeat();
    const saved = JSON.parse(localStorage.getItem(brokerRoot(DEFAULT_BROKER, "view.US100"))!);
    expect(saved.resolution).toBe("HOUR");
    expect(saved.scope).toBe("tab.t.cell.c");

    // Another symbol, then back: US100 reopens on the hour, the newcomer keeps
    // the current period since it has never been viewed.
    act(() => setMobileSymbol({ epic: "US500", name: "US 500" } as never, DEFAULT_BROKER));
    expect(mobilePeriod.value?.resolution).toBe("HOUR");
    act(() => mobilePeriod.set(PERIODS.find((p) => p.resolution === "MINUTE_5")!));
    act(() => setMobileSymbol({ epic: "US100", name: "US 100" } as never, DEFAULT_BROKER));
    expect(mobilePeriod.value?.resolution).toBe("HOUR");
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

describe("MobileChartView chrome-only mode", () => {
  beforeEach(() => {
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });

  it("drops the top bar and the chart strip when the chrome is hidden", async () => {
    const { container } = render(<MobileChartView />);
    expect(container.querySelector(".m-chart-topbar")).not.toBeNull();
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    expect(container.querySelector(".m-chart-topbar")).toBeNull();
  });
});

describe("MobileChartView view-mode controls", () => {
  beforeEach(() => {
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });

  it("hides the chrome from the chart-only control", async () => {
    render(<MobileChartView />);
    // Both chips live inside the `booted` guard, and boot resolves a heartbeat
    // from storage asynchronously, so wait for the chart the way the existing
    // tests in this file do.
    await waitFor(() => expect(screen.getByTestId("chartcore")).toBeTruthy());
    await userEvent.click(screen.getByLabelText("Chart only"));
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
  });

  it("restores the chrome from the same control once hidden", async () => {
    render(<MobileChartView />);
    await waitFor(() => expect(screen.getByTestId("chartcore")).toBeTruthy());
    await userEvent.click(screen.getByLabelText("Chart only"));
    expect(screen.queryByLabelText("Chart only")).toBeNull();
    await userEvent.click(screen.getByLabelText("Show controls"));
    expect(mobileViewMode.value.chromeHidden).toBe(false);
    expect(screen.queryByLabelText("Show controls")).toBeNull();
  });

  it("offers the way back to portrait while rotated", async () => {
    render(<MobileChartView />);
    await waitFor(() => expect(screen.getByTestId("chartcore")).toBeTruthy());
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: true });
    });
    expect(screen.queryByLabelText("Show controls")).toBeNull();
    expect(screen.getByLabelText("Back to portrait")).toBeTruthy();
  });

  it("enters landscape from the landscape control", async () => {
    const calls: string[] = [];
    setScreenAdapter({
      requestFullscreen: async () => void calls.push("requestFullscreen"),
      exitFullscreen: async () => void calls.push("exitFullscreen"),
      isFullscreen: () => true,
      lockLandscape: async () => void calls.push("lockLandscape"),
      unlockOrientation: () => void calls.push("unlockOrientation"),
      onFullscreenChange: () => () => {},
    });
    render(<MobileChartView />);
    await waitFor(() => expect(screen.getByTestId("chartcore")).toBeTruthy());
    await userEvent.click(screen.getByLabelText("Landscape"));
    expect(calls).toEqual(["requestFullscreen", "lockLandscape"]);
    expect(mobileViewMode.value.landscape).toBe(true);
  });
});
