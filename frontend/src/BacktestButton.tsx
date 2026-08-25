// The Backtest control, lifted out of the toolbar into the top tab bar. Runs the
// user's rule-built strategy (⚙ opens the settings modal) on the focused cell's
// chart and overlays markers + equity; the summary chip (pnl / trades / win%)
// sits to its right. Self-contained: it owns its own run state and only needs
// the focused controller + the active period/broker.

import { useEffect, useState } from "react";
import {
  runAndRender,
  clearBacktest,
  fitBacktestTrades,
  coverBacktestHistory,
  oldestBacktestAnchorMs,
  renderWfoArtifacts,
  backtestActionBlockedByReplay,
  isChartReplaying,
} from "./lib/backtest";
import type { ChartController } from "./lib/chartController";
import Tooltip from "./components/Tooltip";
import { fetchRangeWithStatus, RESOLUTION_SECONDS, type Period } from "./lib/feed";
import { cachedRunNotice, emptyRangeError, warmupError } from "./lib/backtestDataHealth";
import type { PriceSide } from "./theme";
import { defaultBacktestConfig, type BacktestConfig, type RuleGroup } from "./lib/backtestConfig";
import { resolveMask } from "./lib/backtestSchedule";
import { loadCodedCfg, resolveParamValues, sendableRisk } from "./lib/codedConfig";
import { BASELINE_KINDS, cancelBacktestRun, fetchStrategies, saveSweepArchive } from "./api";
import { cancelWithRetry } from "./lib/cancelRetry";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
  widenUntilWarm,
  warmupWalkFloor,
} from "./lib/backtestWindow";
import {
  loadBacktestLastUsed,
  saveBacktestLastUsed,
  loadBacktestPeriodsShown,
  loadBacktestRegionsShown,
  loadBacktestMarkersShown,
  loadBacktestEquityShown,
  saveSweepResultId,
} from "./lib/persist";
import {
  openBacktestSettings,
  backtestRunRequest,
  backtestClearRequest,
  backtestResultSignal,
  backtestRunCompletedSignal,
  backtestMessagesSignal,
  backtestPeriodsShownSignal,
  backtestRegionsShownSignal,
  backtestMarkersShownSignal,
  backtestEquityShownSignal,
  backtestRunningSignal,
  backtestCancelRequest,
  progressStageSignal,
  backtestDurationSignal,
  backtestSelectNoticeSignal,
  tradeReviewSignal,
  sweepDurationSignal,
  sweepAxesSignal,
  sweepStateSignal,
  sweepCancelRequest,
  sweepCancelServer,
  sweepTargetSignal,
  computeHostStateSignal,
  holdoutEvalSignal,
  sweepCombosOverrideSignal,
  sweepArchivedSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  wfoRequestSignal,
  wfoStateSignal,
  wfoCancelRequest,
  wfoCancelServer,
  wfoRenderRequest,
  wfoDurationSignal,
} from "./lib/signals";
import { robustWindowBounds, runSweep, sweepCatchState } from "./lib/sweep";
import { runWalkForward, stopResumedWfo, wfoCatchState } from "./lib/wfo";
import { toast } from "./lib/notify";
import { sweepContext } from "./lib/sweepMemory";
import { loadHoldout, splitHoldout } from "./lib/holdout";
import { stopResumedSweep } from "./lib/sweepResume";
import { startBacktestProgressPoller } from "./lib/backtestProgress";
import type { BacktestRequest, ExprBacktestRequest, ExprRow, SweepRow } from "./api";
import { collectExprInstances, exprInstancesFor, exprWarmupByRef, missingExprInstances } from "./lib/exprInstances";
import { liveExprInstances } from "./lib/indicators";
import { applyPortableInstances } from "./lib/useRuleClipboard";

interface Props {
  controller: ChartController | null;
  period?: Period;
  // Symbol epic — only used to reset the readout when the instrument changes.
  epic?: string;
  brokerId: string;
  // The chart's active price side. The backtest MUST fetch the same side the
  // chart shows: the cache is populated per side, and a mismatch (e.g. fetching
  // "mid" while the chart shows "bid") silently backtests a different, often
  // far shorter, candle series than the one on screen.
  priceSide: PriceSide;
}

