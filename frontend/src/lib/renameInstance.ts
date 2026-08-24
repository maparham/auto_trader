// Orchestrates a rule-referenceable indicator instance's rename across every
// place its old id is recorded: the live chart pane (lib/indicators.ts owns
// the actual teardown+recreate), the cell's persisted instance list, and the
// currently-active (rules-based) backtest config's rule text.
//
// SCOPE: only the manual, rules-based backtest config (persist/defaults.ts
// loadBacktestLastUsed/saveBacktestLastUsed) is rewritten. A coded strategy's
// exit rules (lib/codedConfig.ts) are stored per FILE, not per chart, and are
// not enumerated here — a rename leaves a coded exit rule's ref to the old id
// stale (it lints as unknown, same as deleting the pane would; rewriteCodedExitRefs
// exists for the analogous preset-load case and can be called manually per file
// if this becomes a real workflow). If a BacktestSettingsModal for these same
// rules is open concurrently, its own in-memory draft still wins on its next
// debounced auto-save — it does not listen for external rewrites, the same
// limitation the agent-bridge config.set path already has against an open
// panel's local state (see saveBacktestLastUsed's backtestStrategySetupChanged
// comment). Reopening the panel picks up the renamed refs.
import type { ChartController } from "./chartController";
import { renameIndicatorInstance, type RenameInstanceError } from "./indicators";
import { loadBacktestLastUsed, saveBacktestLastUsed, saveIndicators } from "./persist";
import { rewriteConfigInstanceRefs } from "./ruleClipboard";

export function renameInstanceEverywhere(
  controller: ChartController,
  epic: string,
  oldId: string,
  newId: string,
): { ok: true } | { ok: false; error: RenameInstanceError } {
  const result = renameIndicatorInstance(controller.chart, controller.scope, epic, oldId, newId);
  if (!result.ok) return result;
  const next = controller.indicators.value.map((i) => (i.id === oldId ? { ...i, id: newId } : i));
  controller.indicators.set(next);
  saveIndicators(controller.scope, next);
  const cfg = loadBacktestLastUsed();
  if (cfg) saveBacktestLastUsed(rewriteConfigInstanceRefs(cfg, { [oldId]: newId }));
  return { ok: true };
}
