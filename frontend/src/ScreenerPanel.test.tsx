// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/screens", async (orig) => ({
  ...(await orig<typeof import("./lib/screens")>()),
  listScreens: vi.fn(async () => []),
  startScreen: vi.fn(async () => ({ jobId: "j1", total: 2 })),
  cancelScreen: vi.fn(async () => {}),
  saveScreen: vi.fn(async () => ({ id: "new1", name: "x" })),
  deleteScreen: vi.fn(async () => {}),
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
vi.mock("./lib/signals", async (orig) => ({
  ...(await orig<typeof import("./lib/signals")>()),
  requestConfirm: vi.fn(),
}));
const chartPanes = {
  live: [] as Array<{ id: string; type: string; calcParams: number[]; extendData: unknown }>,
  editor: [] as Array<{ id: string; outputs: string[]; timeframe: string | null }>,
};
vi.mock("./lib/indicators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/indicators")>()),
  liveExprInstances: vi.fn(() => chartPanes.live),
}));
vi.mock("./backtestSettings/useExprPick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backtestSettings/useExprPick")>()),
  useExprInstances: vi.fn(() => chartPanes.editor),
}));
vi.mock("./lib/exprPick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/exprPick")>()),
  pickedIndicatorToken: vi.fn(() => "RSI.bullDiv"),
}));

import ScreenerPanel from "./ScreenerPanel";
import {
  cancelScreen, deleteScreen, listScreens, pollScreen, saveScreen, startScreen, type Screen,
} from "./lib/screens";
import { isImpersonating } from "./lib/impersonation";
import { requestConfirm, Signal, type ConfirmRequest } from "./lib/signals";
import { resetScreenerDrafts } from "./lib/screenerDraft";

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
  vi.mocked(saveScreen).mockResolvedValue({ ...SAVED, id: "new1" });
  vi.mocked(deleteScreen).mockResolvedValue(undefined);
  // The draft store is module-level: without this, one test's draft would
  // be restored into the next test's fresh mount.
  resetScreenerDrafts();
  chartPanes.live = [];
  chartPanes.editor = [];
});
afterEach(cleanup);

const SAVED: Screen = {
  id: "s1", name: "Saved one", broker: "yfinance", resolution: "DAY",
  symbols: ["MSFT"], expression: "RSI(14) < 20", columns: [], indicators: {}, created_at: 0, updated_at: 0,
};

function setup() {
  const onOpen = vi.fn();
  render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={null} priceSide="mid" onOpen={onOpen} onClose={() => {}} />);
  return { onOpen };
}

