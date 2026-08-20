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

// Same, but recording what the modal writes back onto the live instance.
function chartRecording(extendData: object) {
  const writes: Array<Record<string, unknown>> = [];
  const ind = {
    paneId: "candle_pane",
    name: "TRENDLINES",
    calcParams: [...Object.values(TRENDLINES_DEFAULTS)],
    extendData: { indType: "TRENDLINES", ...extendData },
    figures: [],
    styles: {},
  };
  const chart = {
    getIndicators: () => [ind],
    overrideIndicator: (o: { extendData?: Record<string, unknown> }) => {
      if (o.extendData) writes.push(o.extendData);
      return true;
    },
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  };
  return { chart: chart as never, writes };
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
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
}

describe("Inputs tab renders a control for every declared input", () => {
  // THE BUG THIS PINS: controlFor had branches for a calcParam number, an
  // extend select and an extend boolean, but not an extend NUMBER, so the merge
  // tolerance drew its label and nothing beside it.
  it("gives the merge tolerance a number box carrying its default", () => {
    open();
    const box = screen.getByLabelText("Merge Lines within");
    expect(box).toBeTruthy();
    expect((box as HTMLInputElement).type).toBe("number");
    expect((box as HTMLInputElement).value).toBe("1");
  });

  it("shows the saved value rather than the default when there is one", () => {
    open({ dedupeAtr: 0.5 });
    expect(
      (screen.getByLabelText("Merge Lines within") as HTMLInputElement).value,
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
    expect(rows[i + 1].textContent).toContain("Extend right");
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

  // A `wide` number keeps its ⓘ beside the label (the label is a phrase the
  // control completes), unlike the half-width numbers above whose tip sits at
  // the end of the row. Its control stays in the shared second column, so it
  // lines up with the checkbox above it rather than running to the modal edge.
  it("gives the merge tolerance its tip beside the label, control in column two", () => {
    open();
    const box = screen.getByLabelText("Merge Lines within");
    const row = box.closest(".ind-row");
    expect(row?.className).toContain("ind-row-cols");
    const head = row!.querySelector(".ind-row-head");
    expect(head).toBeTruthy();
    expect(head!.querySelector(".ind-info")).toBeTruthy();
    expect(row!.querySelector(".ind-cols-control")).toBeNull();
  });

  // The "Merge similar lines" checkbox that used to sit beside this box is gone
  // (tolerance 0 says the same thing), so a pane saved with it UNTICKED has to
  // land on 0 — anything else opens on a rule the pane is not drawing.
  it("opens a legacy unticked merge switch on tolerance 0", () => {
    open({ dedupe: false, dedupeAtr: 1 });
    expect(
      (screen.getByLabelText("Merge Lines within") as HTMLInputElement).value,
    ).toBe("0");
  });

  // ...and the stale flag leaves the live instance, or it keeps forcing the
  // tolerance to 0 and a number typed here would draw nothing until a reload.
  it("clears the legacy flag off the live instance", () => {
    const { chart, writes } = chartRecording({ dedupe: false });
    render(
      <IndicatorSettings
        chart={chart}
        scope="tab.test"
        epic="US100"
        brokerId="capital"
        chartResolution="DAY"
        paneId="candle_pane"
        name="TRENDLINES"
        cellId="cell.test"
        onClose={vi.fn()}
      />,
    );
    expect(writes.some((w) => w.dedupe === true)).toBe(true);
  });

  it("leaves no declared input without a control", () => {
    open();
    // Every label in the Inputs tab must have something focusable beside it.
    for (const label of [
      "Max Trendlines",
      "Min Back Clearance",
      "Merge Lines within",
      "Declutter",
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

describe("Declutter select", () => {
  // A SelectMenu (button + popover), not a native <select>, so what is asserted
  // is the trigger's text: the label of the option in force.
  it("opens on the near-price rule by default", () => {
    open();
    expect(screen.getByLabelText("Declutter").textContent).toContain(
      "Only lines near price",
    );
  });

  it("opens on Off for a pane saved before the select existed", () => {
    // It was an "Only lines near price" checkbox; a pane that stored it
    // UNTICKED must not silently regain the filter when the modal opens.
    open({ nearPrice: false });
    expect(screen.getByLabelText("Declutter").textContent).toContain("Off");
  });

  it("keeps a saved choice over both defaults", () => {
    open({ declutter: "pivot", nearPrice: false });
    expect(screen.getByLabelText("Declutter").textContent).toContain(
      "One line per pivot",
    );
  });
});

describe("the merge tolerance under One line per pivot", () => {
  it("hides it, because that choice runs the merge with no tolerance", () => {
    open({ declutter: "pivot" });
    expect(screen.queryByLabelText("Merge Lines within")).toBeNull();
  });

  it("brings it back on the other two choices", () => {
    open({ declutter: "near" });
    expect(screen.getByLabelText("Merge Lines within")).toBeTruthy();
  });

  it("shows it for a pane saved before the select existed", () => {
    // The legacy fallback resolves to "off"/"near", never to "pivot", so a
    // guard reading the raw stored value would blank the row here.
    open({ nearPrice: false });
    expect(screen.getByLabelText("Merge Lines within")).toBeTruthy();
  });
});
