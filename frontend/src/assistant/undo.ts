// Runs one assistant tool call and, for writes, captures what "Undo this
// turn" needs BEFORE the forward call. Registry tools go through invokeAction,
// the same handlers the toolbar and the MCP bridge use, so persistence and
// alert sync are unchanged.
import { ActionError, invokeAction, type ActionContext } from "../agent/registry";
import { focusedChart, agentPeriod } from "../agent/actions/chart";
import { focusedDrawings } from "../agent/actions/drawings";
import { liveExprInstances, getIndicatorsByPane } from "../lib/indicators";
import { loadIndicatorConfigs } from "../lib/persist/artifacts";
import { tfSeconds } from "../lib/expr/catalog";
import { toast } from "../lib/notify";
import { indicatorInfo } from "../lib/indicatorMeta";
import { toolLabel } from "../lib/drawTools";
import { tfLabel } from "../lib/timeframe";
import { actionFor, prepareInput, budgetResult, RESULT_CAP } from "./tools";
import { describeIndicator, configureParams, describeRules, validateRule, inputLabel } from "./describe";

// `epic`: captured alongside `cellId` at the same point, since a cell can be
// re-pointed at a different symbol (market.select) without its id changing —
// drawings and indicators are keyed by (scope, epic), not by cellId alone, so
// undoTurn must refuse unless BOTH still match.
// `undoable: false` marks a change that is legitimately not revertible, and
// whose label already says so: a read like backtest.run/chart.range.set, a
// market.select with no prior epic to go back to, an indicator.add whose id
// collided with an existing pane, an indicator.remove whose settings
// couldn't be recovered, or one undoTurn already reverted. undoTurn skips
// these silently rather than blocking the rest of the turn forever. A change
// with no `undo` and `undoable` left unset is different: capture failed on
// something that SHOULD have been undoable but wasn't anticipated here, so
// undoTurn treats that as an error rather than silently skipping it.
// `replay`: the tool call that made this change, stamped by the session when
// it records the change; plain JSON, so unlike `undo` it survives a reload.
// "Redo" replays these in order. `createdId`: the id an add handed back, so a
// redo that gets a NEW id can remap later calls that named the old one.
export interface Change {
  label: string;
  cellId: string;
  epic?: string;
  undoable?: boolean;
  /** May resolve to the id it restored a removed object under (a re-add
   * never gets the old id back); undoTurn keeps it as `restoredId`. */
  undo?: () => Promise<void | string>;
  replay?: { tool: string; input: Record<string, unknown> };
  createdId?: string;
  /** Set by undoTurn: the id the undo re-created this change's target under,
   * so redoing a remove removes THAT object, not the vanished old id. */
  restoredId?: string;
}
export interface ExecResult { content: string; isError: boolean; change?: Change }

const NOOP_CTX = (signal: AbortSignal): ActionContext => ({ progress: () => {}, signal });
// Local tools executeTool runs itself. ask_user is the session's (it ends the turn).
const LOCAL_EXEC = new Set(["describe_indicator", "describe_rules", "validate_rule", "indicator_configure", "indicator_values"]);

const SETTLE_TIMEOUT_MS = 2000;
const SETTLE_WARNING = "\nwarning: the chart did not switch within 2 s; check chart_state before editing.";

function cellNow(): string {
  try { return focusedChart().cellId; } catch { return ""; }
}

function epicNow(): string {
  try { return focusedChart().epic; } catch { return ""; }
}

function liveById(id: string) {
  const { chart } = focusedChart();
  return liveExprInstances(chart).find((i) => i.id === id) ?? null;
}

/** Polls `check` every 50ms until it's true or `timeoutMs` elapses (or
 * `signal` aborts). Returns whether it settled, so a caller can warn rather
 * than silently proceed on a chart that never caught up. */
