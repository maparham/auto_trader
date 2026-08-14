// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import StrategyPicker from "./StrategyPicker";
import * as api from "./api";

const LIST: api.StrategyInfo[] = [
  { filename: "ema_cross.py", name: "EMA Cross + RSI", description: "EMA9/21 crossover.", hedged: false, error: null, params: [] },
  { filename: "hedger.py", name: "Hedger", description: "", hedged: true, error: null, params: [] },
  { filename: "broken.py", name: "broken", description: "", hedged: false, error: "SyntaxError: ...", params: [] },
];

beforeEach(() => {
  vi.spyOn(api, "fetchStrategies").mockResolvedValue(LIST);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StrategyPicker", () => {
  it("lists strategies and shows the selected one's description", () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} list={LIST} loadError={null} onReload={() => {}} />);
    expect(screen.getByText("EMA9/21 crossover.")).toBeTruthy();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("ema_cross.py");
  });

  it("disables broken files and marks hedged ones backtest-only", () => {
    render(<StrategyPicker value="hedger.py" onChange={() => {}} list={LIST} loadError={null} onReload={() => {}} />);
    const broken = screen.getByRole("option", { name: /broken/ }) as HTMLOptionElement;
    expect(broken.disabled).toBe(true);
    expect(screen.getByText(/backtest only/i)).toBeTruthy();
  });

  it("shows a hint when the strategy has no description", () => {
    render(<StrategyPicker value="hedger.py" onChange={() => {}} list={LIST} loadError={null} onReload={() => {}} />);
    expect(screen.getByText(/no description/i)).toBeTruthy();
  });

  it("reload calls the parent's reload handler", () => {
    const onReload = vi.fn();
    render(<StrategyPicker value={undefined} onChange={() => {}} list={[]} loadError={null} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("shows the load error when passed", () => {
    render(<StrategyPicker value={undefined} onChange={() => {}} list={[]} loadError="boom" onReload={() => {}} />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("has no View source control", () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} list={LIST} loadError={null} onReload={() => {}} />);
    expect(screen.queryByText(/view source/i)).toBeNull();
  });

  it("formats a bulleted docstring into a lead paragraph and a list", () => {
    const bulleted: api.StrategyInfo = {
      filename: "bb.py",
      name: "BB",
      description:
        "Trend breakout on Bollinger Bands.\nBand width classifies the regime.\n\n• Consolidation: band width in the bottom percentile,\n  staying relatively sideways.\n• No trades inside the range; only a confirmed break matters.",
      hedged: false,
      error: null,
      params: [],
    };
    render(<StrategyPicker value="bb.py" onChange={() => {}} list={[bulleted]} loadError={null} onReload={() => {}} />);

    // Wrapped lines are joined; the lead renders as prose, bullets as list items.
    expect(
      screen.getByText("Trend breakout on Bollinger Bands. Band width classifies the regime."),
    ).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe(
      "Consolidation: band width in the bottom percentile, staying relatively sideways.",
    );
    // The raw "•" glyphs are gone (the list styling owns the markers).
    expect(items[0].textContent).not.toContain("•");
  });

  it("renders a plain description without bullets as a single paragraph", () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} list={LIST} loadError={null} onReload={() => {}} />);
    expect(screen.getByText("EMA9/21 crossover.")).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});
