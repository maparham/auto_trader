// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";
import { TRENDLINES_DEFAULTS } from "./lib/indicators/trendlinesOutputs";

afterEach(cleanup);

// A chart carrying one live TRENDLINES instance, which is all the Inputs tab
// reads. klinecharts itself is not mocked: the modal only calls getIndicators
// and overrideIndicator on this object.
function chartWith(extendData: object) {
  const ind = {
    paneId: "candle_pane",
    name: "TRENDLINES",
    calcParams: [...Object.values(TRENDLINES_DEFAULTS)],
    extendData: { indType: "TRENDLINES", ...extendData },
    figures: [],
    styles: {},
  };
  return {
    getIndicators: () => [ind],
    overrideIndicator: () => true,
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  } as never;
}

function open(extendData: object = {}) {
  render(
    <IndicatorSettings
      chart={chartWith(extendData)}
      scope="tab.test"
      epic="US100"
      brokerId="capital"
      chartResolution="DAY"
      paneId="candle_pane"
      name="TRENDLINES"
      onClose={vi.fn()}
    />,
  );
}

describe("Inputs tab renders a control for every declared input", () => {
  // THE BUG THIS PINS: controlFor had branches for a calcParam number, an
  // extend select and an extend boolean, but not an extend NUMBER, so Merge
  // Tolerance drew its label and nothing beside it.
  it("gives Merge Tolerance a number box carrying its default", () => {
    open();
    const box = screen.getByLabelText("Merge Tolerance");
    expect(box).toBeTruthy();
    expect((box as HTMLInputElement).type).toBe("number");
    expect((box as HTMLInputElement).value).toBe("1");
  });

  it("shows the saved value rather than the default when there is one", () => {
    open({ dedupeAtr: 0.5 });
    expect(
      (screen.getByLabelText("Merge Tolerance") as HTMLInputElement).value,
    ).toBe("0.5");
  });

  // The Inputs tab runs sixteen calculation params straight into the render-only
  // options, and the four tips used to end in "Drawing only" because there was
  // no other way to say it. The heading says it once instead.
  it("opens a Drawing section at the first render-only control", () => {
    open();
    const head = screen.getByText("Drawing");
    expect(head.className).toContain("ind-group");
    // It leads the render-only run rather than sitting anywhere: the next
    // control after it is the first of them.
    const rows = [...document.querySelectorAll(".ind-group, .ind-row, .ind-pair2")];
    const i = rows.indexOf(head);
    expect(i).toBeGreaterThan(0);
    expect(rows[i + 1].textContent).toContain("Only lines near price");
  });

  // The solo numbers used to push their control to the modal's right edge while
  // every paired row put its right-hand control at the half-way mark, so a
  // column of numbers zig-zagged.
  it("lays a solo number on the same two columns as a pair", () => {
    open();
    const box = screen.getByLabelText("Min Back Clearance");
    const row = box.closest(".ind-row");
    expect(row?.className).toContain("ind-row-cols");
    // The tip rides with the CONTROL on these rows, not with the label: half a
    // row does not hold the label and a tip, and the icon was the thing that
    // got clipped.
    const control = box.closest(".ind-cols-control");
    expect(control).toBeTruthy();
    expect(control!.querySelector(".ind-info")).toBeTruthy();
    expect(row!.querySelector(".ind-row-head")).toBeNull();
    // A select is deliberately not in that layout: its options are sentences.
    expect(
      screen.getByLabelText("Extend").closest(".ind-row")?.className,
    ).not.toContain("ind-row-cols");
  });

  it("leaves no declared input without a control", () => {
    open();
    // Every label in the Inputs tab must have something focusable beside it.
    for (const label of [
      "Max Trendlines",
      "Min Back Clearance",
      "Merge Tolerance",
      "Merge similar lines",
      "Only lines near price",
      "Extend",
    ])
      expect(screen.getByLabelText(label), `${label} has no control`).toBeTruthy();
  });
});

describe("Calculation group", () => {
  it("offers the timeframe pin rather than the disabled placeholder", () => {
    // Every other pane type falls through to a single-option, disabled select
    // whose tip lists who does support the pin. Trendlines now detects on the
    // pinned timeframe's own bars, so it must get the real control.
    open();
    const tf = screen
      .getAllByRole("combobox")
      .find((s) => (s as HTMLSelectElement).value === "chart") as HTMLSelectElement;
    expect(tf).toBeTruthy();
    expect(tf.disabled).toBe(false);
    expect(tf.options.length).toBeGreaterThan(1);
  });

  it("shows the saved pin", () => {
    open({ mtf: { timeframe: "HOUR_4" } });
    const tf = screen
      .getAllByRole("combobox")
      .find((s) => (s as HTMLSelectElement).value === "HOUR_4");
    expect(tf).toBeTruthy();
  });
});
