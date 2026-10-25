// Runs one assistant tool call and, for writes, captures what "Undo this
// turn" needs BEFORE the forward call. Registry tools go through invokeAction,
// the same handlers the toolbar and the MCP bridge use, so persistence and
// alert sync are unchanged.
import { ActionError, invokeAction, type ActionContext } from "../agent/registry";
import { focusedChart, agentPeriod } from "../agent/actions/chart";
import { focusedDrawings } from "../agent/actions/drawings";
import { liveExprInstances } from "../lib/indicators";
import { tfSeconds } from "../lib/expr/catalog";
import { toast } from "../lib/notify";
import { actionFor, prepareInput, budgetResult } from "./tools";
import { describeIndicator, configureParams, describeRules, validateRule } from "./describe";

export interface Change { label: string; cellId: string; undo?: () => Promise<void> }
export interface ExecResult { content: string; isError: boolean; change?: Change }

const NOOP_CTX = (signal: AbortSignal): ActionContext => ({ progress: () => {}, signal });
// Local tools executeTool runs itself. ask_user is the session's (it ends the turn).
const LOCAL_EXEC = new Set(["describe_indicator", "describe_rules", "validate_rule", "indicator_configure"]);

function cellNow(): string {
  try { return focusedChart().cellId; } catch { return ""; }
}

function liveById(id: string) {
  const { chart } = focusedChart();
  return liveExprInstances(chart).find((i) => i.id === id) ?? null;
}

export async function settleFocus(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (check()) return; } catch { /* no focused chart yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
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
        const out = (await run(action, args, ctx)) as { id: string; type: string };
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Added ${out.type} (${out.id})`, cellId: cellNow(),
            undo: async () => { await run("indicator.remove", { id: out.id }, undoCtx()); } },
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
          change: { label: `Changed ${live?.type ?? id} settings`, cellId: cellNow(),
            undo: async () => { await run("indicator.set", undoArgs, undoCtx()); } },
        };
      }
      case "indicator.remove": {
        const id = String(args.id);
        const live = liveById(id);
        const inset = focusedChart().controller.indicators.value.find((i: { id: string; inset?: boolean }) => i.id === id)?.inset;
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: {
            label: `Removed ${live?.type ?? id} (undo re-adds it under a new id; alerts and rules on the old id are not restored)`,
            cellId: cellNow(),
            undo: live ? async () => {
              const added = (await run("indicator.add", { type: live.type, calcParams: live.calcParams, inset: inset === true }, undoCtx())) as { id: string };
              const ext = (live.extendData ?? {}) as Record<string, unknown>;
              const setArgs: Record<string, unknown> = { id: added.id, extendData: ext };
              const pin = pinOf(ext);
              if (live.type === "TRENDLINES" && pin) setArgs.timeframe = pin;
              await run("indicator.set", setArgs, undoCtx());
            } : undefined,
          },
        };
      }
      case "drawing.add": {
        const out = (await run(action, args, ctx)) as { id: string; tool: string };
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Drew ${out.tool}`, cellId: cellNow(),
            undo: async () => { await run("drawing.remove", { id: out.id }, undoCtx()); } },
        };
      }
      case "drawing.remove": {
        const snap = focusedDrawings().overlays.getDrawing(String(args.id));
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Removed a ${snap?.name ?? "drawing"}`, cellId: cellNow(),
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
          change: { label: `Updated backtest: ${keys.join(", ")}`, cellId: cellNow(),
            undo: async () => { await run("backtest.config.set", { patch: restore }, undoCtx()); } },
        };
      }
      case "chart.timeframe.set": {
        const prev = focusedChart().resolution;
        const target = agentPeriod(String(args.resolution))?.resolution;
        const out = await run(action, args, ctx);
        await settleFocus(() => focusedChart().resolution === target);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Timeframe ${prev} to ${target ?? args.resolution}`, cellId: cellNow(),
            undo: async () => {
              await run("chart.timeframe.set", { resolution: prev }, undoCtx());
              await settleFocus(() => focusedChart().resolution === prev);
            } },
        };
      }
      case "market.select": {
        let prev = "";
        try { prev = focusedChart().epic; } catch { /* nothing focused */ }
        const out = await run(action, args, ctx);
        await settleFocus(() => focusedChart().epic === String(args.epic));
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: `Opened ${args.epic} (a tab it opened stays open)`, cellId: cellNow(),
            undo: prev ? async () => {
              await run("market.select", { epic: prev }, undoCtx());
              await settleFocus(() => focusedChart().epic === prev);
            } : undefined },
        };
      }
      case "chart.range.set":
      case "backtest.run": {
        const out = await run(action, args, ctx);
        return {
          content: budgetResult(tool, out), isError: false,
          change: { label: action === "backtest.run" ? "Ran the backtest" : "Moved the visible range", cellId: cellNow() },
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
    if (!c.undo) continue;
    if (cellNow() !== c.cellId) {
      toast("Focus the chart this change was made on, then undo.");
      return false;
    }
    try {
      await c.undo();
    } catch (e) {
      toast(`Undo failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  return true;
}
