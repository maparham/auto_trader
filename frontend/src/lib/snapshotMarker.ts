// The snapshot-moment marker: a dashed vertical line at the taken-at timestamp
// (candle pane) + a grey chip on the time axis carrying the snapshot's name.
// Modeled on backtest.ts's periodOverlay (registration idiom, createPointFigures
// + createXAxisFigures, lock: true for a read-only artifact) — see
// lib/backtest.ts:757-796. Unlike periodOverlay this one DOES want a click
// target: the axis chip is the dismiss control, so only the pane line figure
// is ignoreEvent.
import { registerOverlay, type Chart, type OverlayTemplate } from "klinecharts";
import type { SnapshotMeta } from "./persist";

const MARKER_OVERLAY = "snapshotMarker";
const MARKER_COLOR = "#787b86"; // same neutral grey family as backtest period shading

let registered = false;
export function ensureSnapshotMarkerRegistered(): void {
  if (registered) return;
  registered = true;
  const tpl: OverlayTemplate = {
    name: MARKER_OVERLAY,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding }) => [
      {
        type: "line",
        attrs: {
          coordinates: [
            { x: coordinates[0].x, y: 0 },
            { x: coordinates[0].x, y: bounding.height },
          ],
        },
        styles: {
          style: 'dashed',
          color: MARKER_COLOR,
          size: 1,
          dashedValue: [4, 4],
        },
        ignoreEvent: true, // the pane line never swallows chart interactions
      },
    ],
    createXAxisFigures: ({ coordinates, bounding, overlay }) => [
      {
        type: "text",
        attrs: {
          x: coordinates[0].x,
          y: bounding.height / 2,
          text: `⌖ ${String(overlay.extendData ?? "Snapshot")}`,
          align: "center",
          baseline: "middle",
        },
        styles: {
          color: "#ffffff",
          backgroundColor: MARKER_COLOR,
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 2,
          paddingBottom: 2,
          borderRadius: 2,
        },
        // NOT ignoreEvent — the chip is the dismiss target
      },
    ],
  };
  registerOverlay(tpl);
}

/** Draw the taken-at marker. Click on the time-axis chip → onDismiss. */
export function renderSnapshotMarker(
  chart: Chart,
  meta: SnapshotMeta,
  onDismiss: () => void,
): string | null {
  ensureSnapshotMarkerRegistered();
  const data = chart.getDataList() ?? [];
  if (data.length === 0) return null;
  const id = chart.createOverlay({
    name: MARKER_OVERLAY,
    lock: true,
    extendData: meta.name,
    points: [{ timestamp: meta.takenAt, value: data[0].close }], // value unused by figures
    onClick: () => {
      onDismiss();
      return false;
    },
    // v10 deletes an overlay on right-click unless the handler calls
    // e.preventDefault() — keep the chip; dismissing is the onClick's job.
    onRightClick: (e) => {
      e.preventDefault?.();
      return false;
    },
  });
  return typeof id === "string" ? id : null;
}
