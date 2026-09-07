// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const pushSupported = vi.fn();
const isSubscribed = vi.fn();
const subscribePush = vi.fn();
const unsubscribePush = vi.fn();
vi.mock("../lib/pushClient", () => ({
  pushSupported: (...args: unknown[]) => pushSupported(...args),
  isSubscribed: (...args: unknown[]) => isSubscribed(...args),
  subscribePush: (...args: unknown[]) => subscribePush(...args),
  unsubscribePush: (...args: unknown[]) => unsubscribePush(...args),
}));

import MobileSettingsSheet from "./MobileSettingsSheet";

describe("MobileSettingsSheet", () => {
  beforeEach(() => {
    localStorage.clear();
    pushSupported.mockReset().mockReturnValue(true);
    isSubscribed.mockReset().mockResolvedValue(false);
    subscribePush.mockReset().mockResolvedValue(undefined);
    unsubscribePush.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("renders the push toggle unchecked and subscribes on click", async () => {
    render(<MobileSettingsSheet onClose={() => {}} />);

    const toggle = await screen.findByRole("switch", { name: /push notifications/i });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    await userEvent.click(toggle);

    expect(subscribePush).toHaveBeenCalled();
  });

  it("unsubscribes when already subscribed", async () => {
    isSubscribed.mockResolvedValue(true);
    render(<MobileSettingsSheet onClose={() => {}} />);

    const toggle = await screen.findByRole("switch", { name: /push notifications/i });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    await userEvent.click(toggle);

    expect(unsubscribePush).toHaveBeenCalled();
  });

  it("does not render the push toggle when push is unsupported", async () => {
    pushSupported.mockReturnValue(false);
    render(<MobileSettingsSheet onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
    expect(screen.queryByRole("switch", { name: /push notifications/i })).toBeNull();
  });

  it("shows the iOS home-screen hint on iPhone Safari not installed", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    render(<MobileSettingsSheet onClose={() => {}} />);

    expect(
      await screen.findByText(/install this app to your home screen/i),
    ).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("switches theme via saveSettings + applyThemeToDocument", async () => {
    render(<MobileSettingsSheet onClose={() => {}} />);

    await screen.findByText("Settings");
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");

    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("switches to desktop: sets the boot flag and navigates", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...location, assign });

    render(<MobileSettingsSheet onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /switch to desktop/i }));

    expect(localStorage.getItem("auto-trader.mobileBoot")).toBe("0");
    expect(assign).toHaveBeenCalledWith("/?m=0");

    vi.unstubAllGlobals();
  });
});
