// Parameter-sweep results: a sortable metrics table (best value per column
// subtly highlighted, failed combos greyed with the error on hover) plus a
// heatmap whenever axes exist: a DOM grid (diverging color scale around 0 on a
// selectable metric) or a single-row strip for 1 axis. With 3+ axes, X/Y
// dropdowns pick the grid axes and each cell shows the BEST matching row by
// the color metric over the collapsed axes (min for drawdown). Clicking any
// row/cell applies that combo via onApply. Session-state only, never persisted.
// (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import { Fragment, useState } from "react";
import type { SweepRow } from "./api";
import { comboAxisText, type SweepAxis } from "./lib/sweep";
import Tooltip from "./components/Tooltip";

type MetricKey =
  | "net_pnl"
  | "return_pct"
  | "n_trades"
  | "win_rate"
  | "avg_win_loss_ratio"
  | "max_drawdown"
  | "profit_factor";

// `label`: the table header / dropdown text. `abbr`: the compact form used in
// the single-line hovered-cell detail row where space is tight.
const METRIC_COLS: { key: MetricKey; label: string; abbr: string }[] = [
  { key: "net_pnl", label: "Net P/L", abbr: "P/L" },
  { key: "return_pct", label: "Return %", abbr: "Ret" },
  { key: "n_trades", label: "Trades", abbr: "N" },
  { key: "win_rate", label: "Win rate", abbr: "Win" },
  { key: "avg_win_loss_ratio", label: "RR", abbr: "RR" },
  { key: "max_drawdown", label: "Drawdown", abbr: "DD" },
  { key: "profit_factor", label: "Profit factor", abbr: "PF" },
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
  return axes.map((a) => `${a.label} ${comboAxisText(a, combo as Record<string, number | string>)}`).join(", ");
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

      {axes.length > 0 && (
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

// Grid over two picked axes (defaults: first two) or 1-axis single-row strip.
// With 3+ axes the unpicked axes collapse: each cell shows the best matching
// row by the color metric (min for drawdown), and clicking applies that best
// row's full combo. Cell background is the diverging scale.

type HeatTick = { key: string; label: string; match: Record<string, number | string> };

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
  // Direction-aware "which row is better" on the selected color metric:
  // higher wins except drawdown (lower wins); a successful row always beats
  // a failed one; among two failures the first seen is kept.
  const better = (a: SweepRow, b: SweepRow): SweepRow => {
    // Success vs failure is decided on `metrics === null` BEFORE any metric
    // comparison: a nullable metric (profit_factor, avg_win_loss_ratio) can be
    // null on a successful row too, so comparing values first would let a
    // failed row tie and win. Failure only wins over another failure.
    if (a.metrics === null) return b.metrics === null ? a : b;
    if (b.metrics === null) return a;
    const av = metricValue(a, metric);
    const bv = metricValue(b, metric);
    if (bv === null) return a;   // null metric value on a success loses
    if (av === null) return b;
    if (metric === "max_drawdown") return bv < av ? b : a;
    return bv > av ? b : a;
  };
  // A cell's row: the best row (per `better`) among all rows matching the
  // cell's x+y values. With <= 2 axes each cell matches at most one row, so
  // this degenerates to today's exact lookup.
  const find = (match: Record<string, number | string>) => {
    let best: SweepRow | undefined;
    for (const r of rows) {
      if (!Object.entries(match).every(([k, v]) => r.combo[k] === v)) continue;
      best = best ? better(best, r) : r;
    }
    return best;
  };

  const axisTicks = (a: SweepAxis): HeatTick[] => {
    if (a.kind === "list") {
      return a.options.map((o, i) => ({ key: `o${i}`, label: o.label, match: o.patch }));
    }
    const set = new Set<number>();
    for (const r of rows) {
      const v = r.combo[a.target];
      if (typeof v === "number") set.add(v);
    }
    return [...set].sort((x, y) => x - y).map((v) => ({ key: String(v), label: String(v), match: { [a.target]: v } }));
  };

  // Picked grid axes, stored by TARGET (stable across streaming re-renders);
  // a stale target (new sweep, different axes) falls back to the defaults:
  // X = first axis, Y = second, never the axis the other picker holds.
  const [xSel, setXSel] = useState<string | null>(null);
  const [ySel, setYSel] = useState<string | null>(null);
  const xAxis = axes.find((a) => a.target === xSel) ?? axes[0];
  const yAxis = axes.find((a) => a.target === ySel && a.target !== xAxis.target)
    ?? axes.find((a) => a.target !== xAxis.target);
  const collapsed = axes.filter((a) => a !== xAxis && a !== yAxis);
  // Picking in one dropdown the axis the other holds swaps them: X and Y can
  // never be the same axis.
  const pickX = (t: string) => { if (t === yAxis?.target) setYSel(xAxis.target); setXSel(t); };
  const pickY = (t: string) => { if (t === xAxis.target) setXSel(yAxis?.target ?? null); setYSel(t); };
  const xTicks = axisTicks(xAxis);
  const yTicks: (HeatTick | null)[] = yAxis ? axisTicks(yAxis) : [null];

  // Hovered cell's full metric breakdown, surfaced inline in the header row
  // beside the color-metric dropdown (the grid cells themselves only show the
  // one selected metric).
  const [hovered, setHovered] = useState<SweepRow | null>(null);

  return (
    <div className="sweep-heatmap">
      <div className="sweep-heat-metric">
        <select
          aria-label="Heatmap color metric"
          value={metric}
          onChange={(e) => onMetric(e.target.value as MetricKey)}
        >
          {METRIC_COLS.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        {axes.length > 2 && (
          <span className="sweep-heat-axes">
            <select aria-label="Heatmap X axis" value={xAxis.target} onChange={(e) => pickX(e.target.value)}>
              {axes.map((a) => <option key={a.target} value={a.target}>{a.label}</option>)}
            </select>
            <span>by</span>
            <select aria-label="Heatmap Y axis" value={yAxis!.target} onChange={(e) => pickY(e.target.value)}>
              {axes.map((a) => <option key={a.target} value={a.target}>{a.label}</option>)}
            </select>
          </span>
        )}
        <div className="sweep-heat-detail" aria-live="polite">
          {hovered && (
            <>
              {hovered.metrics === null ? (
                <span className="sweep-heat-detail-err">{hovered.error ?? "failed"}</span>
              ) : (
                <>
                  {collapsed.length > 0 && (
                    <span className="sweep-heat-detail-combo">
                      @ {collapsed.map((a) => `${a.label} ${comboAxisText(a, hovered.combo as Record<string, number | string>)}`).join(", ")}
                    </span>
                  )}
                  {METRIC_COLS.map((c) => (
                    <span key={c.key} className="sweep-heat-detail-stat">
                      <span className="sweep-heat-detail-lbl">{c.abbr}</span>
                      <span className="sweep-heat-detail-val">{fmtMetric(c.key, metricValue(hovered, c.key))}</span>
                    </span>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div
        className="sweep-heat-grid"
        style={{ gridTemplateColumns: `auto repeat(${xTicks.length}, 1fr)` }}
      >
        <div className="sweep-heat-corner" />
        {xTicks.map((xt) => (
          <div key={`hx-${xt.key}`} className="sweep-heat-xlabel">{xt.label}</div>
        ))}
        {yTicks.map((yt) => (
          <Fragment key={`hy-${yt?.key ?? ""}`}>
            <div className="sweep-heat-ylabel">{yt?.label ?? ""}</div>
            {xTicks.map((xt) => {
              const match = { ...xt.match, ...(yt ? yt.match : {}) };
              const row = find(match);
              const v = row ? metricValue(row, metric) : null;
              const failed = row && row.metrics === null;
              return (
                <div
                  key={`hc-${xt.key}-${yt?.key ?? ""}`}
                  className={`sweep-cell${failed ? " sweep-error" : ""}${disabled ? " sweep-cell-disabled" : ""}`}
                  style={{ background: divergingBg(v, maxAbs) }}
                  onClick={() => row && !disabled && onApply(row.combo)}
                  onMouseEnter={() => setHovered(row ?? null)}
                  onMouseLeave={() => setHovered((h) => (h === row ? null : h))}
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
