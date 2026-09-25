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
});