const fakeController = () => ({
  chart: {},
  indicatorPickArmed: new Signal<boolean>(false),
  indicatorPickResult: new Signal<unknown>(null),
}) as never;

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
        <ScreenerPanel brokerId="yfinance" tabs={[]} controller={null} priceSide="mid" onOpen={() => {}} onClose={() => {}} />
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
      indicators: {},
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

  it("switching broker resets a loaded screen, so Save creates rather than rewrites it", async () => {
    vi.mocked(listScreens).mockResolvedValue([SAVED]);
    const props = { tabs: [], controller: null, priceSide: "mid", onOpen: () => {}, onClose: () => {} };
    const { rerender } = render(<ScreenerPanel brokerId="yfinance" {...props} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    expect((screen.getByLabelText("Condition") as HTMLTextAreaElement).value).toBe("RSI(14) < 20");
    rerender(<ScreenerPanel brokerId="dukascopy" {...props} />);
    expect((screen.getByLabelText("Condition") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Saved screens") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "RSI(14) < 30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveScreen).toHaveBeenCalled());
    const [, draft, id] = vi.mocked(saveScreen).mock.calls[0];
    expect(id).toBeUndefined();
    expect(draft.broker).toBe("dukascopy");
  });

  it("keeps the draft and the last result across an unmount", async () => {
    const first = render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={null} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    fillAndRun("AAPL, ZZZ", "RSI(14) < 30");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());
    first.unmount();
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={null} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText("Condition") as HTMLTextAreaElement).value).toBe("RSI(14) < 30");
    expect((screen.getByLabelText("Symbols") as HTMLTextAreaElement).value).toBe("AAPL, ZZZ");
    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.getByText("1 of 2 match")).toBeTruthy();
  });

  it("blocks Run on a duplicate column name and says why", () => {
    setup();
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column 1 name"), { target: { value: "RSI" } });
    fireEvent.change(screen.getByLabelText("Column 2 name"), { target: { value: " RSI " } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already named "RSI"/);
    expect(startScreen).not.toHaveBeenCalled();
  });

  it("blocks Save on an empty column name", () => {
    setup();
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column 1 name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Column 1/);
    expect(saveScreen).not.toHaveBeenCalled();
  });

  it("surfaces a pydantic list 422 as readable text", async () => {
    vi.mocked(startScreen).mockRejectedValue(new Error("name: String should have at most 40 characters"));
    setup();
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(
      "name: String should have at most 40 characters"));
  });

  it("asks before deleting, and declining keeps the screen", async () => {
    vi.mocked(listScreens).mockResolvedValue([SAVED]);
    setup();
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(requestConfirm).toHaveBeenCalledTimes(1);
    const req = vi.mocked(requestConfirm).mock.calls[0][0] as ConfirmRequest;
    expect(req.message).not.toMatch(/\u2014|--/);
    req.onCancel?.();
    expect(deleteScreen).not.toHaveBeenCalled();
    req.onConfirm();
    await waitFor(() => expect(deleteScreen).toHaveBeenCalledWith("s1"));
  });

  it("cancels the server job when a poll throws mid-run", async () => {
    vi.mocked(startScreen).mockResolvedValue({ jobId: "j9", total: 1 });
    vi.mocked(pollScreen).mockRejectedValue(new Error("network down"));
    setup();
    fillAndRun("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("network down")).toBeTruthy());
    expect(cancelScreen).toHaveBeenCalledWith("j9");
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("All tabs follows the open tabs, including ones opened later", async () => {
    const props = { brokerId: "yfinance", controller: null, priceSide: "mid", onOpen: () => {}, onClose: () => {} };
    const { rerender } = render(<ScreenerPanel {...props} tabs={[{ id: "t1", epics: ["AAPL"] }]} />);
    fireEvent.click(screen.getByRole("radio", { name: "All tabs" }));
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "RSI(14) < 30" } });
    rerender(<ScreenerPanel {...props} tabs={[{ id: "t1", epics: ["AAPL"] }, { id: "t2", epics: ["MSFT", "AAPL"] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("Some tabs screens only the ticked tabs and drops closed ones", async () => {
    const props = { brokerId: "yfinance", controller: null, priceSide: "mid", onOpen: () => {}, onClose: () => {} };
    const two = [{ id: "t1", epics: ["AAPL"] }, { id: "t2", epics: ["MSFT"] }];
    const { rerender } = render(<ScreenerPanel {...props} tabs={two} />);
    fireEvent.click(screen.getByRole("radio", { name: "Some tabs" }));
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "RSI(14) < 30" } });
    rerender(<ScreenerPanel {...props} tabs={[two[1]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].symbols).toEqual(["MSFT"]);
  });

  it("Run sends the referenced chart pane and shows it on the Indicators line", async () => {
    chartPanes.live = [{ id: "RSI", type: "RSI", calcParams: [14], extendData: {} }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    fillAndRun("AAPL", "count(RSI.bullDiv > 0, 5) >= 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators).toEqual({
      RSI: { type: "RSI", calcParams: [14], extendData: {} },
    });
    expect(await screen.findByText("RSI (14)")).toBeTruthy();
  });

  it("a loaded screen's copy wins over the focused chart", async () => {
    vi.mocked(listScreens).mockResolvedValue([{
      ...SAVED, expression: "RSI.value < 30",
      indicators: { RSI: { type: "RSI", calcParams: [14], extendData: {} } },
    }]);
    chartPanes.live = [{ id: "RSI", type: "RSI", calcParams: [7], extendData: {} }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators.RSI.calcParams).toEqual([14]);
  });

  it("Refresh from chart takes the chart's settings for shared ids", async () => {
    vi.mocked(listScreens).mockResolvedValue([{
      ...SAVED, expression: "RSI.value < 30",
      indicators: { RSI: { type: "RSI", calcParams: [14], extendData: {} } },
    }]);
    chartPanes.live = [{ id: "RSI", type: "RSI", calcParams: [7], extendData: {} }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh from chart" }));
    expect(await screen.findByText("RSI (7)")).toBeTruthy();
  });

  it("a screen with no pane refs sends an empty map", async () => {
    setup();
    fillAndRun();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators).toEqual({});
  });

  it("pick from chart appends to the condition", async () => {
    const c = fakeController() as unknown as { indicatorPickResult: Signal<unknown> };
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={c as never} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "count(" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Pick an indicator from the chart" })[0]);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect((screen.getByLabelText("Condition") as HTMLTextAreaElement).value).toBe("count(RSI.bullDiv");
  });
});
