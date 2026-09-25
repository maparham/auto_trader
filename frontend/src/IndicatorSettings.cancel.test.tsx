// @vitest-environment jsdom
// Cancel must put extendData back exactly as it was when the modal opened, for
// every indicator type. klinecharts merges extendData INTO the live object, so
// a snapshot that only holds a reference to it sees every edit too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";
import { TRENDLINES_DEFAULTS } from "./lib/indicators/trendlinesOutputs";

afterEach(cleanup);

// klinecharts 10's merge(): objects and arrays recurse into the SAME target
// object, anything else (null included) is assigned, cloned on the way in.
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

function open(type: string, calcParams: number[], extendData: object = {}) {
  const ind = {
    paneId: "candle_pane",
    name: type,
    calcParams,
    extendData: structuredClone({ indType: type, ...extendData }) as Record<string, unknown>,
    figures: [],
    styles: {},
  };
  const chart = {
    getIndicators: () => [ind],
    overrideIndicator: (o: { extendData?: Record<string, unknown> }) => {
      if (o.extendData && o.extendData !== ind.extendData) merge(ind.extendData, o.extendData);
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
      name={type}
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
  return ind;
}

// The footer's Cancel is the last one (a preset menu carries its own).
const cancel = () => fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);

describe("Cancel restores extendData for every type", () => {
  it("reverts a changed extend input (Trendlines dim opacity)", () => {
    const ind = open("TRENDLINES", [...Object.values(TRENDLINES_DEFAULTS)], { dimOpacity: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.change(screen.getByLabelText("Dim opacity"), { target: { value: "40" } });
    expect(ind.extendData.dimOpacity).toBe(40);
    cancel();
    expect(ind.extendData.dimOpacity).toBe(60);
  });

  it("removes a key the pane did not have when the modal opened (S/R zone style)", () => {
    const ind = open("SR_LEVELS", [15, 0.5, 2, 8, 500]);
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Dim broken levels"));
    expect((ind.extendData.zoneStyle as { dimBroken: boolean }).dimBroken).toBe(false);
    cancel();
    expect(ind.extendData.zoneStyle ?? null).toBeNull();
  });

  it("reverts a nested edit to an object the pane already had", () => {
    const ind = open("SR_LEVELS", [15, 0.5, 2, 8, 500], {
      zoneStyle: { supColor: "#26A69A", resColor: "#EF5350", opacity: 0.1, dimBroken: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Dim broken levels"));
    cancel();
    expect((ind.extendData.zoneStyle as { dimBroken: boolean }).dimBroken).toBe(true);
  });
});
