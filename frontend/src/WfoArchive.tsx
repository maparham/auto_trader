// Walk-forward archive: the robustness ranking view. Lists past walk-forward
// runs saved server-side, ranked by robustness score (nulls last), and opens one
// back into the results panel on row click. This is the design's ranking view
// (9.4): score leads, net profit is intentionally absent from the summaries.
import { useEffect, useState } from "react";
import {
  listWfoArchives,
  getWfoArchive,
  deleteWfoArchive,
  type WfoArchiveSummary,
  type WfoResult,
} from "./api";
import { periodByResolution } from "./lib/feed";
import { requestConfirm } from "./lib/signals";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";

const SCORE_TIP = [
  "0-100 blend of the walk-forward health checks:",
  "30% walk-forward efficiency, 20% folds profitable, 15% OOS Sharpe, 15% parameter stability, 10% OOS drawdown, 10% plateau breadth.",
  "Discounted when total OOS trades or the fold count is low. Runs are ranked by this score.",
];

function fmtScore(v: number | null): string {
  if (v == null || !isFinite(v)) return "–";
  const s = v.toFixed(1);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
function fmtWfe(v: number | null): string {
  if (v == null || !isFinite(v)) return "–";
  const s = v.toFixed(2);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
function scoreTone(v: number | null): string {
  if (v == null) return "";
  return v >= 60 ? " pos" : v < 40 ? " neg" : "";
}

// Score desc, nulls last, then newest first as a stable tiebreak.
function rankSummaries(rows: WfoArchiveSummary[]): WfoArchiveSummary[] {
  return [...rows].sort((a, b) => {
    const as = a.robustness_score;
    const bs = b.robustness_score;
    if (as == null && bs == null) return b.created_at - a.created_at;
    if (as == null) return 1;
    if (bs == null) return -1;
    if (bs !== as) return bs - as;
    return b.created_at - a.created_at;
  });
}

export function WfoArchive(props: {
  epic?: string;
  onOpen: (archive: { id: string; result: WfoResult }) => void;
}): JSX.Element {
  const { epic, onOpen } = props;
  // Scope: this epic (default) vs all epics. No toggle when there is no epic to
  // scope to — the list is already "all".
  const [allEpics, setAllEpics] = useState(false);
  const [rows, setRows] = useState<WfoArchiveSummary[] | null>(null);

  const refresh = () => {
    const scope = allEpics ? undefined : epic;
    listWfoArchives(scope)
      .then((rs) => setRows(rankSummaries(rs)))
      .catch((e) => {
        console.warn("list walk-forward archives failed", e);
        setRows([]);
      });
  };
  useEffect(() => {
    let alive = true;
    const scope = allEpics ? undefined : epic;
    listWfoArchives(scope)
      .then((rs) => { if (alive) setRows(rankSummaries(rs)); })
      .catch((e) => {
        console.warn("list walk-forward archives failed", e);
        if (alive) setRows([]);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epic, allEpics]);

  const open = (id: string) => {
    getWfoArchive(id)
      .then((a) => onOpen({ id: a.id, result: a.result }))
      .catch((e) => console.warn("open walk-forward archive failed", e));
  };

  const remove = (s: WfoArchiveSummary) => {
    requestConfirm({
      title: "Delete run",
      message: `Delete this ${s.epic} walk-forward run from ${new Date(s.created_at * 1000).toLocaleDateString()}?`,
      confirmLabel: "Delete",
      onConfirm: () => {
        deleteWfoArchive(s.id)
          .then(refresh)
          .catch((e) => console.warn("delete walk-forward archive failed", e));
      },
    });
  };

  return (
    <div className="wfo-arch">
      {epic && (
        <div className="wfo-arch-head">
          <div className="seg" role="group" aria-label="Archive scope">
            <button
              type="button"
              className={allEpics ? "" : "seg-on"}
              aria-pressed={!allEpics}
              onClick={() => setAllEpics(false)}
            >
              This symbol
            </button>
            <button
              type="button"
              className={allEpics ? "seg-on" : ""}
              aria-pressed={allEpics}
              onClick={() => setAllEpics(true)}
            >
              All symbols
            </button>
          </div>
        </div>
      )}

      {rows != null && rows.length === 0 ? (
        <div className="bt-results-empty">
          No walk-forward runs yet. Results save here automatically when a run finishes.
        </div>
      ) : rows == null ? null : (
        <table className="sweep-table wfo-arch-table">
          <thead>
            <tr>
              <th>
                <span className="wfo-arch-th">
                  Score
                  <InfoTip title="Robustness score" text={SCORE_TIP} />
                </span>
              </th>
              <th>WFE</th>
              <th>Schemes</th>
              <th>Symbol</th>
              <th>TF</th>
              <th>Date</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="wfo-arch-row" onClick={() => open(s.id)}>
                <td className={`wfo-arch-score${scoreTone(s.robustness_score)}`}>
                  {fmtScore(s.robustness_score)}
                </td>
                <td>{fmtWfe(s.wfe_median)}</td>
                <td>{s.n_schemes ?? "–"}</td>
                <td>{s.epic}</td>
                <td>{periodByResolution(s.timeframe)?.label ?? s.timeframe}</td>
                <td>{new Date(s.created_at * 1000).toLocaleDateString()}</td>
                <td>
                  <Tooltip content="Delete this run">
                    <button
                      type="button"
                      className="wfo-arch-del"
                      aria-label="Delete this run"
                      onClick={(e) => { e.stopPropagation(); remove(s); }}
                    >
                      <TrashIcon />
                    </button>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}
