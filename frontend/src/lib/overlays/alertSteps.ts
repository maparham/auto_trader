// A line alert's dashed line under a COARSER pin, drawn as the trendline's
// own steps (indicators/trendlineSteps): one horizontal per HTF bar across
// that bar's candles, with a riser at the next bar, so the alert line lies on
// the stepped stroke and shows the level the alert fires at. Points are each
// step's first candle (and the newest candle last); the figure runs each
// step from its first candle's left edge to the next step's, and the last
// point to its candle's right edge. Styled by the overlay's own line style
// (alertLineStyles). Never throws: a throw in a klinecharts draw callback
// kills later layouts.
//
// alertRamp is the same points under the Ramp style (the default): a line
// through each point's left candle edge, so it lies on the ramped stroke,
// then flat over the last candle (the newest HTF bar is flat there too).
import type { OverlayFigure, OverlayTemplate } from "klinecharts";
import { registerOverlay } from "klinecharts";

export const alertStepsTemplate: OverlayTemplate = {
  name: "alertSteps",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, coordinates }) => {
    try {
      if (!coordinates?.length) return [];
      const h = chart.getBarSpace?.().halfBar ?? 0;
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < coordinates.length; i++) {
        const { x, y } = coordinates[i];
        const xEnd = i + 1 < coordinates.length ? coordinates[i + 1].x - h : x + h;
        pts.push({ x: x - h, y }, { x: xEnd, y });
      }
      const fig: OverlayFigure = { type: "line", attrs: { coordinates: pts }, ignoreEvent: true };
      return [fig];
    } catch {
      return [];
    }
  },
};
export const alertRampTemplate: OverlayTemplate = {
  name: "alertRamp",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, coordinates }) => {
    try {
      if (!coordinates?.length) return [];
      const h = chart.getBarSpace?.().halfBar ?? 0;
      const pts = coordinates.map(({ x, y }) => ({ x: x - h, y }));
      const last = coordinates[coordinates.length - 1];
      pts.push({ x: last.x + h, y: last.y });
      const fig: OverlayFigure = { type: "line", attrs: { coordinates: pts }, ignoreEvent: true };
      return [fig];
    } catch {
      return [];
    }
  },
};

// Module-scope, like the picked-line clones: every boot mode that imports the
// alert lines can draw them.
registerOverlay(alertStepsTemplate);
registerOverlay(alertRampTemplate);
