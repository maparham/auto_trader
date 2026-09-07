// The Trade box drawing tool: a planned trade sketched on the chart as a
// green reward zone and a red risk zone either side of the entry, labelled with
// R:R and whatever else the drawing's settings ask for.
//
// Three points carry the geometry — klinecharts only projects an overlay's OWN
// points to pixels, so every level the drawing needs rides one:
//   0 entry  (t0, entryPrice)
//   1 target (t1, targetPrice)   ← t1 is the drawing's right edge…
//   2 stop   (t1, stopPrice)     ← …shared by both, kept in step by
//                                   syncTradePoints on every drag.
// The stop is synthesized on draw-end (two clicks place entry and target only);
// see OverlayManager's trade-drawing handling.
//
// ONE tool draws both directions: which side the reward falls on comes entirely
// from the points, so dragging the target above the entry gives a long and below
// gives a short, and dragging it across afterwards converts the trade in place.
// There is nothing a separate "short" tool could have set that the drag doesn't.
// Reward is always green and risk always red — the convention tradeZones and
// PositionLines already use.

import type { OverlayTemplate, OverlayFigure } from "klinecharts";
import { UP, DOWN } from "./chartTheme";
import { getAccountSnapshot } from "./accountSnapshot";
import { asTradeConfig, defaultStopPrice, tradePlan } from "./tradePlan";
import { hexToRgba } from "./lineStyle";
import { DRAW_CLIP_PAD } from "./indicators/shared";

export const TRADE_BOX = "tradeBox";

const ENTRY_COLOR = "#2962ff";
const ZONE_ALPHA = 0.15; // the same wash the backtest trade zones use
const PILL_FAMILY = "-apple-system, system-ui, sans-serif";
// Below this width the level pills are wider than the drawing itself and stack
// into an unreadable smear; the zones alone still show the trade.
const MIN_LABEL_W = 40;
const LINE_H = 14;

// A small filled pill, matching PositionLines' bracket labels and the backtest
// trade zone's edge tags — three places drawing the same idea, one look.
function pill(
  x: number,
  y: number,
  text: string,
  bg: string,
  align: "left" | "center" | "right",
): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline: "middle" },
    styles: {
      color: "#ffffff",
      backgroundColor: bg,
      size: 11,
      family: PILL_FAMILY,
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 2,
      paddingBottom: 2,
      borderRadius: 3,
    },
    ignoreEvent: true,
  };
}

