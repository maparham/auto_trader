// Illustrated guide for a built-in strategy, opened from the Guide button on
// StrategyPicker. Renders the hand-authored sections + SVG diagrams from
// strategyGuides/, then a parameter table built from the strategy's LIVE
// `meta` params (label / default / help), so the table can never drift from
// the code. Classic blocking backdrop (it's a reading surface, unlike the
// non-blocking FloatingModal), portaled to <body> so it stacks above whichever
// panel spawned it.

import { createPortal } from "react-dom";
import CloseButton from "./CloseButton";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import type { StrategyInfo } from "./api";
import type { StrategyGuide } from "./strategyGuides";

interface Props {
  strategy: StrategyInfo;
  guide: StrategyGuide;
  onClose: () => void;
}

function fmtDefault(v: number | boolean | string): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

export default function StrategyGuideModal({ strategy, guide, onClose }: Props) {
  useCloseOnEscape(onClose);
  return createPortal(
    <div
      className="modal-backdrop sg-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sg-modal" role="dialog" aria-modal="true" aria-label={strategy.name}>
        <div className="modal-head sg-head">
          <div className="sg-head-titles">
            <h2 className="sg-title">{strategy.name}</h2>
            <span className="sg-file">{strategy.filename}</span>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div className="sg-body">
          <p className="sg-tagline">{guide.tagline}</p>
          {guide.sections.map((s) => (
            <section key={s.heading} className="sg-section">
              <h3 className="sg-heading">{s.heading}</h3>
              <div className="sg-prose">{s.body}</div>
              {s.diagram && <figure className="sg-figure">{s.diagram}</figure>}
            </section>
          ))}
          <section className="sg-section">
            <h3 className="sg-heading">Parameters</h3>
            <table className="sg-params">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Default</th>
                  <th>What it does</th>
                </tr>
              </thead>
              <tbody>
                {strategy.params.map((p) => (
                  <tr key={p.name}>
                    <td>{p.label}</td>
                    <td className="sg-params-default">{fmtDefault(p.default)}</td>
                    <td className="sg-params-help">{p.help ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
