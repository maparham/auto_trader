// @vitest-environment jsdom
// Settings' admin-only "Public demo" section: prefilling the editor from the
// currently-published snapshot (so Publish edits rather than blindly
// overwrites - see the coordinator's Task 9 review) and blocking duplicate
// staged backtest names (name-keyed collisions on both the admin and demo
// sides).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

const fetchCurrentDemo = vi.fn();
const listDemoVersions = vi.fn();
const publishDemo = vi.fn();
const rollbackDemo = vi.fn();
const getLastBacktestResult = vi.fn();

vi.mock("./admin/useIsAdmin", () => ({ useIsAdmin: () => true }));
vi.mock("./lib/demoMode", () => ({ isDemoMode: () => false }));
vi.mock("./lib/lastBacktestResult", () => ({
  getLastBacktestResult: (...args: unknown[]) => getLastBacktestResult(...args),
}));
vi.mock("./lib/demoPublish", () => ({
  fetchCurrentDemo: (...args: unknown[]) => fetchCurrentDemo(...args),
  listDemoVersions: (...args: unknown[]) => listDemoVersions(...args),
  publishDemo: (...args: unknown[]) => publishDemo(...args),
  rollbackDemo: (...args: unknown[]) => rollbackDemo(...args),
}));

import SettingsModal from "./Settings";
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
  listDemoVersions.mockResolvedValue([]);
  getLastBacktestResult.mockReturnValue({ trades: [] });
});

afterEach(() => {
  cleanup();
  fetchCurrentDemo.mockReset();
  listDemoVersions.mockReset();
  publishDemo.mockReset();
  rollbackDemo.mockReset();
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

    expect(await screen.findByText("Editing published v3.")).toBeTruthy();
    const epicsInput = screen.getByPlaceholderText("US100, EURUSD") as HTMLInputElement;
    await waitFor(() => expect(epicsInput.value).toBe("US100, EURUSD"));
    expect(screen.getByText("NQ breakout")).toBeTruthy();
  });

  it("shows 'Nothing published yet' with an empty editor on 404", async () => {
    fetchCurrentDemo.mockResolvedValue(null);
    renderDemoTab();

    expect(await screen.findByText("Nothing published yet.")).toBeTruthy();
    const epicsInput = screen.getByPlaceholderText("US100, EURUSD") as HTMLInputElement;
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
    await screen.findByText("Editing published v3.");

    fireEvent.click(screen.getByText("Publish"));
    await waitFor(() => expect(publishDemo).toHaveBeenCalledTimes(1));
    expect(publishDemo).toHaveBeenCalledWith({
      watchlist: ["US100"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
  });
});

describe("Settings Public demo: duplicate backtest names", () => {
  it("refuses to stage a second backtest under a name already staged", async () => {
    fetchCurrentDemo.mockResolvedValue(null);
    renderDemoTab();
    await screen.findByText("Nothing published yet.");

    const nameInput = screen.getByPlaceholderText("NQ breakout") as HTMLInputElement;
    const captureBtn = screen.getByText("Capture current result");

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
    await screen.findByText("Editing published v1.");

    fireEvent.click(screen.getByText("Publish"));
    expect(
      await screen.findByText("Two staged backtests share a name. Rename one before publishing."),
    ).toBeTruthy();
    expect(publishDemo).not.toHaveBeenCalled();
  });
});
