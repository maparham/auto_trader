// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import SlopeColorPanel, { slopeColorConfig } from "./SlopeColorPanel";
import { defaultSlopeColor, type SlopeColorConfig } from "../lib/indicators/slopeColor";

afterEach(cleanup);

function renderPanel(sc: SlopeColorConfig, patch = vi.fn()) {
  render(<SlopeColorPanel sc={sc} patch={patch} />);
  return { patch };
}

describe("SlopeColorPanel", () => {
  it("renders the Enable checkbox, Lookback input, flat-band input, and three picker rows", () => {
    renderPanel(defaultSlopeColor());
    expect(document.querySelector(".ind-check input")).toBeTruthy();
    // Lookback IntInput + flat-band number input: two number inputs total.
    const numberInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    expect(numberInputs.length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain("%/bar");
    expect(document.body.textContent).toContain("Rising");
    expect(document.body.textContent).toContain("Falling");
    expect(document.body.textContent).toContain("Flat");
  });

  it("toggling Enable calls patch({ enabled: true })", () => {
    const { patch } = renderPanel(defaultSlopeColor());
    const checkbox = document.querySelector<HTMLInputElement>(".ind-check input")!;
    fireEvent.click(checkbox);
    expect(patch).toHaveBeenCalledWith({ enabled: true });
  });

  it("committing Lookback calls patch({ len: n }) and enforces min 1", () => {
    const { patch } = renderPanel({ ...defaultSlopeColor(), enabled: true });
    const numberInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    const lookback = numberInputs[0];
    expect(lookback.min).toBe("1");
    fireEvent.change(lookback, { target: { value: "5" } });
    expect(patch).toHaveBeenCalledWith({ len: 5 });
  });

  it("changing the Rising color calls patch({ up: { ...sc.up, color } })", () => {
    const sc = { ...defaultSlopeColor(), enabled: true };
    const { patch } = renderPanel(sc);
    // ColorLineStylePicker renders a swatch trigger button (.clsp-swatch); click it
    // to open the portaled popover, then click a palette swatch (.clsp-cell).
    const risingRow = [...document.querySelectorAll(".ind-row")].find((el) =>
      el.textContent?.includes("Rising"),
    )!;
    const trigger = risingRow.querySelector<HTMLButtonElement>(".clsp-swatch")!;
    fireEvent.click(trigger);
    const swatch = document.querySelector<HTMLButtonElement>(".clsp-cell")!;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    const call = patch.mock.calls.find((c) => "up" in c[0]);
    expect(call).toBeTruthy();
    expect(call![0].up.color).toBeDefined();
  });
});

describe("slopeColorConfig writer", () => {
  it("leaves extendData.slopeColor absent for null", () => {
    const ext: Record<string, unknown> = {};
    slopeColorConfig(ext, null);
    expect(ext.slopeColor).toBeUndefined();
  });

  it("leaves extendData.slopeColor absent for the exact defaults", () => {
    const ext: Record<string, unknown> = {};
    slopeColorConfig(ext, defaultSlopeColor());
    expect(ext.slopeColor).toBeUndefined();
  });

  it("deletes a pre-existing slopeColor key when passed null", () => {
    const ext: Record<string, unknown> = { slopeColor: { enabled: true } };
    slopeColorConfig(ext, null);
    expect(ext.slopeColor).toBeUndefined();
  });

  it("deletes a pre-existing slopeColor key when passed the defaults", () => {
    const ext: Record<string, unknown> = { slopeColor: { enabled: true } };
    slopeColorConfig(ext, defaultSlopeColor());
    expect(ext.slopeColor).toBeUndefined();
  });

  it("writes an enabled config verbatim", () => {
    const ext: Record<string, unknown> = {};
    const sc = { ...defaultSlopeColor(), enabled: true };
    slopeColorConfig(ext, sc);
    expect(ext.slopeColor).toEqual(sc);
  });

  it("writes a disabled-but-customized config verbatim", () => {
    const ext: Record<string, unknown> = {};
    const sc = { ...defaultSlopeColor(), len: 5 };
    slopeColorConfig(ext, sc);
    expect(ext.slopeColor).toEqual(sc);
  });
});
