// Runs one assistant tool call and, for writes, captures what "Undo this
// turn" needs BEFORE the forward call. Registry tools go through invokeAction,
// the same handlers the toolbar and the MCP bridge use, so persistence and
// alert sync are unchanged.
import { ActionError, invokeAction, type ActionContext } from "../agent/registry";
import { focusedChart, agentPeriod } from "../agent/actions/chart";
import { focusedDrawings } from "../agent/actions/drawings";
import { liveExprInstances } from "../lib/indicators";
import { loadIndicatorConfigs } from "../lib/persist/artifacts";
import { tfSeconds } from "../lib/expr/catalog";
import { toast } from "../lib/notify";
import { actionFor, prepareInput, budgetResult } from "./tools";
import { describeIndicator, configureParams, describeRules, validateRule } from "./describe";

// `epic`: captured alongside `cellId` at the same point, since a cell can be
// re-pointed at a different symbol (market.select) without its id changing —
// drawings and indicators are keyed by (scope, epic), not by cellId alone, so
// undoTurn must refuse unless BOTH still match.
// `undoable: false` marks a change that legitimately has nothing to revert
// (a read like backtest.run/chart.range.set, a market.select with no prior
// epic to go back to, or one undoTurn already reverted) — undoTurn skips
// these silently. A change with no `undo` and `undoable` left unset means
// capture failed on something that SHOULD have been undoable (an id
// collision, an indicator.remove whose settings couldn't be recovered):
// undoTurn treats that as an error rather than silently skipping it.
export interface Change {
  label: string;
  cellId: string;
  epic?: string;
  undoable?: boolean;
  undo?: () => Promise<void>;
}
export interface ExecResult { content: string; isError: boolean; change?: Change }

const NOOP_CTX = (signal: AbortSignal): ActionContext => ({ progress: () => {}, signal });
// Local tools executeTool runs itself. ask_user is the session's (it ends the turn).
const LOCAL_EXEC = new Set(["describe_indicator", "describe_rules", "validate_rule", "indicator_configure"]);

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
function oldValues(prev: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const p = (prev && typeof prev === "object" ? prev : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(patch).map((k) => [k, p[k]]));
}

function pinOf(ext: unknown): string | null {
  return (ext as { mtf?: { timeframe?: string | null } } | undefined)?.mtf?.timeframe ?? null;
}

async function local(tool: string, input: Record<string, unknown>, ctx: ActionContext): Promise<ExecResult> {
  if (tool === "describe_indicator") {
    return { content: budgetResult(tool, describeIndicator(String(input.type))), isError: false };
  }
  if (tool === "describe_rules") {
    return { content: budgetResult(tool, describeRules(liveExprInstances(focusedChart().chart))), isError: false };
  }
  if (tool === "validate_rule") {
    const { chart, resolution } = focusedChart();
    const secs = tfSeconds(resolution) ?? 3600;
    const out = validateRule(String(input.expr ?? ""), input.isExit === true, liveExprInstances(chart), secs);
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
    const bits = [input.preset, input.direction ? `${String(input.direction).toLowerCase()} only` : null, ...(input.params ? Object.keys(input.params as object) : [])]
      .filter(Boolean).join(", ");
    return {
      content: budgetResult(tool, { id, changed }),
      isError: false,
      change: {
        label: `${live.type}: ${bits || "settings changed"}`,
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
        return {
          content: budgetResult(tool, out), isError: false,
          change: {
            label: collided
              ? `Added ${out.type} (${out.id}); cannot undo (id collided with an existing pane)`
              : `Added ${out.type} (${out.id})`,
            cellId: cellNow(), epic: epicNow(),
            undo: collided ? undefined : async () => { await run("indicator.remove", { id: out.id }, undoCtx()); },
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
          change: { label: `Changed ${live?.type ?? id} settings`, cellId: cellNow(), epic: epicNow(),
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
              ? `Removed ${type} (undo re-adds it under a new id; alerts and rules on the old id are not restored)`
              : `Removed ${type ?? id}; cannot undo (its settings could not be recovered)`,
            cellId: cellNow(), epic: epicNow(),
            undo: canUndo ? async () => {
              const addArgs: Record<string, unknown> = { type, inset: inset === true };
              if (calcParams !== undefined) addArgs.calcParams = calcParams;
              const added = (await run("indicator.add", addArgs, undoCtx())) as { id: string };
              const ext = extendData ?? {};
              const setArgs: Record<string, unknown> = { id: added.id, extendData: ext };
              const pin = pinOf(ext);
              if (type === "TRENDLINES" && pin) setArgs.timeframe = pin;
              await run("indicator.set", setArgs, undoCtx());
            } : undefined,
          },
        };
      }
      case "drawing.add": {
        const out = (await run(action, args, ctx)) as { id: string; tool: string };
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Drew ${out.tool}`, cellId: cellNow(), epic: epicNow(),
            undo: async () => { await run("drawing.remove", { id: out.id }, undoCtx()); } },
        };
      }
      case "drawing.remove": {
        const snap = focusedDrawings().overlays.getDrawing(String(args.id));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Removed a ${snap?.name ?? "drawing"}`, cellId: cellNow(), epic: epicNow(),
            undo: snap ? async () => { focusedDrawings().overlays.placeDrawing(snap); } : undefined },
        };
      }
      case "backtest.config.set": {
        const before = (await run("backtest.config.get", {}, ctx)) as Record<string, unknown>;
        const keys = Object.keys((args.patch ?? {}) as object);
        const restore = Object.fromEntries(keys.map((k) => [k, before[k]]));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Updated backtest: ${keys.join(", ")}`, cellId: cellNow(), epic: epicNow(),
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
          change: { label: `Timeframe ${prev} to ${target ?? args.resolution}`, cellId: cellNow(), epic: epicNow(),
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
      await c.undo();
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
