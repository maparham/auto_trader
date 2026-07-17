// Parameter-sweep results: a sortable metrics table (best value per column
// subtly highlighted, failed combos greyed with the error on hover) plus a
// heatmap whenever axes exist: a DOM grid (diverging color scale around 0 on a
// selectable metric) or a single-row strip for 1 axis. With 3+ axes, X/Y
// dropdowns pick the grid axes and each cell shows the BEST matching row by
// the color metric over the collapsed axes (min for drawdown). Clicking any
// row/cell applies that combo via onApply. Session-state only, never persisted.
// (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SweepRow } from "./api";
import { axisColumnLabel, comboAxisLabel, comboAxisText, fmtAxisValue, type SweepAxis } from "./lib/sweep";
import { plateauCenter, withPlateau } from "./lib/sweepPlateau";
import { formatPeriodDateRange } from "./lib/backtestPeriods";
import Tooltip from "./components/Tooltip";
import { rowWindow, verdictFor, type RowWindow } from "./lib/backtestPanelData";
import { metricTipLines } from "./components/metricScaleTip";

type MetricKey =
  | "net_pnl"
  | "return_pct"
  | "n_trades"
  | "win_rate"
  | "avg_win_loss_ratio"
  | "max_drawdown"
  | "profit_factor"
  | "sharpe"
  | "sqn"
  | "plateau_score"
  | "worst_window_pnl"
  | "median_window_pnl"
  | "pct_windows_profitable"
  | "mean_window_pnl_minus_std";

// `label`: the table header / dropdown text. `abbr`: the compact form used in
// the single-line hovered-cell detail row where space is tight. `robust` flags
// the window-robustness aggregates that live in the collapsible group. `info`
// is the tooltip copy Task 5 surfaces on those columns.
const METRIC_COLS: { key: MetricKey; label: string; abbr: string; robust?: boolean; info?: string }[] = [
  { key: "net_pnl", label: "Net P/L", abbr: "P/L" },
  { key: "return_pct", label: "Return %", abbr: "Ret" },
  { key: "n_trades", label: "Trades", abbr: "N" },
  { key: "win_rate", label: "Win rate", abbr: "Win" },
  { key: "avg_win_loss_ratio", label: "RR", abbr: "RR" },
  { key: "max_drawdown", label: "Drawdown", abbr: "DD" },
  { key: "profit_factor", label: "Profit factor", abbr: "PF",
    info: "Gross profit divided by gross loss; above 1 is profitable." },
  { key: "sharpe", label: "Sharpe", abbr: "Sh",
    info: "Annualized Sharpe ratio from daily equity returns. Treat with caution under 30 trades." },
  { key: "sqn", label: "SQN", abbr: "SQN",
    info: "System Quality Number: sqrt(trades) times expectancy over trade P&L deviation." },
  { key: "plateau_score", label: "Plateau", abbr: "Plt",
    info: "Median Net P&L of this cell and its grid neighbors (one step on each numeric axis), capped at the cell's own result. A high plateau beats a high lone peak: neighbors confirm the edge is not one lucky cell." },
  { key: "worst_window_pnl", label: "Worst wnd", abbr: "Wst", robust: true,
    info: "Worst window P&L. The most this combo lost (or least it made) in any single window. High values mean no disaster period." },
  { key: "median_window_pnl", label: "Med wnd", abbr: "Med", robust: true,
    info: "Median window P&L. The typical window's result, immune to one outlier week." },
  { key: "pct_windows_profitable", label: "Wnd+", abbr: "W+", robust: true,
    info: "Windows profitable. How many of the N windows ended positive. 4/4 means every period made money." },
  { key: "mean_window_pnl_minus_std", label: "Mean-σ", abbr: "Mσ", robust: true,
    info: "Mean window P&L minus one standard deviation. Rewards steady combos, punishes ones that swing between big wins and big losses." },
];

type SortDir = "asc" | "desc";

function metricValue(row: SweepRow, key: MetricKey): number | null {
  return row.metrics?.[key] ?? null;
}

// Columns sharing the backtest overview's interpretation scales: cells tint by
// verdict band and the header ⓘ shows the same word/range/desc table. Keyed to
// the scale's metric label in backtestPanelData. (Sweep drawdown is an absolute
// amount, not the % the drawdown scale bands, so it stays unscaled.)
const SCALED_COLS: Partial<Record<MetricKey, string>> = {
  profit_factor: "Profit factor",
  sharpe: "Sharpe",
  sqn: "SQN",
};

