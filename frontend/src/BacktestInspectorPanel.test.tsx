// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import BacktestInspectorPanel from "./BacktestInspectorPanel";
import {
  inspectSelectedBarSignal,
  inspectTraceSignal,
  setInspectTraces,
} from "./lib/backtestInspect";
import type { BarTrace } from "./api";

afterEach(() => {
  inspectSelectedBarSignal.set(null);
  inspectTraceSignal.set(null);
  cleanup();
});

const trace = (over: Partial<BarTrace> = {}): BarTrace => ({
  time: 1_710_170_000,
  action: "suppressed",
  reason: "already in position",
  inPositionLong: true,
  inPositionShort: false,
  windowActive: true,
  warmedUp: true,
  spacingOk: null,
  groups: [
    {
      group: "longEntry",
      combine: "AND",
      passed: false,
      terms: [
        { left: "EMA(9)", lval: 30486.2, op: "gt", right: "EMA(200)", rval: 30501.9, leftTf: null, rightTf: "MINUTE_15", passed: false },
        { left: "EMA(21)", lval: 30510, op: "gt", right: "EMA(200)", rval: 30501.9, leftTf: null, rightTf: "MINUTE_15", passed: true },
      ],
    },
    { group: "shortEntry", combine: "AND", passed: false, terms: [] },
    { group: "longExit", combine: "AND", passed: false, terms: [] },
    { group: "shortExit", combine: "AND", passed: false, terms: [] },
  ],
  ...over,
});

describe("BacktestInspectorPanel", () => {
  it("prompts when no bar is selected", () => {
    render(<BacktestInspectorPanel />);
    expect(screen.getByText(/Click a bar to inspect/)).toBeTruthy();
  });

  it("shows an out-of-range message when the selected bar has no trace", () => {
    setInspectTraces([trace()]);
    inspectSelectedBarSignal.set(999); // no trace at this time
    render(<BacktestInspectorPanel />);
    expect(screen.getByText(/outside the backtest range/)).toBeTruthy();
  });

  it("renders all four groups, failing terms, and the outcome + reason", () => {
    const t = trace();
    setInspectTraces([t]);
    inspectSelectedBarSignal.set(t.time);
    const { container } = render(<BacktestInspectorPanel />);

    expect(screen.getByText("Long entry")).toBeTruthy();
    expect(screen.getByText("Short entry")).toBeTruthy();
    expect(screen.getByText("Long exit")).toBeTruthy();
    expect(screen.getByText("Short exit")).toBeTruthy();

    // The failing term's values are shown (and the HTF tag on the right operand).
    expect(container.textContent).toContain("EMA(200) @15m");
    expect(screen.getAllByText("30501.9").length).toBeGreaterThan(0);

    // Outcome chip + human reason.
    expect(screen.getByText("suppressed")).toBeTruthy();
    expect(screen.getByText("already in position")).toBeTruthy();
  });
});
