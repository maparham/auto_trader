// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";
import { TRENDLINES_DEFAULTS } from "./lib/indicators/trendlinesOutputs";

afterEach(cleanup);

// A chart carrying one live TRENDLINES instance, which is all the Inputs tab
// reads. klinecharts itself is not mocked: the modal only calls getIndicators
// and overrideIndicator on this object.
function chartWith(extendData: object, calcParams = [...Object.values(TRENDLINES_DEFAULTS)]) {
  const ind = {
    paneId: "candle_pane",
    name: "TRENDLINES",
    calcParams,
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
  const cpWrites: number[][] = [];
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
    overrideIndicator: (o: {
      extendData?: Record<string, unknown>;
      calcParams?: number[];
    }) => {
      if (o.extendData) writes.push(o.extendData);
      if (o.calcParams) cpWrites.push(o.calcParams);
      return true;
    },
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  };
  return { chart: chart as never, writes, cpWrites };
}

function openRecording(extendData: object = {}) {
  const rec = chartRecording(extendData);
  render(
    <IndicatorSettings
      chart={rec.chart}
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
  return rec;
}

function open(extendData: object = {}, calcParams?: number[]) {
  render(
    <IndicatorSettings
      chart={chartWith(extendData, calcParams)}
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
    open({}, [...Object.values(TRENDLINES_DEFAULTS).slice(0, 21), 0.5]);
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
    expect(rows[i + 1].textContent).toContain("End at last bar");
  });

  // The solo numbers used to push their control to the modal's right edge while
  // every paired row put its right-hand control at the half-way mark, so a
  // column of numbers zig-zagged.
  it("lays a solo number on the same two columns as a pair", () => {
    open();
    const box = screen.getByLabelText("Max Projection");
    const row = box.closest(".ind-row");
    expect(row?.className).toContain("ind-row-cols");
    // The tip rides beside the LABEL like on every other row, so the icons sit
    // in one left-hand column instead of scattering out past the controls (the
    // label ellipsises in CSS when the two don't fit).
    const head = row!.querySelector(".ind-row-head");
    expect(head).toBeTruthy();
    expect(head!.querySelector(".ind-info")).toBeTruthy();
    expect(row!.querySelector(".ind-cols-control")).toBeNull();
    // A select is deliberately not in that layout: its options are sentences.
    expect(
      screen.getByLabelText("Extend").closest(".ind-row")?.className,
    ).not.toContain("ind-row-cols");
  });

  // A `wide` number lays out the same way (tip beside the label, control in
  // the shared second column), so it lines up with the checkbox above it
  // rather than running to the modal edge.
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

  it("leaves no declared input without a control", () => {
    open();
    // Every label in the Inputs tab must have something focusable beside it.
    for (const label of [
      "Max Trendlines",
      "Max Touch Gap",
      "Max Touch Spacing",
      "Merge Lines within",
      "One line per pivot",
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

describe("One line per pivot", () => {
  it("opens unticked by default", () => {
    open();
    expect((screen.getByLabelText("One line per pivot") as HTMLInputElement).checked).toBe(false);
  });

  // The Declutter select was render-only; "One line per pivot" is calcParam
  // slot 22 now, so a merged-away line stops reporting to rules. A pane saved
  // with the select's "pivot" (and no slot 22) opens ticked.
  it("migrates a saved pivot declutter onto the slot", () => {
    open({ declutter: "pivot" }, Object.values(TRENDLINES_DEFAULTS).slice(0, 21));
    expect((screen.getByLabelText("One line per pivot") as HTMLInputElement).checked).toBe(true);
  });

  it("migrates a saved near-price rule onto Max Distance", () => {
    open({ declutter: "near" }, Object.values(TRENDLINES_DEFAULTS).slice(0, 19));
    expect((screen.getByLabelText("Max Distance (×ATR)") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("One line per pivot") as HTMLInputElement).checked).toBe(false);
  });

  it("leaves Max Distance off for a pane that never chose near-price", () => {
    open({ nearPrice: false });
    expect((screen.getByLabelText("Max Distance (×ATR)") as HTMLInputElement).value).toBe("0");
  });
});

describe("the merge tolerance", () => {
  it("hides under One line per pivot, because that choice runs the merge with no tolerance", () => {
    open({}, [...Object.values(TRENDLINES_DEFAULTS).slice(0, 22), 1]);
    expect(screen.queryByLabelText("Merge Lines within")).toBeNull();
  });

  it("shows otherwise, carrying its default", () => {
    open();
    expect((screen.getByLabelText("Merge Lines within") as HTMLInputElement).value).toBe("1");
  });

  // The tolerance lived on extendData while merging was render-only. A pane
  // saved with a number there, or with the older checkbox unticked, opens on
  // that value in the slot.
  it("migrates the render-only tolerance onto slot 21", () => {
    open({ dedupeAtr: 2.5 }, Object.values(TRENDLINES_DEFAULTS).slice(0, 21));
    expect((screen.getByLabelText("Merge Lines within") as HTMLInputElement).value).toBe("2.5");
  });

  it("migrates the unticked checkbox to zero", () => {
    open({ dedupe: false }, Object.values(TRENDLINES_DEFAULTS).slice(0, 21));
    expect((screen.getByLabelText("Merge Lines within") as HTMLInputElement).value).toBe("0");
  });
});

describe("min/max range rows", () => {
  // Touches, Span and Slope each used to be TWO labeled fields ("Min Touches" /
  // "Max Touches"...) saying almost the same thing. Each is one concept, so
  // each is one "label [min] – [max] unit" row now.
  it("collapses each pair into one row holding both boxes", () => {
    open();
    for (const [label, minLabel, maxLabel] of [
      ["Touches", "Min Touches", "Max Touches"],
      ["Span", "Min Span", "Max Span"],
      ["Slope", "Min Slope", "Max Slope"],
    ]) {
      const row = screen.getByText(label).closest(".ind-range-row");
      expect(row, `${label} has no range row`).toBeTruthy();
      expect(row!.contains(screen.getByLabelText(minLabel))).toBe(true);
      expect(row!.contains(screen.getByLabelText(maxLabel))).toBe(true);
    }
  });

  // The stored 0 means "no limit", which a literal 0 in the box hid ("zero
  // touches allowed?"). The box shows that state as empty behind an ∞.
  it("shows a stored 0 on an unbounded max as empty behind an ∞", () => {
    open();
    const box = screen.getByLabelText("Max Touches") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("∞");
    // The min side keeps its literal value.
    expect((screen.getByLabelText("Min Touches") as HTMLInputElement).value).toBe("2");
  });

  it("stores the same 0 sentinel when the box is cleared", () => {
    const { cpWrites } = openRecording();
    const box = screen.getByLabelText("Max Span") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "120" } });
    expect(cpWrites.at(-1)![10]).toBe(120);
    fireEvent.change(box, { target: { value: "" } });
    expect(cpWrites.at(-1)![10]).toBe(0);
    expect(box.value).toBe("");
  });
});

describe("preset select", () => {
  // A SelectMenu, like Declutter: what is asserted is the trigger's text — the
  // preset in force, resolved by VALUE comparison so it survives reopen.
  it("opens on Balanced for a pane at the defaults", () => {
    open();
    expect(screen.getByLabelText("Preset").textContent).toContain("Balanced");
  });

  // A preset writes the FULL calcParams, so the params it doesn't mention land
  // on their defaults and the option means the same thing on every chart.
  it("applies Clean's values on pick", () => {
    const { cpWrites } = openRecording();
    fireEvent.click(screen.getByLabelText("Preset"));
    fireEvent.click(screen.getByRole("option", { name: "Clean" }));
    const cp = cpWrites.at(-1)!;
    expect(cp[5]).toBe(2); // maxLines
    expect(cp[2]).toBe(3); // minTouches
    expect(cp[3]).toBe(40); // minSpanBars
    expect(cp[6]).toBe(0.75); // minSwingAtr
    expect(cp[10]).toBe(0); // maxSpanBars untouched: still the default
    expect(screen.getByLabelText("Preset").textContent).toContain("Clean");
  });

  // Any edit that leaves a preset's numbers behind reads as Custom — an
  // out-of-list state the menu only offers while it is true.
  it("reads Custom after a manual edit", () => {
    open();
    fireEvent.change(screen.getByLabelText("Max Trendlines"), {
      target: { value: "9" },
    });
    expect(screen.getByLabelText("Preset").textContent).toContain("Custom");
    fireEvent.click(screen.getByLabelText("Preset"));
    expect(screen.getByRole("option", { name: "Custom" })).toBeTruthy();
  });
});

describe("input sections", () => {
  // Sixteen equal-weight fields read as a wall; the headings break the run
  // into the detector's story: pivots -> fit -> filters -> lifetime.
  it("opens a heading over each run of related params", () => {
    open();
    for (const h of ["Pivots", "Line Fit", "Filters", "Lifetime"])
      expect(screen.getByText(h).className, `${h} heading`).toContain("ind-group");
  });
});