function verdictClass(key: MetricKey, v: number | null): string {
  const label = SCALED_COLS[key];
  const tone = label ? verdictFor(label, v)?.tone : undefined;
  return tone ? ` sweep-tone-${tone}` : "";
}

function fmtMetric(key: MetricKey, v: number | null): string {
  if (v === null) return "—";
  if (key === "win_rate") return `${(v * 100).toFixed(0)}%`;
  if (key === "return_pct") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  if (key === "net_pnl") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  if (key === "max_drawdown") return v.toFixed(2);
  if (key === "n_trades") return String(v);
  if (key === "pct_windows_profitable") return `${(v * 100).toFixed(0)}%`;
  if (key === "worst_window_pnl" || key === "median_window_pnl" || key === "mean_window_pnl_minus_std")
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  return v.toFixed(2);
}

// Per-window P&L breakdown: one green/red bar per window scaled by |pnl|,
// with the window's dates, pnl and trade count beneath. Answers "one lucky
// week or spread across the range?" at a glance. Window times are epoch
// SECONDS, the formatter takes ms.
function WindowStrip({ windows }: { windows: NonNullable<SweepRow["windows"]> }) {
  const maxAbs = Math.max(...windows.map((w) => Math.abs(w.pnl)), 1e-9);
  return (
    <div className="sweep-wstrip">
      {windows.map((w, i) => (
        <div key={i} className="sweep-wstrip-col">
          <div className="sweep-wstrip-barbox">
            <div
              className={`sweep-wstrip-bar ${w.pnl >= 0 ? "pos" : "neg"}`}
              style={{ height: `${Math.max(8, (Math.abs(w.pnl) / maxAbs) * 100)}%` }}
            />
          </div>
          <div className="sweep-wstrip-range">{formatPeriodDateRange(w.from * 1000, w.to * 1000)}</div>
          <div className={`sweep-wstrip-pnl ${w.pnl >= 0 ? "pos" : "neg"}`}>
            {w.pnl >= 0 ? "+" : ""}{w.pnl.toFixed(2)}
          </div>
          <div className="sweep-wstrip-trades">{w.trades} tr</div>
        </div>
      ))}
    </div>
  );
}

// Cursor-anchored breakdown strip, portaled to <body> so it floats above the
// grid rather than pinning over the top-left cells. It must stay an OVERLAY
// (not an inline block): rendering it inline would shift the grid under a
// stationary cursor, firing mouseleave on the hovered cell and unmounting
// itself (hover flicker). pointer-events:none so it never steals the hover
// that keeps it open. Placed near the cursor with a small offset, flipped to
// the other side of the pointer when it would spill off screen.
function WindowStripOverlay({ windows, cursor }: {
  windows: NonNullable<SweepRow["windows"]>;
  cursor: { x: number; y: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: cursor.x + 14, top: cursor.y + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    let left = cursor.x + 14;
    let top = cursor.y + 16;
    if (left + w > window.innerWidth - 8) left = cursor.x - 14 - w;
    if (top + h > window.innerHeight - 8) top = cursor.y - 16 - h;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [cursor.x, cursor.y, windows]);
  return createPortal(
    <div ref={ref} className="sweep-heat-detail-wstrip" style={{ left: pos.left, top: pos.top }}>
      <WindowStrip windows={windows} />
    </div>,
    document.body,
  );
}

// Short column tag for the Nth sweep axis: A, B, ... Z, then #27, #28, ... so
// it never runs out (axis counts this high are already off the useful end).
function axisTag(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `#${i + 1}`;
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

// Row virtualization for the results table. A sweep can land 9000+ combos, and
// rendering every one as a <tr> (~10 cells + tooltips each) buries the browser
// in tens of thousands of DOM nodes. Rows are uniform single-line height, so we
// render only the window that's actually scrolled into view plus a buffer, with
// spacer <tr>s above and below that preserve the table's height and scrollbar.
//
// We don't own the scroll container (.sweep-panel, an ancestor), so we walk up
// from a ref to find the nearest scrollable element and measure the visible
// window via getBoundingClientRect deltas — robust regardless of what sits above
// the table (heatmap, legend). The window maths (and its stale-scroll clamp) are
// the shared `rowWindow` helper the trades table uses. Returns null when it can't
// measure (no scroll parent, zero-height container as in jsdom); callers fall
// back to a render-time top window sized by an assumed viewport.
const VROW_OVERSCAN = 12;
const VROW_ESTIMATE = 30; // px; replaced by the first real measurement
// Pre-measurement viewport cap so a large result set never renders every row for
// a frame before the container is measured (comfortably larger than any real
// panel, so the measured window that lands before paint only ever shrinks it).
const VROW_INITIAL_VIEWPORT = 2400;

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

function useVirtualRows(
  anchorRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
): RowWindow | null {
  const [win, setWin] = useState<RowWindow | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const parent = findScrollParent(anchorRef.current);
    if (!parent || !list) {
      setWin(null);
      return;
    }
    let frame = 0;
    const recompute = () => {
      frame = 0;
      const pRect = parent.getBoundingClientRect();
      const lRect = list.getBoundingClientRect();
      if (pRect.height === 0) {
        // Can't measure a viewport (e.g. jsdom) — fall back to render-all.
        setWin((prev) => (prev === null ? prev : null));
        return;
      }
      // How far the list top is scrolled above the viewport top == scrollTop
      // relative to the list; rowWindow clamps a stale value to the real range.
      const offset = pRect.top - lRect.top;
      const next = rowWindow(offset, pRect.height, rowHeight, rowCount, VROW_OVERSCAN);
      setWin((prev) =>
        prev && prev.start === next.start && prev.end === next.end && prev.padTop === next.padTop
          ? prev
          : next,
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(recompute);
    };
    recompute();
    parent.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(parent);
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      parent.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", onScroll);
    };
  }, [anchorRef, listRef, rowCount, rowHeight]);

  return win;
}

