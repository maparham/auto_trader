// @vitest-environment jsdom
// Settings' admin-only "Public demo" section: prefilling the editor from the
// currently-published snapshot (so Publish edits rather than blindly
// overwrites - see the coordinator's Task 9 review), reporting the ONE live
// demo (there is no version history in this panel), and blocking duplicate
// staged backtest names (name-keyed collisions on both the admin and demo
// sides).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

// Publish refuses a workspace with no saved default layout (see
// publishDemoStaged), so every test that reaches Publish needs one in
// localStorage. Mirrors the key layout demoSnapshot.test.ts sets up: the
// index and bodies are broker-family keyed, defaultLayoutId is per-feed, and
// the cell's own content is not broker keyed at all.
function seedPublishableLayout(): void {
  const body = JSON.stringify({
    tabs: [{ id: "T1", cells: [{ id: "c0", scope: "tab.T1" }] }],
  });
  localStorage.setItem("auto-trader.b.dukascopy.layouts", '[{"id":"a","name":"Demo"}]');
  localStorage.setItem("auto-trader.b.dukascopy.defaultLayoutId", '"a"');
  localStorage.setItem("auto-trader.b.dukascopy.layout.a", body);
  localStorage.setItem("auto-trader.tab.T1.indicators", '["EMA"]');
}

const fetchCurrentDemo = vi.fn();
const fetchDemoLive = vi.fn();
const publishDemo = vi.fn();
const getLastBacktestResult = vi.fn();

vi.mock("./admin/useIsAdmin", () => ({ useIsAdmin: () => true }));
vi.mock("./lib/demoMode", () => ({ isDemoMode: () => false }));
vi.mock("./lib/lastBacktestResult", () => ({
  getLastBacktestResult: (...args: unknown[]) => getLastBacktestResult(...args),
}));
vi.mock("./lib/demoPublish", () => ({
  fetchCurrentDemo: (...args: unknown[]) => fetchCurrentDemo(...args),
  fetchDemoLive: (...args: unknown[]) => fetchDemoLive(...args),
  publishDemo: (...args: unknown[]) => publishDemo(...args),
}));

import SettingsModal from "./Settings";
import { setPersistBroker } from "./lib/persist/core";
import { DEFAULT_SETTINGS } from "./theme";

function renderDemoTab() {
  render(
    <SettingsModal
      settings={DEFAULT_SETTINGS}
      onChange={() => {}}
      onClose={() => {}}
      initialTab="demo"
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  setPersistBroker("dukascopy");
  seedPublishableLayout();
  fetchDemoLive.mockResolvedValue(null);
  getLastBacktestResult.mockReturnValue({ trades: [] });
});

afterEach(() => {
  cleanup();
  fetchCurrentDemo.mockReset();
  fetchDemoLive.mockReset();
  publishDemo.mockReset();
  getLastBacktestResult.mockReset();
});

describe("Settings Public demo: prefill from the published snapshot", () => {
  it("prefills the watchlist and staged list from the current version", async () => {
    fetchCurrentDemo.mockResolvedValue({
      version: 3,
      watchlist: ["US100", "EURUSD"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
    renderDemoTab();

    const epicsInput = screen.getByPlaceholderText("e.g. US100, EURUSD") as HTMLInputElement;
    await waitFor(() => expect(epicsInput.value).toBe("US100, EURUSD"));
    expect(screen.getByText("NQ breakout")).toBeTruthy();
  });

  it("shows 'Nothing published yet' with an empty editor on 404", async () => {
    fetchCurrentDemo.mockResolvedValue(null);
    renderDemoTab();

    expect(await screen.findByText("Nothing published yet.")).toBeTruthy();
    const epicsInput = screen.getByPlaceholderText("e.g. US100, EURUSD") as HTMLInputElement;
    expect(epicsInput.value).toBe("");
  });

  it("publishes with the prefilled staged backtests still in place (edit, not wipe)", async () => {
    fetchCurrentDemo.mockResolvedValue({
      version: 3,
      watchlist: ["US100"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
    publishDemo.mockResolvedValue(4);
    renderDemoTab();
    await waitFor(() => expect(screen.getByText("NQ breakout")).toBeTruthy());

    fireEvent.click(screen.getByText("Publish"));
    await waitFor(() => expect(publishDemo).toHaveBeenCalledTimes(1));
    expect(publishDemo).toHaveBeenCalledWith({
      watchlist: ["US100"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
  });
});

describe("Settings Public demo: the live demo line", () => {
  it("says when the live demo was published, and that publishing replaces it", async () => {
    fetchCurrentDemo.mockResolvedValue(null);
    fetchDemoLive.mockResolvedValue({
      version: 7,
      publishedBy: "a@b.com",
      createdAt: 1789221839000,
      size: 10,
    });
    renderDemoTab();

    const line = await screen.findByText(/^Live: published /);
    expect(line.textContent).toContain("Publishing replaces it.");
    // No version history: nothing to roll back to, so no such control.
    expect(screen.queryByText("Roll back")).toBeNull();
    expect(screen.queryByText("Published versions")).toBeNull();
  });

  it("says nothing is published when the store is empty", async () => {
    fetchCurrentDemo.mockResolvedValue(null);
    fetchDemoLive.mockResolvedValue(null);
    renderDemoTab();

    expect(await screen.findByText("Nothing published yet.")).toBeTruthy();
  });
});

describe("Settings Public demo: duplicate backtest names", () => {
  it("refuses to stage a second backtest under a name already staged", async () => {
    fetchCurrentDemo.mockResolvedValue(null);
    renderDemoTab();
    await screen.findByText("Nothing published yet.");

    const nameInput = screen.getByPlaceholderText("e.g. NQ breakout") as HTMLInputElement;
    const captureBtn = screen.getByText("Capture");

    fireEvent.change(nameInput, { target: { value: "Foo" } });
    fireEvent.click(captureBtn);
    expect(screen.getByText("Foo")).toBeTruthy();

    fireEvent.change(nameInput, { target: { value: "Foo" } });
    fireEvent.click(captureBtn);
    expect(
      screen.getByText("A staged backtest already has that name. Use a different name."),
    ).toBeTruthy();
    expect(screen.getAllByText("Foo")).toHaveLength(1);
  });

  it("blocks Publish (without calling it) when staged names collide", async () => {
    fetchCurrentDemo.mockResolvedValue({
      version: 1,
      watchlist: ["US100"],
      backtests: [
        { name: "A", result: { trades: [] } },
        { name: "A", result: { trades: [] } },
      ],
    });
    renderDemoTab();
    await waitFor(() => expect(screen.getAllByText("A")).toHaveLength(2));

    fireEvent.click(screen.getByText("Publish"));
    expect(
      await screen.findByText("Two staged backtests share a name. Rename one before publishing."),
    ).toBeTruthy();
    expect(publishDemo).not.toHaveBeenCalled();
  });
});
