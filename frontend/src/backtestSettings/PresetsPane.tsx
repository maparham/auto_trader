// The Presets pane: the saved-configuration library, wired to load into the
// panel and to snapshot/restore the chart panes a preset's rules reference.
import type { Dispatch, SetStateAction } from "react";
import PresetsTab from "../components/PresetsTab";
import type { BacktestConfig } from "../lib/backtestConfig";
import type { ChartController } from "../lib/chartController";
import { defaultCodedCfg, loadCodedCfg, rewriteCodedExitRefs, type CodedStrategyConfig } from "../lib/codedConfig";
import { captureIndicatorAppearance, liveExprInstances } from "../lib/indicators";
import type { BacktestRunMode } from "../lib/persist";
import { applyRiskSync } from "../lib/riskSync";
import { collectPortableInstances, rewriteConfigInstanceRefs } from "../lib/ruleClipboard";
import { requestGoLive } from "../lib/signals";
import { applyPortableInstances } from "../lib/useRuleClipboard";
import { Section } from "./Section";

export function PresetsPane({
  cfg,
  setCfg,
  setCodedCfg,
  side,
  activePreset,
  setActivePreset,
  epic,
  effectiveRes,
  btMode,
  controller,
  resolution,
  brokerId,
}: {
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  setCodedCfg: Dispatch<SetStateAction<CodedStrategyConfig>>;
  side: "long" | "short";
  activePreset: string | null;
  setActivePreset: (name: string | null) => void;
  epic: string;
  effectiveRes: string;
  btMode: BacktestRunMode;
  controller: ChartController | null;
  resolution: string;
  brokerId: string;
}) {
  return (
    <Section
      title="Presets"
      info={[
        "One active preset tracks the whole configuration (range, mask, rules, risk, costs); a dot marks unsaved changes, and you can save, save under a new name, or revert.",
        "The library lists every saved strategy with the results of the last backtest recorded against it, sortable by any column.",
        "Export writes the library to a JSON file; import merges one back in.",
      ]}
    >
      <PresetsTab
        cfg={cfg}
        // Same copy-on-load risk-sync normalization the rest of the modal
        // applies: a preset saved with sync on but the sides drifted apart
        // must land in the panel already reconciled.
        onLoad={(next) => {
          setCfg(applyRiskSync(next, side));
          // A preset load may have just written its coded-param snapshot
          // into the per-file store; the [cfg.codedStrategy] effect won't
          // fire when the filename is unchanged, so re-read here.
          setCodedCfg(applyRiskSync(
            next.codedStrategy ? loadCodedCfg("backtest", next.codedStrategy) : defaultCodedCfg(),
            "long",
          ));
        }}
        activeName={activePreset}
        onActiveChange={setActivePreset}
        chartSymbol={epic}
        chartTimeframe={effectiveRes}
        // Only a plain backtest produces the single result summary a preset
        // can record; sweep/WFO runs produce many.
        captureRuns={btMode === "backtest"}
        // Sends the CURRENTLY configured strategy to the Live panel, not
        // whichever preset happens to be highlighted in the library.
        onGoLive={() => requestGoLive(cfg)}
        // The chart-side halves of the preset's pane snapshot: capture
        // reads the referenced panes' LIVE settings (same map a run
        // ships), apply recreates them on this cell and rewrites the
        // rule refs to the ids that landed — the paste flow, reused.
        // No chart is `undefined`, not `{}`: "can't answer" must be
        // distinguishable from "no panes referenced", or a save while
        // the chart is torn down would wipe the stored snapshot.
        captureExprInstances={(exprs) => {
          const chart = controller?.chart;
          if (!chart) return undefined;
          const live = liveExprInstances(chart);
          return collectPortableInstances(
            exprs, live, captureIndicatorAppearance(chart, live.map((i) => i.id)),
          );
        }}
        applyExprInstances={(instances, c) => {
          const idMap = applyPortableInstances(
            { controller, epic, resolution, brokerId }, instances,
          );
          // The coded store's exits were just restored by the preset
          // (restoreCodedParams runs before this callback) and can name
          // the same panes — their refs must follow renamed ids too.
          if (c.codedStrategy) rewriteCodedExitRefs("backtest", c.codedStrategy, idMap);
          return rewriteConfigInstanceRefs(c, idMap);
        }}
      />
    </Section>
  );
}
