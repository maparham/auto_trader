// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { LegendRow } from "./ChartLegend";

const { default: ChartLegend } = await import("./ChartLegend");
const { ChartController } = await import("./lib/chartController");

const row = (name: string, indType: string, params: string, visible = true): LegendRow => ({
  name,
  shortName: indType === "TRENDLINES" ? "Trendlines" : indType,
  calcParamsText: params,
  visible,
  hideValue: false,
  figures: [],
  indType,
});

function renderLegend(
  rows: LegendRow[],
  onToggleVisible = vi.fn(),
  getChart: () => import("klinecharts").Chart | null = () => null,
) {
  const noop = () => {};
  render(
    <ChartLegend
      getChart={getChart}
      controller={new ChartController()}
      ctx={{
        symbol: "OIL_CRUDE",
        period: "1H",
        precision: 2,
        live: false,
        stale: false,
        broker: "Capital.com",
      }}
      rows={rows}
      collapsed={false}
      onToggleCollapsed={noop}
      candleHidden={false}
      onToggleCandle={noop}
      subPanes={[]}
      insetLegend={null}
      selectedName={null}
      highlightedName={null}
      onToggleVisible={onToggleVisible}
      onOpenSettings={noop}
      onRemove={noop}
      onSelectRow={noop}
      onOpenDetails={noop}
      onChangeSymbol={noop}
      cacheBadge={null}
      onOpenCacheStats={noop}
      onOpenMenu={noop}
      onMove={noop}
      onStartReorder={noop}
    />,
  );
  return onToggleVisible;
}

const fvgs = [
  row("FVG", "FVG", "(0.25,500,10,1D)"),
  row("FVG2", "FVG", "(0.25,500,10,4H)"),
  row("FVG3", "FVG", "(0.25,500,10)"),
];
const groupHeader = () => document.querySelector(".cl-group-header")!;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("same-type indicators fold into a collapsible group", () => {
  it("groups the instances under one header with a count", () => {
    renderLegend(fvgs);
    expect(within(groupHeader() as HTMLElement).getByText("FVG")).toBeTruthy();
    expect(groupHeader().textContent).toContain("3");
  });

  it("leaves a lone indicator as a plain row, with no group chrome", () => {
    renderLegend([row("EMA", "EMA", "(50)")]);
    expect(document.querySelector(".cl-group")).toBeNull();
    expect(screen.getByText(/EMA/)).toBeTruthy();
  });

  it("hides the member rows when the header is clicked, and brings them back", () => {
    renderLegend(fvgs);
    expect(document.querySelectorAll(".cl-group-rows .cl-ind")).toHaveLength(3);
    fireEvent.click(groupHeader());
    expect(document.querySelectorAll(".cl-group-rows .cl-ind")).toHaveLength(0);
    fireEvent.click(groupHeader());
    expect(document.querySelectorAll(".cl-group-rows .cl-ind")).toHaveLength(3);
  });

  it("keeps a group collapsed across a remount, per symbol", () => {
    renderLegend(fvgs);
    fireEvent.click(groupHeader());
    // A fresh mount reads the persisted state rather than defaulting to expanded.
    cleanup();
    renderLegend(fvgs);
    expect(document.querySelectorAll(".cl-group-rows .cl-ind")).toHaveLength(0);
  });
});

// Expanding a group re-mounts its member rows with fresh, EMPTY value spans, and
// nothing else fills them until the next tick or crosshair move — which on a closed
// market never comes. Only a type with readouts can show this (FVG/Trendlines
// declare no figures), so this pins it on a two-EMA group.
describe("a group's readouts fill the moment it is expanded", () => {
  const emaInd = (name: string, period: number, value: number) => ({
    name,
    paneId: "candle_pane",
    shortName: "EMA",
    calcParams: [period],
    figures: [{ key: "ema", title: "EMA: ", type: "line" }],
    visible: true,
    styles: { lines: [{ color: "#fff" }] },
    extendData: { indType: "EMA" },
    result: [{ ema: value }],
  });
  const chart = () =>
    ({
      getIndicators: () => [emaInd("EMA", 50, 433.36), emaInd("EMA2", 200, 421.5)],
      getDataList: () => [{ open: 430, high: 435, low: 429, close: 433, timestamp: 0, volume: 1 }],
      getStyles: () => ({
        indicator: { lines: [{ color: "#888" }], tooltip: { legend: { color: "#ccc" } } },
      }),
      setStyles: () => {},
    }) as unknown as import("klinecharts").Chart;

  const emas = [row("EMA", "EMA", "(50)"), row("EMA2", "EMA", "(200)")].map((r) => ({
    ...r,
    figures: [{ key: "ema", title: "EMA: ", color: "#fff" }],
  }));

  it("shows the values again after a collapse/expand round trip", () => {
    renderLegend(emas, vi.fn(), () => chart());
    const values = () =>
      [...document.querySelectorAll(".cl-group-rows .cl-fig-val")].map((el) => el.textContent);
    expect(values()).toEqual(["433.36", "421.50"]);
    fireEvent.click(groupHeader());
    fireEvent.click(groupHeader());
    expect(values()).toEqual(["433.36", "421.50"]);
  });
});

describe("the group eye hides and shows every member at once", () => {
  it("hides every visible member on one click", () => {
    const onToggleVisible = renderLegend(fvgs);
    // The chevron is button 0; the eye is button 1.
    fireEvent.click(groupHeader().querySelectorAll("button")[1]);
    expect(onToggleVisible.mock.calls.map((c) => c[0])).toEqual(["FVG", "FVG2", "FVG3"]);
  });

  it("shows every member once they are all hidden", () => {
    const allHidden = fvgs.map((r) => ({ ...r, visible: false }));
    const onToggleVisible = renderLegend(allHidden);
    fireEvent.click(groupHeader().querySelectorAll("button")[1]);
    expect(onToggleVisible.mock.calls.map((c) => c[0])).toEqual(["FVG", "FVG2", "FVG3"]);
  });

  it("hides only the still-visible members when the group is mixed", () => {
    const mixed = [fvgs[0], { ...fvgs[1], visible: false }, fvgs[2]];
    const onToggleVisible = renderLegend(mixed);
    fireEvent.click(groupHeader().querySelectorAll("button")[1]);
    expect(onToggleVisible.mock.calls.map((c) => c[0])).toEqual(["FVG", "FVG3"]);
  });
});
