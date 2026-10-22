// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/screens", async (orig) => ({
  ...(await orig<typeof import("./lib/screens")>()),
  listScreens: vi.fn(async () => []),
  startScreen: vi.fn(async () => ({ jobId: "j1", total: 2 })),
  cancelScreen: vi.fn(async () => {}),
  pollScreen: vi.fn(async () => ({
    status: "done", done: 2, total: 2,
    result: {
      matches: [{ epic: "AAPL", bar_time: 1_760_000_000_000, columns: { RSI: 28.4 } }],
      skipped: [{ epic: "ZZZ", reason: "no candles" }],
      stats: { symbols: 2, matched: 1, skipped: 1, ms: 40 },
    },
  })),
}));
vi.mock("./components/RuleExpressionInput", () => ({
  default: (p: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Condition" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));
vi.mock("./lib/impersonation", () => ({ isImpersonating: vi.fn(() => false) }));

import ScreenerPanel from "./ScreenerPanel";
import { cancelScreen, listScreens, pollScreen, startScreen, type Screen } from "./lib/screens";
import { isImpersonating } from "./lib/impersonation";

const DEFAULT_POLL_RESULT = {
  status: "done" as const, done: 2, total: 2,
  result: {
    matches: [{ epic: "AAPL", bar_time: 1_760_000_000_000, columns: { RSI: 28.4 } }],
    skipped: [{ epic: "ZZZ", reason: "no candles" }],
    stats: { symbols: 2, matched: 1, skipped: 1, ms: 40 },
  },
};

// vi.clearAllMocks() only clears call history, not an implementation set via
// mockResolvedValue/mockReturnValue — a test that overrides pollScreen's or
// isImpersonating's behavior would otherwise leak it into every later test.
// Reassign every mock's default behavior here so each test starts the same.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listScreens).mockResolvedValue([]);
  vi.mocked(startScreen).mockResolvedValue({ jobId: "j1", total: 2 });
  vi.mocked(pollScreen).mockResolvedValue(DEFAULT_POLL_RESULT);
  vi.mocked(cancelScreen).mockResolvedValue(undefined);
  vi.mocked(isImpersonating).mockReturnValue(false);
});
afterEach(cleanup);

function setup() {
  const onOpen = vi.fn();
  render(<ScreenerPanel brokerId="yfinance" priceSide="mid" onOpen={onOpen} onClose={() => {}} />);
  return { onOpen };
}

function fillAndRun(symbols = "AAPL, ZZZ", expression = "RSI(14) < 30") {
  fireEvent.change(screen.getByLabelText("Symbols"), { target: { value: symbols } });
  fireEvent.change(screen.getByLabelText("Condition"), { target: { value: expression } });
}

describe("ScreenerPanel", () => {
  it("runs a screen and lists matches and skipped", async () => {
    const { onOpen } = setup();
    fillAndRun();
    // The result table's columns come from what was actually configured and
    // submitted at Run time, not from whatever the server happens to return.
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column 1 name"), { target: { value: "RSI" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());
    expect(vi.mocked(startScreen).mock.calls[0][0]).toMatchObject({
      broker: "yfinance", symbols: ["AAPL", "ZZZ"], expression: "RSI(14) < 30",
    });
    expect(screen.getByText("28.4")).toBeTruthy();
    expect(screen.getByText("1 skipped")).toBeTruthy();
    fireEvent.click(screen.getByText("AAPL"));
    expect(onOpen).toHaveBeenCalledWith("AAPL", "DAY");
  });

  it("disables Run with no symbols", () => {
    setup();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server error when a job fails", async () => {
    vi.mocked(pollScreen).mockResolvedValue({
      status: "error", done: 0, total: 2, result: null, error: "boom",
    });
    setup();
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
  });

  it("is read-only while impersonating: shows the note and disables Run/Save", () => {
    vi.mocked(isImpersonating).mockReturnValue(true);
    setup();
    fillAndRun("AAPL");
    expect(screen.getByText("Read-only while viewing as another user.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel stops the running job and clears progress", async () => {
    vi.mocked(pollScreen).mockResolvedValue({ status: "running", done: 1, total: 2, result: null });
    setup();
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelScreen).toHaveBeenCalledWith("j1");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("sends only one startScreen call on a double-click", async () => {
    setup();
    fillAndRun("AAPL");
    const runBtn = screen.getByRole("button", { name: "Run" });
    fireEvent.click(runBtn);
    fireEvent.click(runBtn);
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());
    expect(startScreen).toHaveBeenCalledTimes(1);
  });

  it("row click navigates at the resolution the run actually used, not a later edit", async () => {
    const { onOpen } = setup();
    fillAndRun();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());
    // Changing the timeframe AFTER the run must not retarget the result rows.
    fireEvent.change(screen.getByLabelText("Timeframe"), { target: { value: "HOUR_4" } });
    fireEvent.click(screen.getByText("AAPL"));
    expect(onOpen).toHaveBeenCalledWith("AAPL", "DAY");
  });

  // Fix round 2, finding 1: React.StrictMode mounts, runs effect cleanup, then
  // remounts. The unmount cleanup used to set a `disposedRef` boolean true and
  // never reset it on remount, so every Run after that synthetic cycle hit the
  // "disposed" branch and never re-enabled itself. A real app always renders
  // under StrictMode in dev (main.tsx), so this must work there too.
  it("runs successfully inside React.StrictMode", async () => {
    render(
      <StrictMode>
        <ScreenerPanel brokerId="yfinance" priceSide="mid" onOpen={() => {}} onClose={() => {}} />
      </StrictMode>,
    );
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());
    expect(cancelScreen).not.toHaveBeenCalled();
  });

  // Fix round 2, finding 2: while startScreen's POST is still pending, jobRef is
  // null, so load() couldn't cancel anything and just re-enabled Run under the
  // newly loaded screen. When the stale POST then resolved, it used to write its
  // jobId/ranSpec/progress under that new screen, and a second Run could race it.
  it("load() during the startScreen POST window cancels the superseded job and renders nothing from it", async () => {
    const savedScreen: Screen = {
      id: "s1",
      name: "Saved one",
      broker: "yfinance",
      resolution: "DAY",
      symbols: ["MSFT"],
      expression: "RSI(14) < 20",
      columns: [],
      created_at: 0,
      updated_at: 0,
    };
    vi.mocked(listScreens).mockResolvedValue([savedScreen]);
    let resolveStart!: (v: { jobId: string; total: number }) => void;
    vi.mocked(startScreen).mockReturnValue(new Promise((res) => { resolveStart = res; }));
    setup();
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    // Load a saved screen while the Run above is still waiting on its POST.
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    resolveStart({ jobId: "j1", total: 2 });
    await waitFor(() => expect(cancelScreen).toHaveBeenCalledWith("j1"));
    expect(screen.queryByText("AAPL")).toBeNull();
  });
});
