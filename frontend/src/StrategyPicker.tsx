// Picker for coded strategies (backend/strategies/*.py, authored in the user's
// IDE): dropdown of discovered files, always-visible description, ⟳ reload
// (the file list changes on disk between runs), and a collapsed read-only
// source view so you can confirm WHICH version you're about to run.

import { useEffect, useState } from "react";
import { fetchStrategies, fetchStrategySource, type StrategyInfo } from "./api";
import Tooltip from "./components/Tooltip";

interface Props {
  value: string | undefined;
  onChange: (filename: string) => void;
}

export default function StrategyPicker({ value, onChange }: Props) {
  const [list, setList] = useState<StrategyInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  async function reload() {
    try {
      setList(await fetchStrategies());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "failed to load strategies");
    }
  }
  useEffect(() => void reload(), []);

  // Source view follows the selection; refetch on toggle so it's never stale.
  async function toggleSource() {
    const next = !showSource;
    setShowSource(next);
    if (next && value) {
      try {
        setSource(await fetchStrategySource(value));
      } catch (e) {
        setSource(e instanceof Error ? e.message : "failed to load source");
      }
    }
  }
  useEffect(() => {
    setShowSource(false);
    setSource(null);
  }, [value]);

  const selected = list.find((s) => s.filename === value);

  return (
    <div className="strat-picker">
      <div className="strat-picker-row">
        <select
          className="strat-picker-select"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>
            Pick a strategy…
          </option>
          {list.map((s) => (
            <option key={s.filename} value={s.filename} disabled={s.error !== null}>
              {s.error ? `${s.name} (broken)` : s.name}
            </option>
          ))}
        </select>
        <Tooltip content="Re-scan backend/strategies/ for new or edited files">
          <button className="anchor-btn" aria-label="Reload strategies" onClick={() => void reload()}>
            ⟳
          </button>
        </Tooltip>
      </div>
      {loadError && <div className="strat-picker-error">{loadError}</div>}
      {selected && (
        <>
          <div className="strat-picker-meta">
            <span className="strat-picker-name">{selected.name}</span>
            <span className="strat-picker-file">{selected.filename}</span>
            {selected.hedged && <span className="strat-picker-badge">hedged — backtest only</span>}
          </div>
          {selected.error ? (
            <div className="strat-picker-error">{selected.error}</div>
          ) : selected.description ? (
            <p className="strat-picker-desc">{selected.description}</p>
          ) : (
            <p className="strat-picker-desc strat-picker-desc-empty">
              No description — add a docstring or meta[&quot;description&quot;] to the file.
            </p>
          )}
          <button className="strat-picker-src-toggle" onClick={() => void toggleSource()}>
            {showSource ? "▾" : "▸"} View source
          </button>
          {showSource && source !== null && (
            <pre className="strat-picker-src">{source}</pre>
          )}
        </>
      )}
    </div>
  );
}
