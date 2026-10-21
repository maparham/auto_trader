// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";
import {
  TL_NEAR_PRICE_ATR,
  TRENDLINES_DEFAULTS,
  TRENDLINES_PRESET_CONFIGS,
  TRENDLINES_SEED,
} from "./lib/indicators/trendlinesOutputs";
import { loadIndicatorConfigs } from "./lib/persist";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

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
function chartRecording(extendData: object, calcParams?: number[]) {
  const writes: Array<Record<string, unknown>> = [];
  const cpWrites: number[][] = [];
  const ind = {
    paneId: "candle_pane",
    name: "TRENDLINES",
    calcParams: calcParams ?? [...Object.values(TRENDLINES_DEFAULTS)],
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

function openRecording(extendData: object = {}, calcParams?: number[]) {
  const rec = chartRecording(extendData, calcParams);
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
    const box = screen.getByLabelText("Merge lines within");
    expect(box).toBeTruthy();
    expect((box as HTMLInputElement).type).toBe("number");
    expect((box as HTMLInputElement).value).toBe("0.25");
  });

  it("shows the saved value rather than the default when there is one", () => {
    open({}, [...Object.values(TRENDLINES_DEFAULTS).slice(0, 21), 0.5]);
    expect(
      (screen.getByLabelText("Merge lines within") as HTMLInputElement).value,
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

  // A cut measured two ways shows ONE box and an ATR/% unit switch in its
  // range row; the per-pivot cap is a solo number row in the shared column.
  it("gives the merge tolerance one box and a unit switch, the per-pivot cap its own row", () => {
    open();
    const atr = screen.getByLabelText("Merge lines within");
    expect(screen.queryByLabelText("Merge lines within (%)")).toBeNull();
    const unit = screen.getByLabelText("Merge lines within unit") as HTMLSelectElement;
    expect(unit.closest(".ind-range")).toBe(atr.closest(".ind-range"));
    expect(unit.selectedOptions[0].textContent).toBe("ATR");
    const cap = screen.getByLabelText("Lines per Pivot").closest(".ind-row");
    expect(cap?.className).toContain("ind-row-cols");
    expect(cap!.querySelector(".ind-info")).toBeTruthy();
  });

  it("leaves no declared input without a control", () => {
    open();
    // Every label in the Inputs tab must have something focusable beside it.
    for (const label of [
      "Max Trendlines",
      "Max Touch Gap",
      "Max Touch Spacing",
      "Merge lines within",
      "Lines per Pivot",
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

describe("Lines per Pivot", () => {
  it("opens empty (off) by default, as an integer box", () => {
    open();
    const box = screen.getByLabelText("Lines per Pivot") as HTMLInputElement;
    expect(box.type).toBe("number");
    expect(box.value).toBe("");
    expect(box.step).toBe("1");
    expect(box.min).toBe("0");
  });

  // The Declutter select was render-only; the cap is calcParam slot 22 now,
  // so a merged-away line stops reporting to rules. A pane saved with the
  // select's "pivot" (and no slot 22) opens on a cap of 1, the old tick.
  it("migrates a saved pivot declutter onto the slot as a cap of one", () => {
    open({ declutter: "pivot" }, Object.values(TRENDLINES_DEFAULTS).slice(0, 21));
    expect((screen.getByLabelText("Lines per Pivot") as HTMLInputElement).value).toBe("1");
  });

  it("migrates a saved near-price rule onto Max Distance", () => {
    open({ declutter: "near" }, Object.values(TRENDLINES_DEFAULTS).slice(0, 19));
    expect((screen.getByLabelText("Max Distance (×ATR)") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Lines per Pivot") as HTMLInputElement).value).toBe("");
  });

  it("leaves Max Distance off (an empty box) for a pane that never chose near-price", () => {
    open({ nearPrice: false });
    expect((screen.getByLabelText("Max Distance (×ATR)") as HTMLInputElement).value).toBe("");
  });
});

describe("the merge tolerance", () => {
  it("stays shown under a per-pivot cap, since the two cuts compose", () => {
    open({}, [...Object.values(TRENDLINES_DEFAULTS).slice(0, 22), 1]);
    expect((screen.getByLabelText("Merge lines within") as HTMLInputElement).value).toBe("0.25");
    expect((screen.getByLabelText("Lines per Pivot") as HTMLInputElement).value).toBe("1");
  });

  it("shows otherwise, carrying its default", () => {
    open();
    expect((screen.getByLabelText("Merge lines within") as HTMLInputElement).value).toBe("0.25");
  });

  // The tolerance lived on extendData while merging was render-only. A pane
  // saved with a number there, or with the older checkbox unticked, opens on
  // that value in the slot.
  it("migrates the render-only tolerance onto slot 21", () => {
    open({ dedupeAtr: 2.5 }, Object.values(TRENDLINES_DEFAULTS).slice(0, 21));
    expect((screen.getByLabelText("Merge lines within") as HTMLInputElement).value).toBe("2.5");
  });

  it("migrates the unticked checkbox to off, an empty box", () => {
    open({ dedupe: false }, Object.values(TRENDLINES_DEFAULTS).slice(0, 21));
    expect((screen.getByLabelText("Merge lines within") as HTMLInputElement).value).toBe("");
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

  // Max Distance and Merge Lines are ONE cut measured two ways (ATR and
  // percent), so each is a single row too: no dash, each box keeps its unit.
  it("puts one box and its unit switch on one row per cut", () => {
    open();
    for (const label of ["Max Distance", "Merge lines within", "Merge slopes within"]) {
      const row = screen.getByText(label).closest(".ind-range-row");
      expect(row, `${label} has no range row`).toBeTruthy();
      expect(row!.querySelectorAll('input[type="number"]')).toHaveLength(1);
      expect(row!.querySelector("select.ind-unit")).toBeTruthy();
      expect(row!.querySelector(".ind-range-dash")).toBeNull();
    }
  });

  // The switch moves the cut between the twin slots in one write, and
  // switching back restores the value that unit held.
  it("moves the cut to the other unit's slot and back", () => {
    const { cpWrites } = openRecording({}, [...Object.values(TRENDLINES_SEED)]);
    const unit = screen.getByLabelText("Max Distance unit") as HTMLSelectElement;
    fireEvent.change(unit, { target: { value: "p20" } });
    expect(cpWrites.at(-1)!.slice(19, 21)).toEqual([0, 0]);
    expect(unit.selectedOptions[0].textContent).toBe("%");
    fireEvent.change(screen.getByLabelText("Max Distance (%)"), { target: { value: "12" } });
    expect(cpWrites.at(-1)!.slice(19, 21)).toEqual([0, 12]);
    fireEvent.change(unit, { target: { value: "p19" } });
    expect(cpWrites.at(-1)!.slice(19, 21)).toEqual([TRENDLINES_SEED.maxDistAtr, 0]);
  });

  // The value a unit held and the unit picked while both are off live in
  // extendData.dualCuts, so they survive a reopen.
  it("persists the left-behind value and restores it after a reopen", () => {
    const first = openRecording({}, [...Object.values(TRENDLINES_SEED)]);
    fireEvent.change(screen.getByLabelText("Max Distance unit"), { target: { value: "p20" } });
    const saved = first.writes.at(-1)!.dualCuts;
    expect(saved).toEqual({ units: { p19: "p20" }, memo: { p19: TRENDLINES_SEED.maxDistAtr } });
    cleanup();
    const cp = [...Object.values(TRENDLINES_SEED)];
    cp[19] = 0;
    const second = openRecording({ dualCuts: saved }, cp);
    const unit = screen.getByLabelText("Max Distance unit") as HTMLSelectElement;
    expect(unit.selectedOptions[0].textContent).toBe("%");
    fireEvent.change(unit, { target: { value: "p19" } });
    expect(second.cpWrites.at(-1)!.slice(19, 21)).toEqual([TRENDLINES_SEED.maxDistAtr, 0]);
  });

  // Ok rebuilds extendData from form state, so the memory must be part of it
  // or a reload loses it.
  it("saves the switch's memory with the pane on Ok", () => {
    openRecording({}, [...Object.values(TRENDLINES_SEED)]);
    fireEvent.change(screen.getByLabelText("Max Distance unit"), { target: { value: "p20" } });
    fireEvent.click(screen.getByRole("button", { name: "Ok" }));
    expect(loadIndicatorConfigs("tab.test").TRENDLINES?.extendData?.dualCuts).toEqual({
      units: { p19: "p20" },
      memo: { p19: TRENDLINES_SEED.maxDistAtr },
    });
  });

  // Both cuts set (an older pane): both boxes stay, so neither filters unseen.
  it("shows both boxes when both units hold a cut", () => {
    const cp = [...Object.values(TRENDLINES_SEED)];
    cp[20] = 15;
    open({}, cp);
    expect(screen.getByLabelText("Max Distance (×ATR)")).toBeTruthy();
    expect(screen.getByLabelText("Max Distance (%)")).toBeTruthy();
    expect(screen.queryByLabelText("Max Distance unit")).toBeNull();
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

  // Slope is signed, so BOTH its boxes are open-ended: the low side reads as
  // -∞ rather than a literal 0 that looks like "no falling lines".
  it("shows the signed Slope range as -∞ to ∞ at the defaults and takes a negative", () => {
    const { cpWrites } = openRecording();
    const lo = screen.getByLabelText("Min Slope") as HTMLInputElement;
    const hi = screen.getByLabelText("Max Slope") as HTMLInputElement;
    expect([lo.value, lo.placeholder]).toEqual(["", "-∞"]);
    expect([hi.value, hi.placeholder]).toEqual(["", "∞"]);
    expect(lo.min).toBe("");
    fireEvent.change(lo, { target: { value: "-0.5" } });
    expect(cpWrites.at(-1)![12]).toBe(-0.5);
  });

  // The boxes are controlled by the parsed number, and "0" in an unbounded
  // box IS the off sentinel (rendered empty), "0." and "-" parse to nothing.
  // Rendering the parse back on each keystroke ate them: "0.3" landed as
  // "3" and "-0.3" could not be typed at all. The raw text stays in the box
  // until it blurs; the slot still gets each keystroke's parse.
  it("keeps the typed text while an unbounded box has focus, so 0.3 and -0.3 can be typed", () => {
    const { cpWrites } = openRecording();
    // ("0." and "-" are not asserted: a number input reports them as "" and
    // keeps the glyphs on screen itself, so the draft has nothing to hold.)
    const lo = screen.getByLabelText("Min Slope") as HTMLInputElement;
    for (const raw of ["0", "0.3"]) {
      fireEvent.change(lo, { target: { value: raw } });
      expect(lo.value).toBe(raw);
    }
    expect(cpWrites.at(-1)![12]).toBe(0.3);
    for (const raw of ["-0", "-0.3"]) {
      fireEvent.change(lo, { target: { value: raw } });
      expect(lo.value).toBe(raw);
    }
    expect(cpWrites.at(-1)![12]).toBe(-0.3);
    fireEvent.blur(lo);
    expect(lo.value).toBe("-0.3");
    // A cleared box, once blurred, shows the sentinel as empty again.
    fireEvent.change(lo, { target: { value: "" } });
    fireEvent.blur(lo);
    expect(lo.value).toBe("");
    expect(cpWrites.at(-1)![12]).toBe(0);
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

describe("preset picker", () => {
  const picker = () => screen.getByLabelText("Preset") as HTMLSelectElement;
  const shown = () => picker().selectedOptions[0].textContent;
  const names = TRENDLINES_PRESET_CONFIGS.map((p) => p.name);

  // The preset in force is resolved by VALUE on every slot, so it survives
  // reopen; the parse defaults are none of the recipes.
  it("opens on Custom for a pane at the parse defaults", () => {
    open();
    expect(shown()).toBe("Custom");
  });

  it("opens on Balanced for a fresh pane", () => {
    open({}, [...Object.values(TRENDLINES_SEED)]);
    expect(shown()).toBe("Balanced");
    expect([...picker().options].map((o) => o.textContent)).toEqual(names);
  });

  it("writes the whole recipe but the slope band", () => {
    const { cpWrites } = openRecording();
    fireEvent.change(picker(), { target: { value: "2" } });
    const want = Object.values(TRENDLINES_PRESET_CONFIGS[2].config);
    want[11] = TRENDLINES_DEFAULTS.maxSlopeAtr;
    want[12] = TRENDLINES_DEFAULTS.minSlopeAtr;
    expect(cpWrites.at(-1)).toEqual(want);
    expect(shown()).toBe("More lines");
  });

  it("reads Custom after a manual edit", () => {
    open({}, [...Object.values(TRENDLINES_SEED)]);
    fireEvent.change(screen.getByLabelText("Max Pierce"), { target: { value: "0.5" } });
    expect(shown()).toBe("Custom");
  });
});

describe("direction picker", () => {
  const picker = () => screen.getByLabelText("Direction") as HTMLSelectElement;
  const shown = () => picker().selectedOptions[0].textContent;

  it("opens on All for a fresh pane", () => {
    open({}, [...Object.values(TRENDLINES_SEED)]);
    expect(shown()).toBe("All");
  });

  // The direction owns the slope band and nothing else, so the preset holds.
  // A pane saved before the distance slot ran a legacy near-price cut from
  // extendData; a Direction pick must write it down, not reset it to off.
  it("keeps an old pane's migrated cuts when picking a direction", () => {
    const { cpWrites } = openRecording(
      { declutter: "near" },
      Object.values(TRENDLINES_DEFAULTS).slice(0, 18),
    );
    fireEvent.change(picker(), { target: { value: "1" } });
    expect(cpWrites.at(-1)![19]).toBe(TL_NEAR_PRICE_ATR);
  });

  it("writes the slope band and keeps the preset", () => {
    const { cpWrites } = openRecording({}, [...Object.values(TRENDLINES_SEED)]);
    fireEvent.change(picker(), { target: { value: "1" } });
    const cp = cpWrites.at(-1)!;
    expect([cp[11], cp[12]]).toEqual([0.3, 0.001]);
    expect(shown()).toBe("Rising");
    expect((screen.getByLabelText("Preset") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Balanced");
    fireEvent.change(picker(), { target: { value: "2" } });
    expect(cpWrites.at(-1)!.slice(11, 13)).toEqual([-0.001, -0.3]);
  });
});

describe("core inputs and the Advanced fold", () => {
  it("shows the core few up front and folds the rest", () => {
    open();
    const fold = document.querySelector("details.ind-advanced")!;
    expect(fold).toBeTruthy();
    for (const l of ["Pivot Length", "Max Swings", "Max Pierce", "Back Clearance", "Merge fanned lines within", "Max Projection"])
      expect(fold.contains(screen.getByLabelText(l)), l).toBe(false);
    for (const l of ["Max Trendlines", "Max Pairs", "Min Touches", "Max Crossings"])
      expect(fold.contains(screen.getByLabelText(l)), l).toBe(true);
  });
});

describe("input sections", () => {
  // Sixteen equal-weight fields read as a wall; the headings break the run
  // into the detector's story: pivots -> fit -> filters -> lifetime.
  it("opens a heading over each run of related params", () => {
    open();
    for (const h of ["Pivots", "Major Swings", "Line Fit", "Filters", "Lifetime"])
      expect(screen.getByText(h).className, `${h} heading`).toContain("ind-group");
  });
});

describe("live pivot readouts", () => {
  // Min Length, Max Pairs and Major Length each carry a count read from the
  // last result row: what the filter admits, how many candidate lines the
  // pairing seeded, how many pivots met the major definition. The Majors
  // cap gets none: the tier's size would only repeat the box.
  it("shows pivots, pairs and majors under their boxes", () => {
    const ind = {
      paneId: "candle_pane",
      name: "TRENDLINES",
      calcParams: [...Object.values(TRENDLINES_DEFAULTS)],
      extendData: { indType: "TRENDLINES" },
      figures: [],
      styles: {},
      result: [{}, { pivots: { idxs: [3, 9, 15], kinds: ["high", "low", "high"], highs: [], lows: [], majorQs: [0, 2], majorsSeen: 5, pairs: 7 } }],
    };
    const chart = {
      getIndicators: () => [ind],
      overrideIndicator: () => true,
      getStyles: () => ({ indicator: { lines: [] } }),
      getDataList: () => [],
    } as never;
    render(
      <IndicatorSettings chart={chart} paneId="candle_pane" name="TRENDLINES" onClose={() => {}} scope="s" cellId="c" epic="E" brokerId="b" chartResolution="DAY" />,
    );
    expect(screen.getByText("3 pivots")).toBeTruthy();
    expect(screen.getByText("5 pivots")).toBeTruthy();
    expect(screen.getByText("7 pairs")).toBeTruthy();
  });
});

describe("number boxes", () => {
  // Typed 1000, the box kept saying 1000 while the chart drew 50 (the calc's
  // ceiling) until the modal was reopened. The ceiling is the meta max now,
  // and the slot stores the clamped value.
  it("clamps Max Trendlines to the calc's ceiling as it is typed", () => {
    const { cpWrites } = openRecording();
    const box = screen.getByLabelText("Max Trendlines") as HTMLInputElement;
    expect(box.max).toBe("50");
    fireEvent.change(box, { target: { value: "1000" } });
    expect(cpWrites.at(-1)![5]).toBe(50);
    fireEvent.blur(box);
    expect(box.value).toBe("50");
  });

  // Scrolling the modal with the pointer over a focused number box spun its
  // value (stray Touch Gap and Crossings edits). The box blurs on wheel, so
  // the browser has no focused spinner to turn.
  it("blurs a focused number box on wheel so scrolling cannot change it", () => {
    openRecording();
    const box = screen.getByLabelText("Max Span") as HTMLInputElement;
    box.focus();
    expect(document.activeElement).toBe(box);
    fireEvent.wheel(box, { deltaY: 100 });
    expect(document.activeElement).not.toBe(box);
  });
});

describe("Style tab pivot-mark toggles", () => {
  // THE BUG THIS PINS: the Style tab's checkbox row only matched a PAIR of
  // booleans and rendered chunk[0] otherwise, so growing the pivotMarks group
  // to three (Show pivot depth) dropped both Mark line pivots and the new
  // toggle: the Style tab showed Show pivots solo and the depth numbers had
  // no switch to turn them on.
  function openStyle(extendData: object = {}) {
    const rec = openRecording(extendData);
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    return rec;
  }

  it("shows all three pivot-mark checkboxes", () => {
    openStyle();
    for (const label of ["Show pivots", "Mark line pivots", "Show pivot depth"])
      expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it("ticking Show pivot depth writes the flag to extendData", () => {
    const { writes } = openStyle();
    fireEvent.click(screen.getByLabelText("Show pivot depth") as HTMLInputElement);
    expect(writes.some((w) => w.showPivotDepth === true)).toBe(true);
  });
});
