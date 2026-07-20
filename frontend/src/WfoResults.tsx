// Walk-forward results panel: robustness scorecard, train-span matrix strip,
// per-fold table with drill-in, and a parameter-drift strip. Renders off the
// WfoRunState mirror (live run or archive reconstruction); all numbers come
// from the backend result payload, nothing is recomputed here.
import { memo, useState } from "react";
import type { SweepRow, WfoFold, WfoScheme } from "./api";
import type { WfoRunState } from "./lib/signals";
import type { SweepAxis, SweepCombo } from "./lib/sweep";
import { comboAxisLabel } from "./lib/sweep";
import { formatPeriodDateRange } from "./lib/backtestPeriods";
import { SweepResults, SweepSortHeader, type SortDir } from "./SweepResults";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";

const PHASE_LABEL: Record<string, string> = {
  grid: "evaluating grid",
  test: "testing winners",
  aggregate: "aggregating",
};

// Trailing-zero-trimmed fixed formatting; en dash for missing values.
function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "–";
  const s = v.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
function fmtPct01(v: number | null | undefined): string {
  return v == null || !isFinite(v) ? "–" : `${Math.round(v * 100)}%`;
}

// Fold-index -> chosen-value step line for one axis. x walks the folds, y is
// the value's rank among the axis's sorted unique swept values (higher value
// higher on the chart); null (no winner that fold) lifts the pen so the line
// breaks. Pure and exported for tests.
export function driftPath(values: Array<number | string | null>): string {
  const W = 220, H = 36, PAD = 4;
  const present = values.filter((v): v is number | string => v != null);
  if (present.length === 0) return "";
  const uniq = Array.from(new Set(present)).sort((a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)),
  );
  const xFor = (i: number) =>
    values.length === 1 ? W / 2 : PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const yFor = (v: number | string) =>
    uniq.length === 1 ? H / 2 : H - PAD - (uniq.indexOf(v) / (uniq.length - 1)) * (H - 2 * PAD);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${d ? " " : ""}${pen ? "L" : "M"}${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

type FoldCol = "window" | "is_obj" | "oos_return" | "oos_trades" | "wfe";

function foldColValue(f: WfoFold, col: FoldCol, metric: string): number | null {
  switch (col) {
    case "window": return f.test_from;
    case "is_obj": return f.is_metrics?.[metric] ?? null;
    case "oos_return": return f.oos_metrics?.return_pct ?? null;
    case "oos_trades": return f.oos_metrics?.n_trades ?? null;
    case "wfe": return f.wfe;
  }
}

const SCORE_TIP = [
  "0-100 blend of the walk-forward health checks:",
  "30% walk-forward efficiency, 20% folds profitable, 15% OOS Sharpe, 15% parameter stability, 10% OOS drawdown, 10% plateau breadth.",
  "Discounted when total OOS trades or the fold count is low.",
];
const WFE_TIP =
  "Out-of-sample return relative to in-sample, annualized. Above ~0.5 is strong; negative means train gains did not carry forward";

// Fold-table endpoints 404 an hour after the job clears from the runner; the
// drill-in surfaces this fixed copy rather than the raw fetch error.
const FOLD_EXPIRY_COPY = "Fold tables expire with the job; reopen from the archive";

export const WfoResults = memo(function WfoResults(props: {
  state: WfoRunState;
  onApplyCombo: (combo: Record<string, number | boolean | string>) => void;
  onLoadFoldTable: (key: string) => Promise<SweepRow[]>;
  axes: SweepAxis[];
  schemeIndex: number;
  onSchemeIndex: (i: number) => void;
}): JSX.Element {
  const { state, onApplyCombo, onLoadFoldTable, axes, schemeIndex, onSchemeIndex } = props;
  const result = state.result;
  const schemes = result?.schemes ?? [];
  const scheme: WfoScheme | undefined = schemes[schemeIndex] ?? schemes[0];
  const metric = result?.objective?.metric ?? "objective";

  const [sort, setSort] = useState<{ key: FoldCol; dir: SortDir } | null>(null);
  const toggleSort = (key: FoldCol) =>
    setSort((s) => (s?.key === key ? (s.dir === "desc" ? { key, dir: "asc" } : null) : { key, dir: "desc" }));

  // Drill-in: one expanded fold at a time. `expandedKey` is the open fold (null
  // when collapsed); fetched tables are cached per key in `foldCache` so
  // collapsing and re-expanding never refetches. A cached entry's `rows === null`
  // means the fetch is still in flight, `error` set means it failed.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [foldCache, setFoldCache] = useState<Record<string, { rows: SweepRow[] | null; error?: string }>>({});
  const toggleFold = (key: string) => {
    if (expandedKey === key) { setExpandedKey(null); return; }
    setExpandedKey(key);
    if (foldCache[key]) return; // already fetched (or fetching) — use the cache
    setFoldCache((c) => ({ ...c, [key]: { rows: null } }));
    onLoadFoldTable(key)
      .then((rows) => setFoldCache((c) => ({ ...c, [key]: { rows } })))
      .catch(() => setFoldCache((c) => ({ ...c, [key]: { rows: [], error: FOLD_EXPIRY_COPY } })));
  };
  const expanded = expandedKey ? { key: expandedKey, ...(foldCache[expandedKey] ?? { rows: null }) } : null;

  const comboText = (combo: Record<string, number | boolean | string>): string =>
    axes.length
      ? axes.map((a) => comboAxisLabel(a, combo as SweepCombo)).join(", ")
      : Object.entries(combo).map(([k, v]) => `${k.replace(/^param:/, "")} ${v}`).join(", ");

  // Sorted view of the selected scheme's folds; original index rides along so
  // fold keys (s{scheme}/f{fold}) stay correct under any sort order.
  const folds = (scheme?.folds ?? []).map((f, i) => ({ f, i }));
  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    folds.sort((a, b) => {
      const av = foldColValue(a.f, sort.key, metric);
      const bv = foldColValue(b.f, sort.key, metric);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  const rb = scheme?.robustness ?? {};
  const score = rb.robustness_score ?? null;
  const scoreTone = score == null ? "" : score >= 60 ? " pos" : score < 40 ? " neg" : "";
  const gridErrors = result?.grid_errors;
  const allFailed = gridErrors != null && gridErrors.total > 0 && gridErrors.failed === gridErrors.total;

  const stats: Array<{ label: string; value: string; tip: string; tone?: string }> = [
    { label: "WFE (median)", value: fmt(rb.wfe_median), tip: WFE_TIP,
      tone: rb.wfe_median != null ? (rb.wfe_median >= 0.5 ? " pos" : rb.wfe_median < 0 ? " neg" : "") : "" },
    { label: "Folds profitable", value: fmtPct01(rb.pct_folds_profitable),
      tip: "Share of test windows that ended positive." },
    { label: "OOS Sharpe", value: fmt(rb.oos_sharpe),
      tip: "Sharpe ratio of the stitched out-of-sample equity." },
    { label: "OOS max DD", value: rb.oos_max_drawdown_pct == null ? "–" : `${fmt(rb.oos_max_drawdown_pct, 1)}%`,
      tip: "Largest peak-to-trough drop of the stitched out-of-sample equity." },
    { label: "Stability", value: fmt(rb.param_stability),
      tip: "How steady the winning parameters stay from fold to fold. 1 means the same pick every fold." },
    { label: "OOS trades", value: fmt(rb.oos_trades_total, 0),
      tip: "Total trades across all test windows." },
  ];

  return (
    <div className="wfo-results">
      {state.running && (
        <div className="sweep-progress">
          <span>{PHASE_LABEL[state.phase] ?? state.phase}</span>
          <span>{state.done} / {state.total}</span>
          <div className="sweep-progress-bar">
            <div
              className="sweep-progress-fill"
              style={{ width: `${state.total ? (state.done / state.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {allFailed && (
        <div className="wfo-error">
          All {gridErrors.total} combos failed{gridErrors.sample ? `: ${gridErrors.sample}` : ""}
        </div>
      )}

      {/* Streaming view while the job runs: winner rows as they land. */}
      {state.running && !result && state.foldRows.length > 0 && (
        <table className="sweep-table wfo-folds-table">
          <thead>
            <tr><th>Fold</th><th>Params</th><th>OOS net</th></tr>
          </thead>
          <tbody>
            {state.foldRows.map((r) => (
              <tr key={r.key} className="wfo-stream-row">
                <td>{r.key}</td>
                <td>
                  {r.combo ? comboText(r.combo)
                    : r.error ? <Tooltip content={r.error}><span>failed</span></Tooltip>
                    : <span className="wfo-dim">no eligible winner</span>}
                </td>
                <td>{fmt(r.oos_metrics?.net_pnl ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result && scheme && (
        <>
          <div className="wfo-scorecard">
            <div className="bt-panel-stat wfo-score-lead">
              <span className="bt-panel-stat-label">
                <span className="bt-panel-stat-name">Robustness</span>
                <InfoTip title="Robustness score" text={SCORE_TIP} />
              </span>
              <span className={`bt-panel-stat-value wfo-score-value${scoreTone}`}>{fmt(score, 1)}</span>
            </div>
            {stats.map((s) => (
              <div className="bt-panel-stat" key={s.label}>
                <span className="bt-panel-stat-label">
                  <span className="bt-panel-stat-name">{s.label}</span>
                  <InfoTip title={s.label} text={s.tip} />
                </span>
                <span className={`bt-panel-stat-value${s.tone ?? ""}`}>{s.value}</span>
              </div>
            ))}
          </div>

          {schemes.length > 1 && (
            <table className="sweep-table wfo-matrix">
              <thead>
                <tr>
                  <th>Train</th><th>Score</th><th>WFE</th><th>Folds+</th>
                  <th>Sharpe</th><th>DD</th><th>Stability</th>
                </tr>
              </thead>
              <tbody>
                {schemes.map((s, i) => (
                  <tr
                    key={s.train_span + i}
                    className={`wfo-matrix-row${i === schemeIndex ? " seg-on" : ""}`}
                    onClick={() => onSchemeIndex(i)}
                  >
                    <td>{s.train_span}</td>
                    <td>{fmt(s.robustness?.robustness_score ?? null, 1)}</td>
                    <td>{fmt(s.robustness?.wfe_median ?? null)}</td>
                    <td>{fmtPct01(s.robustness?.pct_folds_profitable ?? null)}</td>
                    <td>{fmt(s.robustness?.oos_sharpe ?? null)}</td>
                    <td>{s.robustness?.oos_max_drawdown_pct == null ? "–" : `${fmt(s.robustness.oos_max_drawdown_pct, 1)}%`}</td>
                    <td>{fmt(s.robustness?.param_stability ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <table className="sweep-table wfo-folds-table">
            <thead>
              <tr>
                <th><SweepSortHeader<FoldCol> label="Window" col="window" sort={sort} onSort={toggleSort} /></th>
                <th>Params</th>
                <th><SweepSortHeader<FoldCol> label={`IS ${metric}`} col="is_obj" sort={sort} onSort={toggleSort} /></th>
                <th><SweepSortHeader<FoldCol> label="OOS ret %" col="oos_return" sort={sort} onSort={toggleSort} /></th>
                <th><SweepSortHeader<FoldCol> label="OOS trades" col="oos_trades" sort={sort} onSort={toggleSort} /></th>
                <th><SweepSortHeader<FoldCol> label="WFE" col="wfe" sort={sort} onSort={toggleSort} /></th>
                <th />
              </tr>
            </thead>
            <tbody>
              {folds.map(({ f, i }) => {
                const key = `s${Math.min(schemeIndex, schemes.length - 1)}/f${i}`;
                const window = formatPeriodDateRange(f.test_from * 1000, f.test_to * 1000);
                const noWinner = f.combo === null && f.error === null;
                const open = expanded?.key === key;
                return (
                  <FoldRowGroup key={key} open={open}>
                    <tr
                      className={`wfo-fold-row${f.low_sample ? " sweep-error" : ""}${open ? " wfo-fold-open" : ""}`}
                      onClick={() => toggleFold(key)}
                    >
                      <td>{window}</td>
                      {noWinner ? (
                        <td colSpan={5} className="wfo-dim">no eligible winner</td>
                      ) : f.error !== null ? (
                        <>
                          <td><Tooltip content={f.error}><span>failed</span></Tooltip></td>
                          <td>–</td><td>–</td><td>–</td><td>–</td>
                        </>
                      ) : (
                        <>
                          <td>{f.combo ? comboText(f.combo) : "–"}</td>
                          <td>{fmt(f.is_metrics?.[metric] ?? null)}</td>
                          <td>{f.oos_metrics?.return_pct == null ? "–" : `${fmt(f.oos_metrics.return_pct, 1)}%`}</td>
                          <td>{fmt(f.oos_metrics?.n_trades ?? null, 0)}</td>
                          <td>{fmt(f.wfe)}</td>
                        </>
                      )}
                      <td>
                        {f.combo && (
                          <button
                            type="button"
                            className="ghost wfo-apply"
                            onClick={(e) => { e.stopPropagation(); onApplyCombo(f.combo!); }}
                          >
                            Apply
                          </button>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="wfo-fold-drill">
                        <td colSpan={7}>
                          {expanded!.error ? (
                            <div className="wfo-error">{expanded!.error}</div>
                          ) : expanded!.rows === null ? (
                            <div className="wfo-dim">Loading fold table…</div>
                          ) : (
                            <SweepResults
                              rows={expanded!.rows}
                              axes={axes}
                              onApply={onApplyCombo}
                              progress={null}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </FoldRowGroup>
                );
              })}
            </tbody>
          </table>

          {Object.keys(scheme.stability?.per_axis ?? {}).length > 0 && (
            <div className="wfo-drift">
              {Object.entries(scheme.stability.per_axis).map(([target, ax]) => {
                const label =
                  axes.find((a) => a.kind !== "list" && "target" in a && a.target === target)?.label ??
                  target.replace(/^param:/, "");
                return (
                  <div className="wfo-drift-axis" key={target}>
                    <span className="wfo-drift-label">{label}</span>
                    <span className="wfo-drift-nums">
                      stability {fmt(ax.stability)} · adjacency {fmt(ax.adjacency)}
                    </span>
                    <svg width={220} height={36} className="wfo-drift-line" aria-hidden="true">
                      <path d={driftPath(ax.values)} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
                    </svg>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
});

// Fragment wrapper so a fold row and its drill-in row share one list key
// without an extra tbody per fold.
function FoldRowGroup({ children }: { open: boolean; children: React.ReactNode }) {
  return <>{children}</>;
}
