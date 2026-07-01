// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import VisibilityTab from "./VisibilityTab";
import { defaultVisibility, applyPreset } from "./lib/visibility";

const RES = "MINUTE_15";

// Vitest doesn't run with jest-style `globals: true`, so RTL's automatic
// afterEach cleanup (which detects a global `afterEach`) never registers here.
// Without this, each test's render() leaks into the next test's DOM.
afterEach(cleanup);

describe("VisibilityTab", () => {
  it("toggling a unit off emits a model with that unit disabled", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide={false} currentResolution={RES} />);
    // The Minutes row enable checkbox.
    fireEvent.click(screen.getByLabelText("Minutes"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.units.minutes.on).toBe(false);
  });

  it("editing a unit max emits the clamped value", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide={false} currentResolution={RES} />);
    const maxInput = screen.getByLabelText("Hours max");
    fireEvent.change(maxInput, { target: { value: "12" } });
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.units.hours.max).toBe(12);
  });

  it("hides the auto-hide row when showAutoHide is false", () => {
    render(<VisibilityTab model={defaultVisibility()} onChange={vi.fn()} showAutoHide={false} currentResolution={RES} />);
    expect(screen.queryByLabelText(/auto-hide/i)).toBeNull();
  });

  it("shows + toggles auto-hide when showAutoHide is true", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide currentResolution={RES} />);
    fireEvent.click(screen.getByLabelText(/auto-hide/i));
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.autoHide.on).toBe(true);
  });

  it("the preset dropdown rewrites the grid (this & finer)", () => {
    const onChange = vi.fn();
    render(<VisibilityTab model={defaultVisibility()} onChange={onChange} showAutoHide={false} currentResolution={RES} />);
    fireEvent.change(screen.getByLabelText("Visible on"), { target: { value: "finer" } });
    const next = onChange.mock.calls.at(-1)![0];
    // 15m & finer: minutes capped at 15, hours/days/weeks off.
    expect(next.units.minutes).toEqual({ on: true, min: 1, max: 15 });
    expect(next.units.hours.on).toBe(false);
    expect(next.units.seconds.on).toBe(true);
  });

  it("the dropdown reflects the model's detected preset", () => {
    const m = applyPreset(defaultVisibility(), RES, "coarser");
    render(<VisibilityTab model={m} onChange={vi.fn()} showAutoHide={false} currentResolution={RES} />);
    expect((screen.getByLabelText("Visible on") as HTMLSelectElement).value).toBe("coarser");
  });
});
