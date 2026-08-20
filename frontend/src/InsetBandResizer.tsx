// The inset band's resize handle: a thin strip along the band's top edge that drags
// the band taller or shorter, the way a pane separator resizes a sub-pane.
//
// The band is not a klinecharts pane (it is a region of the candle pane, painted by
// the inset draw), so nothing in the library resizes it. The height lives as a
// fraction on the chart instance (setInsetBandFraction); a drag rewrites it, asks
// klinecharts to repaint, and persists the result on release.
import { useRef } from "react";
import type { Chart } from "klinecharts";
import {
  INSET_BAND_FRACTION,
  bandFractionFromDrag,
  insetBandFraction,
  setInsetBandFraction,
  type InsetBandBox,
} from "./lib/indicators/inset";

// Grab area, centred on the band's top edge. Wider than the 1px lid it straddles so
// it is catchable without pixel-hunting (the same reason sub-pane grips are 18px).
const GRAB_H = 7;

export default function InsetBandResizer({
  box,
  getChart,
  onRepaint,
  onCommit,
}: {
  box: InsetBandBox;
  getChart: () => Chart | null;
  // Repaint the chart canvas AND the DOM layers over it: the band's height only
  // reaches the screen when klinecharts re-runs the inset draw.
  onRepaint: () => void;
  // Persist the settled height (called on release, not per pointer move).
  onCommit: (fraction: number) => void;
}) {
  const drag = useRef<{ startY: number; startH: number; paneH: number } | null>(
    null,
  );
  const frame = useRef(0);

  const repaint = () => {
    if (frame.current) return; // one repaint per animation frame, not per move event
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      // resize() makes klinecharts re-measure and re-render every pane; onRepaint
      // then re-reads the geometry for the card and this handle.
      getChart()?.resize();
      onRepaint();
    });
  };

  // No <Tooltip>: it anchors its bubble to a zero-size inline <span> wrapper, which
  // an absolutely-positioned strip like this one leaves behind at the container's
  // origin. The ns-resize cursor plus the hover tint carry the affordance, the same
  // way a pane separator does.
  return (
    <div
      className="inset-band-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the inset band"
      style={{
        top: box.top - Math.floor(GRAB_H / 2),
        left: box.left,
        width: box.width,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // primary button only
        const chart = getChart();
        const paneH = chart?.getSize("candle_pane", "main")?.height ?? 0;
        if (!paneH) return;
        drag.current = { startY: e.clientY, startH: box.height, paneH };
        // Capture so the drag survives the pointer leaving the 7px strip, and stop
        // the event before the chart's own crosshair/drawing handlers see it.
        e.currentTarget.setPointerCapture(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        e.stopPropagation();
        setInsetBandFraction(
          getChart(),
          bandFractionFromDrag(d.paneH, d.startH, e.clientY - d.startY),
        );
        repaint();
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        e.stopPropagation();
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit(insetBandFraction(getChart()));
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setInsetBandFraction(getChart(), INSET_BAND_FRACTION);
        repaint();
        onCommit(INSET_BAND_FRACTION);
      }}
    />
  );
}
