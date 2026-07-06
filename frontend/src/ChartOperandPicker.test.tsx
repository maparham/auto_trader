// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChartOperandPicker from "./ChartOperandPicker";
import type { ChartOperandSource } from "./lib/chartOperand";
import type { Operand } from "./lib/backtestConfig";

afterEach(cleanup);

const op = (label: string): Operand => ({ kind: "series", seriesKey: label, label, recipe: { source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 } });

const SOURCES: ChartOperandSource[] = [
  { id: "EMA#1", baseLabel: "EMA(9)", emphasis: { kind: "indicator", paneId: "candle_pane", name: "EMA#1" }, outputs: [{ lineIndex: 0, label: "EMA(9)", base: true, operand: op("EMA(9)") }] },
  { id: "PH#1", baseLabel: "Prev H/L", outputs: [
    { lineIndex: 2, label: "Day High", operand: op("Prev H/L: Day High") },
    { lineIndex: 3, label: "Day Low", operand: op("Prev H/L: Day Low") },
  ] },
  { id: "MACD#1", baseLabel: "MACD", disabled: true, disabledReason: "MACD isn't supported in rules yet", outputs: [] },
];

describe("ChartOperandPicker", () => {
  it("empty state when there are no sources", () => {
    render(<ChartOperandPicker sources={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/No indicators on this chart/i)).toBeTruthy();
  });

  it("single-output row picks on click", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: "EMA(9)" }));
  });

  it("multi-output row expands then picks a sub-item", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Prev H\/L/ }));
    fireEvent.click(screen.getByRole("button", { name: "Day High" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: "Prev H/L: Day High" }));
  });

  it("disabled source is not clickable and shows its reason", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    const row = screen.getByRole("button", { name: /MACD/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("hovering a row emits its emphasis target, and clears on leave / unmount", () => {
    const onHoverSource = vi.fn();
    const { unmount } = render(
      <ChartOperandPicker sources={SOURCES} onPick={vi.fn()} onClose={vi.fn()} onHoverSource={onHoverSource} />,
    );
    const row = screen.getByRole("button", { name: "EMA(9)" }).parentElement!;
    fireEvent.mouseEnter(row);
    expect(onHoverSource).toHaveBeenLastCalledWith({ kind: "indicator", paneId: "candle_pane", name: "EMA#1" });
    fireEvent.mouseLeave(row);
    expect(onHoverSource).toHaveBeenLastCalledWith(null);
    onHoverSource.mockClear();
    fireEvent.mouseEnter(row); // re-emphasize, then unmount without a leave
    unmount();
    expect(onHoverSource).toHaveBeenLastCalledWith(null); // cleanup releases it
  });

  it("rows with no emphasis (e.g. a source lacking a chart target) don't wire hover", () => {
    const onHoverSource = vi.fn();
    render(
      <ChartOperandPicker
        sources={[{ id: "X", baseLabel: "X", outputs: [{ lineIndex: 0, label: "X", base: true, operand: op("X") }] }]}
        onPick={vi.fn()} onClose={vi.fn()} onHoverSource={onHoverSource}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: "X" }).parentElement!);
    expect(onHoverSource).not.toHaveBeenCalled();
  });
});
