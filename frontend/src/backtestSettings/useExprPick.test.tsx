// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/notify", () => ({ toast: vi.fn() }));

import { Signal } from "../lib/signals";
import { defaultBacktestConfig, type BacktestConfig } from "../lib/backtestConfig";
import { useExprPick } from "./useExprPick";

function fakeController() {
  return {
    chart: {},
    indicatorPickArmed: new Signal<boolean>(false),
    indicatorPickResult: new Signal<unknown>(null),
  };
}

const line = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };

function setup() {
  const controller = fakeController();
  const { result } = renderHook(() => {
    const [cfg, setCfg] = useState<BacktestConfig>(defaultBacktestConfig);
    return { cfg, pick: useExprPick(controller as never, setCfg) };
  });
  const pickLine = (group: "longEntry" | "longExit", row: number, l = line) => {
    act(() => result.current.pick!.arm(group, row));
    act(() => controller.indicatorPickResult.set({ paneId: "candle_pane", name: "TRENDLINES", line: l }));
  };
  return { result, pickLine };
}

describe("useExprPick picked lines", () => {
  it("a picked line appends L1 and stores the line", () => {
    const { result, pickLine } = setup();
    pickLine("longEntry", 0);
    expect(result.current.cfg.longEntry.rules[0].expr).toMatch(/L1$/);
    expect(result.current.cfg.lines).toEqual({ L1: line });
  });

  it("re-picking the same geometry reuses its id; a new line mints the next id", () => {
    const { result, pickLine } = setup();
    pickLine("longEntry", 0);
    pickLine("longExit", 0, { ...line, tRef: 99, pRef: 99 });
    expect(result.current.cfg.longExit.rules[0].expr).toMatch(/L1$/);
    expect(Object.keys(result.current.cfg.lines!)).toEqual(["L1"]);
    pickLine("longExit", 0, { ...line, p2: 5 });
    expect(result.current.cfg.longExit.rules[0].expr).toMatch(/L1L2$/);
    expect(Object.keys(result.current.cfg.lines!)).toEqual(["L1", "L2"]);
  });
});
