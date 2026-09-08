// The preset half of the pattern panel: family cards (built-in archetypes +
// the signed-in user's own saved presets), per-family param overrides, a
// scan-all-open-charts button, and grouped results. All state lives in
// lib/patternPanelStore — this component only reads it and dispatches store
// actions, same idiom as PatternMatchesPanel for the Similar half.
import { useEffect, useState, useSyncExternalStore } from "react";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { toast } from "./lib/notify";
import { jumpToMatch } from "./WorkspacePatternPanel";
import {
  findPatternSource,
  getPatternPanelState,
  getPresetScanCharts,
  openPatternPanel,
  refreshUserPresets,
  runPatternSearch,
  runPresetScanNow,
  setFamilyParam,
  setPatternView,
  setPresetSelectedHit,
  subscribePatternPanel,
  toggleFamily,
} from "./lib/patternPanelStore";
import {
  deleteUserPreset,
  renameUserPreset,
  type PresetChartResult,
  type PresetFamily,
  type PresetHit,
  type PresetParamSchema,
  type UserPreset,
} from "./lib/presetScan";
import type { PatternBar, PatternMatch } from "./lib/patternSearch";

// Idealized close paths per built-in family, (t, value) knots in the unit
// square — one representative variant per family, lifted straight from the
// backend's ARCHETYPES (auto_trader/core/pattern_presets.py) so the glyph is
// literally the shape the family looks for.
const GLYPHS: Record<string, [number, number][]> = {
  hns: [[0.0, 0.1], [0.15, 0.6], [0.3, 0.2], [0.5, 1.0], [0.7, 0.22], [0.85, 0.58], [1.0, 0.05]],
  double: [[0.0, 0.0], [0.25, 1.0], [0.5, 0.5], [0.75, 0.97], [1.0, 0.1]],
  broadening: [[0.0, 0.5], [0.12, 0.65], [0.25, 0.35], [0.4, 0.78], [0.55, 0.22], [0.72, 0.9], [0.88, 0.1], [1.0, 0.6]],
  triangle: [[0.0, 0.1], [0.12, 0.9], [0.28, 0.2], [0.45, 0.75], [0.62, 0.32], [0.8, 0.62], [1.0, 0.45]],
};

function knotsToPoints(knots: readonly (readonly [number, number])[]): string {
  // v=1 is the archetype's high point; SVG y grows downward, so it's flipped.
  return knots.map(([t, v]) => `${(t * 100).toFixed(1)},${((1 - v) * 100).toFixed(1)}`).join(" ");
}

/** A saved preset's own glyph: its bars' closes, normalized to the unit
 *  square — unlike the built-ins there is no idealized archetype, only the
 *  literal shape the user captured. */
function barsToPoints(bars: PatternBar[]): string {
  if (bars.length === 0) return "";
  const closes = bars.map((b) => b.c);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const n = bars.length - 1 || 1;
  return bars
    .map((b, i) => `${((i / n) * 100).toFixed(1)},${((1 - (b.c - lo) / span) * 100).toFixed(1)}`)
    .join(" ");
}

function Glyph({ points }: { points: string }) {
  return (
    <svg className="preset-glyph" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

// Same tiny date helpers PatternMatchesPanel uses, duplicated rather than
// imported: they're presentational one-liners, not worth a shared module for
// two call sites.
function stamp(ts: number, timezone: string): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: timezone || "UTC",
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function day(ts: number, timezone: string): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    timeZone: timezone || "UTC", year: "numeric", month: "short", day: "2-digit",
  });
}

const STATUS_MSG: Record<string, string> = {
  "no-history": "no stored history",
  "too-few-bars": "too few bars",
};

function chartStatusLine(c: PresetChartResult): string | null {
  if (c.status === "ok") return null;
  if (c.status === "error") return c.error ?? "scan failed";
  return STATUS_MSG[c.status] ?? c.status;
}

/** hit.tell reads as one of two fixed strings; no percentage rides along on
 *  the wire (PresetHit has no such field), so this only relabels it — it does
 *  not invent a number. */
function tellLabel(tell: string): string {
  return tell === "partial-rise" ? "partial rise" : tell === "partial-decline" ? "partial decline" : tell;
}

