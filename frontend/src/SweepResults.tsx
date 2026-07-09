// Parameter-sweep results: a sortable metrics table (best value per column
// subtly highlighted, failed combos greyed with the error on hover) plus a
// heatmap for exactly 2 axes (a DOM grid, diverging color scale around 0 on a
// selectable metric) or a single-row strip for 1 axis. Clicking any row/cell
// applies that combo via onApply. Session-state only — never persisted.
// (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import { Fragment, useState } from "react";
import type { SweepRow } from "./api";
import type { SweepAxis } from "./lib/sweep";
import Tooltip from "./components/Tooltip";

type MetricKey = "net_pnl" | "return_pct" | "n_trades" | "win_rate" | "max_drawdown" | "profit_factor";

const METRIC_COLS: { key: MetricKey; label: string }[] = [
  { key: "net_pnl", label: "Net P/L" },
  { key: "return_pct", label: "Return %" },
  { key: "n_trades", label: "Trades" },
  { key: "win_rate", label: "Win rate" },
  { key: "max_drawdown", label: "Drawdown" },
  { key: "profit_factor", label: "Profit factor" },
];

type SortDir = "asc" | "desc";

function metricValue(row: SweepRow, key: MetricKey): number | null {
  return row.metrics?.[key] ?? null;
}

function fmtMetric(key: MetricKey, v: number | null): string {
  if (v === null) return "—";
  if (key === "win_rate") return `${(v * 100).toFixed(0)}%`;
  if (key === "return_pct") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  if (key === "net_pnl") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  if (key === "max_drawdown") return v.toFixed(2);
  if (key === "n_trades") return String(v);
  return v.toFixed(2);
}

function comboLabel(combo: SweepRow["combo"], axes: SweepAxis[]): string {
  return axes.map((a) => `${a.label} ${combo[a.target]}`).join(", ");
}

// Diverging background: neutral at 0, green ramping positive, red ramping
// negative, scaled by the row set's own min/max magnitude (never a fixed
// domain — a sweep's net P/L range varies wildly by instrument/window).
function divergingBg(v: number | null, maxAbs: number): string {
  if (v === null || maxAbs === 0) return "transparent";
  const t = Math.min(1, Math.abs(v) / maxAbs);
  const alpha = 0.12 + t * 0.55;
  return v > 0 ? `rgba(38, 166, 91, ${alpha})` : v < 0 ? `rgba(220, 62, 66, ${alpha})` : "transparent";
}

