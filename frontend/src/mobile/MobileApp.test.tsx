// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { mobileViewMode, setScreenAdapter } from "./mobileViewMode";

installMemStorage();

vi.mock("../lib/persist", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hydrateFromBackend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/alertsApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hydrateAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchFavorites: vi.fn().mockResolvedValue([]),
}));
vi.mock("../ChartCore", () => ({
  default: (p: { symbol: { epic: string } }) => (
    <div data-testid="chartcore" data-epic={p.symbol.epic} />
  ),
}));

import MobileApp from "./MobileApp";
import { mobileTabSignal } from "./mobileChartState";

describe("MobileApp shell", () => {
  beforeEach(() => mobileTabSignal.set("chart"));
  afterEach(cleanup);

  it("renders the four tabs after hydration and switches on tap", async () => {
    render(<MobileApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alerts" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Chart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Positions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trade" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(mobileTabSignal.value).toBe("alerts");
  });

  // CSS in mobile.css scopes the FloatingModal-based re-hosted modals
  // (AlertModal/IndicatorSettings/DrawingSettings) with "body.m-mobile
  // .floating-modal" because FloatingModal portals straight to
  // document.body, bypassing ".m-app" entirely — jsdom never evaluates CSS
  // selector matching, so the only thing a test CAN verify is that the
  // marker class is actually applied to <body>, and removed again on
  // unmount so it can't outlive the mobile shell.
  it("marks <body> with m-mobile while mounted, and clears it on unmount", async () => {
    expect(document.body.classList.contains("m-mobile")).toBe(false);
    const { unmount } = render(<MobileApp />);
    await waitFor(() => expect(document.body.classList.contains("m-mobile")).toBe(true));
    unmount();
    expect(document.body.classList.contains("m-mobile")).toBe(false);
  });

  it("shows the offline banner while offline and hides it again once back online", async () => {
    render(<MobileApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Chart" })).toBeTruthy());
    expect(screen.queryByText("Offline — reconnecting…")).toBeNull();

    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(screen.getByText("Offline — reconnecting…")).toBeTruthy());

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(screen.queryByText("Offline — reconnecting…")).toBeNull());
  });
});

describe("MobileApp chrome-only mode", () => {
  beforeEach(() => {
    mobileTabSignal.set("chart");
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });
  afterEach(cleanup);

  it("drops the tab bar when the chrome is hidden", async () => {
    const { container } = render(<MobileApp />);
    await waitFor(() => expect(container.querySelector(".m-tabbar")).not.toBeNull());
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    expect(container.querySelector(".m-tabbar")).toBeNull();
  });

  it("leaves one way back: a restore control", async () => {
    render(<MobileApp />);
    expect(screen.queryByLabelText("Show controls")).toBeNull();
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    await userEvent.click(screen.getByLabelText("Show controls"));
    expect(mobileViewMode.value.chromeHidden).toBe(false);
  });

  it("keeps the restore control outside the chart tab, so hiding the chart tab cannot hide it", async () => {
    const { container } = render(<MobileApp />);
    await waitFor(() => expect(container.querySelector(".m-tabbar")).not.toBeNull());
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    const restore = screen.getByLabelText("Show controls");
    const chartTab = container.querySelector('[data-tab="chart"]');
    expect(chartTab).not.toBeNull();
    // The chart tab is the only one kept mounted (display:none) when inactive,
    // so it's the one case where a nested control could still be "hidden" by
    // its ancestor rather than unmounted. A restore control nested in there
    // would take the last way out with it. jsdom has no layout, so containment
    // is the assertion that can see this, not visibility.
    expect(chartTab!.contains(restore)).toBe(false);
  });

  it("ends chart-only when something navigates away from the chart", async () => {
    const { container } = render(<MobileApp />);
    await waitFor(() => expect(container.querySelector(".m-tabbar")).not.toBeNull());
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    await act(async () => {
      // MobileModals does exactly this when a draft order is staged from the
      // chart's price-axis menu, which is reachable with the chrome hidden.
      mobileTabSignal.set("trade");
    });
    expect(mobileViewMode.value.chromeHidden).toBe(false);
    expect(container.querySelector(".m-tabbar")).not.toBeNull();
  });

  it("gives the body a bottom-safe-area class only while the chrome is hidden", async () => {
    const { container } = render(<MobileApp />);
    await waitFor(() => expect(container.querySelector(".m-tabbar")).not.toBeNull());
    const body = container.querySelector(".m-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("m-body--no-tabbar")).toBe(false);

    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    expect(body!.classList.contains("m-body--no-tabbar")).toBe(true);

    await act(async () => {
      mobileViewMode.set({ chromeHidden: false, landscape: false });
    });
    expect(body!.classList.contains("m-body--no-tabbar")).toBe(false);
  });
});

it("watches for full screen ending outside the app", async () => {
  let onChange: (() => void) | null = null;
  setScreenAdapter({
    requestFullscreen: async () => {},
    exitFullscreen: async () => {},
    isFullscreen: () => false,
    lockLandscape: async () => {},
    unlockOrientation: () => {},
    onFullscreenChange: (fn) => {
      onChange = fn;
      return () => {
        onChange = null;
      };
    },
  });
  render(<MobileApp />);
  await waitFor(() => expect(onChange).not.toBeNull());
  await act(async () => {
    mobileViewMode.set({ chromeHidden: true, landscape: true });
    onChange!();
  });
  expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
});
