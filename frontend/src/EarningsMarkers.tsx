// Earnings markers: a small "E" chip on the candle pane's bottom edge at the bar
// holding each report, beside the split chips (SplitMarkers.tsx). The next
// scheduled report sits past the last bar, dashed, when the chart's right-side
// space reaches it. ChartCore's redraw loop projects the dates
// (lib/earnings.ts projectEarningsMarkers) and pushes them here through the
// handle, so a pan re-renders only this layer.

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import Tooltip from "./components/Tooltip";
import { EARNINGS_CHIP, type EarningsMarker } from "./lib/earnings";

export interface EarningsMarkersHandle {
  setMarkers(markers: EarningsMarker[], paneBottom: number): void;
}

const GAP = 4; // lift off the time axis
const ROW = EARNINGS_CHIP + 2; // a lifted chip clears a split chip below it

export default function EarningsMarkers({ handleRef }: { handleRef?: Ref<EarningsMarkersHandle> }) {
  const [state, setState] = useState<{ markers: EarningsMarker[]; bottom: number }>({
    markers: [],
    bottom: 0,
  });
  const sigRef = useRef("");
  useImperativeHandle(
    handleRef,
    () => ({
      setMarkers(markers, paneBottom) {
        // Called every redraw frame: skip the render when nothing moved.
        const sig = `${Math.round(paneBottom)}|${markers.map((m) => `${m.key}@${Math.round(m.x)}${m.lift ? "^" : ""}`).join(",")}`;
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setState({ markers, bottom: paneBottom });
      },
    }),
    [],
  );

  if (state.markers.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none" }}>
      {state.markers.map((m) => (
        <Tooltip key={m.key} content={m.lines} asChild>
          <span
            aria-label={m.lines.join(", ")}
            style={{
              position: "absolute",
              left: `${m.x}px`,
              top: `${state.bottom - EARNINGS_CHIP - GAP - (m.lift ? ROW : 0)}px`,
              transform: "translateX(-50%)",
              width: EARNINGS_CHIP,
              height: EARNINGS_CHIP,
              lineHeight: `${EARNINGS_CHIP - 2}px`,
              textAlign: "center",
              fontSize: 10,
              fontWeight: 600,
              borderRadius: 3,
              border: `1px ${m.upcoming ? "dashed" : "solid"} var(--border)`,
              background: "var(--surface-2)",
              color: "var(--text-dim)",
              pointerEvents: "auto",
              cursor: "default",
              userSelect: "none",
              boxSizing: "border-box",
            }}
          >
            E
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