export default function BacktestButton({ controller, period, epic, brokerId, priceSide }: Props) {
  const chart = controller?.chart ?? null;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The transient run error belongs to a specific run; drop it when the symbol or
  // timeframe changes. Reset during render on the key change (React's "adjust
  // state on prop change" pattern) rather than in an effect. The result itself is
  // now persisted and rehydrated by ChartCore, so it is NOT cleared here anymore.
  const runKey = `${epic ?? ""}|${period?.resolution ?? ""}`;
  const [msgKey, setMsgKey] = useState(runKey);
  if (msgKey !== runKey) {
    setMsgKey(runKey);
    setError(null);
  }

  // Publish the transient error so the results pane renders it (it no longer
  // lives next to this toolbar button).
  useEffect(() => {
    backtestMessagesSignal.set({ error });
  }, [error]);

  // The results pane's clear (✕) asks for a clear through this signal; the
  // teardown lives here because only this component has the chart/controller.
  useEffect(() => backtestClearRequest.subscribe(() => clear()));

  // The panel's "Run backtest" saves the config as last-used then bumps this
  // signal, which runs the backtest here (run() always reads the latest
  // last-used config, so no config needs to be threaded through). The toolbar
  // button only opens the panel — running lives with the config.
  useEffect(() => backtestRunRequest.subscribe(() => void run()));

  // Modal scheme picker -> chart: re-render the requested scheme's stitched OOS
  // equity + fold bands from the stored last WFO result. No deps (like the
  // subscribes above) so it re-binds each render, capturing the current chart.
  useEffect(() =>
    wfoRenderRequest.subscribe(() => {
      const req = wfoRenderRequest.value;
      if (!req) return;
      // Render off the LIVE published result — a direct run, a resume, and a
      // reopen all set wfoStateSignal.value.result. A ref that only the direct-run
      // path writes would leave the scheme picker stale (or empty) on resumed runs.
      const scheme = wfoStateSignal.value?.result?.schemes[req.schemeIndex];
      if (!chart || !scheme) return;
      // renderWfoArtifacts refuses on a replaying chart (it would tear the
      // reveal down and paint real-calendar fold bands). Say so: this is a
      // click on a scheme in the results panel, and a picker that silently
      // does nothing is the pattern this feature rejected once already.
      if (!renderWfoArtifacts(chart, scheme)) {
        toast(backtestActionBlockedByReplay({ replaying: true, action: "render-wfo" })!);
      }
    }),
  );

  // Seed the on-chart display toggles from device-local storage once at startup
  // (the component is mounted for the whole app session).
  useEffect(() => {
    backtestPeriodsShownSignal.set(loadBacktestPeriodsShown());
    backtestRegionsShownSignal.set(loadBacktestRegionsShown());
    backtestMarkersShownSignal.set(loadBacktestMarkersShown());
    backtestEquityShownSignal.set(loadBacktestEquityShown());
  }, []);

  async function run() {
    // Holdout ("lockbox") one-shot: consume the evaluate flag at the VERY top,
    // before the guard below can early-return. If a stranded flag survived a
    // no-op run, the next NORMAL run would silently evaluate on the reserved
    // tail — contaminating the out-of-sample guarantee this feature protects.
    // Consuming it on a no-op run is harmless (the user just re-clicks).
    const evaluatingHoldout = holdoutEvalSignal.value;
    holdoutEvalSignal.set(false);
    if (!chart || !epic || !period || running) return;
    // ...and not while this cell is REPLAYING. Placed after the holdout consume
    // above (which is deliberately ahead of every early return) and before any
    // work, because a run does three things a blind session cannot survive: it
    // publishes `period` as a real calendar range onto the shared panel, it
    // renders every trade the strategy is about to take, and it then pages real
    // post-cursor history in and fits the view to the whole traded span. One
    // guard here covers Backtest, Sweep and Walk-forward (all three enter
    // through this function) and the agent bridge with them, which is why there
    // is no second copy in the sweep/WFO branches below.
    //
    // isChartReplaying, not controller.replaying: the signal is effect-timed for
    // chrome that has to re-render, this is the render-fresh read, and when they
    // could ever disagree the refusal must win.
    const replayBlock = backtestActionBlockedByReplay({
      replaying: isChartReplaying(chart),
      action: "run",
    });
    if (replayBlock) {
      // Surfaced, not swallowed: the results pane renders this. A Run button that
      // quietly does nothing is the pattern this feature already rejected once.
      setError(replayBlock);
      // ...and surfaced to the AGENT BRIDGE, which is the other caller of this
      // entrance and has its own protocol (agent/actions/backtest.ts): it only
      // attributes an error to the run it requested once `running` has gone
      // true, and it settles on `running` going false. A refusal that touched
      // neither would leave ui_invoke("backtest.run") waiting out the bridge's
      // 5s start timeout and then reporting "run did not start (is a chart with
      // a symbol open and focused?)", which is the wrong reason. Flip the pair
      // around an IMPERATIVE publish of the same string so the bridge rejects
      // immediately, with this message. React batches the two flips into one
      // commit, so nothing flickers; the effect on `error` re-publishes the
      // identical value harmlessly.
      backtestRunningSignal.set(true);
      backtestMessagesSignal.set({ error: replayBlock });
      // A SWEEP has a THIRD channel, watched by neither of the above: both the
      // panel's sweep view and agent/actions/sweep.ts read sweepStateSignal, and
      // that bridge settles on a terminal state carrying an `error` even before
      // its run started. Without this, ui_invoke("sweep.start") waited out its
      // own 5s START_TIMEOUT_MS and then rejected with "sweep did not start (is
      // a chart with a symbol open and focused?)" — the wrong reason, late, with
      // the axes pinned for the whole window. sweepCatchState (not a hand-built
      // state) so a refusal looks exactly like any other failed sweep and keeps
      // the rows a previous sweep put on screen.
      if (sweepAxesSignal.value.length > 0) {
        sweepStateSignal.set(sweepCatchState(sweepStateSignal.value, false, new Error(replayBlock)));
      }
      backtestRunningSignal.set(false);
      return;
    }
    setRunning(true);
    // Wall-clock start for the footer's "Took Ns" readout. Captured before any
    // fetching so the displayed duration covers the whole run, not just the
    // engine call.
    const runStart = performance.now();
    // Published imperatively (not via an effect on `running`) so the settings
    // modal's disabled "Run backtest" can never strand: the finally below always
    // resets it, even if this component were unmounted mid-run.
    backtestRunningSignal.set(true);
    // Progress side-channel: the poller feeds backtestProgressSignal (panel
    // renders it); progressId ties the POST to GET /api/backtest/progress/{id}.
    // Declared outside the try so the finally below can always stop it.
    const progressId = crypto.randomUUID();
    const stopProgress = startBacktestProgressPoller(progressId);
    // Cancel plumbing for the single-run path (the modal's "Cancel backtest",
    // Backtest mode only — sweep/WFO cancels have their own controllers in
    // their branches below). Aborting kills whichever fetch is in flight
    // (candle download or the run POST); the server-side engine is stopped
    // best-effort via its progressId. cancelBacktestRun swallows the 404 of a
    // run that already finished, so a late cancel is harmless.
    const runCtl = new AbortController();
    const unsubRunCancel = backtestCancelRequest.subscribe(() => {
      runCtl.abort();
      void cancelWithRetry(() => cancelBacktestRun(progressId));
    });
    setError(null);
    // Captured once up front: the modal publishes the axes (empty in Backtest
    // mode) right before bumping the run request, and nothing may change them
    // mid-run (run() no-ops while running).
    const sweepAxes = sweepAxesSignal.value;
    // Random-search one-shot override: captured + cleared up front (like the
    // holdout flag) so a stale sample can never leak into the next grid sweep.
    const sweepCombosOverride = sweepCombosOverrideSignal.value;
    sweepCombosOverrideSignal.set(null);
    // Walk-forward one-shot request: captured + cleared up front (like the
    // holdout flag and sweep override above) so a run that bails in prepare
    // (no candles in range, a thrown fetch/schema error) can't leave the
    // payload armed — the next plain backtest/sweep would silently execute a
    // walk-forward. The walkforward branch below uses this captured value.
    const wfoRequest = wfoRequestSignal.value;
    wfoRequestSignal.set(null);
    // Single run: drop the previous result from the pane right away — when two
    // runs produce identical numbers, a pane that never visibly changes reads
    // as "the click did nothing". Emptying it (the pane shows its running
    // state) makes every run observable. Chart artifacts are torn down later
    // by runAndRender, once the fresh result is in hand. A sweep leaves the
    // last single-run result alone: it streams into sweepStateSignal, and the
    // modal's mode switch flips between the two coexisting result sets.
    // Selection/highlight indexes belong to the result being dropped — clear
    // them here too. teardownArtifacts' own reset is owner-gated on
    // backtestResultSignal still holding the old result, which this null-set
    // defeats, so without this a re-run inherits the previous run's selected
    // trade index against the NEW trade list.
    if (sweepAxes.length === 0) {
      backtestResultSignal.set(null);
      highlightTradeSignal.set(null);
      selectedTradeSignal.set(null);
      // Only a successful finish writes a duration; a failed run shows none.
      backtestDurationSignal.set(null);
    }
    try {
      const cfg = loadBacktestLastUsed() ?? defaultBacktestConfig();
      const coded = cfg.mode === "coded";
      if (coded && !cfg.codedStrategy) {
        setError("no coded strategy selected: pick one in the backtest panel");
        return;
      }
      // The main rule groups edit as expressions. Sweeps run on the expr engine
      // (/api/expr/sweep/jobs), holdout evaluation runs the expr backtest over the
      // reserved tail window, and walk-forward routes to the expr engine
      // (/api/expr/walkforward/jobs) via exprReq below. Coded runs keep their
      // structured path throughout.
      // Coded mode: the panel's per-file config (params + risk + exit rules,
      // Task 8) drives the run — entries stay empty (the .py file opens
      // positions itself). This "effective cfg" trick (natives/ATR computed
      // server-side) other tasks reuse, so no other machinery needs to know
      // coded mode exists.
      const EMPTY_GROUP: RuleGroup = { combine: "AND", rules: [] };
      const codedCfg = coded ? loadCodedCfg("backtest", cfg.codedStrategy!) : null;
      const effCfg: BacktestConfig = coded
        ? {
            ...cfg,
            longEntry: EMPTY_GROUP,
            shortEntry: EMPTY_GROUP,
            longExit: codedCfg!.longExit,
            shortExit: codedCfg!.shortExit,
            longRisk: codedCfg!.longRisk,
            shortRisk: codedCfg!.shortRisk,
            longScaling: undefined,
            shortScaling: undefined,
          }
        : cfg;
      // The strategy's declared params schema, so panel-tuned values are
      // clamped/defaulted the same way the Parameters section shows them. A
      // stale schema (file edited since the values were saved) is harmless —
      // the backend re-validates codedParams itself. A FAILED fetch must abort
      // the run (via the catch below), not resolve against an empty schema:
      // that would silently drop every tuned value and run on file defaults.
      const codedParams = coded
        ? resolveParamValues((await fetchStrategies()).find((s) => s.filename === cfg.codedStrategy)?.params ?? [], codedCfg!.params)
        : undefined;
      // The config timeframe overrides the active chart timeframe when set;
      // absent means follow the chart (the historical behavior).
      const runResolution = cfg.range.resolution ?? period.resolution;
      const resSeconds = RESOLUTION_SECONDS[runResolution] ?? 60;
      const now = Date.now();
      const resolved = resolveWindow(cfg, resSeconds, now);
      let windowFromMs = resolved.fromMs;
      let windowToMs = resolved.toMs;
      // Holdout ("lockbox"): reserve the tail pct of the configured range. A
      // normal run or sweep clamps its `to` bound to the training span so the
      // reserved tail is never touched; the explicit Evaluate action instead
      // runs over the reserved tail only. Keyed per strategy context (rules /
      // coded file), identical to sweep memory.
      const holdoutPct = loadHoldout(sweepContext(cfg.mode, cfg.codedStrategy))?.pct ?? null;
      if (holdoutPct) {
        const { trainToMs } = splitHoldout(windowFromMs, windowToMs, holdoutPct);
        if (evaluatingHoldout) {
          // Invariant: evaluation must start strictly after the training span's
          // last tradable second. splitHoldout returns holdoutFromMs === trainToMs
          // (the shared cut), and training trades every bar <= floor(cut/1000)
          // inclusive. Starting the holdout one whole second past that upper
          // second prevents a bar sitting exactly on the boundary from trading in
          // both spans (a one-bar leak of training data into out-of-sample).
          windowFromMs = (Math.floor(trainToMs / 1000) + 1) * 1000;
        } else windowToMs = trainToMs;
      }
      const toSec = Math.floor(windowToMs / 1000);
      // Each fetch covers the full [from, toSec] span and the depth-retry /
      // widening walk keep whole results, so the run's data health is the
      // degraded status of WHICHEVER fetch's bars were kept — not a sticky OR
      // across attempts (a transient failure healed by a later fetch must not
      // brand a healthy run "ran on cached candles"). Tracked per result array.
      const degradedByResult = new WeakMap<object, string | null>();
      const fetchBars = async (fromMs: number) => {
        const r = await fetchRangeWithStatus(
          epic, runResolution, Math.floor(Math.max(0, fromMs) / 1000), toSec, priceSide, brokerId, runCtl.signal,
        );
        degradedByResult.set(r.bars, r.degraded);
        return r.bars;
      };

      // Coded exits are sent as expression rows (baseReq below) and rule-mode
      // runs post whole { expr, enabled }[] groups. Defined here so the pane
      // repair right below, the coded baseReq and the rule-mode exprReq/sweep
      // branch all read the SAME rows.
      const exprRows = (g: RuleGroup): ExprRow[] =>
        g.rules.map((r) => ({ expr: r.expr ?? "", enabled: r.enabled !== false }));
      // Every row the run ships, for the reference scan below and the
      // `indicators` map further down. effCfg, not cfg: a coded run's dormant
      // rule-mode groups name panes this run never evaluates.
      const allRunRows = [effCfg.longEntry, effCfg.longExit, effCfg.shortEntry, effCfg.shortExit]
        .flatMap(exprRows);
      const runRows = allRunRows.map((r) => r.expr);
      // A rule can outlive the pane it names (the rules live in the config; the
      // panes are chart state anyone can delete from the legend). Rather than
      // let the request omit the entry and the backend 422 on
      // `unknown_indicator_ref`, re-create the missing panes from the refs
      // themselves — `SLOPE2.50 > SLOPE2.100` mints a SLOPE pane carrying the 50
      // and 100 MAs. Only lengths and the accel companion survive in a ref, so
      // everything else (MA kind, unit, ATR smoothing, any timeframe pin) takes
      // defaults — hence the toast: the run proceeds, but the user is told the
      // series was rebuilt from the rule text and not from their old settings.
      // Presets are the lossless path (they snapshot the panes whole), which is
      // what the notice points at.
      // ENABLED rows only, unlike the `indicators` map below: the backend skips a
      // disabled row before it ever compiles (api/expr_exec.py), so a disabled
      // rule naming a dead pane costs the run nothing today — re-creating a pane
      // for it would put a chart artifact in front of the user for a rule that
      // isn't running.
      if (chart) {
        const missing = missingExprInstances(
          liveExprInstances(chart),
          allRunRows.filter((r) => r.enabled).map((r) => r.expr),
        );
        applyPortableInstances(
          {
            controller,
            epic,
            resolution: runResolution,
            brokerId,
            notice: (ids) =>
              `Re-created ${ids.join(", ")} from the rules (default settings: ` +
              `MA type, units and timeframe). Load a preset to restore the originals.`,
          },
          missing,
        );
      }
      // The chart's live panes, read ONCE (AFTER the repair above, so a
      // re-created pane is sized and shipped like any other): a row saying
      // `SLOPE.9 > 0.5` names an output and restates none of the pane's
      // settings, so the pane is the only place both the run's WARM-UP DEPTH
      // (warmupRefs, used by every sizing call below) and the request's
      // `indicators` map (exprIndicators, built further down from this same
      // list) can come from. Read before sizing, not at request-build time, or
      // the history ask would charge a referenced pane zero bars and the run
      // would trade an unwarmed series.
      const live = chart ? liveExprInstances(chart) : [];
      const warmupRefs = {
        instances: exprInstancesFor(live),
        warmupByRef: exprWarmupByRef(live),
      };
      // Warm-up/history depth must size against the config the run actually
      // executes (effCfg): in coded mode that's the file's panel exit rules +
      // risk, not the dormant rules-mode groups sitting in cfg.
      const required = requiredWarmupBars(effCfg, resSeconds, warmupRefs);
      const depth = cfg.range.history ?? "minimal";
      // Temporary phase timing (perf investigation) — logged as [backtest perf].
      const tFetch0 = performance.now();
      progressStageSignal.set("downloading");
      let historyFromMs = resolveHistoryStart(effCfg, windowFromMs, resSeconds, warmupRefs);
      let bars = await fetchBars(historyFromMs);

      // The requested depth can exceed what the broker/account actually serves
      // (e.g. "Full" asking further back than a live account's history limit) —
      // that can come back either completely empty OR a non-empty but too-short
      // history (a broker rejecting only the oldest chunk, or the cache serving
      // whatever it already had). Either way, retry once at the minimal depth
      // (the smallest, most likely-to-succeed ask) rather than only checking for
      // the empty case.
      if (depth !== "minimal" && (bars.length === 0 || warmupBarCount(bars, windowFromMs) < required)) {
        const minimalFromMs = minimalHistoryStart(effCfg, windowFromMs, resSeconds, warmupRefs);
        const retried = await fetchBars(minimalFromMs);
        if (warmupBarCount(retried, windowFromMs) > warmupBarCount(bars, windowFromMs)) {
          bars = retried;
          historyFromMs = minimalFromMs;
        }
      }

      // An indicator's warm-up is a mathematical requirement of the indicator —
      // it isn't bounded by the user's range or by session hours. The asks above
      // are calendar-time conversions of a bar count, so one landing inside a
      // weekend/holiday closure comes back short (see widenedHistoryStart).
      bars = await widenUntilWarm(
        bars,
        historyFromMs,
        {
          windowFromMs,
          resSeconds,
          required,
          floorMs: warmupWalkFloor(effCfg, windowFromMs, resSeconds, warmupRefs),
        },
        fetchBars,
      );

      // The kept result's health (see degradedByResult above).
      const dataDegraded = degradedByResult.get(bars) ?? null;

      const tradeFromTime = Math.round(windowFromMs / 1000);
      if (!bars.some((k) => Math.round(k.timestamp / 1000) >= tradeFromTime)) {
        setError(emptyRangeError(dataDegraded));
        return;
      }

      // Insufficient warm-up is a hard failure, not a warning. An indicator seeded
      // from fewer bars than its lookback isn't a less-accurate version of itself —
      // it's a different series, and near the window start it crosses where the
      // real one doesn't. Those phantom crosses become trades, and a result that
      // silently mixes them with real ones is worse than no result: it reports a
      // P&L the strategy never had. The widening walk above already tried to get
      // the bars honestly, so reaching here means they aren't available.
      const warmup = warmupBarCount(bars, windowFromMs);
      if (warmup < required) {
        // Zero warm-up bars with data in the window means the broker's history
        // for this epic/resolution simply starts after the requested From date
        // (the widening walk already asked deeper and got nothing). Deeper
        // depth or shorter indicators can't help there, so don't suggest them.
        if (warmup === 0 && bars.length > 0) {
          const firstBar = new Date(bars[0].timestamp).toISOString().slice(0, 10);
          setError(
            warmupError(
              `no history before the window: ${epic} ${runResolution} data starts ` +
                `${firstBar}, after the range's From date. Move the range start past ` +
                `that date (or switch to a data source with deeper history).`,
              dataDegraded,
            ),
          );
          return;
        }
        setError(
          warmupError(
            `not enough history: ${warmup} of ${required} warm-up bars before the window. ` +
              `Indicators can't be computed correctly here — start the range later, ` +
              `raise the history depth, or shorten the longest indicator.`,
            dataDegraded,
          ),
        );
        return;
      }

      // Enough cached data to run despite a broker outage: proceed (the result
      // is identical for the bars that exist), but say so — including the
      // effective data end when the unreachable tail cut the range short.
      const degradedNotice = cachedRunNotice(
        dataDegraded,
        bars.length ? bars[bars.length - 1].timestamp : null,
        toSec,
        resSeconds,
      );
      if (degradedNotice) toast(degradedNotice);

      // The backend recomputes every indicator/price/ATR series itself from the
      // rule expressions (and coded mode's strategy-file indicators run in
      // Python), so the browser ships no precomputed series.
      const tSeries0 = performance.now();
      const series: Record<string, Array<number | null>> = {};
      const tSeries1 = performance.now();
      const candles = bars.map((k) => ({
        time: Math.round(k.timestamp / 1000),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume ?? 0,
      }));

      console.info(
        `[backtest perf] prepare: bars fetch ${(tSeries0 - tFetch0).toFixed(0)}ms (${bars.length} bars), ` +
          `series ${(tSeries1 - tSeries0).toFixed(0)}ms (${Object.keys(series).length} series)`,
      );
      const tRun0 = performance.now();
      // The chart panes these rows reference ("SLOPE.9"), with their LIVE
      // settings — read off the chart rather than storage so a pane retuned a
      // moment ago runs as it looks. Only referenced panes travel. A referenced
      // pane that is gone was re-created from the refs before `live` was read
      // (see the repair above), so the only ids still missing here are ones no
      // pane type can mint (a typo'd id) — those ship nothing and the backend
      // reports them, which is the honest answer for a name that means nothing.
      // Both requests carry the map: a coded run still posts THIS panel's exit
      // rules as expressions.
      const exprIndicators = chart ? collectExprInstances(live, runRows) : undefined;
      const baseReq: BacktestRequest = {
        epic,
        resolution: runResolution,
        candles,
        series,
        // Coded strategies compute indicators in Python — nothing to precompute.
        codedStrategy: coded ? cfg.codedStrategy : undefined,
        // The backend fetches higher-timeframe candles itself for BOTH coded
        // strategies (ctx.ema(tf=...)) and rule mode (a native indicator on a
        // non-base @tf, incl. sloped operands) — always over the same broker/
        // price side the chart is showing, so its cache/side matches the base
        // candles we shipped. Omitting these in rule mode made the backend fall
        // back to its "capital"/"mid" defaults and fetch the wrong series → an
        // empty HTF set → "no candles for timeframe '…'".
        broker: brokerId,
        priceSide,
        // Panel-tuned ctx.param() overrides for the coded strategy.
        codedParams,
        // Coded exits travel on exprLongExit/exprShortExit (below); the structured
        // rule groups have been removed from the backtest request.
        exprLongExit: exprRows(effCfg.longExit),
        exprShortExit: exprRows(effCfg.shortExit),
        // The exit groups' AND/OR switch rides along with their rows.
        exprLongExitCombine: effCfg.longExit.combine,
        exprShortExitCombine: effCfg.shortExit.combine,
        // Coded runs post their exits as expression rows, so those rows can
        // reference a chart pane the same way rule mode does.
        indicators: exprIndicators,
        // `!== false` so a preset predating these flags (undefined) still trades.
        // Coded mode: longEnabled/shortEnabled are rules-mode UI; RuleStrategy
        // gates EXITS on them (rule.py). A coded run must never let a
        // rules-mode toggle silently disable that side's panel exit rules
        // while the .py file still opens positions on it (I1).
        longEnabled: coded ? true : cfg.longEnabled !== false,
        shortEnabled: coded ? true : cfg.shortEnabled !== false,
        // A none/none risk (RiskSection touched then reset) must be
        // indistinguishable from no panel risk at all, or the backend strips
        // the coded file's own sl=/tp= while applying no stop either (C1).
        longRisk: sendableRisk(effCfg.longRisk),
        shortRisk: sendableRisk(effCfg.shortRisk),
        longScaling: effCfg.longScaling,
        shortScaling: effCfg.shortScaling,
        costs: cfg.costs,
        tradeFromTime,
        mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        // Always-on for single runs: the handler skips it when a sweep is set,
        // so the sweep path below pays nothing.
        costSensitivity: true,
      };

      // Task 13 Stage A: rule-mode runs go through the expression-native engine,
      // posting { expr, enabled }[] groups. This request drives BOTH the plain
      // single run (/api/expr/backtest) and the expr sweep (/api/expr/sweep/jobs)
      // below; coded runs stay on the structured baseReq.
      const exprReq: ExprBacktestRequest = {
        epic,
        resolution: runResolution,
        candles,
        // @tf rows: backend fetches HTF candles itself — over the chart's
        // broker/side, or its "capital"/"mid" defaults would fetch the wrong
        // series (same failure the coded baseReq comment above recounts).
        broker: brokerId,
        priceSide,
        longEntry: exprRows(effCfg.longEntry),
        longExit: exprRows(effCfg.longExit),
        shortEntry: exprRows(effCfg.shortEntry),
        shortExit: exprRows(effCfg.shortExit),
        // Each group's AND/OR switch — undefined (a preset predating the field)
        // drops the key and the backend defaults to AND.
        longEntryCombine: effCfg.longEntry.combine,
        longExitCombine: effCfg.longExit.combine,
        shortEntryCombine: effCfg.shortEntry.combine,
        shortExitCombine: effCfg.shortExit.combine,
        longEnabled: cfg.longEnabled !== false,
        shortEnabled: cfg.shortEnabled !== false,
        longRisk: sendableRisk(effCfg.longRisk),
        shortRisk: sendableRisk(effCfg.shortRisk),
        longScaling: effCfg.longScaling,
        shortScaling: effCfg.shortScaling,
        costs: cfg.costs,
        tradeFromTime,
        mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        // The chart panes these rows reference ("SLOPE.9"), with their LIVE
        // settings — read off the chart rather than storage so a pane retuned a
        // moment ago runs as it looks. Only referenced panes travel; a reference
        // to a pane that is gone ships nothing (the editor already flags it).
        indicators: exprIndicators,
      };

      // Walk-forward mode: the modal populated wfoRequestSignal (one-shot,
      // captured + cleared up front) and asked for this same run — submit the
      // whole grid + test schedule as one backend job via runWalkForward,
      // streaming state into wfoStateSignal for the modal's WFO results view.
      // Sibling branch BEFORE the sweep branch: a consumed request takes
      // precedence, and the two never fire together because the modal sets only one.
      if (wfoRequest) {
        const wf = wfoRequest;
        // Managed-host gate, same as the sweep branch below.
        const hostState = computeHostStateSignal.value;
        if (sweepTargetSignal.value === "remote" && (hostState === "stopped" || hostState === "booting")) {
          toast("Compute host is not ready yet. Start it from the toolbar (Host off / Start).");
          return;
        }
        // Take over from any live re-attached (resumed) poll first, so this
        // fresh submission owns the WFO state cleanly.
        stopResumedWfo();
        const ctl = new AbortController();
        const unsub = wfoCancelRequest.subscribe(() => ctl.abort());
        const wfoRunStart = performance.now();
        // Cleared up front, written only on a clean completion below — a cancelled
        // or failed walk-forward shows no duration (mirrors the sweep branch).
        wfoDurationSignal.set(null);
        wfoStateSignal.set({ phase: "grid", done: 0, total: 0, running: true, foldRows: [], result: null, startedAt: wfoRunStart });
        try {
          progressStageSignal.set(sweepTargetSignal.value === "remote" ? "uploading" : "submitting");
          const result = await runWalkForward(coded ? baseReq : exprReq, wf, {
            signal: ctl.signal,
            target: sweepTargetSignal.value,
            shouldCancelServer: () => wfoCancelServer.value,
            expr: !coded,
            // Same origin as the seed above and as wfoDurationSignal below, so
            // the progress bar's elapsed readout never rewinds across the first
            // poll and agrees with the footer's "Took Ns".
            startedAt: wfoRunStart,
            // After an abort (modal closed / Cancel) the state may already be
            // cleared — a late-resolving poll must not resurrect a ghost run.
            // Mirrors the sweep branch's onRows guard + continueResumeWfo.
            onState: (st) => {
              if (ctl.signal.aborted) return;
              progressStageSignal.set(null);
              wfoStateSignal.set(st);
            },
          });
          // Draw the primary scheme's stitched OOS equity + fold bands on the
          // chart. Guarded: `result` is null on a backend-reported cancel, and a
          // run where every fold failed can yield zero schemes. The modal's scheme
          // picker re-renders other schemes off the published wfoStateSignal.result.
          if (result) {
            wfoDurationSignal.set(performance.now() - wfoRunStart);
            const scheme0 = result.schemes[0];
            if (chart && scheme0) renderWfoArtifacts(chart, scheme0);
          }
        } catch (e) {
          // When the modal already tore the state down (detach-close abort),
          // stay torn down instead of resurrecting a cancelled ghost — mirrors
          // the sweep branch's teardown guard below.
          if (!(ctl.signal.aborted && wfoStateSignal.value === null)) {
            wfoStateSignal.set(wfoCatchState(wfoStateSignal.value, ctl.signal.aborted, e));
          }
        } finally {
          unsub();
        }
        return;
      }

      // Sweep mode (Task 10): the modal populated sweepAxesSignal and asked for
      // this same run — chunk through runSweep instead of a single runAndRender.
      // Nothing renders on the chart; results stream into sweepStateSignal for
      // the modal's <SweepResults> to show. Clicking a result applies it, which
      // clears the axes and re-enters this function on the normal path.
      if (sweepAxes.length > 0) {
        // Managed-host gate: a remote sweep can't run while the EC2 host is
        // stopped or still booting. "unknown"/"unconfigured" submit as before
        // (plain remote hosts without lifecycle management keep working). The
        // outer finally resets `running`, so an early return here is clean.
        const hostState = computeHostStateSignal.value;
        if (sweepTargetSignal.value === "remote" && (hostState === "stopped" || hostState === "booting")) {
          toast("Compute host is not ready yet. Start it from the toolbar (Host off / Start).");
          return;
        }
        const ctl = new AbortController();
        const unsubCancel = sweepCancelRequest.subscribe(() => ctl.abort());
        // Take over from any live re-attached (resumed) poll first, so this fresh
        // submission owns the sweep state cleanly instead of racing a resumed one.
        stopResumedSweep();
        sweepStateSignal.set({ rows: [], done: 0, total: 0, running: true, etaSeconds: null, startedAt: runStart });
        // Cleared up front, written only on completion below — a cancelled or
        // failed sweep shows no duration.
        sweepDurationSignal.set(null);
        const windows = robustWindowBounds(windowFromMs, windowToMs, cfg.robustWindows);
        const sweepTarget = sweepTargetSignal.value;
        try {
          const landed: SweepRow[] = [];
          progressStageSignal.set(sweepTarget === "remote" ? "uploading" : "submitting");
          const rows = await runSweep(coded ? baseReq : exprReq, sweepAxes, {
            signal: ctl.signal,
            windows,
            target: sweepTarget,
            // Non-coded (expression) sweeps submit to the expr sweep route.
            expr: !coded,
            // Random search: submit the sampled subset instead of the full grid.
            combosOverride: sweepCombosOverride ?? undefined,
            // A modal-close abort (requestSweepCancel(false)) leaves the server
            // job running for a reload to re-attach; the Cancel button
            // (requestSweepCancel(true)) kills it. Read at abort time.
            shouldCancelServer: () => sweepCancelServer.value,
            onRows: (chunkRows, done, total, etaSeconds) => {
              // After an abort (modal closed / Cancel) the state may already be
              // cleared — a late chunk must not resurrect a ghost sweep.
              if (ctl.signal.aborted) return;
              progressStageSignal.set(null);
              landed.push(...chunkRows);
              sweepStateSignal.set({ rows: landed, done, total, running: true, etaSeconds, startedAt: runStart });
            },
          });
          sweepStateSignal.set({ rows, done: rows.length, total: rows.length, running: false });
          sweepDurationSignal.set(performance.now() - runStart);
          // Only on a real completion with produced rows (never on cancel/empty).
          if (rows.length > 0) {
            // Archive the completed sweep server-side (fire-and-forget) so it can
            // be listed and reopened later. Never blocks the UI path.
            saveSweepArchive({
              epic: baseReq.epic,
              timeframe: baseReq.resolution,
              name: null,
              axes: sweepAxes,
              rows,
              windows: windows ?? null,
            })
              .then(({ id }) => {
                // Bind this freshly-archived sweep to the running cell so it is
                // THIS tab+cell's result on the next mount/reload — not inherited
                // by any other cell showing the same epic.
                if (controller) saveSweepResultId(controller.scope, baseReq.epic, id);
                sweepArchivedSignal.set(sweepArchivedSignal.value + 1);
              })
              .catch((e) => console.warn("sweep archive failed", e));
          }
        } catch (e) {
          // A user Cancel and a real chunk failure both reject the same
          // promise — check the controller's own signal (not the error's
          // message) to tell them apart, so Cancel never renders as an error.
          // When the modal already tore the state down (unmount cancel), stay
          // torn down instead of re-publishing a cancelled ghost.
          if (!(ctl.signal.aborted && sweepStateSignal.value === null)) {
            sweepStateSignal.set(sweepCatchState(sweepStateSignal.value, ctl.signal.aborted, e));
          }
        } finally {
          unsubCancel();
        }
        return;
      }

      progressStageSignal.set("engine");
      // Rule-mode single runs go through the expression-native /api/expr/backtest
      // via the exprReq built above (coded runs stay on baseReq). Sweeps/WFO above
      // use their own routing.
      const res = await runAndRender(
        chart,
        // progressId rides only on the SINGLE-RUN body: baseReq/exprReq are
        // shared with the sweep and walk-forward submissions above, which run on
        // job workers with their own status polling — one shared id there would
        // cross-talk. Spread here so those literals stay untouched.
        //
        // baselines rides the same way, and for the same reason: the null/hold
        // reference runs belong to a single run only, coded or expression. The
        // sweep and walk-forward branches above share baseReq/exprReq and their
        // per-combo/per-fold jobs must not carry the field.
        coded
          ? { ...baseReq, progressId, baselines: BASELINE_KINDS }
          : { ...exprReq, progressId, baselines: BASELINE_KINDS },
        controller!.scope,
        // Displayed TF, so runAndRender picks native/aggregate/none correctly when
        // the run's base TF (runResolution) differs from what the chart shows.
        period.resolution,
        {
          fromMs: windowFromMs,
          toMs: windowToMs,
          mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        },
        runCtl.signal,
      );
      // The summary chip is driven by the signal subscription above, so just
      // publish the result (rehydrate uses the same publish path).
      backtestResultSignal.set(res);
      // Announce the COMPLETION separately, adjacent to the publish so the
      // pairing stays local. Rehydrate shares the publish path above but must
      // not look like a new run to consumers that record one (PresetsTab), and
      // it cannot be distinguished by object identity — runAndRender returns the
      // copy read back out of storage, so a fresh run is a distinct object from
      // the in-memory result too. Only this site, reached solely by a completed
      // single backtest, bumps the counter.
      backtestRunCompletedSignal.set(backtestRunCompletedSignal.value + 1);
      // The run's range can predate the chart's currently-loaded (recent) bars —
      // runAndRender then culls those fills as out-of-window. Page history back to
      // the RUN'S OWN oldest fill (not the drawings walk: its target is the oldest
      // saved drawing anchor, which can be years older than the run and drag a
      // deep budget-capped page-back into every run), which reanchors the markers
      // onto their real candles. No-op when already covered. Await it so trades
      // predating the loaded window are paged in, then fit the chart to the full
      // traded span. Only on a fresh run: reload/TF-switch go via renderArtifacts.
      const tCover0 = performance.now();
      const oldestFillMs = oldestBacktestAnchorMs(res.markers);
      if (chart && oldestFillMs != null) await coverBacktestHistory(chart, oldestFillMs);
      const tCover1 = performance.now();
      if (chart) fitBacktestTrades(chart, res);
      const tFit1 = performance.now();
      console.info(
        `[backtest perf] land: runAndRender ${(tCover0 - tRun0).toFixed(0)}ms, ` +
          `coverage walk ${(tCover1 - tCover0).toFixed(0)}ms, fit ${(tFit1 - tCover1).toFixed(0)}ms, ` +
          `run total ${(tFit1 - tFetch0).toFixed(0)}ms`,
      );
      backtestDurationSignal.set(performance.now() - runStart);
      saveBacktestLastUsed(cfg);
    } catch (e) {
      // A user Cancel and a real failure reject the same promise — check the
      // controller's own signal (not the error) to tell them apart, so Cancel
      // never renders as an error (mirrors the sweep branch's catch).
      if (!runCtl.signal.aborted) {
        setError(e instanceof Error ? e.message : "backtest failed");
      }
    } finally {
      unsubRunCancel();
      setRunning(false);
      stopProgress();
      backtestRunningSignal.set(false);
      progressStageSignal.set(null);
    }
  }

  function clear() {
    // Delete the persisted result too, so it doesn't come back on the next
    // timeframe switch or reload. (summary follows backtestResultSignal.)
    if (chart && controller && epic) clearBacktest(chart, controller.scope, epic);
    backtestResultSignal.set(null);
    setError(null);
    // Companions of the result that outlive teardownArtifacts: the trade review
    // card, the footer's "Took …" readout (run() resets it, clear() must too)
    // and the trades-tab select notice would all render against a gone result.
    tradeReviewSignal.set(null);
    backtestDurationSignal.set(null);
    backtestSelectNoticeSignal.set(null);
  }

  return (
    <div className="backtest">
      <Tooltip content={running ? "Backtest running…" : "Open or close the backtest panel"}>
        <button
          className={`anchor-btn backtest-toggle${running ? " on" : ""}`}
          onClick={openBacktestSettings}
        >
          {/* Rewind clock: replay history — run a strategy over past bars. */}
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 2.6-6.3" />
            <path d="M3 4v4h4" />
            <path d="M12 7.5v5l3.5 2" />
          </svg>
          <span className="tb-label">Backtest</span>
        </button>
      </Tooltip>
    </div>
  );
}
