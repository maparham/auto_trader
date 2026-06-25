// TradingView-style drawing settings modal, opened from a drawing's right-click
// "Settings…" item or a double-click on the drawing (drawingSettingsRequest ->
// App mounts this). Reads the live overlay via the focused cell's OverlayManager
// and writes changes back through it (which persists). Tabs mirror TV:
//   Style       — line color / width / style; Extend (trend lines only)
//   Coordinates — each anchor point's price (+ timestamp, read-only date label)
//   Visibility  — whether the drawing is drawn
//
// Edits preview live on the chart; Cancel/Escape restores the opening snapshot.
// The Text tab + middle-point / price-labels are a planned second pass (the
// built-in overlays have fixed figure rendering); the tab shell is present so the
// layout matches TV, with those fields noted as coming soon.

import { useMemo, useState } from "react";
import { LineType } from "klinecharts";
import type { DeepPartial, OverlayStyle } from "klinecharts";
import { type OverlayManager, asDrawingExtra } from "./lib/overlays";
import { PERIOD_GROUPS } from "./lib/feed";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import ColorLineStylePicker, { type LineStyleOpt } from "./ColorLineStylePicker";

interface Props {
  overlays: OverlayManager;
  id: string;
  // The modal may RE-CREATE the overlay (Extend changes its klinecharts name →
  // new id). It calls this so the opener (the drawingSettingsRequest signal) keeps
  // pointing at the live overlay.
  onIdChange: (id: string) => void;
  onClose: () => void;
}

type Tab = "style" | "text" | "coordinates" | "visibility";

// Trend-line family whose endpoints define a line we can "extend" by swapping the
// built-in (segment = no extend, rayLine = one side, straightLine = both).
const ALL_RESOLUTIONS = PERIOD_GROUPS.flatMap((g) => g.periods.map((p) => p.resolution));

const TREND = new Set(["segment", "rayLine", "straightLine"]);
const EXTEND_OF: Record<string, "none" | "ray" | "both"> = {
  segment: "none",
  rayLine: "ray",
  straightLine: "both",
};

// Friendly modal title per overlay name (falls back to the raw name).
const TITLES: Record<string, string> = {
  segment: "Trend line",
  rayLine: "Ray",
  straightLine: "Trend line",
  horizontalStraightLine: "Horizontal line",
  verticalStraightLine: "Vertical line",
  priceLine: "Price line",
  priceChannelLine: "Parallel channel",
  fibonacciLine: "Fib retracement",
};

