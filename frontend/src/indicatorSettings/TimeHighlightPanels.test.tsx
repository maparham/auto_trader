// @vitest-environment jsdom
//
// TIME_HIGHLIGHT Inputs panel: recurring-range rows (anchor range + repeat
// period, edited through the shared RangeCalendarPopover) next to the legacy
// daily HH:MM rows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import { TimeHighlightInputsPanel, makeAddRecurringWindow } from "./TimeHighlightPanels";
import type { RecurringWindowDef, TimeWindowDef } from "../lib/indicators/timeHighlight";

afterEach(cleanup);

const daily: TimeWindowDef = {
  id: "d1",
  color: "#2962ff",
  from: "09:00",
  to: "17:00",
  mode: "band",
  enabled: true,
};

const recurring: RecurringWindowDef = {
  id: "r1",
  color: "#787b86",
  mode: "band",
  enabled: true,
  anchorStartMs: Date.parse("2026-07-06T00:00:00Z"),
  anchorEndMs: Date.parse("2026-07-07T00:00:00Z"),
  period: "day",
  mask: { enabled: true },
};

function renderPanel(windows: TimeWindowDef[], patchWindow = vi.fn(), writeWindows = vi.fn()) {
  render(
    <TimeHighlightInputsPanel
      windows={windows}
      tz="UTC"
      patchWindow={patchWindow}
      writeWindows={writeWindows}
      addWindow={() => {}}
    />,
  );
  return { patchWindow, writeWindows };
}

describe("TimeHighlightInputsPanel recurring rows", () => {
  it("renders a repeat-period select and patches the period", () => {
    const { patchWindow } = renderPanel([recurring]);
    const sel = screen.getByLabelText("Repeat period");
    fireEvent.change(sel, { target: { value: "year" } });
    expect(patchWindow).toHaveBeenCalledWith(0, { period: "year" });
  });

  it("still renders daily rows with time inputs alongside recurring rows", () => {
    renderPanel([daily, recurring]);
    expect(screen.getByLabelText("Window start")).toBeTruthy();
    expect(screen.getByLabelText("Repeat period")).toBeTruthy();
  });

  it("opens the range calendar from the range button", () => {
    renderPanel([recurring]);
    fireEvent.click(screen.getByLabelText("Edit range"));
    expect(document.querySelector(".bt-calendar-pop")).toBeTruthy();
  });

  it("patches whole-day anchor bounds when a span is picked in the calendar", () => {
    const { patchWindow } = renderPanel([recurring]);
    fireEvent.click(screen.getByLabelText("Edit range"));
    // Two clicks outside the current span (anchor is Jul 6) arm + complete.
    fireEvent.click(document.querySelector('[data-date="2026-07-01"]')!);
    fireEvent.click(document.querySelector('[data-date="2026-07-03"]')!);
    expect(patchWindow).toHaveBeenCalledWith(0, {
      anchorStartMs: Date.parse("2026-07-01T00:00:00Z"),
      anchorEndMs: Date.parse("2026-07-04T00:00:00Z"),
    });
  });

  it("routes calendar mask edits onto the window's mask", () => {
    const { patchWindow } = renderPanel([recurring]);
    fireEvent.click(screen.getByLabelText("Edit range"));
    // Toggling the Mon header patches daysOfWeek (all-on minus Monday).
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    expect(patchWindow).toHaveBeenCalledWith(0, {
      mask: { enabled: true, daysOfWeek: [0, 2, 3, 4, 5, 6] },
    });
  });
});

describe("makeAddRecurringWindow", () => {
  it("appends an enabled recurring window with an enabled mask", () => {
    const write = vi.fn();
    makeAddRecurringWindow([daily], write, "UTC")();
    expect(write).toHaveBeenCalledTimes(1);
    const next = write.mock.calls[0][0] as TimeWindowDef[];
    expect(next).toHaveLength(2);
    const added = next[1] as RecurringWindowDef;
    expect(added.period).toBe("day");
    expect(added.enabled).toBe(true);
    expect(added.mask).toEqual({ enabled: true });
    expect(added.anchorEndMs - added.anchorStartMs).toBe(86_400_000);
  });
});
