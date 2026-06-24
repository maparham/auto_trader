// klinecharts core ships only a light style; we build dark/light style overrides
// from our app palette. Container background comes from CSS (--bg); these set the
// line/text/candle colors klinecharts draws on the canvas.

import {
  LineType,
  TooltipShowRule,
  type DeepPartial,
  type Styles,
} from "klinecharts";
import { chartColors, type CrosshairStyle, type Theme } from "../theme";
import { hexToRgba } from "./lineStyle";

// Crosshair dash patterns ([on, off] px). Looser than the indicator-line patterns
// in lineStyle.ts so the guide lines read less dense (TradingView-style).
const CROSSHAIR_DASH: Record<CrosshairStyle["lineStyle"], [number, number] | undefined> = {
  solid: undefined,
  dashed: [4, 6],
  dotted: [1, 4],
};

const UP = "#26a69a";
const DOWN = "#ef5350";

// Axis label font (price + time). The system stack (SF on Apple) mirrors
// TradingView's and renders thinner/cleaner than klinecharts' default Helvetica
// Neue at 12px. Kept in sync with `.axis-plus-price` in App.css (the "+" pill).
const AXIS_FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

// Far-left x of every legend row (symbol/OHLC and the indicator rows below it),
// so they all line up. On the candle pane klinecharts forces the indicator rows
// to reuse the candle tooltip's offsetLeft, so keeping this single constant for
// both candle and indicator tooltips is what makes them align.
const LEGEND_OFFSET_LEFT = 8;

// `legendHovered` is the owning cell's legend-hover state (was a module signal;
// now per-cell so two cells don't share a crosshair-hide). ChartCore passes
// controller.legendHovered.value and re-applies styles on each hover transition.
export function klineStyles(
  theme: Theme,
  legendHovered = false,
  crosshair?: CrosshairStyle,
): DeepPartial<Styles> {
  const c = chartColors[theme];
  // Crosshair line: solid vs dashed/dotted, color (empty = follow theme textDim),
  // opacity folded into the color (klinecharts lines have no opacity field).
  const xhDash = CROSSHAIR_DASH[crosshair?.lineStyle ?? "dashed"];
  const xhColor = hexToRgba(crosshair?.color || c.textDim, crosshair?.opacity ?? 1);
  const xhLine = {
    color: xhColor,
    style: xhDash ? LineType.Dashed : LineType.Solid,
    dashedValue: xhDash ?? [4, 6],
  };
  const axis = {
    axisLine: { color: c.border },
    tickLine: { color: c.border },
    // Muted grey + the system font stack (SF on Apple, like TV's stack) at 12px:
    // thin and crisp rather than the heavier near-white default Helvetica Neue.
    tickText: { color: c.axisText, size: 12, weight: "normal", family: AXIS_FONT },
  };
  return {
    grid: {
      horizontal: { color: c.grid },
      vertical: { color: c.grid },
    },
    candle: {
      bar: {
        upColor: UP,
        downColor: DOWN,
        noChangeColor: c.text,
        upBorderColor: UP,
        downBorderColor: DOWN,
        noChangeBorderColor: c.text,
        upWickColor: UP,
        downWickColor: DOWN,
        noChangeWickColor: c.text,
      },
      // The candle-pane legend (symbol/OHLC row + candle-pane indicator rows) is
      // now rendered as crisp DOM by <ChartLegend> (TradingView layers DOM text
      // over its canvas; klinecharts' canvas text was blurry). showRule None turns
      // off klinecharts' own candle-pane legend entirely. indicator.tooltip below
      // stays on, so sub-pane indicators (RSI/MACD) keep their in-pane legends.
      tooltip: { showRule: TooltipShowRule.None },
      priceMark: {
        high: { color: c.text },
        low: { color: c.text },
        // Dotted last-price line (klinecharts has no Dotted, so it's a tight dash
        // pattern). Hide the built-in axis text box — ChartCore renders its own
        // TV-style price + countdown pill instead.
        last: {
          line: { style: LineType.Dashed, dashedValue: [2, 2], size: 2 },
          text: { show: false },
        },
      },
    },
    indicator: {
      tooltip: {
        // Same far-left x as the candle legend so indicator rows line up under the
        // symbol (this value is what separate indicator panes use; on the candle
        // pane klinecharts reuses the candle tooltip's offsetLeft regardless).
        offsetLeft: LEGEND_OFFSET_LEFT,
        text: { color: c.text },
        // Icons are driven per-indicator by legendTooltipSource (hover-gated, with
        // the hidden-indicator eye exception), so the global set stays empty.
        icons: [],
      },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: c.border },
    crosshair: {
      // Hide the crosshair while the cursor is over the top-left legend strip
      // (TradingView-style — the legend area isn't a price/time the crosshair
      // should track). The owning cell toggles its legendHovered and re-applies
      // these styles on each transition, so this stays in sync.
      show: !legendHovered,
      horizontal: {
        line: xhLine,
        text: { backgroundColor: c.text, color: c.border },
      },
      vertical: {
        line: xhLine,
        text: { backgroundColor: c.text, color: c.border },
      },
    },
  };
}
