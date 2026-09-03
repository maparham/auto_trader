// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import RangeCalendarPopover, { type RangeCalendarProps } from "./RangeCalendarPopover";
import type { RecurrenceMask } from "./lib/backtestConfig";

// See VisibilityTab.test.tsx: vitest isn't run with jest-style globals, so RTL's
// automatic cleanup never registers. Without this each render leaks into the next.
afterEach(cleanup);

// Fixed span: Jan 10 .. Jan 20 2024 inclusive (toMs = exclusive whole-day
// bound, start of Jan 21). tz "UTC" so tz-day boundaries == Date.UTC.
const FROM = Date.UTC(2024, 0, 10);
const TO = Date.UTC(2024, 0, 21);

function renderCal(over: Partial<RangeCalendarProps> = {}) {
  const onSpan = vi.fn();
  const onMaskPatch = vi.fn();
  const onClose = vi.fn();
  const props: RangeCalendarProps = {
    fromMs: FROM,
    toMs: TO,
    mask: undefined,
    tz: "UTC",
    timeStripDisabled: false,
    onSpan,
    onMaskPatch,
    onClose,
    anchor: { top: 0, left: 0 },
    ...over,
  };
  const utils = render(<RangeCalendarPopover {...props} />);
  return { ...utils, onSpan, onMaskPatch, onClose };
}

// Cells carry data-date="YYYY-MM-DD" (the popover is portaled to <body>, so
// query the document rather than the render container).
function cell(ds: string): HTMLElement {
  const el = document.querySelector(`[data-date="${ds}"]`);
  if (!el) throw new Error(`no cell for ${ds}`);
  return el as HTMLElement;
}

