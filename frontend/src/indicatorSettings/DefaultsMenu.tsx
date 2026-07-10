// TradingView-style "Defaults" menu (the modal footer's left-pinned dropdown):
// a single global default per indicator TYPE that seeds freshly-added instances,
// plus named presets applied on demand. Both store the SAME SavedIndicatorConfig
// currentConfig() produces (see persist.ts). Applying recreates the instance from
// the chosen config (the established copy/paste mechanism) and closes the modal —
// reopening reads the fresh live state. We DON'T try to push a config back into the
// caller's ~12 useState fields.
import { useEffect, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import InfoTip from "../components/InfoTip";
import {
  saveIndicatorConfig,
  loadIndicatorDefault,
  saveIndicatorDefault,
  clearIndicatorDefault,
  loadIndicatorPresets,
  saveIndicatorPreset,
  deleteIndicatorPreset,
  type SavedIndicatorConfig,
} from "../lib/persist";
import { applyIndicator, removeIndicatorById } from "../lib/indicators";
import { toast } from "../lib/notify";

export default function DefaultsMenu({
  chart,
  scope,
  epic,
  name,
  type,
  currentConfig,
  onClose,
}: {
  chart: Chart;
  scope: string;
  epic: string;
  name: string;
  type: string;
  currentConfig: () => SavedIndicatorConfig;
  onClose: () => void;
}) {
  const [defOpen, setDefOpen] = useState(false);
  const [naming, setNaming] = useState(false); // inline "Save as preset…" name field
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
    // Capture phase: the modal body calls stopPropagation on mousedown, which
    // would otherwise prevent this document-level listener from ever seeing
    // clicks inside the modal.
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [defOpen]);

  // Recreate THIS instance (same id) from `cfg`, then close. Reuses the same
  // remove+add path as paste; reusing the id keeps its per-cell config key aligned.
  // `cfg === null` resets to the type baseline (no config → BASE_TEMPLATES defaults).
  // `rehydrate: true` so an AVWAP keeps its placed anchor across the recreate (the
  // anchor lives in per-epic storage, NOT in the preset config which is anchorless).
  function applyConfigToOpenInstance(cfg: SavedIndicatorConfig | null) {
    removeIndicatorById(chart, scope, name); // also clears this id's per-cell config
    saveIndicatorConfig(scope, name, cfg ?? {}); // persist the new config for next reload
    applyIndicator(chart, scope, epic, { id: name, type }, { config: cfg ?? {}, rehydrate: true });
    setDefOpen(false);
    onClose();
  }

  function saveAsDefault() {
    saveIndicatorDefault(type, currentConfig());
    setDefOpen(false);
    toast(`Saved ${type} default`);
  }
  function resetToDefault() {
    // Type default if one exists, else the bare type baseline.
    applyConfigToOpenInstance(loadIndicatorDefault(type));
  }
  function commitPreset() {
    const nm = presetName.trim();
    if (!nm) return;
    saveIndicatorPreset(type, nm, currentConfig());
    setNaming(false);
    setPresetName("");
    setDefOpen(false);
    toast(`Saved preset "${nm}"`);
  }
  function applyPreset(nm: string) {
    const cfg = loadIndicatorPresets(type)[nm];
    if (cfg) applyConfigToOpenInstance(cfg);
  }
  function removePreset(nm: string) {
    deleteIndicatorPreset(type, nm);
    // keep the menu open so the user can delete several; force a re-read by toggling
    setDefOpen(false);
    setTimeout(() => setDefOpen(true), 0);
  }

  return (
    <div className="menu ind-def-menu" ref={defMenuRef}>
      <span className="ind-row-head">
        <button
          className={`ghost ${defOpen ? "on" : ""}`}
          onClick={() => setDefOpen((v) => !v)}
        >
          Defaults ▾
        </button>
        <InfoTip
          title="Defaults"
          text="Save these settings as the default for this indicator, or store named presets."
        />
      </span>
      {defOpen && (
        <div className="dropdown ind-def-dropdown">
          <ul>
            <li onClick={resetToDefault}>Reset settings</li>
            <li onClick={saveAsDefault}>Save as default</li>
            {loadIndicatorDefault(type) && (
              <li
                onClick={() => {
                  clearIndicatorDefault(type);
                  setDefOpen(false);
                  toast(`Cleared ${type} default`);
                }}
              >
                Clear default
              </li>
            )}
            <li className="sep" />
            {Object.keys(loadIndicatorPresets(type)).map((nm) => (
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
                  placeholder="Preset name…"
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
              <li onClick={() => setNaming(true)}>Save as preset…</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
