import Tooltip from "../components/Tooltip";
import type { BacktestConfig } from "../lib/backtestConfig";
import { requiredWarmupBars } from "../lib/backtestWindow";
import type { ChartController } from "../lib/chartController";
import { exprInstancesFor, exprWarmupByRef } from "../lib/exprInstances";
import { RESOLUTION_SECONDS } from "../lib/feed";
import { liveExprInstances } from "../lib/indicators";
import { estimateWindowBars } from "./shared";

/** The history-vs-trading-window split, illustrated to scale — this is the one
 * idea (D6, in the design notes) that's hardest to explain in words: the range
 * picker only decides where TRADES happen, while indicators warm up over
 * however much history is loaded before it. "Full" depth has no known size
 * (it's whatever the broker will actually serve), so it's drawn as an
 * open-ended fade rather than a fabricated number. */
export function WindowTimeline(
  { cfg, resolution, controller }:
  { cfg: BacktestConfig; resolution: string; controller: ChartController | null },
) {
  const resSeconds = RESOLUTION_SECONDS[resolution] ?? 60;
  const windowBars = estimateWindowBars(cfg, resSeconds);
  const depth = cfg.range.history ?? "minimal";
  // Size from what the run itself demands (BacktestButton passes the same
  // resolution into requiredWarmupBars) — expression rows carry almost all of a
  // config's warm-up, and the ATR-only longestIndicatorLength never saw them.
  // "Full" stays open-ended: it has no known size to draw.
  // The chart's panes, for any `SLOPE.9`-style row: a reference carries none
  // of the pane's settings, so without these the drawn estimate reads the base
  // floor (1) while the run actually fetches the pane's full warm-up. Same list
  // BacktestButton sizes with, so the picture matches the run.
  const live = controller?.chart ? liveExprInstances(controller.chart) : [];
  const warmupRefs = { instances: exprInstancesFor(live), warmupByRef: exprWarmupByRef(live) };
  const historyBars = depth === "full" ? null : requiredWarmupBars(cfg, resSeconds, warmupRefs);

  const historyShare = historyBars === null ? 0.62 : historyBars / (historyBars + windowBars);
  const windowShare = 1 - historyShare;

  return (
    <div className="bt-timeline" aria-hidden="true">
      <div className="bt-timeline-track">
        <div
          className={`bt-timeline-history${historyBars === null ? " open-ended" : ""}`}
          style={{ flexGrow: historyShare }}
        />
        <Tooltip asChild content="Trades can only open from here on">
          <div className="bt-timeline-marker" />
        </Tooltip>
        <div className="bt-timeline-window" style={{ flexGrow: windowShare }} />
      </div>
      <div className="bt-timeline-labels">
        <span>{historyBars === null ? "as much history as the broker has" : `${historyBars.toLocaleString()} bars warm-up`}</span>
        <span className="bt-timeline-window-label">{windowBars.toLocaleString()} bars traded</span>
      </div>
    </div>
  );
}
