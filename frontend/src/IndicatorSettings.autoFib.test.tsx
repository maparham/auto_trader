// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";
import { autoFibFibConfig } from "./lib/indicators/autoFibOutputs";

afterEach(cleanup);

// klinecharts 10's merge(): objects and arrays recurse into the SAME target
// object, anything else (null included) is assigned, cloned on the way in.
// Merging in place is what lets a live-reference snapshot alias the edits.
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const s = source[key];
    const t = target[key];
    if (isObj(s) && isObj(t)) merge(t, s);
    else target[key] = isObj(s) ? structuredClone(s) : s;
  }
}

function open(extendData: object = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const ind = {
    paneId: "candle_pane",
    name: "AUTO_FIB",
    calcParams: [5, 0],
    // Cloned so the in-place merges below never reach the caller's objects.
    extendData: structuredClone({ indType: "AUTO_FIB", ...extendData }) as Record<string, unknown>,
    figures: [],
    styles: {},
  };
  const chart = {
    getIndicators: () => [ind],
    overrideIndicator: (o: { extendData?: Record<string, unknown> }) => {
      if (o.extendData) {
        writes.push(structuredClone(o.extendData));
        if (o.extendData !== ind.extendData) merge(ind.extendData, o.extendData);
      }
      return true;
    },
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  };
  render(
    <IndicatorSettings
      chart={chart as never}
      scope="tab.test"
      epic="US100"
      brokerId="capital"
      chartResolution="DAY"
      paneId="candle_pane"
      name="AUTO_FIB"
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
  return { writes, ind };
}

describe("Auto Fib settings", () => {
  it("offers Past fibs and a timeframe pin on the Inputs tab", () => {
    open();
    // The value is not asserted: a 0 in a number box can render empty (the
    // off-sentinel draft rule), which is not what this pins.
    expect(screen.getByLabelText("Past fibs")).toBeTruthy();
    // Only pinnable types render this checkbox; the fallback shows a disabled select.
    expect(screen.getAllByText("Wait for timeframe closes").length).toBeGreaterThan(0);
  });

  it("edits the levels from the Style tab as a plain extendData write", () => {
    const { writes } = open();
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Level 0.236"));
    const fib = writes.at(-1)?.fib as { levels: Array<{ enabled: boolean }>; extend: string };
    expect(fib.levels[1].enabled).toBe(false);
    // A pane with no saved fib starts extended right.
    expect(fib.extend).toBe("right");
  });

  it("offers Past fib opacity on the Style tab", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    expect(screen.getByLabelText("Past fib opacity")).toBeTruthy();
  });

  it("Cancel reverts a Style-tab edit on a fresh pane", () => {
    const { ind } = open();
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Reverse"));
    expect((ind.extendData.fib as { reverse: boolean }).reverse).toBe(true);
    fireEvent.click(screen.getByText("Cancel", { selector: "button" }));
    // The pane had no fib key: the edit must not survive, and what is left
    // must read back as the untouched default (extended right).
    expect(ind.extendData.fib ?? null).toBeNull();
    expect(autoFibFibConfig(ind.extendData)).toEqual(autoFibFibConfig({}));
  });

  it("Cancel restores a saved fib and past-fib inputs", () => {
    const saved = { ...autoFibFibConfig({}), extend: "none" as const };
    const { ind } = open({ fib: saved, pastCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Reverse"));
    fireEvent.click(screen.getByLabelText("Level 0.236"));
    fireEvent.change(screen.getByLabelText("Past fib opacity"), { target: { value: "60" } });
    expect(ind.extendData.pastOpacity).toBe(60);
    fireEvent.click(screen.getByText("Cancel", { selector: "button" }));
    expect(autoFibFibConfig(ind.extendData)).toEqual(saved);
    expect(ind.extendData.pastCount).toBe(2);
    expect(ind.extendData.pastOpacity ?? null).toBeNull();
  });
});
