// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";

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
