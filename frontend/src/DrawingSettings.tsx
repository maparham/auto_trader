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

import { useEffect, useMemo, useRef, useState } from "react";
import CloseButton from "./CloseButton";
import { LineType } from "klinecharts";
import type { DeepPartial, OverlayStyle } from "klinecharts";
import { type OverlayManager, asDrawingExtra } from "./lib/overlays";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import ColorLineStylePicker, { type LineStyleOpt } from "./ColorLineStylePicker";
import VisibilityTab from "./VisibilityTab";
import { type VisibilityModel, defaultVisibility } from "./lib/visibility";
import { toast } from "./lib/notify";
import InfoTip from "./components/InfoTip";
import {
  loadDrawingDefault,
  saveDrawingDefault,
  clearDrawingDefault,
  loadDrawingPresets,
  saveDrawingPreset,
  deleteDrawingPreset,
  type SavedDrawingConfig,
} from "./lib/persist";

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
  const [vis, setVis] = useState<VisibilityModel>(extra0.visibility ?? defaultVisibility());

  // "Defaults ▾" footer menu: this drawing type's default + named templates (global,
  // keyed by overlay name). Mirrors the indicator settings Defaults menu.
  const [defOpen, setDefOpen] = useState(false);
  const [naming, setNaming] = useState(false); // inline "Save as template…" field
  const [presetName, setPresetName] = useState("");
  const defMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!defOpen) return;
    const onDown = (e: MouseEvent) => {
      if (defMenuRef.current && !defMenuRef.current.contains(e.target as Node)) {
        setDefOpen(false);
        setNaming(false);
      }
    };
    // Capture phase: the modal body stops mousedown propagation, so a document
    // listener must capture to see clicks inside the modal.
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [defOpen]);

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

  function applyVis(next: VisibilityModel) {
    setVis(next);
    overlays.setVisibilityModel(curId, next);
  }

  function applyPointValue(i: number, value: number) {
    const next = points.map((p, j) => (j === i ? { ...p, value } : p));
    setPoints(next);
    overlays.updatePoints(curId, next);
  }

  // Apply a config to the open drawing AND refresh local state so the controls
  // reflect it. `null` = this name's default (or no-op if none saved). Note the
  // setters: `setStyle` is the local line-style state, `setVis` the visibility state.
  function applyConfigHere(cfg: SavedDrawingConfig | null) {
    if (!cfg) return;
    overlays.applyDrawingConfig(curId, cfg);
    if (cfg.line?.color !== undefined) setColor(cfg.line.color);
    if (cfg.line?.size !== undefined) setSize(cfg.line.size);
    if (cfg.line?.style !== undefined) setStyle(cfg.line.style);
    if (cfg.showMiddle !== undefined) setShowMiddle(cfg.showMiddle);
    if (cfg.priceLabels !== undefined) setPriceLabels(cfg.priceLabels);
    if (cfg.visibility !== undefined) setVis(cfg.visibility);
  }

  function resetToDefault() {
    applyConfigHere(loadDrawingDefault(name));
    setDefOpen(false);
  }
  function saveAsDefault() {
    const cfg = overlays.getDrawingConfig(curId); // LIVE overlay → correct name key
    if (cfg) saveDrawingDefault(name, cfg);
    setDefOpen(false);
    toast(`Saved ${title} default`);
  }
  function commitPreset() {
    const nm = presetName.trim();
    if (!nm) return;
    const cfg = overlays.getDrawingConfig(curId);
    if (cfg) saveDrawingPreset(name, nm, cfg);
    setNaming(false);
    setPresetName("");
    setDefOpen(false);
    toast(`Saved template "${nm}"`);
  }
  function applyPreset(nm: string) {
    const cfg = loadDrawingPresets(name)[nm];
    if (cfg) applyConfigHere(cfg);
    setDefOpen(false);
  }
  function removePreset(nm: string) {
    deleteDrawingPreset(name, nm);
    // Re-read by toggling the menu (same idiom as the indicator menu).
    setDefOpen(false);
    setTimeout(() => setDefOpen(true), 0);
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
        overlays.setVisibilityModel(curId, oExtra.visibility ?? defaultVisibility());
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
          <CloseButton onClick={cancel} label="Cancel" />
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

              <VisibilityTab
                model={vis}
                onChange={applyVis}
                showAutoHide
                currentResolution={overlays.getResolution()}
              />
            </>
          )}
        </div>

        <div className="modal-foot">
          {/* TV-style "Defaults" menu: this drawing type's default + named templates,
              all global. Pinned left opposite Cancel/Ok. */}
          <div className="menu ind-def-menu" ref={defMenuRef}>
            <span className="ind-row-head">
              <button className={`ghost ${defOpen ? "on" : ""}`} onClick={() => setDefOpen((v) => !v)}>
                Defaults ▾
              </button>
              <InfoTip
                title="Defaults"
                text="Save these settings as the default for this drawing type, or store named templates."
              />
            </span>
            {defOpen && (
              <div className="dropdown ind-def-dropdown">
                <ul>
                  <li onClick={resetToDefault}>Reset settings</li>
                  <li onClick={saveAsDefault}>Save as default</li>
                  {loadDrawingDefault(name) && (
                    <li
                      onClick={() => {
                        clearDrawingDefault(name);
                        setDefOpen(false);
                        toast(`Cleared ${title} default`);
                      }}
                    >
                      Clear default
                    </li>
                  )}
                  <li className="sep" />
                  {Object.keys(loadDrawingPresets(name)).map((nm) => (
                    <li key={nm} className="ind-def-preset">
                      <span onClick={() => applyPreset(nm)} title={`Apply "${nm}"`}>
                        {nm}
                      </span>
                      <button
                        className="ind-def-del"
                        title={`Delete "${nm}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removePreset(nm);
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                  {naming ? (
                    <li className="ind-def-name">
                      <input
                        autoFocus
                        placeholder="Template name…"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitPreset();
                          if (e.key === "Escape") {
                            setNaming(false);
                            setPresetName("");
                          }
                        }}
                      />
                      <button onClick={commitPreset}>Save</button>
                    </li>
                  ) : (
                    <li onClick={() => setNaming(true)}>Save as template…</li>
                  )}
                </ul>
              </div>
            )}
          </div>
          <button className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button onClick={onClose}>Ok</button>
        </div>
      </div>
    </div>
  );
}
