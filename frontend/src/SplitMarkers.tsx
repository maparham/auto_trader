// Stock split markers: a small "S" chip on the candle pane's bottom edge at the
// bar that carries each split, with the ratio and date in its tooltip. Tells a
// user why the price halves (or drops 25x) overnight when a broker serves
// unadjusted history, and that a split-day bar was repaired when it does
// adjust. DOM, like the other chart marker layers: ChartCore's redraw loop
// projects the splits (lib/splits.ts projectSplitMarkers) and pushes them here
// through the handle, so a pan re-renders only this layer.

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import Tooltip from "./components/Tooltip";
import type { SplitMarker } from "./lib/splits";

export interface SplitMarkersHandle {
  setMarkers(markers: SplitMarker[], paneBottom: number): void;
}

const CHIP = 14;
const GAP = 4; // lift off the time axis

export default function SplitMarkers({ handleRef }: { handleRef?: Ref<SplitMarkersHandle> }) {
  const [state, setState] = useState<{ markers: SplitMarker[]; bottom: number }>({
    markers: [],
    bottom: 0,
  });
  const sigRef = useRef("");
  useImperativeHandle(
    handleRef,
    () => ({
      setMarkers(markers, paneBottom) {
        // Called every redraw frame: skip the render when nothing moved.
        const sig = `${Math.round(paneBottom)}|${markers.map((m) => `${m.key}@${Math.round(m.x)}`).join(",")}`;
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
        <Tooltip key={m.key} content={[`Stock split ${m.label}`, m.date]} asChild>
          <span
            aria-label={`Stock split ${m.label}, ${m.date}`}
            style={{
              position: "absolute",
              left: `${m.x}px`,
              top: `${state.bottom - CHIP - GAP}px`,
              transform: "translateX(-50%)",
              width: CHIP,
              height: CHIP,
              lineHeight: `${CHIP - 2}px`,
              textAlign: "center",
              fontSize: 10,
              fontWeight: 600,
              borderRadius: 3,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--text-dim)",
              pointerEvents: "auto",
              cursor: "default",
              userSelect: "none",
              boxSizing: "border-box",
            }}
          >
            S
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
