import { useState, type ReactNode } from "react";
import type { AnalysisHist, AnalysisRow, BacktestAnalysis, BacktestWhatif } from "./api";
import InfoTip from "./components/InfoTip";
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
              (!r.low_sample && r.net_pnl < 0 ? "bt-analysis-under" : "")
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
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry } = whatif;
  return Boolean(rule_exit || no_target || stop_curve || target_curve || fill_delay || limit_entry);
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
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry } = whatif!;
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
      {!collapsed && (stop_curve || target_curve) && (
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
                    <td>{r.net_delta_r.toFixed(2)}</td>
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
      </div>
      )}
    </section>
  );
}

export default function BacktestAnalysisPanel({
  analysis,
}: {
  analysis: BacktestAnalysis | null | undefined;
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
  // A persisted "whatif" tab can point at a hidden tab (old stored runs have no
  // whatif payload): fall back to Placement rather than an empty page.
  const active: BacktestAnalysisTab = tab === "whatif" && !hasWhatif ? "placement" : tab;
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
          Placement
        </button>
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
          Context
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
          ["candle_pattern", "Entry-bar pattern", "ctx-candle-pattern"],
          ["day_of_week", "Day of week", "ctx-day-of-week"],
        ] as const
      ).map(([key, label, slug]) => (
        <section key={key} className="bt-analysis-section">
          <SectionH4 slug={slug} open={!collapsed.has(slug)} onToggle={toggleSection}>
            {label}
          </SectionH4>
          {!collapsed.has(slug) && (
            <RowsTable
              rows={
                key === "day_of_week"
                  ? dayOfWeekRows(analysis.context[key] ?? [])
                  : analysis.context[key] ?? []
              }
            />
          )}
        </section>
      ))}
      </>
      )}
    </div>
  );
}