function hitToMatch(hit: PresetHit, epic: string, resolution: string): PatternMatch {
  // A preset scan spans every open chart, not one dragged-on origin, so the
  // hit itself carries no cellId — resolve the real MatchSource (cellId,
  // tabId, label) from the workspace's series provider by epic+resolution.
  // Without this, jumpToMatch is handed cellId "" for a series that lives on
  // another tab, and its cross-tab park-and-reveal fails with a misleading
  // "no open chart shows..." toast even though a chart DOES show it.
  const source = findPatternSource(epic, resolution) ?? { cellId: "", epic, resolution, label: resolution };
  return {
    ts: hit.ts, endTs: hit.endTs, distance: hit.distance, bars: hit.bars,
    forward: [], forwardComplete: false, forwardPct: null,
    source,
  };
}

interface Props {
  broker: string;
  priceSide: string;
  timezone: string;
  onReveal: (cellId: string) => boolean;
}

export default function PresetScanView({ broker, priceSide, timezone, onReveal }: Props) {
  const st = useSyncExternalStore(subscribePatternPanel, getPatternPanelState);

  // A drag-search opens the panel without ever fetching the manifest — this
  // is the view that actually needs it, so it kicks the fetch off itself.
  // openPatternPanel() is idempotent (guarded in the store) and retries on
  // the next mount if the previous fetch failed, so calling it unconditionally
  // here is safe even if a prior open already succeeded.
  useEffect(() => {
    openPatternPanel();
  }, []);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const families = st.families ?? [];
  const userPresets = st.userPresets ?? [];
  const familyTitle = (key: string): string =>
    families.find((f) => f.family === key)?.title
    ?? userPresets.find((p) => `user:${p.id}` === key)?.name
    ?? key;

  const startRename = (p: UserPreset) => {
    setRenamingId(p.id);
    setRenameValue(p.name);
  };
  const confirmRename = async (id: string) => {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    try {
      await renameUserPreset(id, trimmed);
      await refreshUserPresets();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const doDelete = async (id: string) => {
    try {
      await deleteUserPreset(id);
      const key = `user:${id}`;
      if (st.selectedFamilies.includes(key)) toggleFamily(key);
      await refreshUserPresets();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const charts = getPresetScanCharts();
  const scanDisabled = st.presetLoading || st.selectedFamilies.length === 0 || charts.length === 0;

  const onFindSimilar = (chart: PresetChartResult, hit: PresetHit) => {
    runPatternSearch({
      origin: { cellId: "", epic: chart.epic, resolution: chart.resolution, label: chart.resolution },
      broker, priceSide,
      bars: hit.bars,
      range: { fromMs: hit.ts * 1000, toMs: hit.endTs * 1000 },
    });
    setPatternView("similar");
  };

  return (
    <div className="preset-scan">
      <div className="preset-cards">
        {families.map((f) => (
          <button
            key={f.family}
            type="button"
            className={"preset-card" + (st.selectedFamilies.includes(f.family) ? " selected" : "")}
            onClick={() => toggleFamily(f.family)}
            aria-pressed={st.selectedFamilies.includes(f.family)}
          >
            <Glyph points={knotsToPoints(GLYPHS[f.family] ?? [[0, 0.5], [1, 0.5]])} />
            <span className="preset-card-title">{f.title}</span>
          </button>
        ))}
        {userPresets.length > 0 && (
          <div className="preset-cards-group">
            <span className="preset-cards-group-title">Your presets</span>
            <div className="preset-cards">
              {userPresets.map((p) => {
                const key = `user:${p.id}`;
                return (
                  <div
                    key={p.id}
                    className={"preset-card preset-card-user" + (st.selectedFamilies.includes(key) ? " selected" : "")}
                  >
                    <button
                      type="button"
                      className="preset-card-body"
                      onClick={() => toggleFamily(key)}
                      aria-pressed={st.selectedFamilies.includes(key)}
                    >
                      <Glyph points={barsToPoints(p.bars)} />
                      {renamingId === p.id ? (
                        <input
                          autoFocus
                          className="preset-card-rename"
                          value={renameValue}
                          aria-label={`Rename ${p.name}`}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmRename(p.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={() => setRenamingId(null)}
                        />
                      ) : (
                        <span className="preset-card-title">{p.name}</span>
                      )}
                    </button>
                    <span className="preset-card-actions">
                      <Tooltip content="Rename">
                        <button
                          type="button"
                          aria-label={`Rename ${p.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(p);
                          }}
                        >
                          ✎
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete">
                        <button
                          type="button"
                          aria-label={`Delete ${p.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            doDelete(p.id);
                          }}
                        >
                          ✕
                        </button>
                      </Tooltip>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {st.familiesError && <div className="preset-msg preset-err">{st.familiesError}</div>}

      {st.selectedFamilies
        .map((key) => families.find((f) => f.family === key))
        .filter((f): f is PresetFamily => f != null)
        .map((f) => {
          const overrides = st.paramsByFamily[f.family] ?? {};
          const strictness = f.params.find((p) => p.name === "strictness");
          const rest = f.params.filter((p) => p.name !== "strictness");
          const step = (p: PresetParamSchema) => (p.type === "int" ? 1 : (p.max - p.min) / 100 || 0.01);
          const val = (p: PresetParamSchema) => overrides[p.name] ?? p.default;
          return (
            <div key={f.family} className="preset-params-group">
              <div className="preset-params-title">{f.title}</div>
              {strictness && (
                <label className="preset-param-row">
                  {strictness.name}
                  <input
                    type="range"
                    min={strictness.min}
                    max={strictness.max}
                    step={step(strictness)}
                    value={val(strictness)}
                    aria-label={strictness.name}
                    onChange={(e) => setFamilyParam(f.family, strictness.name, Number(e.target.value))}
                  />
                  <span className="preset-param-val">{val(strictness)}</span>
                  <InfoTip title={strictness.name} text={strictness.help} />
                </label>
              )}
              {rest.length > 0 && (
                <details className="preset-advanced">
                  <summary>Advanced</summary>
                  {/* Two params per row: the panel is ~400px and each field is a
                      short number, so one-per-row wastes half the height. */}
                  <div className="preset-advanced-grid">
                    {rest.map((p) => (
                      <label key={p.name} className="preset-param-cell">
                        <span className="preset-param-name">{p.name}</span>
                        <span className="preset-param-field">
                          <input
                            type="number"
                            min={p.min}
                            max={p.max}
                            step={step(p)}
                            value={val(p)}
                            aria-label={p.name}
                            onChange={(e) => setFamilyParam(f.family, p.name, Number(e.target.value))}
                          />
                          <InfoTip title={p.name} text={p.help} />
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}

      <button
        type="button"
        className="preset-scan-btn"
        disabled={scanDisabled}
        onClick={() => runPresetScanNow(broker, priceSide)}
      >
        {st.presetLoading ? "Scanning…" : "Scan open charts"}
      </button>

      {st.presetError && <div className="preset-msg preset-err">{st.presetError}</div>}

      {st.presetResult && (
        <div className="preset-results">
          {st.presetResult.charts.map((c) => {
            const statusLine = chartStatusLine(c);
            return (
              <div key={`${c.epic}|${c.resolution}`} className="preset-chart-group">
                <div className="preset-chart-head">
                  {c.epic} · {c.resolution} ({c.hits.length})
                </div>
                {statusLine ? (
                  <div className="preset-msg">{statusLine}</div>
                ) : (
                  <ul className="preset-hit-list">
                    {c.hits.map((h, i) => {
                      // Identifies the row within THIS result set; a rescan
                      // clears the store's selection with the rows it named.
                      const hitKey = `${c.epic}|${c.resolution}|${h.family}|${h.ts}|${h.endTs}`;
                      return (
                      <li key={i} className="preset-hit-row-wrap">
                        <button
                          type="button"
                          className={
                            "preset-hit-row" +
                            (st.presetSelectedHit === hitKey ? " selected" : "")
                          }
                          aria-label={`Go to ${h.variant} match, ${stamp(h.ts, timezone)}`}
                          aria-pressed={st.presetSelectedHit === hitKey}
                          onClick={() => {
                            setPresetSelectedHit(hitKey);
                            jumpToMatch(hitToMatch(h, c.epic, c.resolution), onReveal);
                          }}
                        >
                          <span className={h.forming ? "preset-badge-forming" : "preset-badge-done"}>
                            {h.forming ? "forming" : "done"}
                          </span>
                          <span className="preset-hit-title">
                            {h.variant} <span className="preset-hit-family">· {familyTitle(h.family)}</span>
                          </span>
                          <span className="preset-hit-range">
                            {stamp(h.ts, timezone)} – {day(h.endTs, timezone)}
                          </span>
                          <span className="preset-hit-stats">
                            {h.breakoutUpPct != null && <span>{h.breakoutUpPct}% up</span>}
                            {h.target != null && <span>→ {h.target.toFixed(1)}</span>}
                            {h.tell && <span className="preset-hit-tell">{tellLabel(h.tell)}</span>}
                            {(h.breakoutUpPct != null || h.tell) && (
                              <InfoTip title="Source" text={h.source} />
                            )}
                            <span className="preset-hit-dist">{h.distance.toFixed(2)}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="preset-find-similar"
                          onClick={(e) => {
                            e.stopPropagation();
                            onFindSimilar(c, h);
                          }}
                        >
                          Find similar
                        </button>
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
