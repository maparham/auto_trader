import { useState, type ReactNode } from "react";
import type {
  AnalysisHist,
  AnalysisRow,
  BacktestAnalysis,
  BarDynamicsMetrics,
  BacktestWhatif,
} from "./api";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import {
  loadBacktestAnalysisCollapsed,
  loadBacktestAnalysisTab,
  saveBacktestAnalysisCollapsed,
  saveBacktestAnalysisTab,
  type BacktestAnalysisTab,
} from "./lib/persist";

/** Analysis tab of the backtest dock: renders the backend-computed `analysis`
 * payload (SL/TP efficiency, exit reasons, R distribution, context breakdowns).
 * Pure formatting: every number here was computed server-side. */

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtR = (v: number) => `${v.toFixed(1)}R`;
// Like fmtPct, but a value below 1 never rounds up to display as "100%"
// (e.g. a 0.9968 fill rate should read "99.7%", not "100%"). Floors instead
// of rounding so values arbitrarily close to 1 (e.g. 0.9996) still show below
// 100%.
const fmtPctBelow100 = (v: number) =>
  v < 1 && Math.round(v * 100) >= 100
    ? `${(Math.floor(v * 1000) / 10).toFixed(1)}%`
    : fmtPct(v);

// Compact wall-clock duration for a bar count at the run's bar interval.
function fmtDuration(bars: number, barSeconds: number): string {
  const s = Math.round(bars * barSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// Backend day_of_week buckets are Python weekday() ints as strings ("0" = Mon).
// Show day names in calendar order (backend rows arrive sorted by trade count).
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayOrd = (bucket: string) => {
  const n = parseInt(bucket, 10);
  return Number.isNaN(n) ? 7 : n; // "unknown" sorts last
};
const dayOfWeekRows = (rows: AnalysisRow[]): AnalysisRow[] =>
  rows
    .slice()
    .sort((a, b) => dayOrd(a.bucket) - dayOrd(b.bucket))
    .map((r) => ({ ...r, bucket: DAY_NAMES[parseInt(r.bucket, 10)] ?? r.bucket }));

// Group per-UTC-hour stats into six local-timezone-aligned 4-hour buckets.
// offsetHours defaults to the viewer's local offset; it is a parameter so the
// bucketing is unit-testable without mocking Date. Bucketing is at hour
// granularity: for a rare half-hour timezone a UTC hour that straddles a local
// 4-hour boundary is assigned whole to one bucket by its start; whole-hour
// offsets are exact.
const HOUR_BUCKET_COUNT = 6;
const HOUR_BUCKET_WIDTH = 4;
const HOUR_LOW_SAMPLE_N = 5; // mirrors backend analysis.LOW_SAMPLE_N
const pad2 = (n: number) => String(n).padStart(2, "0");

export function hourBucketRows(
  hourStats: { hour: number; n: number; wins: number; sum_pnl: number }[],
  offsetHours = -new Date().getTimezoneOffset() / 60,
): AnalysisRow[] {
  const acc = Array.from({ length: HOUR_BUCKET_COUNT }, () => ({
    n: 0,
    wins: 0,
    sum_pnl: 0,
  }));
  for (const s of hourStats) {
    const localHour = (((s.hour + offsetHours) % 24) + 24) % 24;
    const idx = Math.floor(localHour / HOUR_BUCKET_WIDTH) % HOUR_BUCKET_COUNT;
    acc[idx].n += s.n;
    acc[idx].wins += s.wins;
    acc[idx].sum_pnl += s.sum_pnl;
  }
  const rows: AnalysisRow[] = [];
  acc.forEach((b, idx) => {
    if (b.n === 0) return;
    const start = idx * HOUR_BUCKET_WIDTH;
    const end = start + HOUR_BUCKET_WIDTH;
    rows.push({
      bucket: `${pad2(start)}:00-${pad2(end)}:00`,
      n: b.n,
      win_rate: b.wins / b.n,
      expectancy: b.sum_pnl / b.n,
      net_pnl: b.sum_pnl,
      low_sample: b.n < HOUR_LOW_SAMPLE_N,
    });
  });
  return rows;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="bt-analysis-chevron" aria-hidden="true">
      {open ? "▾" : "▸"}
    </span>
  );
}

// A section h4 that toggles its section body. InfoTips inside the header keep
// working: InfoTip stops click propagation itself, so tapping the icon never
// reaches this onClick.
function SectionH4({
  slug,
  open,
  onToggle,
  children,
}: {
  slug: string;
  open: boolean;
  onToggle: (slug: string) => void;
  children: ReactNode;
}) {
  return (
    <h4
      className="bt-analysis-htoggle"
      role="button"
      aria-expanded={open}
      onClick={() => onToggle(slug)}
    >
      <Chevron open={open} />
      {children}
    </h4>
  );
}

function Dist({
  hist,
  label,
  slug,
  collapsed,
  onToggle,
  tip,
  pctOfStop,
  centeredR,
}: {
  hist: AnalysisHist;
  label: string;
  slug: string;
  collapsed: boolean;
  onToggle: (slug: string) => void;
  tip?: string;
  pctOfStop?: boolean; // buckets are fractions of the stop distance: show "25% to stop"
  centeredR?: boolean; // edges sit on half-R lines: label each bucket by its whole-R center
}) {
  const last = hist.edges[hist.edges.length - 1];
  // A clean stop realizes exactly -1R, so R buckets are centered on whole
  // R values (edges on the .5 lines). Label each bucket by its center, e.g.
  // "-1R", "breakeven", "+2R"; tails read "-3R or worse" / "+3R or better".
  const rName = (center: number) =>
    center === 0 ? "breakeven" : `${center > 0 ? "+" : ""}${center}R`;
  const names = centeredR
    ? [
        `${rName(hist.edges[0] - 0.5)} or worse`,
        ...hist.edges.slice(1).map((e, i) => rName((hist.edges[i] + e) / 2)),
        `${rName(last + 0.5)} or better`,
      ]
    : pctOfStop
    ? [
        `≤${hist.edges[0] * 100}% to stop`,
        ...hist.edges.slice(1).map((e, i) => `${hist.edges[i] * 100}–${e * 100}% to stop`),
        `>${last * 100}% to stop`,
      ]
    : [
        `≤${hist.edges[0]}R`,
        ...hist.edges.slice(1).map((e, i) => `${hist.edges[i]} to ${e}R`),
        `>${last}R`,
      ];
  // Empty buckets carry no information; show only buckets with trades in them.
  const items = hist.counts
    .map((c, i) => ({ c, name: names[i] }))
    .filter((r) => r.c > 0);
  if (!items.length) return null;
  return (
    <div className="bt-analysis-dist">
      <div
        className="bt-analysis-dist-label bt-analysis-htoggle"
        role="button"
        aria-expanded={!collapsed}
        onClick={() => onToggle(slug)}
      >
        <Chevron open={!collapsed} />
        {label}
        {tip && <InfoTip title={label} text={tip} />}
      </div>
      {!collapsed && (
        <ul className="bt-analysis-dist-items">
          {items.map(({ c, name }, i) => (
            <li key={i} className="bt-analysis-dist-item">
              {c} {c === 1 ? "trade" : "trades"} {pctOfStop ? "reached" : "closed at"}{" "}
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type BarMetricKind = "duration" | "count";
const BAR_DYNAMICS_METRICS: {
  key: keyof BarDynamicsMetrics;
  label: string;
  kind: BarMetricKind;
  tip: string;
}[] = [
  { key: "bars_held", label: "Bars held", kind: "duration",
    tip: "Total bars the trade stayed open, entry through exit." },
  { key: "bars_in_profit", label: "Bars in profit", kind: "duration",
    tip: "Bars that closed on the winning side of entry." },
  { key: "bars_in_loss", label: "Bars in loss", kind: "duration",
    tip: "Bars that closed on the losing side of entry." },
  { key: "longest_profit_streak", label: "Longest profit streak", kind: "duration",
    tip: "Longest unbroken run of bars closing in profit." },
  { key: "longest_loss_streak", label: "Longest loss streak", kind: "duration",
    tip: "Longest unbroken run of bars closing in loss." },
  { key: "bars_to_mfe", label: "Bars to peak (MFE)", kind: "duration",
    tip: "Bars from entry to the best price the trade reached." },
  { key: "bars_to_mae", label: "Bars to worst (MAE)", kind: "duration",
    tip: "Bars from entry to the worst price the trade reached." },
  { key: "body_through", label: "Body through entry", kind: "duration",
    tip: "Bars whose open-to-close body crossed back through entry." },
  { key: "wick_from_profit", label: "Wicked in from profit", kind: "duration",
    tip: "Bars that closed in profit but whose wick dipped back to entry." },
  { key: "wick_from_loss", label: "Wicked in from loss", kind: "duration",
    tip: "Bars that closed in loss but whose wick poked up to entry." },
  { key: "entry_crossings", label: "Entry crossings", kind: "count",
    tip: "Times price flipped between the profit and loss side of entry." },
];

// A duration cell shows the wall-clock span of the average bar count and its
// share of bars held. Bars held is the denominator, so it shows no percentage.
function fmtBarMetric(
  m: BarDynamicsMetrics,
  key: keyof BarDynamicsMetrics,
  kind: BarMetricKind,
  barSeconds: number,
): string {
  const v = m[key];
  if (v == null) return "n/a";
  if (kind === "count") return v.toFixed(1);
  const held = m.bars_held;
  const pct =
    key !== "bars_held" && held != null && held > 0 ? `, ${fmtPct(v / held)}` : "";
  return `${fmtDuration(v, barSeconds)}${pct}`;
}

function BarDynamicsTable({
  winners,
  losers,
  total,
  barSeconds,
}: {
  winners: BarDynamicsMetrics;
  losers: BarDynamicsMetrics;
  total: BarDynamicsMetrics;
  barSeconds: number;
}) {
  return (
    <table className="bt-analysis-table bt-bardyn-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>
            <span className="bt-bardyn-colhead">
              Winners
              <InfoTip title="Winners" text="Averaged over trades that closed in profit." />
            </span>
          </th>
          <th>
            <span className="bt-bardyn-colhead">
              Losers
              <InfoTip title="Losers" text="Averaged over trades that closed at a loss." />
            </span>
          </th>
          <th>
            <span className="bt-bardyn-colhead">
              Total
              <InfoTip title="Total" text="Averaged over all trades, winners and losers together." />
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {BAR_DYNAMICS_METRICS.map(({ key, label, kind, tip }) => (
          <tr key={key}>
            <td>
              <span className="bt-bardyn-metric">
                {label}
                <InfoTip title={label} text={tip} />
              </span>
            </td>
            <td>{fmtBarMetric(winners, key, kind, barSeconds)}</td>
            <td>{fmtBarMetric(losers, key, kind, barSeconds)}</td>
            <td>{fmtBarMetric(total, key, kind, barSeconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Tallest bar in the duration histogram, in pixels. Bar heights are absolute
// (count / max * this) rather than percentages, which collapse to nothing when
// a flex ancestor has no resolved height.
const DUR_HIST_MAX_PX = 72;

/** Grouped bar chart of winner/loser trade counts by hold duration. Bucket
 * width (in bars) is chosen server-side; here each bucket becomes a duration
 * range via barSeconds, with a green winner bar and a red loser bar side by
 * side. Only buckets that hold at least one trade are drawn, so empty spans
 * leave no gap. Green is winners, red is losers, matching the table below. */
function DurationHistogram({
  hist,
  barSeconds,
}: {
  hist: { bar_width: number; winners: number[]; losers: number[] };
  barSeconds: number;
}) {
  const { bar_width: width, winners, losers } = hist;
  const buckets = winners
    .map((w, i) => ({
      i,
      w,
      l: losers[i],
      label: `${fmtDuration(i * width, barSeconds)} to ${fmtDuration((i + 1) * width, barSeconds)}`,
    }))
    .filter((b) => b.w > 0 || b.l > 0);
  // Nothing eligible (e.g. every trade broke even, counted in neither series):
  // render nothing, heading included, so no orphaned title is left behind.
  if (!buckets.length) return null;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.w, b.l)));
  const barPx = (c: number) => (c > 0 ? Math.max(2, (c / max) * DUR_HIST_MAX_PX) : 0);
  return (
    <div className="bt-dur-hist-block">
      <div className="bt-dur-hist-title">
        Trades by hold duration
        <InfoTip
          title="Trades by hold duration"
          text="How many winning (green) and losing (red) trades were held for each span of time. Bucket width is set automatically from the longest hold."
        />
      </div>
      <div className="bt-dur-hist-plot" style={{ height: DUR_HIST_MAX_PX + 18 }}>
        {buckets.map(({ i, w, l, label }) => (
          <div key={i} className="bt-dur-hist-col">
            <div className="bt-dur-hist-pair">
              <Tooltip content={`${label}: ${w} ${w === 1 ? "winner" : "winners"}`}>
                <div className="bt-dur-bar-slot">
                  {w > 0 && <span className="bt-dur-bar-count">{w}</span>}
                  <div className="bt-dur-bar bt-dur-bar-win" style={{ height: barPx(w) }} />
                </div>
              </Tooltip>
              <Tooltip content={`${label}: ${l} ${l === 1 ? "loser" : "losers"}`}>
                <div className="bt-dur-bar-slot">
                  {l > 0 && <span className="bt-dur-bar-count">{l}</span>}
                  <div className="bt-dur-bar bt-dur-bar-loss" style={{ height: barPx(l) }} />
                </div>
              </Tooltip>
            </div>
            <div className="bt-dur-hist-xlabel">{fmtDuration((i + 1) * width, barSeconds)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RowsTable({ rows }: { rows: AnalysisRow[] }) {
  if (!rows.length) return <div className="bt-analysis-empty">No data.</div>;
  return (
    <table className="bt-analysis-table">
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Trades</th>
          <th>Win rate</th>
          <th>Expectancy</th>
          <th>Net P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.bucket}
            className={
              (r.low_sample ? "bt-analysis-low " : "") +
              (r.net_pnl < 0 ? "bt-analysis-under" : "")
            }
          >
            <td>{r.bucket}</td>
            <td>{r.n}</td>
            <td>{fmtPct(r.win_rate)}</td>
            <td>{r.expectancy.toFixed(2)}</td>
            <td>{r.net_pnl.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CAVEAT =
  "Per-trade attribution: replays ignore knock-on effects on later trades " +
  "(one position at a time means a longer hold could block the next entry). " +
  "Confirm promising findings with a rerun or sweep.";

// True when the whatif payload has at least one populated section. Drives both
// the What-if tab button visibility and the section render (old stored runs
// carry no whatif, or one with every section null).
function whatifHasContent(whatif: BacktestWhatif | null | undefined): boolean {
  if (!whatif) return false;
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry, breakeven_curve } =
    whatif;
  return Boolean(
    rule_exit || no_target || stop_curve || target_curve || fill_delay || limit_entry || breakeven_curve,
  );
}

function WhatIfSection({
  whatif,
  collapsed,
  onToggle,
}: {
  whatif: BacktestWhatif | null | undefined;
  collapsed: boolean;
  onToggle: (slug: string) => void;
}) {
  if (!whatifHasContent(whatif)) return null;
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry, breakeven_curve } =
    whatif!;
  const bullets: string[] = [];
  if (rule_exit) {
    for (const r of rule_exit.by_reason) {
      bullets.push(
        `${r.would_have_won} of ${r.n} trades closed by "${r.reason}" would have gone on to hit the target and ${r.would_have_lost} the stop` +
          (r.undecided ? ` (${r.undecided} undecided)` : "") +
          `. Holding them would have ${r.net_delta_r >= 0 ? "added" : "cost"} ${fmtR(Math.abs(r.net_delta_r))} net.`,
      );
    }
  }
  if (no_target) {
    bullets.push(
      `${no_target.would_have_stopped} of ${no_target.n} target exits would have later hit the stop. The target ${no_target.net_saved_r >= 0 ? "saved" : "cost"} ${fmtR(Math.abs(no_target.net_saved_r))} net.`,
    );
  }
  if (fill_delay) {
    // avg is small: keep 2 decimals so "0.07R" doesn't round to "0.1R".
    bullets.push(
      `The one-bar fill delay ${fill_delay.avg_r >= 0 ? "costs" : "earns"} ${Math.abs(fill_delay.avg_r).toFixed(2)}R per trade (${fmtR(Math.abs(fill_delay.total_r))} over this run).`,
    );
  }
  if (limit_entry) {
    const fillClause = `A limit order at the signal close (3-bar window) would have filled ${fmtPctBelow100(limit_entry.fill_rate)} of entries`;
    const filledClause = `${limit_entry.filled_net_delta_r >= 0 ? "improving filled entries by" : "worsening filled entries by"} ${fmtR(Math.abs(limit_entry.filled_net_delta_r))}`;
    // unfilled_foregone_r is a net sum: positive means the limit missed winners,
    // negative means it net-dodged losers on the trades that never filled.
    const unfilledClause =
      limit_entry.unfilled_foregone_r >= 0
        ? `while missing ${fmtR(limit_entry.unfilled_foregone_r)} on ${limit_entry.unfilled_winners} never-filled winners`
        : `while dodging ${fmtR(Math.abs(limit_entry.unfilled_foregone_r))} of losses on entries that never filled`;
    const netClause = `Net: ${limit_entry.net_verdict_r >= 0 ? "limit entries add" : "market entries keep"} ${fmtR(Math.abs(limit_entry.net_verdict_r))}.`;
    bullets.push(`${fillClause}, ${filledClause} ${unfilledClause}. ${netClause}`);
  }
  if (breakeven_curve) {
    const oneR = breakeven_curve.find((r) => r.frac === 1.0);
    if (oneR && oneR.n_fired > 0) {
      const verb = oneR.net_delta_r >= 0 ? "saved" : "cost";
      bullets.push(
        `Moving the stop to breakeven once a trade was 1R in profit would have ${verb} ${fmtR(
          Math.abs(oneR.net_delta_r),
        )} net across ${oneR.n_fired} trades that came back to entry.`,
      );
    }
  }
  return (
    <section className="bt-analysis-section">
      <SectionH4 slug="whatif" open={!collapsed} onToggle={onToggle}>
        What if
        <InfoTip title="What if" text={CAVEAT} />
      </SectionH4>
      {!collapsed && bullets.length > 0 && (
        <ul className="bt-analysis-readouts">
          {bullets.map((b, i) => (
            <li key={i} className="bt-analysis-readout">{b}</li>
          ))}
        </ul>
      )}
      {!collapsed && (stop_curve || target_curve || breakeven_curve) && (
      <div className="bt-analysis-dists">
        {stop_curve && (
          <div className="bt-analysis-dist">
            <div className="bt-analysis-dist-label">
              Tighter stop
              <InfoTip
                title="Tighter stop"
                text="Outcome if the stop sat at a fraction of its current distance: a trade whose worst drawdown reached that fraction exits there for that loss; others keep their real result. Tightening only, widening needs data past the real stop."
              />
            </div>
            <table className="bt-analysis-table">
              <thead>
                <tr><th>Stop at</th><th>Winners lost</th><th>Losers cheapened</th><th>Net R</th></tr>
              </thead>
              <tbody>
                {stop_curve.map((r) => (
                  <tr key={r.frac}>
                    <td>{Math.round(r.frac * 100)}%</td>
                    <td>{r.winners_killed}</td>
                    <td>{r.losers_cheapened}</td>
                    <td className={r.net_delta_r < 0 ? "bt-analysis-neg" : ""}>{r.net_delta_r.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {target_curve && (
          <div className="bt-analysis-dist">
            <div className="bt-analysis-dist-label">
              Target placement
              <InfoTip
                title="Target placement"
                text="Share of trades whose best run-up reached each candidate target. Trades that exited at their real target are censored there; the target bullet above is the uncensored answer."
              />
            </div>
            <table className="bt-analysis-table">
              <thead>
                <tr><th>Target</th><th>Reached</th><th>Share</th></tr>
              </thead>
              <tbody>
                {target_curve.map((r) => (
                  <tr key={r.target_r}>
                    <td>{r.target_r}R</td>
                    <td>{r.n_reached}</td>
                    <td>{fmtPct(r.pct_reached)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {breakeven_curve && (
          <div className="bt-analysis-dist">
            <div className="bt-analysis-dist-label">
              Move stop to breakeven
              <InfoTip
                title="Move stop to breakeven"
                text="Outcome if the stop moved to entry once a trade reached each profit trigger: a trade that then retraced to entry exits flat, so a real loser is rescued and a real winner is cut to zero; trades that ran away untouched keep their result. R of the full position, live runs only."
              />
            </div>
            <table className="bt-analysis-table">
              <thead>
                <tr><th>Trigger</th><th>Reached</th><th>Rescued</th><th>Cut</th><th>Net R</th></tr>
              </thead>
              <tbody>
                {breakeven_curve.map((r) => (
                  <tr key={r.frac}>
                    <td>+{r.frac}R</td>
                    <td>{r.n_armed}</td>
                    <td>{r.losers_rescued}</td>
                    <td>{r.winners_cut}</td>
                    <td className={r.net_delta_r < 0 ? "bt-analysis-neg" : ""}>{r.net_delta_r.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </section>
  );
}

export default function BacktestAnalysisPanel({
  analysis,
  barSeconds = 60,
}: {
  analysis: BacktestAnalysis | null | undefined;
  barSeconds?: number;
}) {
  const [tab, setTab] = useState<BacktestAnalysisTab>(loadBacktestAnalysisTab);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(loadBacktestAnalysisCollapsed()),
  );
  const toggleSection = (slug: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      saveBacktestAnalysisCollapsed([...next]);
      return next;
    });
  };
  if (!analysis) {
    return <div className="bt-analysis-empty">Run a backtest to see the analysis.</div>;
  }
  if (analysis.n_trades === 0) {
    return <div className="bt-analysis-empty">No trades to analyse.</div>;
  }
  const { sl, tp } = analysis;

  const hasWhatif = whatifHasContent(analysis.whatif);
  const hasBarDynamics = !!analysis.bar_dynamics && analysis.bar_dynamics.n_total > 0;
  // A persisted tab can point at a now-hidden tab (old stored runs lack the
  // whatif payload or the bar-stat fields): fall back to Stops & targets rather
  // than an empty page.
  const active: BacktestAnalysisTab =
    (tab === "whatif" && !hasWhatif) || (tab === "bardyn" && !hasBarDynamics)
      ? "placement"
      : tab;
  const pick = (t: BacktestAnalysisTab) => {
    setTab(t);
    saveBacktestAnalysisTab(t);
  };

  const readouts: string[] = [];
  if (sl.winners_near_stop_pct != null) {
    readouts.push(
      `${fmtPct(sl.winners_near_stop_pct)} of winners drew down 80% of the way to the stop before recovering.`,
    );
  }
  if (tp.avg_winner_mfe_r != null && tp.avg_winner_realized_r != null) {
    readouts.push(
      `Winners ran to ${fmtR(tp.avg_winner_mfe_r)} on average but realized ${fmtR(tp.avg_winner_realized_r)}.`,
    );
  }
  if (tp.median_left_on_table_r != null) {
    readouts.push(`Median ${fmtR(tp.median_left_on_table_r)} left on the table per winner.`);
  }
  if (tp.pct_nontarget_exits_reached_target != null) {
    readouts.push(
      `${fmtPct(tp.pct_nontarget_exits_reached_target)} of trades exited by rule/stop had already reached the target level.`,
    );
  }

  return (
    <div className="bt-analysis">
      <div className="seg bt-analysis-seg" role="tablist" aria-label="Analysis view">
        <button
          className={active === "placement" ? "seg-on" : ""}
          role="tab"
          aria-selected={active === "placement"}
          onClick={() => pick("placement")}
        >
          Stops &amp; targets
        </button>
        {hasBarDynamics && (
          <button
            className={active === "bardyn" ? "seg-on" : ""}
            role="tab"
            aria-selected={active === "bardyn"}
            onClick={() => pick("bardyn")}
          >
            Bar dynamics
          </button>
        )}
        {hasWhatif && (
          <button
            className={active === "whatif" ? "seg-on" : ""}
            role="tab"
            aria-selected={active === "whatif"}
            onClick={() => pick("whatif")}
          >
            What-if
          </button>
        )}
        <button
          className={active === "context" ? "seg-on" : ""}
          role="tab"
          aria-selected={active === "context"}
          onClick={() => pick("context")}
        >
          Breakdowns
        </button>
      </div>

      {active === "placement" && (
      <section className="bt-analysis-section">
        <SectionH4
          slug="placement-readouts"
          open={!collapsed.has("placement-readouts")}
          onToggle={toggleSection}
        >
          Stop &amp; target placement check
        </SectionH4>
        {!collapsed.has("placement-readouts") && (
          <ul className="bt-analysis-readouts">
            {readouts.map((r, i) => (
              <li key={i} className="bt-analysis-readout">
                {r}
              </li>
            ))}
          </ul>
        )}
        <div className="bt-analysis-dists">
          <Dist
            hist={sl.winners_mae_hist}
            label="Winners: worst drawdown before profit"
            slug="dist-winners-mae"
            collapsed={collapsed.has("dist-winners-mae")}
            onToggle={toggleSection}
            tip="How far each winning trade dropped before it closed in profit, as a percent of the stop distance. Winners in the 75 to 100% bucket nearly hit the stop before recovering; a crowd there means the stop is tighter than these trades need."
            pctOfStop
          />
          <Dist
            hist={sl.losers_mae_hist}
            label="Losers: worst drawdown"
            slug="dist-losers-mae"
            collapsed={collapsed.has("dist-losers-mae")}
            onToggle={toggleSection}
            tip="How far each losing trade dropped at its worst, as a percent of the stop distance. Stop exits land past 100% because they traveled the full stop distance. Losers below 100% were closed by a rule or session end before reaching the stop; many there can mean the exit rules cut trades the stop would have survived."
            pctOfStop
          />
          <Dist
            hist={analysis.r_hist}
            label="Result distribution (R)"
            slug="dist-result-r"
            collapsed={collapsed.has("dist-result-r")}
            onToggle={toggleSection}
            tip="Counts trades by realized result in R multiples. 1R is the distance from entry to the initial stop, so a +2R trade made twice the amount it risked and a trade in the -1R bucket was stopped out for about its full risk. Each bar is centered on a whole R: a clean stop reads as -1R."
            centeredR
          />
        </div>
      </section>
      )}

      {active === "bardyn" && analysis.bar_dynamics && (
        <section className="bt-analysis-section">
          <SectionH4
            slug="bar-dynamics"
            open={!collapsed.has("bar-dynamics")}
            onToggle={toggleSection}
          >
            Bar dynamics
          </SectionH4>
          {!collapsed.has("bar-dynamics") && (
            <>
              {analysis.duration_hist && (
                <DurationHistogram hist={analysis.duration_hist} barSeconds={barSeconds} />
              )}
              <BarDynamicsTable
                winners={analysis.bar_dynamics.winners}
                losers={analysis.bar_dynamics.losers}
                total={analysis.bar_dynamics.total}
                barSeconds={barSeconds}
              />
            </>
          )}
        </section>
      )}

      {active === "whatif" && (
        <WhatIfSection
          whatif={analysis.whatif}
          collapsed={collapsed.has("whatif")}
          onToggle={toggleSection}
        />
      )}

      {active === "context" && (
      <>
      <section className="bt-analysis-section">
        <SectionH4
          slug="exit-reasons"
          open={!collapsed.has("exit-reasons")}
          onToggle={toggleSection}
        >
          Exit reasons
        </SectionH4>
        {!collapsed.has("exit-reasons") && (
          <RowsTable rows={analysis.exit_reasons} />
        )}
      </section>

      {(
        [
          ["trend", "Trend at entry", "ctx-trend"],
          ["vol_regime", "Volatility regime", "ctx-vol-regime"],
          ["session", "Session", "ctx-session"],
          ["hour_bucket", "Time of day", "ctx-hour-bucket"],
          ["month", "By month", "ctx-month"],
          ["candle_pattern", "Entry-bar pattern", "ctx-candle-pattern"],
          ["day_of_week", "Day of week", "ctx-day-of-week"],
        ] as const
      ).map(([key, label, slug]) => {
        const rows =
          key === "month"
            ? analysis.month_stats ?? []
            : key === "day_of_week"
              ? dayOfWeekRows(analysis.context[key] ?? [])
              : key === "hour_bucket"
                ? hourBucketRows(analysis.hour_stats ?? [])
                : analysis.context[key] ?? [];
        // The monthly table only earns its place on multi-month runs; a
        // single-month run would be a one-row table that says nothing.
        if (key === "month" && rows.length < 2) return null;
        return (
          <section key={key} className="bt-analysis-section">
            <SectionH4 slug={slug} open={!collapsed.has(slug)} onToggle={toggleSection}>
              {label}
            </SectionH4>
            {!collapsed.has(slug) && <RowsTable rows={rows} />}
          </section>
        );
      })}
      </>
      )}
    </div>
  );
}
