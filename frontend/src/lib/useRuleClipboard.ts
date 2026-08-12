// The rule copy/paste handlers shared by the backtest modal and the Live panel.
//
// Copy writes the portable envelope (rules + referenced pane configs, see
// ruleClipboard.ts) to the SYSTEM clipboard so it survives across windows and
// app instances, and mirrors the rules into local state as a fallback for
// clipboard-blocked environments (http://, denied permission, jsdom).
//
// Paste prefers the system clipboard: a valid envelope has its referenced panes
// recreated on this cell's chart (reusing exact matches, minting fresh ids on
// conflicts) and its expressions rewritten to the ids that actually landed.
// Anything else on the clipboard falls back to the locally copied rules.
import { useState } from "react";
import { cloneRule, type Rule } from "./backtestConfig";
import type { ChartController } from "./chartController";
import { rewriteInstanceRefs } from "./exprInstances";
import {
  captureIndicatorAppearance,
  importExprInstances,
  isSubPaneIndicator,
  liveExprInstances,
} from "./indicators";
import { refreshMtfIndicators } from "./mtfCoordinator";
import { toast } from "./notify";
import { saveIndicators } from "./persist";
import { decodeRuleClipboard, encodeRuleClipboard } from "./ruleClipboard";

export interface RuleClipboardApi {
  /** Copy `rules` (one or a whole group) — system clipboard + local fallback. */
  copyRules: (rules: readonly Rule[]) => void;
  /** Resolve what a paste should append, or null when there is nothing. */
  pasteRules: () => Promise<Rule[] | null>;
}

export function useRuleClipboard(opts: {
  controller?: ChartController | null;
  epic: string;
  resolution: string;
  /** Data broker for the HTF refetch a pasted MTF-pinned pane needs. */
  brokerId?: string;
}): RuleClipboardApi {
  const { controller, epic, resolution, brokerId } = opts;
  const [fallback, setFallback] = useState<Rule[] | null>(null);

  const copyRules = (rules: readonly Rule[]) => {
    if (!rules.length) return;
    setFallback(rules.map(cloneRule));
    const chart = controller?.chart;
    const live = chart ? liveExprInstances(chart) : [];
    const appearance = chart ? captureIndicatorAppearance(chart, live.map((i) => i.id)) : {};
    try {
      navigator.clipboard
        ?.writeText(encodeRuleClipboard(rules, live, appearance))
        ?.catch(() => toast("Copy failed (clipboard blocked) — pasteable in this window only"));
    } catch {
      // No clipboard API at all: the local fallback still works.
    }
  };

  const pasteRules = async (): Promise<Rule[] | null> => {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText?.()) ?? "";
    } catch {
      // Blocked/absent — fall through to the local fallback.
    }
    const payload = decodeRuleClipboard(text);
    if (!payload) return fallback ? fallback.map(cloneRule) : null;

    const ids = Object.keys(payload.indicators);
    if (!ids.length || !controller?.chart || controller.readOnly.value) {
      // Nothing to recreate (or nowhere to put it — no chart, or a locked
      // snapshot). Rules still paste; a missing ref lints as unknown.
      return payload.rules;
    }
    const { idMap, added } = importExprInstances(controller.chart, controller.scope, epic, payload.indicators, {
      resolution,
      forceHidden: controller.indicatorsHidden.value,
    });
    if (added.length) {
      const next = [...controller.indicators.value, ...added];
      controller.indicators.set(next);
      saveIndicators(controller.scope, next);
      // Pasting a sub-pane indicator un-collapses the sub-pane band, mirroring
      // the toolbar add and the indicator paste.
      if (controller.subPanesHidden.value && added.some((i) => isSubPaneIndicator(i.type)))
        controller.subPanesHidden.set(false);
      // The envelope ships mtf.timeframe but never the HTF series (that stash
      // belongs to the source chart's epic) — fetch it now, exactly like the
      // reload path, so a pasted pinned pane renders its own timeframe. No-op
      // when nothing added is pinned.
      void refreshMtfIndicators(controller.chart, epic, brokerId).catch(() => {});
      toast(`Added ${added.map((i) => i.id).join(", ")} to the chart`);
    }
    return payload.rules.map((r) =>
      r.expr ? { ...r, expr: rewriteInstanceRefs(r.expr, idMap) } : r,
    );
  };

  return { copyRules, pasteRules };
}