export async function settleFocus(
  check: () => boolean, timeoutMs = SETTLE_TIMEOUT_MS, signal?: AbortSignal,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal?.aborted) return false;
    try { if (check()) return true; } catch { /* no focused chart yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  try { return check(); } catch { return false; }
}

function err(e: unknown): ExecResult {
  if (e instanceof DOMException && e.name === "AbortError") throw e;
  const msg = e instanceof ActionError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return { content: msg, isError: true };
}

async function run(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  return invokeAction(action, args, ctx);
}

/** Old values of the keys a shallow extendData patch touches; absent keys map
 * to undefined so the undo patch clears them. */
/** The indicator's display title ("Trendlines", "Relative Strength Index"),
 * never its registry code. */
function titleOf(type: string): string {
  return indicatorInfo(type).title || type;
}

/** "a ray", "an arrow": the panel collapses repeats of these into "2 rays". */
function article(noun: string): string {
  return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}

function oldValues(prev: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const p = (prev && typeof prev === "object" ? prev : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(patch).map((k) => [k, p[k]]));
}

function pinOf(ext: unknown): string | null {
  return (ext as { mtf?: { timeframe?: string | null } } | undefined)?.mtf?.timeframe ?? null;
}

/** Human labels for BacktestConfig keys, for the "Updated backtest: ..." change
 * label (lib/backtestConfig.ts has the field list). Unlisted keys fall back to
 * the raw key name. */
const BACKTEST_KEY_LABELS: Record<string, string> = {
  longEntry: "long entry rule", longExit: "long exit rule",
  shortEntry: "short entry rule", shortExit: "short exit rule",
  longRisk: "long stop/target", shortRisk: "short stop/target",
  longScaling: "long scaling", shortScaling: "short scaling",
  longEnabled: "long side enabled", shortEnabled: "short side enabled",
  riskSynced: "sync long/short risk", costs: "costs", range: "date range",
  mode: "strategy mode", codedStrategy: "coded strategy",
  robustWindows: "robustness windows", runBaselines: "reference baselines",
  lines: "picked trend lines",
};
function backtestKeyLabel(key: string): string {
  return BACKTEST_KEY_LABELS[key] ?? key;
}

const VALUES_DEFAULT = 60;
const VALUES_MAX = 300;

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** A pane's per-bar results, aligned to the candles klinecharts holds. */
function indicatorValues(input: Record<string, unknown>): ExecResult {
  const { chart } = focusedChart();
  const id = String(input.id);
  let ind: { result?: unknown[] } | null = null;
  for (const inds of getIndicatorsByPane(chart).values()) {
    if (inds.has(id)) { ind = inds.get(id) as { result?: unknown[] }; break; }
  }
  if (!ind) return { content: `NOT_FOUND: no indicator with id ${id}`, isError: true };
  const data = chart.getDataList();
  const result = ind.result ?? [];
  const from = Number(input.from), to = Number(input.to);
  const rows: Array<Record<string, number>> = [];
  data.forEach((bar, i) => {
    if (Number.isFinite(from) && bar.timestamp < from) return;
    if (Number.isFinite(to) && bar.timestamp > to) return;
    const row: Record<string, number> = { t: bar.timestamp, close: bar.close };
    const r = result[i];
    if (r && typeof r === "object") {
      for (const [k, v] of Object.entries(r)) if (typeof v === "number" && Number.isFinite(v)) row[k] = round(v);
    }
    rows.push(row);
  });
  const want = Math.min(VALUES_MAX, Math.max(1, Number(input.bars) || VALUES_DEFAULT));
  let out = rows.slice(-want);
  const body = () => JSON.stringify({ id, rows: out, omittedOlder: rows.length - out.length });
  // Drop the oldest rows rather than let the result cap cut the JSON mid-row.
  while (out.length > 1 && body().length > RESULT_CAP - 64) out = out.slice(Math.ceil(out.length / 10));
  return { content: body(), isError: false };
}

async function local(tool: string, input: Record<string, unknown>, ctx: ActionContext): Promise<ExecResult> {
  if (tool === "describe_indicator") {
    return { content: budgetResult(tool, describeIndicator(String(input.type))), isError: false };
  }
  if (tool === "indicator_values") {
    return indicatorValues(input);
  }
  if (tool === "describe_rules") {
    return { content: budgetResult(tool, describeRules(liveExprInstances(focusedChart().chart))), isError: false };
  }
  if (tool === "validate_rule") {
    const { chart, resolution } = focusedChart();
    const secs = tfSeconds(resolution) ?? 3600;
    // Picked trendlines (bare L<n> ids) the rule may reference, read from the
    // backtest config the same way the backtest panel does (cfg.lines), so
    // unknown_line_ref lints correctly instead of flagging every L<n>.
    const cfg = (await run("backtest.config.get", {}, ctx)) as { lines?: Record<string, unknown> };
    const lines = cfg.lines ? new Set(Object.keys(cfg.lines)) : undefined;
    const out = validateRule(String(input.expr ?? ""), input.isExit === true, liveExprInstances(chart), secs, lines);
    return { content: budgetResult(tool, out), isError: false };
  }
  if (tool === "indicator_configure") {
    const id = String(input.id);
    const live = liveById(id);
    if (!live) return { content: `NOT_FOUND: no indicator with id ${id}`, isError: true };
    const prev = [...(live.calcParams ?? [])];
    const { calcParams, changed } = configureParams(live.type, prev, {
      preset: input.preset as string | undefined,
      direction: input.direction as string | undefined,
      params: input.params as Record<string, number> | undefined,
    });
    await run("indicator.set", { id, calcParams }, ctx);
    const bits = [
      input.preset ? `${String(input.preset)} preset` : null,
      input.direction ? `${String(input.direction).toLowerCase()} only` : null,
      ...(input.params ? Object.keys(input.params as object).map((k) => inputLabel(live.type, k)) : []),
    ].filter(Boolean).join(", ");
    return {
      content: budgetResult(tool, { id, changed }),
      isError: false,
      change: {
        label: `${titleOf(live.type)}: ${bits || "settings changed"}`,
        cellId: cellNow(),
        epic: epicNow(),
        undo: async () => { await run("indicator.set", { id, calcParams: prev }, NOOP_CTX(new AbortController().signal)); },
      },
    };
  }
  return { content: `unknown tool ${tool}`, isError: true };
}

export async function executeTool(
  tool: string, input: Record<string, unknown>, ctx: ActionContext,
): Promise<ExecResult> {
  try {
    if (LOCAL_EXEC.has(tool)) return await local(tool, input, ctx);
    const action = actionFor(tool);
    if (!action) return { content: `UNKNOWN_TOOL: ${tool} is not available`, isError: true };
    const args = prepareInput(tool, input);
    const undoCtx = () => NOOP_CTX(new AbortController().signal);

    switch (action) {
      case "indicator.add": {
        // Snapshot ids present before the add: if the registry handed back
        // an id that already named one of the user's own panes, undoing by
        // that id would remove THEIR pane, not the one just added.
        const beforeIds = new Set(focusedChart().controller.indicators.value.map((i: { id: string }) => i.id));
        const out = (await run(action, args, ctx)) as { id: string; type: string };
        const collided = beforeIds.has(out.id);
        // The id only adds anything when it isn't the bare type (RSI2 next to
        // an existing RSI); "Added Trendlines (TRENDLINES)" just repeats it.
        const title = out.id === out.type ? titleOf(out.type) : `${titleOf(out.type)} (${out.id})`;
        return {
          content: budgetResult(tool, out), isError: false,
          change: {
            label: collided
              ? `Added ${titleOf(out.type)} (${out.id}); cannot undo (id collided with an existing pane)`
              : `Added ${title}`,
            cellId: cellNow(), epic: epicNow(), createdId: out.id,
            // Explicitly non-undoable (the label already says so), not a capture
            // failure: undoTurn must skip it, not block the rest of the turn.
            ...(collided
              ? { undoable: false }
              : { undo: async () => { await run("indicator.remove", { id: out.id }, undoCtx()); } }),
          },
        };
      }
      case "indicator.set": {
        const id = String(args.id);
        const live = liveById(id);
        const prevParams = [...(live?.calcParams ?? [])];
        const patch = (args.extendData ?? {}) as Record<string, unknown>;
        const prevExt = oldValues(live?.extendData, patch);
        const prevPin = pinOf(live?.extendData);
        const out = await run(action, args, ctx);
        const undoArgs: Record<string, unknown> = { id, calcParams: prevParams, extendData: prevExt };
        if (args.timeframe !== undefined) undoArgs.timeframe = prevPin ?? "chart";
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Changed ${live ? titleOf(live.type) : id} settings`, cellId: cellNow(), epic: epicNow(),
            undo: async () => { await run("indicator.set", undoArgs, undoCtx()); } },
        };
      }
      case "indicator.remove": {
        const id = String(args.id);
        const live = liveById(id);
        const { controller, scope } = focusedChart();
        const instMeta = controller.indicators.value.find(
          (i: { id: string; type?: string; inset?: boolean }) => i.id === id,
        );
        const inset = instMeta?.inset;
        // The pane the user is looking at right now may not have been drawn
        // yet (liveExprInstances misses it), so fall back to the bookkeeping
        // list (type) and the persisted config (calcParams/extendData) BEFORE
        // the remove call deletes both.
        const saved = !live ? loadIndicatorConfigs(scope)[id] : undefined;
        const type = live?.type ?? instMeta?.type;
        const calcParams = live?.calcParams ?? saved?.calcParams;
        const extendData = (live?.extendData ?? saved?.extendData) as Record<string, unknown> | undefined;
        const canUndo = type !== undefined;
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: {
            label: canUndo
              ? `Removed ${titleOf(type as string)} (undo re-adds it under a new id; alerts and rules on the old id are not restored)`
              : `Removed ${type ?? id}; cannot undo (its settings could not be recovered)`,
            cellId: cellNow(), epic: epicNow(),
            // Explicitly non-undoable (the label already says so), not a capture
            // failure: undoTurn must skip it, not block the rest of the turn.
            ...(canUndo
              ? { undo: async () => {
                  const addArgs: Record<string, unknown> = { type, inset: inset === true };
                  if (calcParams !== undefined) addArgs.calcParams = calcParams;
                  const added = (await run("indicator.add", addArgs, undoCtx())) as { id: string };
                  const ext = extendData ?? {};
                  const setArgs: Record<string, unknown> = { id: added.id, extendData: ext };
                  const pin = pinOf(ext);
                  if (type === "TRENDLINES" && pin) setArgs.timeframe = pin;
                  await run("indicator.set", setArgs, undoCtx());
                  return added.id;
                } }
              : { undoable: false }),
          },
        };
      }
      case "drawing.add": {
        const out = (await run(action, args, ctx)) as { id: string; tool: string };
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Drew ${article(toolLabel(out.tool).toLowerCase())}`, cellId: cellNow(), epic: epicNow(), createdId: out.id,
            undo: async () => { await run("drawing.remove", { id: out.id }, undoCtx()); } },
        };
      }
      case "drawing.remove": {
        const snap = focusedDrawings().overlays.getDrawing(String(args.id));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Removed ${article(snap ? toolLabel(snap.name).toLowerCase() : "drawing")}`, cellId: cellNow(), epic: epicNow(),
            undo: snap ? async () => focusedDrawings().overlays.placeDrawing(snap) ?? undefined : undefined },
        };
      }
      case "backtest.config.set": {
        const before = (await run("backtest.config.get", {}, ctx)) as Record<string, unknown>;
        const keys = Object.keys((args.patch ?? {}) as object);
        const restore = Object.fromEntries(keys.map((k) => [k, before[k]]));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Updated backtest: ${keys.map(backtestKeyLabel).join(", ")}`, cellId: cellNow(), epic: epicNow(),
            undo: async () => { await run("backtest.config.set", { patch: restore }, undoCtx()); } },
        };
      }
      case "chart.timeframe.set": {
        const prev = focusedChart().resolution;
        const target = agentPeriod(String(args.resolution))?.resolution;
        const out = await run(action, args, ctx);
        const settled = await settleFocus(() => focusedChart().resolution === target, SETTLE_TIMEOUT_MS, ctx.signal);
        return {
          content: budgetResult(tool, out) + (settled ? "" : SETTLE_WARNING), isError: false,
          change: { label: `Timeframe ${tfLabel(prev)} to ${tfLabel(String(target ?? args.resolution))}`, cellId: cellNow(), epic: epicNow(),
            undo: async () => {
              await run("chart.timeframe.set", { resolution: prev }, undoCtx());
              await settleFocus(() => focusedChart().resolution === prev, SETTLE_TIMEOUT_MS, undoCtx().signal);
            } },
        };
      }
      case "market.select": {
        let prev = "";
        try { prev = focusedChart().epic; } catch { /* nothing focused */ }
        const out = await run(action, args, ctx);
        const settled = await settleFocus(() => focusedChart().epic === String(args.epic), SETTLE_TIMEOUT_MS, ctx.signal);
        return {
          content: budgetResult(tool, out) + (settled ? "" : SETTLE_WARNING), isError: false,
          change: {
            label: `Opened ${args.epic} (a tab it opened stays open)`,
            cellId: cellNow(), epic: epicNow(),
            // No prior epic (nothing was focused before) means there is
            // nothing to go back to — that's a legitimate non-undoable
            // outcome, not a capture failure, so it's marked rather than
            // left to look like an error.
            ...(prev
              ? { undo: async () => {
                  await run("market.select", { epic: prev }, undoCtx());
                  await settleFocus(() => focusedChart().epic === prev, SETTLE_TIMEOUT_MS, undoCtx().signal);
                } }
              : { undoable: false }),
          },
        };
      }
      case "chart.range.set":
      case "backtest.run": {
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: {
            label: action === "backtest.run" ? "Ran the backtest" : "Moved the visible range",
            cellId: cellNow(), epic: epicNow(), undoable: false,
          },
        };
      }
      default: {
        const out = await run(action, args, ctx);
        return { content: budgetResult(tool, out), isError: false };
      }
    }
  } catch (e) {
    return err(e);
  }
}