export function SweepResults(props: {
  rows: SweepRow[];
  axes: SweepAxis[];
  onApply: (combo: Record<string, number | boolean | string>) => void;
  progress?: { done: number; total: number } | null;
}) {
  const { rows, axes, onApply, progress } = props;
  const [sort, setSort] = useState<{ key: MetricKey; dir: SortDir } | null>(null);
  const [heatMetric, setHeatMetric] = useState<MetricKey>("net_pnl");

  const toggleSort = (key: MetricKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  // Failed (metrics === null) rows always sort to the bottom, independent of
  // direction — an error isn't "worse" or "better", it's just not comparable.
  const sortedRows = sort
    ? [...rows].sort((a, b) => {
        const av = metricValue(a, sort.key);
        const bv = metricValue(b, sort.key);
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return sort.dir === "asc" ? av - bv : bv - av;
      })
    : rows;

  // Best value per column (highest wins, except drawdown where smaller-magnitude
  // is better) — only among successful rows.
  const bestByCol: Partial<Record<MetricKey, number>> = {};
  for (const { key } of METRIC_COLS) {
    const vals = rows.map((r) => metricValue(r, key)).filter((v): v is number => v !== null);
    if (!vals.length) continue;
    bestByCol[key] = key === "max_drawdown" ? Math.min(...vals) : Math.max(...vals);
  }

  const heatVals = rows.map((r) => metricValue(r, heatMetric)).filter((v): v is number => v !== null);
  const maxAbs = heatVals.length ? Math.max(...heatVals.map((v) => Math.abs(v))) : 0;

  // While a sweep is still streaming, clicking a row/cell can't apply: the
  // runner is mid-run and a re-run request would silently no-op instead of
  // applying (I2). Rows stay visible (so progress is still legible) but go
  // inert, with a hint explaining why — cancel the sweep (or let it finish)
  // to apply a combo.
  const applyDisabled = !!progress;
  const applyOrNoop = (combo: Record<string, number | boolean | string>) => {
    if (!applyDisabled) onApply(combo);
  };

  return (
    <div className="sweep-results">
      {progress && (
        <div className="sweep-progress">
          <span>{progress.done} / {progress.total}</span>
          <div className="sweep-progress-bar">
            <div
              className="sweep-progress-fill"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {applyDisabled && (
        <div className="al-note sweep-apply-hint">
          Cancel the sweep to apply a combo — results keep landing until then.
        </div>
      )}

      {axes.length > 0 && axes.length <= 2 && (
        <SweepHeatmap
          rows={rows}
          axes={axes}
          metric={heatMetric}
          onMetric={setHeatMetric}
          maxAbs={maxAbs}
          onApply={applyOrNoop}
          disabled={applyDisabled}
        />
      )}

      <div className="sweep-table-wrap">
        <table className="sweep-table">
          <thead>
            <tr>
              <th>Combo</th>
              {METRIC_COLS.map((c) => (
                <th key={c.key} className="sweep-c-num">
                  <SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => {
              const failed = row.metrics === null;
              // The error tooltip wraps the combo CELL's content, not the <tr>:
              // Tooltip renders a wrapper <span>, and a span between <tbody> and
              // <tr> is invalid DOM the browser hoists out of the table.
              const combo = comboLabel(row.combo, axes);
              return (
                <tr
                  key={i}
                  className={`sweep-row${failed ? " sweep-error" : ""}${applyDisabled ? " sweep-row-disabled" : ""}`}
                  aria-disabled={applyDisabled}
                  onClick={() => applyOrNoop(row.combo)}
                >
                  <td>
                    {failed ? <Tooltip content={row.error ?? "failed"}>{combo}</Tooltip> : combo}
                  </td>
                  {METRIC_COLS.map((c) => {
                    const v = metricValue(row, c.key);
                    const isBest = v !== null && bestByCol[c.key] === v;
                    return (
                      <td key={c.key} className={`sweep-c-num${isBest ? " sweep-best" : ""}`}>
                        {fmtMetric(c.key, v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SweepSortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: MetricKey;
  sort: { key: MetricKey; dir: SortDir } | null;
  onSort: (key: MetricKey) => void;
}) {
  const active = sort?.key === col;
  return (
    <button
      type="button"
      className={`sweep-sort${active ? " on" : ""}`}
      onClick={() => onSort(col)}
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span>{label}</span>
      <span className="sweep-sort-caret" aria-hidden="true">
        {active ? (sort!.dir === "asc" ? "▲" : "▼") : ""}
      </span>
    </button>
  );
}

// 2-axis grid (x = axis 0 values, y = axis 1 values) or 1-axis single-row
// strip. Cell background is the diverging scale; click applies that cell's
// combo the same as a table row click.
function SweepHeatmap({
  rows,
  axes,
  metric,
  onMetric,
  maxAbs,
  onApply,
  disabled,
}: {
  rows: SweepRow[];
  axes: SweepAxis[];
  metric: MetricKey;
  onMetric: (m: MetricKey) => void;
  maxAbs: number;
  onApply: (combo: Record<string, number | boolean | string>) => void;
  disabled?: boolean;
}) {
  const find = (match: Record<string, number>) =>
    rows.find((r) => Object.entries(match).every(([k, v]) => r.combo[k] === v));

  const axisVals = (a: SweepAxis): number[] => {
    const set = new Set<number>();
    for (const r of rows) {
      const v = r.combo[a.target];
      if (typeof v === "number") set.add(v);
    }
    return [...set].sort((x, y) => x - y);
  };

  const xAxis = axes[0];
  const yAxis = axes[1];
  const xVals = axisVals(xAxis);
  const yVals = yAxis ? axisVals(yAxis) : [null];

  return (
    <div className="sweep-heatmap">
      <label className="sweep-heat-metric">
        <span>Color</span>
        <select value={metric} onChange={(e) => onMetric(e.target.value as MetricKey)}>
          {METRIC_COLS.map((c) => (
            // Prefixed so the option text never collides with the table's own
            // sort-header label text (e.g. bare "Net P/L") in the DOM.
            <option key={c.key} value={c.key}>Color: {c.label}</option>
          ))}
        </select>
      </label>
      <div
        className="sweep-heat-grid"
        style={{ gridTemplateColumns: `auto repeat(${xVals.length}, 1fr)` }}
      >
        <div className="sweep-heat-corner" />
        {xVals.map((xv) => (
          <div key={`hx-${xv}`} className="sweep-heat-xlabel">{xv}</div>
        ))}
        {yVals.map((yv) => (
          <Fragment key={`hy-${yv}`}>
            <div className="sweep-heat-ylabel">{yAxis ? yv : ""}</div>
            {xVals.map((xv) => {
              const match: Record<string, number> = { [xAxis.target]: xv };
              if (yAxis && yv !== null) match[yAxis.target] = yv;
              const row = find(match);
              const v = row ? metricValue(row, metric) : null;
              const failed = row && row.metrics === null;
              return (
                <div
                  key={`hc-${xv}-${yv}`}
                  className={`sweep-cell${failed ? " sweep-error" : ""}${disabled ? " sweep-cell-disabled" : ""}`}
                  style={{ background: divergingBg(v, maxAbs) }}
                  onClick={() => row && !disabled && onApply(row.combo)}
                >
                  {failed ? (
                    <Tooltip content={row!.error ?? "failed"}>
                      <span>err</span>
                    </Tooltip>
                  ) : (
                    fmtMetric(metric, v)
                  )}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
