// @vitest-environment jsdom
// The legend's "Add alert" bell: hidden when alertCheck says the indicator is
// not alertable, inert (with its reason) when it says why not, live otherwise.
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { LegendRow } from "./ChartLegend";

const { default: ChartLegend } = await import("./ChartLegend");
const { ChartController } = await import("./lib/chartController");

const row = (name: string): LegendRow => ({
  name, shortName: name, calcParamsText: "(14)", visible: true, hideValue: false, figures: [], indType: name,
});

function renderLegend(alertCheck: (name: string) => { reason: string | null } | null) {
  const noop = () => {};
  const onAddAlert = vi.fn();
  render(
    <ChartLegend
      getChart={() => null}
      controller={new ChartController("cell-1", "scope-1")}
      ctx={{ symbol: "US100", period: "1H", precision: 2, live: false, stale: false, broker: "Capital.com" }}
      rows={[row("RSI")]}
      collapsed={false}
      onToggleCollapsed={noop}
      candleHidden={false}
      onToggleCandle={noop}
      subPanes={[]}
      insetLegend={null}
      selectedName={null}
      highlightedName={null}
      onToggleVisible={noop}
      onOpenSettings={noop}
      onRemove={noop}
      onCopyGroup={noop}
      onSelectRow={noop}
      onOpenDetails={noop}
      onChangeSymbol={noop}
      cacheBadge={null}
      onOpenCacheStats={noop}
      onOpenMenu={noop}
      onAddAlert={onAddAlert}
      alertCheck={alertCheck}
      onMove={noop}
      onStartReorder={noop}
    />,
  );
  return onAddAlert;
}

afterEach(cleanup);

describe("legend alert bell", () => {
  it("is absent when the indicator is not alertable", () => {
    renderLegend(() => null);
    expect(screen.queryByLabelText("Add alert")).toBeNull();
  });

  it("opens the alert for an alertable indicator", () => {
    const onAddAlert = renderLegend(() => ({ reason: null }));
    const bell = screen.getByLabelText("Add alert");
    expect(bell.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(bell);
    expect(onAddAlert).toHaveBeenCalledWith("RSI");
  });

  it("is inert with a reason when the config cannot take an alert", () => {
    const onAddAlert = renderLegend(() => ({ reason: "Alerts need the line offset at 0" }));
    const bell = screen.getByLabelText("Add alert");
    expect(bell.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(bell);
    expect(onAddAlert).not.toHaveBeenCalled();
  });
});