export const tradeBox: OverlayTemplate = {
  name: TRADE_BOX,
  // Two clicks: entry, then target. The stop is added afterwards.
  totalStep: 3,
  needDefaultPointFigure: true, // drag grips on all three levels + the edge
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates, bounding, chart }) => {
    if (coordinates.length < 2) return [];
    const points = overlay.points ?? [];
    const entry = points[0]?.value ?? 0;
    const target = points[1]?.value ?? entry;
    const [cEntry, cTarget] = coordinates;
    // Mid-draw there is no stop point yet (it is synthesized on draw-end), so
    // the preview mirrors where it will land — half the reward on the other
    // side of the entry, taken in PIXELS because that is all we have here.
    const drawing = coordinates.length < 3;
    const cStop = drawing
      ? { x: cTarget.x, y: cEntry.y + (cEntry.y - cTarget.y) / 2 }
      : coordinates[2];
    const stop = drawing ? defaultStopPrice(entry, target) : (points[2]?.value ?? entry);
    const cfg = asTradeConfig((overlay.extendData as { trade?: unknown })?.trade);
    const m = tradePlan({
      entry,
      target,
      stop,
      precision: chart.getSymbol()?.pricePrecision ?? 2,
      // Counted off the LOADED bars, not the points' dataIndex: a rehydrated
      // drawing's points carry only {timestamp, value}, so a dataIndex diff
      // read "0 bars" for every trade that survived a reload. Same count the
      // Time Range tool reports, and it is robust to session gaps.
      bars: barsBetween(chart, points[0]?.timestamp, points[1]?.timestamp),
      ms: Math.abs((points[1]?.timestamp ?? 0) - (points[0]?.timestamp ?? 0)),
      account: getAccountSnapshot(),
      config: cfg,
    });

    const left = Math.min(cEntry.x, cTarget.x);
    const right = Math.max(cEntry.x, cTarget.x);
    const width = right - left;
    const figures: OverlayFigure[] = [];

    // Each side of the trade is one leg: a zone from the entry to its level, a
    // dashed line marking that level, and its label. A leg whose level sits ON
    // the entry is dropped whole — there is no zone to draw and no distance to
    // report, and leaving the line and a "0.00%" pill behind would claim a level
    // the trade does not have.
    const legs = [
      { y: cTarget.y, color: UP, lines: m.targetLines, collapsed: target === entry },
      { y: cStop.y, color: DOWN, lines: m.stopLines, collapsed: stop === entry },
    ].filter((leg) => !leg.collapsed);

    // Zones, biggest first. Normally the two only meet at the entry and order is
    // irrelevant, but a target dragged ACROSS the entry puts both legs on one
    // side, where they overlap — painted smallest-first the larger one buries the
    // other completely. Biggest-first makes them nest instead, so a trade in that
    // state still reads. Hit-testable (no ignoreEvent): clicking the body selects
    // and drags the drawing as a whole.
    const bySize = [...legs].sort(
      (a, b) => Math.abs(cEntry.y - b.y) - Math.abs(cEntry.y - a.y),
    );
    for (const leg of bySize) {
      figures.push({
        type: "rect",
        attrs: {
          x: left,
          y: Math.min(cEntry.y, leg.y),
          width,
          height: Math.abs(cEntry.y - leg.y),
        },
        // hexToRgba, not a hex-suffix concat: the alpha then survives a theme
        // colour that isn't #RRGGBB (#RGB, rgb(), an already-alpha'd rgba()).
        styles: { style: "fill", color: hexToRgba(leg.color, ZONE_ALPHA) },
      });
    }

    // Level lines, then the entry accent on top of them. Clamped near the
    // pane: these are UNCONDITIONALLY dashed, klinecharts neither culls
    // overlays nor clips its line figure, and a saved trade panned far away
    // would otherwise stroke a dashed line of arbitrary length every frame.
    const lineL = Math.max(left, -DRAW_CLIP_PAD);
    const lineR = Math.min(right, bounding.width + DRAW_CLIP_PAD);
    if (lineR > lineL) {
      for (const leg of legs) {
        figures.push({
          type: "line",
          attrs: { coordinates: [{ x: lineL, y: leg.y }, { x: lineR, y: leg.y }] },
          styles: { style: "dashed", dashedValue: [4, 4], color: leg.color, size: 1 },
          ignoreEvent: true,
        });
      }
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: lineL, y: cEntry.y }, { x: lineR, y: cEntry.y }] },
        styles: { style: "solid", color: ENTRY_COLOR, size: 1.5 },
        ignoreEvent: true,
      });
    }

    if (width < MIN_LABEL_W) return figures;

    // Level pills sit just outside the right edge, flipping inside when that
    // would spill off the pane (same move the backtest zone's edge tags make).
    const flip = right > bounding.width - 90;
    const labelX = flip ? right - 4 : right + 4;
    const align: "left" | "right" = flip ? "right" : "left";
    // R:R rides the entry line, clamped inside the pane top for a trade drawn
    // against the very top of the visible range.
    figures.push(
      pill((left + right) / 2, Math.max(cEntry.y - LINE_H, 10), m.rrLabel, ENTRY_COLOR, "center"),
    );
    for (const leg of legs) {
      // Multi-line labels grow away from their level so the first line stays
      // pinned to the price it belongs to — upwards instead when growing down
      // would push a line off the pane bottom.
      const down = leg.y + (leg.lines.length - 1) * LINE_H <= bounding.height - LINE_H / 2;
      leg.lines.forEach((text, i) =>
        figures.push(pill(labelX, leg.y + (down ? i : -i) * LINE_H, text, leg.color, align)),
      );
    }
    // The drawing's own caption (DrawingExtra.text) — set from the settings
    // modal's Text tab, or by the agent bridge's `drawing.add`. Above the top of
    // the box, left-aligned, so it clears the centred R:R pill.
    // Read inline rather than through overlays.ts's asDrawingExtra: that module
    // imports THIS one (for TRADE_BOX), and the cycle is not worth one narrowing.
    const caption = (overlay.extendData as { text?: unknown })?.text;
    if (typeof caption === "string" && caption.trim()) {
      const top = Math.min(cEntry.y, ...legs.map((l) => l.y));
      figures.push(pill(left, Math.max(top - LINE_H, 10), caption.trim(), ENTRY_COLOR, "left"));
    }
    if (m.widthLine) {
      figures.push(pill((left + right) / 2, Math.max(cTarget.y, cStop.y) + LINE_H, m.widthLine, ENTRY_COLOR, "center"));
    }
    return figures;
  },
};

// Loaded candles whose open falls in [from, to) — the drawing's width in bars at
// the CURRENT timeframe. 0 when either anchor is missing.
function barsBetween(
  chart: { getDataList: () => Array<{ timestamp: number }> },
  from?: number,
  to?: number,
): number {
  if (from == null || to == null) return 0;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return chart.getDataList().filter((k) => k.timestamp >= lo && k.timestamp < hi).length;
}


