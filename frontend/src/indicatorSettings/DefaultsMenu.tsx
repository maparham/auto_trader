// TradingView-style "Defaults" menu (the modal footer's left-pinned dropdown):
// a single global default per indicator TYPE that seeds freshly-added instances,
// plus named presets applied on demand. Both store the SAME SavedIndicatorConfig
// currentConfig() produces (see persist.ts). Applying recreates the instance from
// the chosen config (the established copy/paste mechanism) and tells the modal
// shell, which remounts the form over the fresh live state; the stored config is
// left exactly as it was, because only Ok persists. We DON'T try to push a
// config back into the form's ~60 useState fields.
import { useEffect, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import InfoTip from "../components/InfoTip";
import Tooltip from "../components/Tooltip";
import {
  saveIndicatorConfig,
  deleteIndicatorConfig,
  loadIndicatorConfigs,
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
  onRecreated,
}: {
  chart: Chart;
  scope: string;
  epic: string;
  name: string;
  type: string;
  currentConfig: () => SavedIndicatorConfig;
  // The instance was recreated (same id, possibly a new pane): the modal
  // re-reads it. It stays open, like any other edit.
  onRecreated: () => void;
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
    // The remove clears this id's stored config; put it back afterwards so the
    // apply is a preview like any other edit, persisted by Ok or dropped by Cancel.
    const stored = loadIndicatorConfigs(scope)[name];
    removeIndicatorById(chart, scope, name);
    applyIndicator(chart, scope, epic, { id: name, type }, { config: cfg ?? {}, rehydrate: true });
    if (stored) saveIndicatorConfig(scope, name, stored);
    else deleteIndicatorConfig(scope, name);
    setDefOpen(false);
    // Unconditional: the old instance is gone either way, and the shell must
    // re-read rather than keep a form bound to a removed indicator.
    onRecreated();
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
              // The whole row applies: the hover highlight spans it, so a click
              // landing beside the (often two-character) name must not be lost.
              <li key={nm} className="ind-def-preset" onClick={() => applyPreset(nm)}>
                <Tooltip content={`Apply "${nm}"`}>
                  <span>{nm}</span>
                </Tooltip>
                <Tooltip content={`Delete "${nm}"`}>
                  <button
                    className="ind-def-del"
                    aria-label={`Delete "${nm}"`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removePreset(nm);
                    }}
                  >
                    ✕
                  </button>
                </Tooltip>
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