export async function undoTurn(changes: Change[]): Promise<boolean> {
  for (const c of [...changes].reverse()) {
    // Explicitly non-undoable: a read-like change, a market.select with no
    // prior epic, or one undoTurn already reverted on an earlier call (see
    // below). Skip silently — there's nothing wrong here.
    if (c.undoable === false) continue;
    if (cellNow() !== c.cellId || epicNow() !== c.epic) {
      toast("Focus the chart this change was made on, then undo.");
      return false;
    }
    if (!c.undo) {
      // undoable was never marked false, so this SHOULD have had an undo
      // closure (an id collision, an indicator.remove whose settings
      // couldn't be recovered) — surface it rather than silently moving on.
      toast(`Can't undo "${c.label}": its previous settings could not be recovered.`);
      return false;
    }
    try {
      const restored = await c.undo();
      if (typeof restored === "string") c.restoredId = restored;
      // Mark reverted so a retried undoTurn (after the user fixes focus for
      // an earlier mismatch) doesn't run this revert a second time.
      c.undo = undefined;
      c.undoable = false;
    } catch (e) {
      toast(`Undo failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  return true;
}

export interface RedoResult {
  /** Every replayed call ran; false on a focus refusal or a failed call. */
  ok: boolean;
  /** The fresh changes (with live undo closures) from the calls that ran. */
  changes: Change[];
  /** Old id to new id, for adds that came back under a different id. */
  ids: Record<string, string>;
}

/** Replays a reverted turn's recorded calls, in order, through executeTool,
 * so each one captures a fresh undo. An id an add returns differently from
 * the first time is remapped in every later call's top-level string args
 * (indicator_set / indicator_configure / drawing_remove name it as `id`). */
export async function redoTurn(changes: Change[]): Promise<RedoResult> {
  const steps = changes.filter((c) => c.replay);
  const ids: Record<string, string> = {};
  const out: Change[] = [];
  if (steps.length === 0) return { ok: false, changes: out, ids };
  if (cellNow() !== steps[0].cellId || epicNow() !== steps[0].epic) {
    toast("Focus the chart this change was made on, then redo.");
    return { ok: false, changes: out, ids };
  }
  for (const c of steps) {
    const { tool } = c.replay!;
    // A remove whose undo re-created its target under a new id must now
    // remove that one; this rename is internal, not news for the model.
    const local: Record<string, string> = { ...ids };
    const oldId = c.replay!.input.id;
    if (c.restoredId && typeof oldId === "string") local[oldId] = c.restoredId;
    const input = Object.fromEntries(
      Object.entries(c.replay!.input).map(([k, v]) => [k, typeof v === "string" && local[v] ? local[v] : v]),
    );
    const r = await executeTool(tool, input, NOOP_CTX(new AbortController().signal));
    if (r.isError) {
      toast(`Redo stopped at "${c.label}": ${r.content}`);
      return { ok: false, changes: out, ids };
    }
    if (!r.change) continue;
    if (c.createdId && r.change.createdId && r.change.createdId !== c.createdId) {
      ids[c.createdId] = r.change.createdId;
    }
    out.push({ ...r.change, replay: { tool, input } });
  }
  return { ok: true, changes: out, ids };
}
