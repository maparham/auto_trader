// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import BacktestSignalPopover from "./BacktestSignalPopover";
import { backtestSignalHoverSignal } from "./lib/signals";
import type { SignalGlyph } from "./lib/signalGlyphs";

afterEach(() => {
  backtestSignalHoverSignal.set(null);
  cleanup();
});

const glyph = (over: Partial<SignalGlyph> = {}): SignalGlyph => ({
  signalTime: 1_710_170_000,
  leg: "long",
  side: "buy",
  reason: "",
  placement: "below",
  combine: "AND",
  terms: [
    { left: "EMA(56)", lval: 24989.6, op: "lt", right: "open", rval: 25002.5, leftTf: "MINUTE_15", rightTf: null },
    { left: "close", lval: 25010.7, op: "gt", right: "open", rval: 25002.5, leftTf: null, rightTf: null },
  ],
  ...over,
});

describe("BacktestSignalPopover", () => {
  it("renders nothing when no glyph is hovered", () => {
    render(<BacktestSignalPopover />);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders one row per term with the timeframe-tagged label", () => {
    backtestSignalHoverSignal.set({ glyph: glyph(), x: 10, y: 10 });
    render(<BacktestSignalPopover />);

    // The base-timeframe indicator shows its TF (@15m); the price operand is bare.
    expect(screen.getByText("EMA(56) @15m")).toBeTruthy();
    expect(screen.getAllByText("open")).toHaveLength(2);
    expect(screen.getByText("close")).toBeTruthy();

    // One <tr> per term.
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    // The values the engine compared are shown.
    expect(screen.getByText("24989.6")).toBeTruthy();
    expect(screen.getByText("25010.7")).toBeTruthy();
  });

  it("shows a header naming the leg, action and combine", () => {
    backtestSignalHoverSignal.set({ glyph: glyph({ side: "sell", leg: "short" }), x: 0, y: 0 });
    render(<BacktestSignalPopover />);
    expect(screen.getByText(/Short entry — signal .* \(AND\)/)).toBeTruthy();
  });

  it("renders note-style terms (empty op) as plain key/value", () => {
    backtestSignalHoverSignal.set({
      glyph: glyph({
        terms: [{ left: "rsi", lval: 71.23, op: "", right: "", rval: null, leftTf: null, rightTf: null }],
      }),
      x: 10,
      y: 10,
    });
    render(<BacktestSignalPopover />);

    expect(screen.getByText("rsi")).toBeTruthy();
    expect(screen.getByText("71.23")).toBeTruthy();

    // No dangling operator glyph or empty right-side cell for a note term.
    const row = screen.getByRole("row");
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(2);
  });
});