describe("RangeCalendarPopover", () => {
  it("renders the month grid of fromMs in tz with Mon…Sun headers", () => {
    renderCal();
    // Displayed month derives from fromMs → January 2024.
    expect(screen.getByText("January 2024")).toBeTruthy();
    for (const wd of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(screen.getByRole("button", { name: wd })).toBeTruthy();
    }
    // One cell per day of the shown month, none from neighbours.
    for (let d = 1; d <= 31; d++) {
      expect(cell(`2024-01-${String(d).padStart(2, "0")}`)).toBeTruthy();
    }
    expect(document.querySelector('[data-date="2024-02-01"]')).toBeNull();
    expect(document.querySelector('[data-date="2023-12-31"]')).toBeNull();
  });

  it("two clicks outside the span select a new whole-day span and enable the mask", () => {
    const { onSpan, onMaskPatch } = renderCal({ mask: undefined });
    fireEvent.click(cell("2024-01-25")); // outside current span → arms
    expect(onSpan).not.toHaveBeenCalled();
    fireEvent.click(cell("2024-01-28")); // completes
    expect(onSpan).toHaveBeenCalledTimes(1);
    expect(onSpan).toHaveBeenCalledWith(Date.UTC(2024, 0, 25), Date.UTC(2024, 0, 29));
    // No mask yet → enable it AND default weekdays to Mon–Fri.
    expect(onMaskPatch).toHaveBeenCalledWith({ enabled: true, daysOfWeek: [1, 2, 3, 4, 5] });
  });

  it("span completion patches {enabled:true} only when daysOfWeek already set, and nothing when already enabled", () => {
    const { onMaskPatch } = renderCal({ mask: { enabled: false, daysOfWeek: [1, 2, 3] } });
    fireEvent.click(cell("2024-01-25"));
    fireEvent.click(cell("2024-01-28"));
    expect(onMaskPatch).toHaveBeenCalledWith({ enabled: true });
    cleanup();
    const second = renderCal({ mask: { enabled: true, daysOfWeek: [1, 2, 3] } });
    fireEvent.click(cell("2024-01-25"));
    fireEvent.click(cell("2024-01-28"));
    expect(second.onSpan).toHaveBeenCalledWith(Date.UTC(2024, 0, 25), Date.UTC(2024, 0, 29));
    expect(second.onMaskPatch).not.toHaveBeenCalled();
  });

  it("reverse click order yields the same span", () => {
    const { onSpan } = renderCal();
    fireEvent.click(cell("2024-01-28"));
    fireEvent.click(cell("2024-01-25"));
    expect(onSpan).toHaveBeenCalledWith(Date.UTC(2024, 0, 25), Date.UTC(2024, 0, 29));
  });

  it("weekday header buttons toggle daysOfWeek", () => {
    const full: RecurrenceMask = { enabled: true, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
    const a = renderCal({ mask: full });
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(a.onMaskPatch).toHaveBeenCalledWith({ daysOfWeek: [0, 1, 2, 3, 4, 5] });
    cleanup();
    const b = renderCal({ mask: { enabled: true, daysOfWeek: [0, 1, 2, 3, 4, 5] } });
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(b.onMaskPatch).toHaveBeenCalledWith({ daysOfWeek: [0, 1, 2, 3, 4, 5, 6] });
  });

  it("a plain click inside the current span toggles that date in excludeDates", () => {
    const a = renderCal({ mask: { enabled: true } });
    fireEvent.click(cell("2024-01-15")); // inside Jan 10..20 → holiday toggle, not span start
    expect(a.onSpan).not.toHaveBeenCalled();
    expect(a.onMaskPatch).toHaveBeenCalledWith({ excludeDates: ["2024-01-15"] });
    cleanup();
    const b = renderCal({ mask: { enabled: true, excludeDates: ["2024-01-15"] } });
    fireEvent.click(cell("2024-01-15")); // already excluded → un-exclude
    expect(b.onMaskPatch).toHaveBeenCalledWith({ excludeDates: [] });
  });

  it("mask-writing gestures enable a disabled/absent mask along with their patch", () => {
    // Exclusion click, with mask undefined.
    const a = renderCal({ mask: undefined });
    fireEvent.click(cell("2024-01-15")); // inside Jan 10..20 span
    expect(a.onMaskPatch).toHaveBeenCalledWith({ enabled: true, excludeDates: ["2024-01-15"] });
    cleanup();
    // Exclusion click, with mask explicitly disabled.
    const b = renderCal({ mask: { enabled: false } });
    fireEvent.click(cell("2024-01-15"));
    expect(b.onMaskPatch).toHaveBeenCalledWith({ enabled: true, excludeDates: ["2024-01-15"] });
    cleanup();
    // Weekday-header click, with mask disabled.
    const c = renderCal({ mask: { enabled: false, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(c.onMaskPatch).toHaveBeenCalledWith({ enabled: true, daysOfWeek: [0, 1, 2, 3, 4, 5] });
    cleanup();
    // Strip drag commit, with mask undefined.
    const d = renderCal({ mask: undefined });
    const strip = screen.getByTestId("bt-timestrip");
    strip.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 480, bottom: 14, width: 480, height: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(strip, { clientX: 120 });
    fireEvent.pointerUp(strip, { clientX: 360 });
    expect(d.onMaskPatch).toHaveBeenCalledWith({ enabled: true, timeOfDay: { startMin: 360, endMin: 1080 } });
  });

  it("excluded dates and off-weekdays inside the span carry class off", () => {
    renderCal({ mask: { enabled: true, daysOfWeek: [1, 2, 3, 4, 5], excludeDates: ["2024-01-15"] } });
    expect(cell("2024-01-15").className).toContain("off"); // excluded, in span
    expect(cell("2024-01-13").className).toContain("off"); // Saturday, in span
    expect(cell("2024-01-16").className).not.toContain("off"); // Tuesday, in span
    expect(cell("2024-01-16").className).toContain("in-span");
    expect(cell("2024-01-27").className).not.toContain("off"); // Saturday, outside span
    expect(cell("2024-01-27").className).not.toContain("in-span");
  });

  it("Weekends button toggles Sat+Sun as a pair", () => {
    const a = renderCal({ mask: { enabled: true, daysOfWeek: [1, 2, 3, 4, 5] } });
    fireEvent.click(screen.getByRole("button", { name: "Weekends" }));
    expect(a.onMaskPatch).toHaveBeenCalledWith({ daysOfWeek: [0, 1, 2, 3, 4, 5, 6] });
    cleanup();
    const b = renderCal({ mask: { enabled: true, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    fireEvent.click(screen.getByRole("button", { name: "Weekends" }));
    expect(b.onMaskPatch).toHaveBeenCalledWith({ daysOfWeek: [1, 2, 3, 4, 5] });
  });

  it("month paging changes the label without calling onSpan", () => {
    const { onSpan } = renderCal();
    expect(screen.getByText("January 2024")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("February 2024")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("December 2023")).toBeTruthy();
    expect(onSpan).not.toHaveBeenCalled();
  });

  it("time-strip drag writes timeOfDay snapped to 30 minutes; disabled strip is inert", () => {
    // jsdom has no layout, so the strip's getBoundingClientRect is stubbed to a
    // fixed 480px-wide rect (mechanism: override the instance method on the
    // element found by data-testid). 480px track ⇒ x=120 is 25% (06:00=360min),
    // x=360 is 75% (18:00=1080min).
    const { onMaskPatch } = renderCal({ mask: { enabled: true } });
    const strip = screen.getByTestId("bt-timestrip");
    strip.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 480, bottom: 14, width: 480, height: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(strip, { clientX: 120 });
    fireEvent.pointerMove(strip, { clientX: 300 });
    fireEvent.pointerUp(strip, { clientX: 360 });
    expect(onMaskPatch).toHaveBeenCalledWith({ timeOfDay: { startMin: 360, endMin: 1080 } });
    cleanup();
    const b = renderCal({ mask: { enabled: true }, timeStripDisabled: true });
    const off = screen.getByTestId("bt-timestrip");
    expect(off.className).toContain("is-off");
    expect(off.hasAttribute("inert")).toBe(true); // out of tab order + a11y tree
    expect(strip.hasAttribute("inert")).toBe(false);
    off.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 480, bottom: 14, width: 480, height: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(off, { clientX: 120 });
    fireEvent.pointerUp(off, { clientX: 360 });
    expect(b.onMaskPatch).not.toHaveBeenCalled();
  });

  it("Escape and outside pointerdown close; inside pointerdown does not", () => {
    const a = renderCal();
    fireEvent.pointerDown(cell("2024-01-15"));
    expect(a.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(a.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const b = renderCal();
    fireEvent.pointerDown(document.body);
    expect(b.onClose).toHaveBeenCalledTimes(1);
  });

  it("consumes Escape: the event does not reach a window-level listener (host modal's useCloseOnEscape)", () => {
    const windowListener = vi.fn();
    window.addEventListener("keydown", windowListener);
    try {
      const { onClose } = renderCal();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(windowListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowListener);
    }
  });
});
