import type { ReactNode } from "react";
import { metricScale } from "../lib/backtestPanelData";

// Metric tooltip body: the plain-language line, plus an aligned word/range/desc
// table for metrics with an interpretation scale (words tinted like the verdict
// they explain). Shared by the backtest overview tiles and the sweep table
// headers so the scale renders identically everywhere.
export function metricTipLines(label: string, info: string): Array<string | ReactNode> | string {
  const scale = metricScale(label);
  if (!scale) return info;
  return [
    info,
    <span className="bt-scale" key="scale">
      {scale.map((s) => (
        <span className="bt-scale-row" key={s.range}>
          <span className={`bt-scale-word ${s.tone}`}>{s.label}</span>
          <span className="bt-scale-range">{s.range}</span>
          <span className="bt-scale-desc">{s.desc}</span>
        </span>
      ))}
    </span>,
  ];
}
