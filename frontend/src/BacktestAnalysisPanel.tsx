import type { AnalysisHist, AnalysisRow, BacktestAnalysis } from "./api";
import InfoTip from "./components/InfoTip";

/** Analysis tab of the backtest dock: renders the backend-computed `analysis`
 * payload (SL/TP efficiency, exit reasons, R distribution, context breakdowns).
 * Pure formatting: every number here was computed server-side. */

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtR = (v: number) => `${v.toFixed(1)}R`;

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

function Dist({
  hist,
  label,
  tip,
  pctOfStop,
}: {
  hist: AnalysisHist;
  label: string;
  tip?: string;
  pctOfStop?: boolean; // buckets are fractions of the stop distance: show "25% to stop"
}) {
  const last = hist.edges[hist.edges.length - 1];
  const names = pctOfStop
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
      <div className="bt-analysis-dist-label">
        {label}
        {tip && <InfoTip title={label} text={tip} />}
      </div>
      <ul className="bt-analysis-dist-items">
        {items.map(({ c, name }, i) => (
          <li key={i} className="bt-analysis-dist-item">
            {c} {c === 1 ? "trade" : "trades"} {pctOfStop ? "reached" : "closed at"}{" "}
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowsTable({ rows, avg }: { rows: AnalysisRow[]; avg: number }) {
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
              (!r.low_sample && r.expectancy < avg ? "bt-analysis-under" : "")
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

export default function BacktestAnalysisPanel({
  analysis,
}: {
  analysis: BacktestAnalysis | null | undefined;
}) {
  if (!analysis) {
    return <div className="bt-analysis-empty">Run a backtest to see the analysis.</div>;
  }
  if (analysis.n_trades === 0) {
    return <div className="bt-analysis-empty">No trades to analyse.</div>;
  }
  const { sl, tp } = analysis;
  const runAvg =
    analysis.exit_reasons.reduce((s, r) => s + r.net_pnl, 0) / analysis.n_trades;

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
      <section className="bt-analysis-section">
        <h4>Stop &amp; target placement check</h4>
        <ul className="bt-analysis-readouts">
          {readouts.map((r, i) => (
            <li key={i} className="bt-analysis-readout">
              {r}
            </li>
          ))}
        </ul>
        <div className="bt-analysis-dists">
          <Dist
            hist={sl.winners_mae_hist}
            label="Winners: worst drawdown before profit"
            tip="How far each winning trade dropped before it closed in profit, as a percent of the stop distance. Winners in the 75 to 100% bucket nearly hit the stop before recovering; a crowd there means the stop is tighter than these trades need."
            pctOfStop
          />
          <Dist
            hist={sl.losers_mae_hist}
            label="Losers: worst drawdown"
            tip="How far each losing trade dropped at its worst, as a percent of the stop distance. Stop exits land past 100% because they traveled the full stop distance. Losers below 100% were closed by a rule or session end before reaching the stop; many there can mean the exit rules cut trades the stop would have survived."
            pctOfStop
          />
          <Dist
            hist={analysis.r_hist}
            label="Result distribution (R)"
            tip="Counts trades by realized result in R multiples. 1R is the distance from entry to the initial stop, so a +2R trade made twice the amount it risked and a trade in the -1R bucket lost about its full risk."
          />
        </div>
      </section>

      <section className="bt-analysis-section">
        <h4>Exit reasons</h4>
        <RowsTable rows={analysis.exit_reasons} avg={runAvg} />
      </section>

      {(
        [
          ["trend", "Trend at entry"],
          ["vol_regime", "Volatility regime"],
          ["session", "Session"],
          ["candle_pattern", "Entry-bar pattern"],
          ["day_of_week", "Day of week"],
        ] as const
      ).map(([key, label]) => (
        <section key={key} className="bt-analysis-section">
          <h4>{label}</h4>
          <RowsTable
            rows={
              key === "day_of_week"
                ? dayOfWeekRows(analysis.context[key] ?? [])
                : analysis.context[key] ?? []
            }
            avg={runAvg}
          />
        </section>
      ))}
    </div>
  );
}