export function SweepResults(props: {
  rows: SweepRow[];
  axes: SweepAxis[];
  onApply: (combo: Record<string, number | boolean | string>) => void;
  // Refine-around-a-result: narrows the sweep ranges to this combo's
  // neighborhood (halve step, re-center, clamp). Optional — omit to hide the
  // Refine controls entirely.
  onRefine?: (combo: SweepRow["combo"]) => void;
  progress?: { done: number; total: number } | null;
}) {
  const { rows, axes, onApply, onRefine, progress } = props;

  // Plateau scoring over the loaded rows: new row objects whose metrics gain
  // `plateau_score`, so the existing sort / best-per-column / heatmap paths
  // pick it up as just another metric. `spikes` is aligned to the ORIGINAL
  // row order while the table renders sorted rows, so carry the flag as a
  // Set membership by object identity (withPlateau returns fresh objects,
  // and [...].sort keeps identities).
  // rows is mutated in place during a streaming sweep (BacktestButton re-sets
  // the same `landed` array each chunk), so length is the change signal.
  const { rows: scoredRows, spikes } = useMemo(() => withPlateau(rows, axes), [rows, rows.length, axes]);
  // Memoized so a scroll-driven re-render (the virtualization hook lives in this
  // component and updates on every scroll frame) doesn't rebuild the spike set.
  const spikeSet = useMemo(() => new Set(scoredRows.filter((_, i) => spikes[i])), [scoredRows, spikes]);
  const center = useMemo(() => plateauCenter(scoredRows), [scoredRows]);

  const [sort, setSort] = useState<{ key: MetricKey; dir: SortDir } | null>(null);
  const [heatMetric, setHeatMetric] = useState<MetricKey>("net_pnl");
  const [robustOpen, setRobustOpen] = useState(true);

  // The robust aggregates share one collapsible group. When collapsed they drop
  // out of the header AND body loops; the toggle keeps its own column so widths
  // stay aligned either way.
  const baseCols = METRIC_COLS.filter((c) => !c.robust);
  const robustCols = robustOpen ? METRIC_COLS.filter((c) => c.robust) : [];

  // Each sweep axis gets one short tag column (A, B, C, ...) so the table stays
  // narrow; a legend above the table maps every tag to its full operand name.
  // `fullHeaders` is that full name (also the per-tag hover text).
  const fullHeaders = axes.map(axisColumnLabel);

  const toggleSort = (key: MetricKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  // Failed (metrics === null) rows always sort to the bottom, independent of
  // direction — an error isn't "worse" or "better", it's just not comparable.
  // Memoized: with thousands of rows this sort must not re-run on every
  // scroll-driven re-render (see the virtualization hook below).
  const sortedRows = useMemo(
    () =>
      sort
        ? [...scoredRows].sort((a, b) => {
            const av = metricValue(a, sort.key);
            const bv = metricValue(b, sort.key);
            if (av === null && bv === null) return 0;
            if (av === null) return 1;
            if (bv === null) return -1;
            return sort.dir === "asc" ? av - bv : bv - av;
          })
        : scoredRows,
    [scoredRows, sort],
  );

  // Best value per column (highest wins, except drawdown where smaller-magnitude
  // is better) — only among successful rows.
  const bestByCol = useMemo(() => {
    const best: Partial<Record<MetricKey, number>> = {};
    for (const { key } of METRIC_COLS) {
      const vals = scoredRows.map((r) => metricValue(r, key)).filter((v): v is number => v !== null);
      if (!vals.length) continue;
      best[key] = key === "max_drawdown" ? Math.min(...vals) : Math.max(...vals);
    }
    return best;
  }, [scoredRows]);

  const maxAbs = useMemo(() => {
    const heatVals = scoredRows.map((r) => metricValue(r, heatMetric)).filter((v): v is number => v !== null);
    return heatVals.length ? Math.max(...heatVals.map((v) => Math.abs(v))) : 0;
  }, [scoredRows, heatMetric]);

  // While a sweep is still streaming, clicking a row/cell can't apply: the
  // runner is mid-run and a re-run request would silently no-op instead of
  // applying (I2). Rows stay visible (so progress is still legible) but go
  // inert, with a hint explaining why — cancel the sweep (or let it finish)
  // to apply a combo.
  const applyDisabled = !!progress;
  const applyOrNoop = (combo: Record<string, number | boolean | string>) => {
    if (!applyDisabled) onApply(combo);
  };

  // One-click jump to the most robust neighborhood: the row with the highest
  // plateau_score (ties broken by net P&L). Hidden when nothing is scored
  // (no numeric range axes, or no successful rows yet).
  const plateauAction = center && (
    <button type="button" className="sweep-plateau-apply"
            disabled={applyDisabled}
            onClick={() => applyOrNoop(center.combo)}>
      Apply plateau center
    </button>
  );

  // Virtualization wiring. `anchorRef` locates the scroll container (walked up
  // from the results root); `bodyRef` marks the top of the row area; `rowRef`
  // measures one real row (uniform height) so the spacer math is exact.
  const anchorRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const [rowHeight, setRowHeight] = useState(VROW_ESTIMATE);
  useLayoutEffect(() => {
    // Replace the estimate with the real rendered height (subpixel, so spacer
    // heights don't drift over thousands of rows); it's a fixed single line, so
    // the >0.5px guard settles it after one measurement.
    const h = rowRef.current?.getBoundingClientRect().height ?? 0;
    if (h > 0 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  }, [sortedRows.length, rowHeight]);

  // Full column span for the spacer rows so table layout/scrollbar stay put:
  // axis cells (one per axis, or a single "Combo" cell) + base metrics + the
  // robustness-toggle column + open robust metrics + optional Refine action.
  const axisColCount = axes.length > 0 ? axes.length : 1;
  const colCount = axisColCount + baseCols.length + 1 + robustCols.length + (onRefine ? 1 : 0);

  // Before the container is measured (mount, or re-mount with results already
  // present), fall back to a render-time top window so a large set never renders
  // every row for a frame; the measured window lands before paint.
  const measuredWin = useVirtualRows(anchorRef, bodyRef, sortedRows.length, rowHeight);
  const win = measuredWin ?? rowWindow(0, VROW_INITIAL_VIEWPORT, rowHeight, sortedRows.length, VROW_OVERSCAN);
  const visibleRows = sortedRows.slice(win.start, win.end);
  const baseIndex = win.start;
  const padTop = win.padTop;
  const padBottom = win.padBottom;

  return (
    <div className="sweep-results" ref={anchorRef}>
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
          Cancel the sweep to apply a combo; results keep landing until then.
        </div>
      )}

      {axes.length > 0 && (
        <SweepHeatmap
          rows={scoredRows}
          axes={axes}
          metric={heatMetric}
          onMetric={setHeatMetric}
          maxAbs={maxAbs}
          onApply={applyOrNoop}
          disabled={applyDisabled}
          plateauAction={plateauAction}
          onRefine={onRefine && !applyDisabled ? onRefine : undefined}
        />
      )}

      {axes.length > 0 && (
        <div className="sweep-axis-legend">
          {axes.map((a, ai) => (
            <span key={a.target} className="sweep-axis-legend-item">
              <span className="sweep-axis-tag">{axisTag(ai)}</span>
              {fullHeaders[ai]}
            </span>
          ))}
        </div>
      )}

      <div className="sweep-table-wrap">
        <table className="sweep-table">
          <thead>
            <tr>
              {axes.length > 0 ? (
                axes.map((a, ai) => (
                  <th key={a.target} className="sweep-c-axis">
                    <Tooltip content={fullHeaders[ai]}>
                      <span className="sweep-axis-tag">{axisTag(ai)}</span>
                    </Tooltip>
                  </th>
                ))
              ) : (
                <th>Combo</th>
              )}
              {baseCols.map((c) => (
                <th key={c.key} className="sweep-c-num">
                  {c.info ? (
                    <Tooltip content={metricTipLines(SCALED_COLS[c.key] ?? "", c.info)}>
                      <span><SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} /></span>
                    </Tooltip>
                  ) : (
                    <SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} />
                  )}
                </th>
              ))}
              <th className="sweep-robust-toggle-th">
                <Tooltip content="These score how evenly the P&L was earned across sub-windows of the range. A combo that wins on Net P&L but fails here likely got lucky in one period.">
                  <button type="button" className="sweep-robust-toggle"
                          onClick={() => setRobustOpen((o) => !o)}
                          aria-expanded={robustOpen}>
                    {robustOpen ? "Robustness ▾" : "Robustness ▸"}
                  </button>
                </Tooltip>
              </th>
              {robustCols.map((c) => (
                <th key={c.key} className="sweep-c-num">
                  {c.info ? (
                    <Tooltip content={c.info}>
                      <span><SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} /></span>
                    </Tooltip>
                  ) : (
                    <SweepSortHeader label={c.label} col={c.key} sort={sort} onSort={toggleSort} />
                  )}
                </th>
              ))}
              {onRefine && <th className="sweep-c-act" />}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {padTop > 0 && (
              <tr aria-hidden="true" className="sweep-vspacer">
                <td colSpan={colCount} style={{ height: padTop, padding: 0, border: "none" }} />
              </tr>
            )}
            {visibleRows.map((row, vi) => {
              const i = baseIndex + vi;
              const failed = row.metrics === null;
              const combo = row.combo as Record<string, number | string>;
              return (
                <tr
                  key={i}
                  ref={vi === 0 ? rowRef : undefined}
                  className={`sweep-row${failed ? " sweep-error" : ""}${applyDisabled ? " sweep-row-disabled" : ""}`}
                  aria-disabled={applyDisabled}
                  onClick={() => applyOrNoop(row.combo)}
                >
                  {/* One cell per axis (the swept value); the header carries the
                      operand name. A failed row's error tooltip wraps the first
                      axis cell's content — not the <tr>: Tooltip renders a
                      wrapper <span>, and a span between <tbody> and <tr> is
                      invalid DOM the browser hoists out of the table. */}
                  {axes.length > 0 ? (
                    axes.map((a, ai) => {
                      const val = comboAxisText(a, combo);
                      return (
                        <td key={a.target} className="sweep-c-axis">
                          {failed && ai === 0 ? (
                            <Tooltip content={row.error ?? "failed"}>{val}</Tooltip>
                          ) : (
                            val
                          )}
                        </td>
                      );
                    })
                  ) : (
                    <td>{failed ? <Tooltip content={row.error ?? "failed"}>—</Tooltip> : "—"}</td>
                  )}
                  {baseCols.map((c) => {
                    const v = metricValue(row, c.key);
                    const isBest = v !== null && bestByCol[c.key] === v;
                    return (
                      <td key={c.key} className={`sweep-c-num${isBest ? " sweep-best" : ""}${verdictClass(c.key, v)}`}>
                        {c.key === "plateau_score" && spikeSet.has(row) ? (
                          <span className="sweep-spike" aria-label="isolated peak">▲ {fmtMetric(c.key, v)}</span>
                        ) : (
                          fmtMetric(c.key, v)
                        )}
                      </td>
                    );
                  })}
                  <td className="sweep-robust-toggle-td" />
                  {robustCols.map((c) => {
                    const v = metricValue(row, c.key);
                    const isBest = v !== null && bestByCol[c.key] === v;
                    const cellContent =
                      c.key === "pct_windows_profitable" && row.windows
                        ? `${row.windows.filter((w) => w.pnl > 0).length}/${row.windows.length}`
                        : fmtMetric(c.key, v);
                    return (
                      <td key={c.key} className={`sweep-c-num${isBest ? " sweep-best" : ""}`}>
                        {row.windows && row.windows.length > 0 ? (
                          <Tooltip content={<WindowStrip windows={row.windows} />} delay={0}>
                            <span>{cellContent}</span>
                          </Tooltip>
                        ) : (
                          cellContent
                        )}
                      </td>
                    );
                  })}
                  {onRefine && (
                    <td className="sweep-c-act">
                      <button type="button" disabled={applyDisabled}
                              onClick={(e) => { e.stopPropagation(); onRefine(row.combo); }}>
                        Refine
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true" className="sweep-vspacer">
                <td colSpan={colCount} style={{ height: padBottom, padding: 0, border: "none" }} />
              </tr>
            )}
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
  plateauAction,
  onRefine,
}: {
  rows: SweepRow[];
  axes: SweepAxis[];
  metric: MetricKey;
  onMetric: (m: MetricKey) => void;
  maxAbs: number;
  onApply: (combo: Record<string, number | boolean | string>) => void;
  disabled?: boolean;
  // "Apply plateau center" button, rendered beside the color-metric dropdown
  // (built by the parent, which owns the scored rows and apply gating).
  plateauAction?: ReactNode;
  // Refine around the hovered cell's combo; already gated off while a sweep
  // streams (undefined then), so no extra disabled check is needed here.
  onRefine?: (combo: SweepRow["combo"]) => void;
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
    return [...set].sort((x, y) => x - y).map((v) => ({ key: String(v), label: fmtAxisValue(v), match: { [a.target]: v } }));
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
  // Cursor position (viewport coords) so the per-window breakdown strip can
  // follow the pointer instead of pinning over the top-left cells. Null until
  // the first mouse event, which guards against a flash at (0,0).
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Robustness columns share short table labels; the dropdown spells them out.
  const heatLabel = (c: (typeof METRIC_COLS)[number]) =>
    c.key === "worst_window_pnl" ? "Worst window"
    : c.key === "median_window_pnl" ? "Median window"
    : c.key === "pct_windows_profitable" ? "Windows profitable"
    : c.key === "mean_window_pnl_minus_std" ? "Mean-σ window"
    : c.label;

  return (
    <div className="sweep-heatmap">
      <div className="sweep-heat-metric">
        <select
          aria-label="Heatmap color metric"
          value={metric}
          onChange={(e) => onMetric(e.target.value as MetricKey)}
        >
          {METRIC_COLS.map((c) => (
            <option key={c.key} value={c.key}>{heatLabel(c)}</option>
          ))}
        </select>
        {plateauAction}
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
                      @ {collapsed.map((a) => comboAxisLabel(a, hovered.combo as Record<string, number | string>)).join(", ")}
                    </span>
                  )}
                  {METRIC_COLS.map((c) => (
                    <span key={c.key} className="sweep-heat-detail-stat">
                      <span className="sweep-heat-detail-lbl">{c.abbr}</span>
                      <span className="sweep-heat-detail-val">{fmtMetric(c.key, metricValue(hovered, c.key))}</span>
                    </span>
                  ))}
                  {onRefine && (
                    <button type="button" className="sweep-refine"
                            onClick={() => onRefine(hovered.combo)}>
                      Refine
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {hovered && hovered.windows && hovered.windows.length > 0 && cursor && (
        <WindowStripOverlay windows={hovered.windows} cursor={cursor} />
      )}
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
                  // max_drawdown is a positive magnitude where SMALLER is better —
                  // negate it so the ramp reads red-for-worse like every other metric.
                  style={{ background: divergingBg(metric === "max_drawdown" && v !== null ? -v : v, maxAbs) }}
                  onClick={() => row && !disabled && onApply(row.combo)}
                  onMouseEnter={(e) => { setHovered(row ?? null); setCursor({ x: e.clientX, y: e.clientY }); }}
                  onMouseMove={(e) => setCursor({ x: e.clientX, y: e.clientY })}
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
