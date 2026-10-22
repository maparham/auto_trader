// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/screens", async (orig) => ({
  ...(await orig<typeof import("./lib/screens")>()),
  listScreens: vi.fn(async () => []),
  startScreen: vi.fn(async () => ({ jobId: "j1", total: 2 })),
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

import ScreenerPanel from "./ScreenerPanel";
import { pollScreen, startScreen } from "./lib/screens";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function setup() {
  const onOpen = vi.fn();
  render(<ScreenerPanel brokerId="yfinance" priceSide="mid" onOpen={onOpen} onClose={() => {}} />);
  return { onOpen };
}

describe("ScreenerPanel", () => {
  it("runs a screen and lists matches and skipped", async () => {
    const { onOpen } = setup();
    fireEvent.change(screen.getByLabelText("Symbols"), { target: { value: "AAPL, ZZZ" } });
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "RSI(14) < 30" } });
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
    fireEvent.change(screen.getByLabelText("Symbols"), { target: { value: "AAPL" } });
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "RSI(14) < 30" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
  });
});
