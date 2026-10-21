// Earnings markers: a small "E" chip on the candle pane's bottom edge at the bar
// holding each report, beside the split chips (SplitMarkers.tsx). The next
// scheduled report sits past the last bar, dashed, when the chart's right-side
// space reaches it. ChartCore's redraw loop projects the dates
// (lib/earnings.ts projectEarningsMarkers) and pushes them here through the
// handle, so a pan re-renders only this layer.
//
// Clicking a chip opens its detail popup, which stays open (and follows the
// chip through pans) until the x, Escape, a click elsewhere, or the chip again.

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import InfoTip from "./components/InfoTip";
import { computePlacement } from "./components/tooltipPosition";
import { EARNINGS_CHIP, earningsView, type EarningsMarker, type EarningsView } from "./lib/earnings";
import type { Clock } from "./lib/timeFormat";

export interface EarningsMarkersHandle {
  setMarkers(markers: EarningsMarker[], paneBottom: number): void;
}

const GAP = 4; // lift off the time axis
const ROW = EARNINGS_CHIP + 2; // a lifted chip clears a split chip below it

export default function EarningsMarkers({
  handleRef,
  timeZone,
  clock,
}: {
  handleRef?: Ref<EarningsMarkersHandle>;
  /** The chart's time zone (the popup names open/close times in it). */
  timeZone?: string;
  clock: Clock;
}) {
  const [state, setState] = useState<{ markers: EarningsMarker[]; bottom: number }>({
    markers: [],
    bottom: 0,
  });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const sigRef = useRef("");
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
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

  const open = openKey ? state.markers.find((m) => m.key === openKey) : undefined;
  // A chip panned off the pane (or a symbol switch) takes its popup with it.
  useEffect(() => {
    if (openKey && !open) setOpenKey(null);
  }, [openKey, open]);

  // Anchor the popup to its chip after every layout, so it follows a pan. The
  // half-pixel check ends the loop after one extra pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const chip = open ? chipRefs.current.get(open.key) : undefined;
    const pop = popRef.current;
    if (!chip || !pop) {
      if (pos) setPos(null);
      return;
    }
    const r = chip.getBoundingClientRect();
    const p = computePlacement(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      { width: pop.offsetWidth, height: pop.offsetHeight },
      "top",
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (!pos || Math.abs(pos.left - p.left) > 0.5 || Math.abs(pos.top - p.top) > 0.5) {
      setPos({ left: p.left, top: p.top });
    }
  });

  // Dismiss on a press outside the popup and its chip, or on Escape.
  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || chipRefs.current.get(openKey)?.contains(t)) return;
      setOpenKey(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenKey(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [openKey]);

  if (state.markers.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none" }}>
      {state.markers.map((m) => (
        <button
          key={m.key}
          type="button"
          ref={(el) => {
            if (el) chipRefs.current.set(m.key, el);
            else chipRefs.current.delete(m.key);
          }}
          aria-label={m.label}
          aria-expanded={openKey === m.key}
          aria-haspopup="dialog"
          onClick={() => setOpenKey((k) => (k === m.key ? null : m.key))}
          style={{
            position: "absolute",
            left: `${m.x}px`,
            top: `${state.bottom - EARNINGS_CHIP - GAP - (m.lift ? ROW : 0)}px`,
            transform: "translateX(-50%)",
            width: EARNINGS_CHIP,
            height: EARNINGS_CHIP,
            padding: 0,
            lineHeight: `${EARNINGS_CHIP - 2}px`,
            textAlign: "center",
            fontSize: 10,
            fontWeight: 600,
            fontFamily: "inherit",
            borderRadius: 3,
            border: `1px ${m.upcoming ? "dashed" : "solid"} var(--border)`,
            background: openKey === m.key ? "var(--hover)" : "var(--surface-2)",
            color: "var(--text-dim)",
            pointerEvents: "auto",
            cursor: "pointer",
            userSelect: "none",
            boxSizing: "border-box",
          }}
        >
          E
        </button>
      ))}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="earn-pop"
            role="dialog"
            aria-label={open.label}
            // Measured hidden on the first frame, then placed by the layout effect.
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
            // A portal still bubbles React events to ChartCore: keep chart
            // gestures (cell focus, drag) out of clicks inside the popup.
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <EarningsDetail view={earningsView(open.earnings, { timeZone, clock })} onClose={() => setOpenKey(null)} />
          </div>,
          document.body,
        )}
    </div>
  );
}

// Plain-language glosses for someone new to earnings reports.
const TIPS: Record<string, string[]> = {
  EPS: ["Earnings per share.", "The quarter's profit divided by the number of shares."],
  Revenue: ["Total sales in the quarter, before any costs.", "Shows whether the business is growing."],
  Estimate: ["What analysts expected, on average."],
  Actual: ["What the company reported."],
  "EPS surprise": [
    "How far actual EPS landed from the estimate.",
    "Positive is a beat, negative a miss.",
    "The price often moves on this.",
  ],
};

function Term({ label }: { label: string }) {
  return (
    <span className="earn-pop-term">
      {label}
      <InfoTip title={label} text={TIPS[label]} />
    </span>
  );
}

function EarningsDetail({ view, onClose }: { view: EarningsView; onClose: () => void }) {
  return (
    <>
      <div className="earn-pop-head">
        <div>
          <div className="earn-pop-title">Earnings</div>
          <div className="earn-pop-date">{view.date}</div>
        </div>
        <button type="button" className="earn-pop-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="earn-pop-meta">
        <span className={`earn-pop-status${view.status === "Reported" ? "" : " is-upcoming"}`}>{view.status}</span>
        {view.session && <span>{view.session}</span>}
      </div>
      {view.rows.length > 0 && (
        <table className="earn-pop-grid">
          <thead>
            <tr>
              <th />
              <th>
                <Term label="Estimate" />
              </th>
              {view.hasActual && (
                <th>
                  <Term label="Actual" />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{TIPS[r.label] ? <Term label={r.label} /> : r.label}</th>
                <td>{r.estimate ?? "n/a"}</td>
                {view.hasActual && <td className="earn-pop-actual">{r.actual ?? "n/a"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.surprise && (
        <div className="earn-pop-surprise">
          <Term label="EPS surprise" />
          <span className={`is-${view.surprise.tone}`}>{view.surprise.text}</span>
        </div>
      )}
    </>
  );
}
