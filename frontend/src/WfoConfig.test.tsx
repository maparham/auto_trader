// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WfoConfig } from "./WfoConfig";
import { DEFAULT_WFO_CONFIG } from "./lib/wfo";

afterEach(cleanup);

describe("WfoConfig", () => {
  it("multi-selects train spans (matrix) and reports objective changes", () => {
    const onChange = vi.fn();
    render(<WfoConfig cfg={{ ...DEFAULT_WFO_CONFIG, trainSpans: ["3m"] }} onChange={onChange} comboTotal={12} droppedAxes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "6m" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ trainSpans: ["3m", "6m"] }));
    fireEvent.click(screen.getByRole("button", { name: /best/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selection: "best" }));
  });

  it("deselecting the last train span is blocked", () => {
    const onChange = vi.fn();
    render(<WfoConfig cfg={{ ...DEFAULT_WFO_CONFIG, trainSpans: ["3m"] }} onChange={onChange} comboTotal={1} droppedAxes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "3m" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows combo math and dropped-axes note", () => {
    render(<WfoConfig cfg={{ ...DEFAULT_WFO_CONFIG, trainSpans: ["2w", "3m"] }} onChange={() => {}} comboTotal={40} droppedAxes={["Period"]} />);
    expect(screen.getByText(/40 combos/)).toBeTruthy();
    expect(screen.getByText(/2 scheme/)).toBeTruthy();
    expect(screen.getByText(/Period/)).toBeTruthy();
  });
});
