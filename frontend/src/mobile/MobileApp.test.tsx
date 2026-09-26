// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { mobileViewMode, setScreenAdapter } from "./mobileViewMode";

installMemStorage();

// Flipped per test: the real isDemoMode() is a one-way latch, so a mock is
// the only way one file can cover both the signed-in and the demo shell.
const demoFlag = vi.hoisted(() => ({ on: false }));
vi.mock("../lib/demoMode", () => ({
  isDemoMode: () => demoFlag.on,
  setDemoMode: () => {
    demoFlag.on = true;
  },
}));

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
import { hydrateAlerts } from "../lib/alertsApi";

// The top-level test at the bottom has no describe-level cleanup. Without
// this, its tree stays mounted into env teardown and React's scheduler throws
// "window is not defined" as an unhandled error.
afterEach(cleanup);

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

describe("MobileApp in the public demo", () => {
  beforeEach(() => {
    demoFlag.on = true;
    mobileTabSignal.set("chart");
    vi.mocked(hydrateAlerts).mockClear();
  });
  afterEach(() => {
    demoFlag.on = false;
    cleanup();
  });

  it("replaces the account tabs with the sign-up nudge and skips the alerts hydrate", async () => {
    render(<MobileApp />);
    const cta = await screen.findByRole("link", { name: "Sign up free" });
    expect(cta.getAttribute("href")).toBe("/?sign_in=1");
    expect(screen.queryByRole("button", { name: "Alerts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Trade" })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(hydrateAlerts).not.toHaveBeenCalled();
  });

  it("slots the banner inside the shell", async () => {
    render(<MobileApp banner={<div data-testid="banner" />} />);
    await screen.findByRole("link", { name: "Sign up free" });
    expect(screen.getByTestId("banner").closest(".m-app")).not.toBeNull();
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
