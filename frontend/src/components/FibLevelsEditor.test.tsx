// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FibLevelsEditor from "./FibLevelsEditor";
import { defaultFibConfig } from "../lib/fibConfig";

afterEach(cleanup);

function setup() {
  const onChange = vi.fn();
  render(
    <FibLevelsEditor fib={defaultFibConfig()} onChange={onChange} sharedSize={1} sharedStyle="solid" trendLabel="Width line" />,
  );
  return onChange;
}

describe("FibLevelsEditor", () => {
  it("toggles one level without touching the others", () => {
    const onChange = setup();
    fireEvent.click(screen.getByLabelText("Level 0.236"));
    const next = onChange.mock.calls[0][0];
    expect(next.levels[1].enabled).toBe(false);
    expect(next.levels[0].enabled).toBe(true);
  });

  it("flips reverse and shows the caller's trend label", () => {
    const onChange = setup();
    expect(screen.getByText("Width line")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Reverse"));
    expect(onChange.mock.calls[0][0].reverse).toBe(true);
  });

  it("changes the extend mode", () => {
    const onChange = setup();
    fireEvent.change(screen.getByLabelText("Extend"), { target: { value: "right" } });
    expect(onChange.mock.calls[0][0].extend).toBe("right");
  });

  it("never commits a cleared or half-typed ratio", () => {
    const onChange = setup();
    const box = screen.getByLabelText("Level 2 ratio") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.change(box, { target: { value: "-" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "0.3" } });
    expect(onChange.mock.calls[0][0].levels[1].value).toBe(0.3);
  });

  it("sets line style on every level and leaves their colours mixed", () => {
    const onChange = vi.fn();
    const fib = defaultFibConfig();
    fib.levels[2] = { ...fib.levels[2], size: 3, style: "solid" };
    render(
      <FibLevelsEditor fib={fib} onChange={onChange} sharedSize={1} sharedStyle="solid" trendLabel="Trend line" allLevelsStyle />,
    );
    // All levels row: [colour picker, line style picker], ahead of the levels.
    fireEvent.click(document.querySelectorAll(".clsp-swatch")[1]);
    const presets = document.querySelectorAll(".clsp-preset");
    fireEvent.click(presets[1]); // 2px
    fireEvent.click(presets[5]); // dashed
    const sized = onChange.mock.calls[0][0].levels;
    expect(sized.every((l: { size?: number }) => l.size === 2)).toBe(true);
    expect(sized.map((l: { color: string }) => l.color)).toEqual(fib.levels.map((l) => l.color));
    expect(onChange.mock.calls[1][0].levels.every((l: { style?: string }) => l.style === "dashed")).toBe(true);
  });

  it("sets colour on every level and leaves their line styles alone", () => {
    const onChange = vi.fn();
    const fib = defaultFibConfig();
    fib.levels[2] = { ...fib.levels[2], size: 3, style: "dashed" };
    render(
      <FibLevelsEditor fib={fib} onChange={onChange} sharedSize={1} sharedStyle="solid" trendLabel="Trend line" allLevelsStyle />,
    );
    fireEvent.click(document.querySelectorAll(".clsp-swatch")[0]);
    expect(document.querySelectorAll(".clsp-preset").length).toBe(0);
    fireEvent.click(document.querySelectorAll(".clsp-cell")[1]); // #d1d4dc
    const next = onChange.mock.calls[0][0].levels;
    expect(next.every((l: { color: string }) => l.color === "#d1d4dc")).toBe(true);
    expect(next[2]).toMatchObject({ size: 3, style: "dashed" });
    expect(next[0].size).toBeUndefined();
  });

  it("hides the All levels row unless asked", () => {
    setup();
    expect(screen.queryByText("All levels")).toBeNull();
  });
});