export default function DrawingSettings({ overlays, id, onIdChange, onClose }: Props) {
  const drag = useDraggable();
  // Live id (changes if Extend recreates the overlay). All reads/writes use this;
  // every handler below is recreated each render, so it closes over the current id.
  const [curId, setCurId] = useState(id);

  // Opening snapshot for Cancel — captured ONCE via the lazy state initializer (by
  // value), so it survives an Extend recreate (which cancel re-applies by recreating
  // if the name changed).
  const [original] = useState(() => overlays.getDrawing(id));

  const live = overlays.getDrawing(curId);
  const name = live?.name ?? original?.name ?? "";
  const title = TITLES[name] ?? "Drawing";
  const isTrend = TREND.has(name);

  const line = (live?.styles?.line ?? {}) as Partial<{ color: string; size: number; style: LineType }>;
  const [tab, setTab] = useState<Tab>("style");
  const [color, setColor] = useState(line.color ?? "#2962ff");
  const [size, setSize] = useState<number>(line.size ?? 1);
  const [style, setStyle] = useState<LineType>(line.style ?? LineType.Solid);
  const [extend, setExtend] = useState<"none" | "ray" | "both">(EXTEND_OF[name] ?? "none");
  const [visible, setVisible] = useState<boolean>(live?.visible ?? true);

  // Visibility tab extras (from extendData): price-axis tag toggle, and the set of
  // intervals the drawing shows on (null = every interval).
  const extra0 = asDrawingExtra(live?.extendData);
  const [priceLabels, setPriceLabels] = useState<boolean>(extra0.priceLabels ?? true);
  // Text tab (trend lines only — the overridden custom overlays render these).
  const [text, setText] = useState<string>(extra0.text ?? "");
  const [showMiddle, setShowMiddle] = useState<boolean>(extra0.showMiddle ?? false);
  // null sentinel = "all intervals"; a Set means a specific allow-list.
  const [intervals, setIntervals] = useState<Set<string> | null>(
    extra0.intervals && extra0.intervals.length ? new Set(extra0.intervals) : null,
  );

  // Coordinates: editable price per point, with the timestamp shown as a date.
  const [points, setPoints] = useState(() =>
    (live?.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
  );
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [],
  );

  function applyStyle(next: Partial<{ color: string; size: number; style: LineType }>) {
    const merged = { color, size, style, ...next };
    setColor(merged.color);
    setSize(merged.size);
    setStyle(merged.style);
    overlays.setStyle(curId, {
      line: { color: merged.color, size: merged.size, style: merged.style },
    } as DeepPartial<OverlayStyle>);
  }

  function applyExtend(mode: "none" | "ray" | "both") {
    setExtend(mode);
    const newId = overlays.setExtend(curId, mode);
    if (newId && newId !== curId) {
      setCurId(newId);
      onIdChange(newId);
    }
  }

  function applyVisible(v: boolean) {
    setVisible(v);
    overlays.setVisible(curId, v);
  }

  function applyPriceLabels(v: boolean) {
    setPriceLabels(v);
    overlays.setPriceLabels(curId, v);
  }

  function applyText(v: string) {
    setText(v);
    overlays.setText(curId, v);
  }

  function applyShowMiddle(v: boolean) {
    setShowMiddle(v);
    overlays.setShowMiddle(curId, v);
  }

  // "Show on all intervals" toggle. On → clear the allow-list (null); off → seed it
  // with the current interval set, or all known intervals if none was pinned.
  function applyAllIntervals(all: boolean) {
    if (all) {
      setIntervals(null);
      overlays.setVisibleIntervals(curId, null);
    } else {
      const seed = new Set(intervals ?? ALL_RESOLUTIONS);
      setIntervals(seed);
      overlays.setVisibleIntervals(curId, [...seed]);
    }
  }

  function toggleInterval(resolution: string, on: boolean) {
    const next = new Set(intervals ?? ALL_RESOLUTIONS);
    if (on) next.add(resolution);
    else next.delete(resolution);
    setIntervals(next);
    overlays.setVisibleIntervals(curId, [...next]);
  }

  function applyPointValue(i: number, value: number) {
    const next = points.map((p, j) => (j === i ? { ...p, value } : p));
    setPoints(next);
    overlays.updatePoints(curId, next);
  }

  function cancel() {
    // Restore the opening snapshot. If Extend changed the overlay's name, the
    // current overlay is a different one (different id) — remove it and recreate
    // the original; otherwise just push the original style/points/visible back.
    const o = original;
    if (o) {
      if (o.name !== overlays.getDrawing(curId)?.name) {
        overlays.remove(curId);
        overlays.placeDrawing({
          name: o.name,
          points: o.points,
          styles: o.styles,
          lock: o.lock,
          visible: o.visible,
          zLevel: o.zLevel,
          extendData: o.extendData,
        });
      } else {
        const oExtra = asDrawingExtra(o.extendData);
        overlays.setStyle(curId, o.styles ?? {});
        overlays.updatePoints(curId, o.points);
        overlays.setVisibleIntervals(curId, oExtra.intervals ?? null);
        overlays.setPriceLabels(curId, oExtra.priceLabels ?? true);
        overlays.setText(curId, oExtra.text ?? "");
        overlays.setShowMiddle(curId, oExtra.showMiddle ?? false);
        overlays.setVisible(curId, o.visible);
      }
    }
    onClose();
  }

  useCloseOnEscape(cancel);

  if (!live && !original) return null;

  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div className="modal ind-settings" style={drag.style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head" {...drag.handleProps}>
          <strong>{title}</strong>
          <button className="modal-close" onClick={cancel} title="Cancel">
            ✕
          </button>
        </div>

        <div className="ind-tabs">
          {(["style", "text", "coordinates", "visibility"] as Tab[]).map((t) => (
            <button key={t} className={`ind-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {t === "style"
                ? "Style"
                : t === "text"
                  ? "Text"
                  : t === "coordinates"
                    ? "Coordinates"
                    : "Visibility"}
            </button>
          ))}
        </div>

        <div className="ind-body">
          {tab === "style" && (
            <>
              <div className="ind-row ind-style-row">
                <label>Line</label>
                <div className="ind-line-controls">
                  {/* klinecharts overlays support Solid / Dashed only (no dotted),
                      so the picker offers just those two line styles. */}
                  <ColorLineStylePicker
                    color={color}
                    onColor={(hex) => applyStyle({ color: hex })}
                    size={size}
                    onSize={(s) => applyStyle({ size: s })}
                    lineStyle={style === LineType.Dashed ? "dashed" : "solid"}
                    onLineStyle={(s) =>
                      applyStyle({ style: s === "dashed" ? LineType.Dashed : LineType.Solid })
                    }
                    lineStyleOptions={["solid", "dashed"] as LineStyleOpt[]}
                  />
                </div>
              </div>
              {isTrend && (
                <div className="ind-row">
                  <label>Extend</label>
                  <select
                    value={extend}
                    onChange={(e) => applyExtend(e.target.value as "none" | "ray" | "both")}
                  >
                    <option value="none">Don't extend</option>
                    <option value="ray">Extend right</option>
                    <option value="both">Extend both</option>
                  </select>
                </div>
              )}
            </>
          )}

          {tab === "text" &&
            (isTrend ? (
              <>
                <div className="ind-row ind-style-row">
                  <label>Label</label>
                  <input
                    type="text"
                    placeholder="Add text…"
                    value={text}
                    onChange={(e) => applyText(e.target.value)}
                    style={{ flex: 1 }}
                  />
                </div>
                <label className="ind-check">
                  <input
                    type="checkbox"
                    checked={showMiddle}
                    onChange={(e) => applyShowMiddle(e.target.checked)}
                  />
                  <span>Show midpoint marker</span>
                </label>
              </>
            ) : (
              <p className="ind-note">
                Text labels and the midpoint marker are available on trend lines
                (segment, ray, extended line).
              </p>
            ))}

          {tab === "coordinates" && (
            <>
              {points.length === 0 && (
                <p className="ind-note">This drawing has no editable coordinates.</p>
              )}
              {points.map((p, i) => (
                <div className="ind-row" key={i}>
                  <label>{points.length > 1 ? `Point ${i + 1}` : "Price"}</label>
                  <div className="ind-line-controls">
                    <input
                      type="number"
                      step="any"
                      value={p.value ?? ""}
                      onChange={(e) => applyPointValue(i, Number(e.target.value))}
                    />
                    {p.timestamp != null && (
                      <span className="ind-coord-date">{dateFmt.format(p.timestamp)}</span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "visibility" && (
            <>
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => applyVisible(e.target.checked)}
                />
                <span>Show on chart</span>
              </label>
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={priceLabels}
                  onChange={(e) => applyPriceLabels(e.target.checked)}
                />
                <span>Show price label on axis</span>
              </label>

              <div className="ind-row" style={{ marginTop: 8 }}>
                <label>Intervals</label>
                <select
                  value={intervals == null ? "all" : "custom"}
                  onChange={(e) => applyAllIntervals(e.target.value === "all")}
                >
                  <option value="all">All intervals</option>
                  <option value="custom">Specific intervals…</option>
                </select>
              </div>
              {intervals != null && (
                <div className="ind-interval-grid">
                  {PERIOD_GROUPS.map((g) => (
                    <div className="ind-interval-group" key={g.label}>
                      <div className="ind-interval-group-label">{g.label}</div>
                      {g.periods.map((p) => (
                        <label className="ind-check" key={p.resolution}>
                          <input
                            type="checkbox"
                            checked={intervals.has(p.resolution)}
                            onChange={(e) => toggleInterval(p.resolution, e.target.checked)}
                          />
                          <span>{p.label}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button onClick={onClose}>Ok</button>
        </div>
      </div>
    </div>
  );
}
