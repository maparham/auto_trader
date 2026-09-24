// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isOverLegend } from "./usePointerCrosshair";

describe("isOverLegend", () => {
  it("claims a pointer over any legend row, candle pane or sub-pane", () => {
    document.body.innerHTML = `
      <div class="chart-wrap">
        <div id="canvas-host"><canvas></canvas></div>
        <div class="chart-legend"><div class="cl-row cl-ind"><span id="ind">Trendlines(4H)</span></div></div>
        <div class="chart-legend sub-pane-legend"><div class="cl-row cl-ind" id="sub"></div></div>
      </div>`;
    expect(isOverLegend(document.getElementById("ind"))).toBe(true);
    expect(isOverLegend(document.getElementById("sub"))).toBe(true);
  });

  it("leaves the chart itself and non-elements to the hit-tests", () => {
    document.body.innerHTML = `<div class="chart-wrap"><div id="canvas-host"><canvas></canvas></div></div>`;
    expect(isOverLegend(document.querySelector("canvas"))).toBe(false);
    expect(isOverLegend(document.getElementById("canvas-host"))).toBe(false);
    expect(isOverLegend(null)).toBe(false);
    expect(isOverLegend(window)).toBe(false);
  });
});
