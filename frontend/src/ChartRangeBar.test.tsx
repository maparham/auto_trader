// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChartRangeBar from "./ChartRangeBar";

afterEach(cleanup);

function renderBar(onGoToDate = vi.fn()) {
  render(
    <ChartRangeBar activeKey={null} onPick={() => {}} onGoToDate={onGoToDate} />,
  );
  return onGoToDate;
}

const openPicker = () => fireEvent.click(screen.getByLabelText("Open date picker"));
const dateInput = () => screen.getByLabelText("Go to date") as HTMLInputElement;

describe("ChartRangeBar go-to-date", () => {
  it("takes a full datetime value and hands it up on Go", () => {
    const onGoToDate = renderBar();
    openPicker();
    const input = dateInput();
    // datetime-local, not date: a 5m chart wants an intraday landing, and a
    // date-only value still works (the picker fills midnight).
    expect(input.type).toBe("datetime-local");
    fireEvent.change(input, { target: { value: "2024-03-07T14:30" } });
    fireEvent.submit(input.closest("form")!);
    expect(onGoToDate).toHaveBeenCalledWith("2024-03-07T14:30");
  });

  it("keeps the entered value between Go runs", () => {
    renderBar();
    openPicker();
    fireEvent.change(dateInput(), { target: { value: "2024-03-07T14:30" } });
    fireEvent.submit(dateInput().closest("form")!);
    // Submit closes the popover; reopening must show the last value, so a
    // second jump near the first is an edit, not a re-type. (Session-only:
    // component state, nothing persisted.)
    openPicker();
    expect(dateInput().value).toBe("2024-03-07T14:30");
  });

  it("keeps the value when the popover is dismissed without submitting", () => {
    renderBar();
    openPicker();
    fireEvent.change(dateInput(), { target: { value: "2024-03-07T14:30" } });
    fireEvent.keyDown(document, { key: "Escape" });
    openPicker();
    expect(dateInput().value).toBe("2024-03-07T14:30");
  });
});
