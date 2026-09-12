// The panel host for BOTH pattern-search views: the drag-driven Similar
// search (existing PatternMatchesPanel) and the preset-family scan (Task
// 13's PresetScanView — a null placeholder here until then). One workspace
// panel, a segmented switcher at the top picks which half shows; switching
// never touches either half's state, which lives entirely in
// lib/patternPanelStore.
import { useState, useSyncExternalStore } from "react";
import CloseButton from "./CloseButton";
import PatternMatchesPanel from "./PatternMatchesPanel";
import PresetScanView from "./PresetScanView";
import { SavePresetIcon, SelectRangeIcon } from "./lib/menuIcons";
import { toast } from "./lib/notify";
import {
  armPatternSelect,
  closePatternPanel,
  getPatternPanelState,
  savePresetFromLastRun,
  setPatternView,
  subscribePatternPanel,
  type PatternScope,
  type PatternView,
} from "./lib/patternPanelStore";
import type {
  PatternMatch,
  PatternMode,
  PatternSearchResult,
  SourceOutcome,
} from "./lib/patternSearch";

const VIEWS: readonly [PatternView, string][] = [
  ["similar", "Similar"],
  ["presets", "Presets"],
];

interface Props {
  timezone: string;
  onReveal: (cellId: string) => boolean;
  /** Everything below mirrors PatternMatchesPanel's own props — WorkspacePatternPanel
   *  passes them straight through from the store, same as before this panel
   *  existed. */
  result: (PatternSearchResult & { sources?: SourceOutcome[] }) | null;
  loading: boolean;
  error: string | null;
  epic: string;
  resolution: string;
  broker: string;
  priceSide: string;
  /** The workspace's CURRENT broker/price-side (App's live values, e.g. what
   *  it feeds ChartCore) — distinct from `broker`/`priceSide` above, which
   *  describe the Similar half's LAST-RUN query and only get seeded once a
   *  search has actually run. PresetScanView's scan-all-open-charts action
   *  has no "last run" of its own to describe, so it must use the live pair;
   *  using the Similar pair here is exactly the bug this fixes (an empty
   *  priceSide before any Similar search this session 422s on the backend's
   *  bid|mid|ask pattern). */
  liveBroker: string;
  livePriceSide: string;
  truncatedTo?: number | null;
  mode: PatternMode;
  onModeChange: (mode: PatternMode) => void;
  forwardBars: number;
  onForwardBarsChange: (bars: number) => void;
  scope: PatternScope;
  onScopeChange: (scope: PatternScope) => void;
  onCopy: (match: PatternMatch) => void;
  onJump: (match: PatternMatch) => void;
  onDismiss: () => void;
}

export default function PatternPanel(props: Props) {
  const st = useSyncExternalStore(subscribePatternPanel, getPatternPanelState);
  // Inline name entry for Save-as-preset: local, not store state — it's a
  // transient editing gesture, not something that needs to survive a panel
  // close/reopen.
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  const confirmSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const saved = await savePresetFromLastRun(trimmed);
    if (saved) {
      toast(`saved "${saved.name}" as a preset`);
      setSaving(false);
      setName("");
    } else {
      toast(getPatternPanelState().presetError ?? "could not save preset");
    }
  };

  return (
    <div className="pattern-panel">
      <div className="pattern-panel-head">
        {/* Same seg/seg-on classes as PatternMatchesPanel's mode chips. */}
        <div className="seg" role="group" aria-label="Pattern search view">
          {VIEWS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={st.view === v ? "seg-on" : ""}
              aria-pressed={st.view === v}
              onClick={() => setPatternView(v)}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Distinct from the Similar view's own ✕ below (which only clears the
         *  result via onDismiss) — this one hides the whole panel. */}
        <CloseButton onClick={closePatternPanel} label="Close panel" />
      </div>

      {st.view === "similar" ? (
        <div className="pattern-panel-similar">
          <div className="pattern-panel-similar-head">
            <button
              type="button"
              className={`anchor-btn${st.selectArmed ? " seg-on" : ""}`}
              onClick={armPatternSelect}
            >
              <SelectRangeIcon size={14} />
              {st.selectArmed ? "drag on the chart" : "Select range on chart"}
            </button>
            {saving ? (
              <input
                autoFocus
                className="pattern-panel-save-input"
                value={name}
                placeholder="preset name"
                aria-label="Preset name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmSave();
                  if (e.key === "Escape") {
                    setSaving(false);
                    setName("");
                  }
                }}
                // Blur cancels unconditionally — typed-but-unconfirmed text is
                // not a reason to trap the control open; Enter is the only
                // path that saves it.
                onBlur={() => {
                  setSaving(false);
                  setName("");
                }}
              />
            ) : (
              <button
                type="button"
                className="anchor-btn"
                disabled={!st.origin}
                onClick={() => setSaving(true)}
              >
                <SavePresetIcon size={14} />
                Save as preset
              </button>
            )}
          </div>
          <PatternMatchesPanel
            result={props.result}
            loading={props.loading}
            error={props.error}
            epic={props.epic}
            resolution={props.resolution}
            broker={props.broker}
            priceSide={props.priceSide}
            timezone={props.timezone}
            truncatedTo={props.truncatedTo}
            mode={props.mode}
            onModeChange={props.onModeChange}
            forwardBars={props.forwardBars}
            onForwardBarsChange={props.onForwardBarsChange}
            scope={props.scope}
            onScopeChange={props.onScopeChange}
            onCopy={props.onCopy}
            onJump={props.onJump}
            onDismiss={props.onDismiss}
          />
        </div>
      ) : (
        <PresetScanView
          broker={props.liveBroker}
          priceSide={props.livePriceSide}
          timezone={props.timezone}
          onReveal={props.onReveal}
        />
      )}
    </div>
  );
}
