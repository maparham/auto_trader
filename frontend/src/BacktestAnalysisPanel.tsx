import type { AnalysisHist, AnalysisRow, BacktestAnalysis } from "./api";
import InfoTip from "./components/InfoTip";

/** Analysis tab of the backtest dock: renders the backend-computed `analysis`
 * payload (SL/TP efficiency, exit reasons, R distribution, context breakdowns).
 * Pure formatting — every number here was computed server-side. */

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtR = (v: number) => `${v.toFixed(1)}R`;

function Hist({ hist, label }: { hist: AnalysisHist; label: string }) {
  const max = Math.max(1, ...hist.counts);
  const names = [
    `≤${hist.edges[0]}`,
    ...hist.edges.slice(1).map((e, i) => `${hist.edges[i]}–${e}`),
    `>${hist.edges[hist.edges.length - 1]}`,
  ];
  return (
    <div className="bt-analysis-hist">
      <div className="bt-analysis-hist-label">{label}</div>
      {hist.counts.map((c, i) => (
        <div key={i} className="bt-analysis-hist-row">
          <span className="bt-analysis-hist-bucket">{names[i]}</span>
          <span className="bt-analysis-hist-bar" style={{ width: `${(c / max) * 100}%` }} />
          <span className="bt-analysis-hist-count">{c || ""}</span>
        </div>
      ))}
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
            <td>
              {r.bucket}
              {r.low_sample && (
                <InfoTip title="Low sample" text="Fewer than 5 trades — treat with caution." />
              )}
            </td>
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
      `${fmtPct(sl.winners_near_stop_pct)} of winners came within 0.8R of the stop before working out.`,
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
        <h4>Stops &amp; targets</h4>
        {readouts.map((r, i) => (
          <p key={i} className="bt-analysis-readout">
            {r}
          </p>
        ))}
        <div className="bt-analysis-hists">
          <Hist
            hist={sl.winners_mae_hist}
            label="Winners — worst drawdown before profit (MAE, in R)"
          />
          <Hist hist={sl.losers_mae_hist} label="Losers — MAE (in R)" />
          <Hist hist={analysis.r_hist} label="Result distribution (R)" />
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
          <RowsTable rows={analysis.context[key] ?? []} avg={runAvg} />
        </section>
      ))}
    </div>
  );
}
