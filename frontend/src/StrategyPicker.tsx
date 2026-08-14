// Picker for coded strategies (backend/strategies/*.py, authored in the user's
// IDE): dropdown of discovered files, always-visible description, ⟳ reload
// (the file list changes on disk between runs), and a Guide button for the
// built-in strategies (illustrated document, see StrategyGuideModal).
//
// The discovered list is fetched by the PARENT (BacktestSettingsModal) and
// passed in, rather than fetched here, so the parent can also read the
// selected strategy's `params` schema (for the Parameters/Risk/Exit sections)
// without a second, out-of-sync fetch. This component keeps the reload button
// — clicking it calls the parent's `onReload`.

import { useState } from "react";
import type { StrategyInfo } from "./api";
import Tooltip from "./components/Tooltip";
import StrategyGuideModal from "./StrategyGuideModal";
import { strategyGuides } from "./strategyGuides";

interface Props {
  value: string | undefined;
  onChange: (filename: string) => void;
  list: StrategyInfo[];
  loadError: string | null;
  onReload: () => void;
}

const BULLET_RE = /^\s*[•▪‣*-]\s+/;

// Docstrings arrive as hard-wrapped plain text with "•" bullet lines. Turn
// them into prose paragraphs + a proper list: wrapped lines join with a space,
// blank lines split lead paragraphs, and each bullet (with its continuation
// lines) becomes one item.
function parseDescription(text: string): { paragraphs: string[]; bullets: string[] } {
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  let current: string[] = [];
  let inBullet = false;

  const flush = () => {
    if (!current.length) return;
    const joined = current.join(" ").replace(/\s+/g, " ").trim();
    if (joined) (inBullet ? bullets : paragraphs).push(joined);
    current = [];
  };

  for (const line of text.split("\n")) {
    if (BULLET_RE.test(line)) {
      flush();
      inBullet = true;
      current.push(line.replace(BULLET_RE, ""));
    } else if (!line.trim()) {
      flush();
      inBullet = false;
    } else {
      // Continuation of the current paragraph/bullet.
      current.push(line.trim());
    }
  }
  flush();
  return { paragraphs, bullets };
}

function Description({ text }: { text: string }) {
  const { paragraphs, bullets } = parseDescription(text);
  return (
    <div className="strat-picker-desc">
      {paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {bullets.length > 0 && (
        <ul className="strat-picker-desc-list">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StrategyPicker({ value, onChange, list, loadError, onReload }: Props) {
  // Which strategy's guide is open, keyed by filename so switching strategies
  // implicitly closes it (no effect needed).
  const [guideFor, setGuideFor] = useState<string | null>(null);

  const selected = list.find((s) => s.filename === value);
  // Illustrated guides ship only for the built-in strategies; user-authored
  // files simply have no Guide button.
  const guide = selected && !selected.error ? strategyGuides[selected.filename] : undefined;
  const showGuide = selected !== undefined && guideFor === selected.filename;

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
          <button className="anchor-btn" aria-label="Reload strategies" onClick={onReload}>
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
            {guide && (
              <Tooltip content="Open the illustrated guide: how the strategy trades, with diagrams">
                <button className="sg-open-btn" onClick={() => setGuideFor(selected.filename)}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H12v17.5H4.5A2.5 2.5 0 0 0 2 22V4.5Z" />
                    <path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H12v17.5h7.5A2.5 2.5 0 0 1 22 22V4.5Z" />
                  </svg>
                  Guide
                </button>
              </Tooltip>
            )}
          </div>
          {selected.error ? (
            <div className="strat-picker-error">{selected.error}</div>
          ) : selected.description ? (
            <Description text={selected.description} />
          ) : (
            <p className="strat-picker-desc strat-picker-desc-empty">
              No description — add a docstring or meta[&quot;description&quot;] to the file.
            </p>
          )}
          {showGuide && guide && (
            <StrategyGuideModal strategy={selected} guide={guide} onClose={() => setGuideFor(null)} />
          )}
        </>
      )}
    </div>
  );
}
