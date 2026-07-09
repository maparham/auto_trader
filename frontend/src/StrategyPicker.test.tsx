// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import StrategyPicker from "./StrategyPicker";
import * as api from "./api";

const LIST: api.StrategyInfo[] = [
  { filename: "ema_cross.py", name: "EMA Cross + RSI", description: "EMA9/21 crossover.", hedged: false, error: null },
  { filename: "hedger.py", name: "Hedger", description: "", hedged: true, error: null },
  { filename: "broken.py", name: "broken", description: "", hedged: false, error: "SyntaxError: ..." },
];

beforeEach(() => {
  vi.spyOn(api, "fetchStrategies").mockResolvedValue(LIST);
  vi.spyOn(api, "fetchStrategySource").mockResolvedValue("def on_bar(ctx):\n    return []");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StrategyPicker", () => {
  it("lists strategies and shows the selected one's description", async () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("EMA9/21 crossover.")).toBeTruthy());
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("ema_cross.py");
  });

  it("disables broken files and marks hedged ones backtest-only", async () => {
    render(<StrategyPicker value="hedger.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    const broken = screen.getByRole("option", { name: /broken/ }) as HTMLOptionElement;
    expect(broken.disabled).toBe(true);
    expect(screen.getByText(/backtest only/i)).toBeTruthy();
  });

  it("shows a hint when the strategy has no description", async () => {
    render(<StrategyPicker value="hedger.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no description/i)).toBeTruthy());
  });

  it("reload re-fetches the list", async () => {
    render(<StrategyPicker value={undefined} onChange={() => {}} />);
    await waitFor(() => expect(api.fetchStrategies).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() => expect(api.fetchStrategies).toHaveBeenCalledTimes(2));
  });

  it("view source fetches and renders the file read-only", async () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /view source/i }));
    await waitFor(() => expect(screen.getByText(/def on_bar/)).toBeTruthy());
  });
});
