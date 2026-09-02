// @vitest-environment jsdom
//
// The Envelope option is chart-timeframe-only: computeMa's MTF branch carries
// the base + smoothing lines but never the bands (see ma.ts). The checkbox
// must say so — a live-looking toggle that silently does nothing under a
// pinned timeframe reads as a rendering bug (exactly how the pre-MTF
// smoothing gap was reported).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MaInputsPanel } from "./MaAvwapPanels";

afterEach(cleanup);

function renderPanel(timeframe: string) {
  render(
    <MaInputsPanel
      maLength={50}
      setMaLength={() => {}}
      source="close"
      setSource={() => {}}
      offset={0}
      setOffset={() => {}}
      smoothType="sma"
      setSmoothType={() => {}}
      smoothLen={50}
      setSmoothLen={() => {}}
      timeframe={timeframe}
      setTimeframe={() => {}}
      timeframeOptions={[
        { resolution: "chart", label: "Chart" },
        { resolution: "HOUR_4", label: "4H" },
      ]}
      maType="ema"
      setMaType={() => {}}
      envelope={false}
      setEnvelope={() => {}}
      applyMa={() => {}}
    />,
  );
}

const envelopeBox = () =>
  [...document.querySelectorAll<HTMLInputElement>(".ind-check input")].find((el) =>
    el.parentElement?.textContent?.includes("Envelope"),
  );

describe("MaInputsPanel envelope under MTF", () => {
  it("keeps the checkbox live on the chart timeframe", () => {
    renderPanel("chart");
    expect(envelopeBox()!.disabled).toBe(false);
  });
  it("disables the checkbox when a higher timeframe is pinned", () => {
    renderPanel("HOUR_4");
    expect(envelopeBox()!.disabled).toBe(true);
  });
});
