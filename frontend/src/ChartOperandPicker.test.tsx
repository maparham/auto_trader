// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChartOperandPicker from "./ChartOperandPicker";
import type { ChartOperandSource } from "./lib/chartOperand";
import type { SeriesOperand } from "./lib/backtestConfig";

afterEach(cleanup);

const op = (label: string): SeriesOperand => ({ kind: "series", seriesKey: label, label, recipe: { source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 } });

const SOURCES: ChartOperandSource[] = [
  { id: "EMA#1", baseLabel: "EMA(9)", emphasis: { kind: "indicator", paneId: "candle_pane", name: "EMA#1" }, outputs: [{ lineIndex: 0, label: "EMA(9)", base: true, operand: op("EMA(9)") }] },
  { id: "PH#1", baseLabel: "Prev H/L", emphasis: { kind: "drawing", id: "PH#1" }, outputs: [
    { lineIndex: 2, label: "Day High", operand: op("Prev H/L: Day High") },
    { lineIndex: 3, label: "Day Low", operand: op("Prev H/L: Day Low") },
  ] },
  { id: "MACD#1", baseLabel: "MACD", disabled: true, disabledReason: "MACD isn't supported in rules yet", outputs: [] },
];

const addBtn = () => screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;

describe("ChartOperandPicker", () => {
  it("empty state when there are no sources (no Add button)", () => {
    render(<ChartOperandPicker sources={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/No indicators on this chart/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("Add is disabled until a row is selected", () => {
    render(<ChartOperandPicker sources={SOURCES} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(addBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    expect(addBtn().disabled).toBe(false);
  });

  it("selecting a row does not commit; Add fires onPick with that operand and closes", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    expect(onPick).not.toHaveBeenCalled(); // click only selects
    fireEvent.click(addBtn());
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: "EMA(9)" }));
  });

  it("multi-output row expands, sub-item selects, Add commits the sub-operand", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Prev H\/L/ }));
    fireEvent.click(screen.getByRole("button", { name: "Day High" }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(addBtn());
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: "Prev H/L: Day High" }));
  });

  it("Cancel closes without picking", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Escape closes without picking", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("disabled source is not selectable and shows its reason", () => {
    render(<ChartOperandPicker sources={SOURCES} onPick={vi.fn()} onClose={vi.fn()} />);
    const row = screen.getByRole("button", { name: /MACD/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(addBtn().disabled).toBe(true); // still nothing selected
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

  it("selection keeps the emphasis sticky after the pointer leaves; hovering another row previews it", () => {
    const onHoverSource = vi.fn();
    render(
      <ChartOperandPicker sources={SOURCES} onPick={vi.fn()} onClose={vi.fn()} onHoverSource={onHoverSource} />,
    );
    const emaRow = screen.getByRole("button", { name: "EMA(9)" }).parentElement!;
    // Select EMA, then move the pointer off it — emphasis stays on the selection.
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    fireEvent.mouseEnter(emaRow);
    fireEvent.mouseLeave(emaRow);
    expect(onHoverSource).toHaveBeenLastCalledWith({ kind: "indicator", paneId: "candle_pane", name: "EMA#1" });
    // Hover the Prev H/L parent row → previews its (drawing) target without losing selection.
    const phRow = screen.getByRole("button", { name: /Prev H\/L/ }).parentElement!;
    fireEvent.mouseEnter(phRow);
    expect(onHoverSource).toHaveBeenLastCalledWith({ kind: "drawing", id: "PH#1" });
    // Leaving it falls back to the still-selected EMA.
    fireEvent.mouseLeave(phRow);
    expect(onHoverSource).toHaveBeenLastCalledWith({ kind: "indicator", paneId: "candle_pane", name: "EMA#1" });
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
