// The assistant's conversation loop. One session per browser tab, mirrored to
// sessionStorage. Invariant: no new user content is ever appended while the
// last assistant message holds a tool_use without a result (closePending is
// the one place that invariant gets restored, from send/retry/undoLast alike).
import { Signal } from "../lib/signals";
import { PREFIX } from "../lib/workspaceKeys";
import { postMessages, type PostResult } from "./api";
import { buildTools } from "./tools";
import { buildRequest, contextLine } from "./prompt";
import { executeTool, undoTurn, redoTurn, type Change } from "./undo";
import { focusedChart } from "../agent/actions/chart";
import {
  isText, isToolUse,
  type ContentBlock, type MessageParam, type ToolDef, type ToolResultBlock, type ToolUseBlock,
} from "./types";

export const MAX_ROUNDS = 12;
const KEY = `${PREFIX}.assistant.session`;
const ASK_NOT_RUN = "not run: the assistant stopped to ask the user";

export type TurnError = {
  kind: "upstream" | "network" | "refusal" | "max_tokens" | "rounds" | "stopped";
  status?: number; body?: string;
};
export type Turn =
  | {
      role: "user"; text: string; pickedFrom?: string;
      // Where this message starts in `messages`, and what was still open
      // (pending) just before it: editFrom cuts back to exactly this state.
      rewind?: { msgIndex: number; pending: SessionState["pending"] };
    }
  | {
      role: "assistant"; text: string; changes: Change[]; undone: boolean;
      ask?: { question: string; options: Array<{ label: string; description?: string }> };
      error?: TurnError; trimmedBefore?: boolean;
    };
export interface SessionState {
  turns: Turn[];
  messages: MessageParam[];
  pending: { toolUseIds: string[]; heldResults: ToolResultBlock[]; askId: string | null };
  busy: boolean;
  working: string | null;
}
export interface SessionDeps {
  post: typeof postMessages;
  tools: () => ToolDef[];
  exec: typeof executeTool;
  undo: typeof undoTurn;
  redo: typeof redoTurn;
  context: () => string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/**
 * Index of the newest, not-yet-undone assistant turn that still has at least
 * one change worth reverting, or -1. A turn whose changes are ALL
 * `undoable === false` (e.g. a market.select with no prior epic to go back
 * to) has nothing to revert. A turn restored from storage has its changes'
 * `undo` closures stripped by JSON serialization (functions don't survive
 * `JSON.stringify`) even when `undoable` was never set to false, so a change
 * only counts when it is BOTH not explicitly non-undoable AND still carries
 * a live `undo` function.
 */
export function undoableIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (
      t.role === "assistant" && !t.undone &&
      t.changes.some((c) => c.undoable !== false && typeof c.undo === "function")
    ) return i;
  }
  return -1;
}

/**
 * Index of the undone assistant turn "Redo" applies to, or -1: the newest
 * undone turn with recorded calls, as long as the user has sent nothing
 * since (a new message makes the redo stale, like any single-level redo).
 * Works after a reload: `replay` is plain JSON.
 */
export function redoableIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "user") return -1;
    if (t.undone && t.changes.some((c) => c.replay)) return i;
  }
  return -1;
}

const EMPTY_PENDING = { toolUseIds: [], heldResults: [], askId: null };
const fresh = (): SessionState => ({ turns: [], messages: [], pending: { ...EMPTY_PENDING }, busy: false, working: null });

const result = (id: string, content: string, isError = false): ToolResultBlock =>
  ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

export function createSession(deps: SessionDeps) {
  const state = new Signal<SessionState>(load());
  let abort: AbortController | null = null;

  function load(): SessionState {
    try {
      const raw = deps.storage.getItem(KEY);
      if (!raw) return fresh();
      const s = JSON.parse(raw) as SessionState;
      return { ...s, busy: false, working: null };
    } catch {
      return fresh();
    }
  }
  function save(s: SessionState) {
    state.set(s);
    try {
      deps.storage.setItem(KEY, JSON.stringify({ ...s, busy: false, working: null }));
    } catch { /* storage full or blocked: the session still works in memory */ }
  }
  const patch = (p: Partial<SessionState>) => save({ ...state.value, ...p });

  /**
   * The ONE place that restores the transcript invariant: every tool_use in
   * the last assistant message gets a matching tool_result before any new
   * content is appended. Closes (in order) the already-finished held
   * results, the not-yet-run tool uses (as errors, with `reason`), and the
   * pending ask_user, if any - answered with `askAnswer` when given, else
   * closed as not run. Used from send (answering or abandoning an ask),
   * retry and undoLast; all three read `state.value.pending` fresh, so this
   * is always called before `pending` is reset.
   */
  function closePending(opts: { reason: string; askAnswer?: string }): ContentBlock[] {
    const { pending } = state.value;
    const blocks: ContentBlock[] = [
      ...pending.heldResults,
      ...pending.toolUseIds.map((id) => result(id, opts.reason, true)),
    ];
    if (pending.askId) {
      blocks.push(
        opts.askAnswer !== undefined
          ? result(pending.askId, opts.askAnswer)
          : result(pending.askId, ASK_NOT_RUN, true),
      );
    }
    return blocks;
  }

  function lastAssistant(turns: Turn[]): Extract<Turn, { role: "assistant" }> | null {
    const t = turns.at(-1);
    return t && t.role === "assistant" ? t : null;
  }

  function appendAssistantTurn(t: Extract<Turn, { role: "assistant" }>) {
    patch({ turns: [...state.value.turns, t] });
  }
  function updateLastTurn(fn: (t: Extract<Turn, { role: "assistant" }>) => Extract<Turn, { role: "assistant" }>) {
    const turns = [...state.value.turns];
    const t = lastAssistant(turns);
    if (!t) return;
    turns[turns.length - 1] = fn(t);
    patch({ turns });
  }

  async function loop() {
    abort = new AbortController();
    const signal = abort.signal;
    patch({ busy: true });
    if (!lastAssistant(state.value.turns)) {
      appendAssistantTurn({ role: "assistant", text: "", changes: [], undone: false });
    }
    let rounds = 0;
    try {
      while (rounds < MAX_ROUNDS) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        rounds++;
        const { body, trimmed } = buildRequest(state.value.messages, deps.tools());
        if (trimmed) updateLastTurn((t) => ({ ...t, trimmedBefore: true }));
        let res: PostResult;
        try {
          res = await deps.post(body, signal);
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
          updateLastTurn((t) => ({ ...t, error: { kind: "network", body: e instanceof Error ? e.message : String(e) } }));
          return;
        }
        if (!res.ok) {
          updateLastTurn((t) => ({ ...t, error: { kind: "upstream", status: res.status, body: res.body } }));
          return;
        }
        const m = res.message;
        patch({ messages: [...state.value.messages, { role: "assistant", content: m.content }] });
        const said = m.content.filter(isText).map((b) => b.text).join("\n").trim();
        if (said) updateLastTurn((t) => ({ ...t, text: t.text ? `${t.text}\n\n${said}` : said }));
        const uses = m.content.filter(isToolUse) as ToolUseBlock[];

        if (m.stop_reason === "refusal" || m.stop_reason === "max_tokens") {
          if (uses.length > 0) patch({ pending: { toolUseIds: uses.map((u) => u.id), heldResults: [], askId: null } });
          updateLastTurn((t) => ({ ...t, error: { kind: m.stop_reason as "refusal" | "max_tokens" } }));
          return;
        }
        if (m.stop_reason !== "tool_use") {
          // Any other stop_reason (end_turn, or anything else the API might
          // send) that still carries tool_use blocks must not leave them
          // dangling in the transcript: record them as pending so the next
          // send/retry closes them with a synthesized result.
          if (uses.length > 0) patch({ pending: { toolUseIds: uses.map((u) => u.id), heldResults: [], askId: null } });
          return;
        }
        if (uses.length === 0) return;

        const results: ToolResultBlock[] = [];
        for (let i = 0; i < uses.length; i++) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          const u = uses[i];
          if (u.name === "ask_user") {
            const input = u.input as { question?: string; options?: Array<{ label: string; description?: string }> };
            patch({
              pending: {
                toolUseIds: uses.slice(i + 1).map((x) => x.id),
                heldResults: [...results],
                askId: u.id,
              },
            });
            updateLastTurn((t) => ({ ...t, ask: { question: String(input.question ?? ""), options: input.options ?? [] } }));
            return;
          }
          patch({ working: u.name, pending: { toolUseIds: uses.slice(i).map((x) => x.id), heldResults: [...results], askId: null } });
          const r = await deps.exec(u.name, u.input, { progress: () => {}, signal });
          // A tool that completes (normally or with its own error) always
          // gets its real result recorded and its change kept on the turn,
          // even if Stop fired while it was running - only THEN do we check
          // whether to abandon the rest of the batch, so a completed tool is
          // never reported as "not run" just because it finished late.
          results.push(result(u.id, r.content, r.isError));
          if (r.change) {
            // Only a change that can be reverted gets its call recorded for
            // Redo: replaying a read or a refused add would do nothing useful.
            const change = r.change.undoable === false ? r.change : { ...r.change, replay: { tool: u.name, input: u.input } };
            updateLastTurn((t) => ({ ...t, changes: [...t.changes, change] }));
          }
          patch({ pending: { toolUseIds: uses.slice(i + 1).map((x) => x.id), heldResults: [...results], askId: null } });
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
        }
        patch({
          working: null,
          pending: { ...EMPTY_PENDING },
          messages: [...state.value.messages, { role: "user", content: results }],
        });
      }
      updateLastTurn((t) => ({ ...t, error: { kind: "rounds" } }));
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
      updateLastTurn((t) => ({ ...t, error: { kind: "stopped" } }));
    } finally {
      abort = null;
      patch({ busy: false, working: null });
    }
  }

  async function send(text: string) {
    if (state.value.busy) return;
    const { pending } = state.value;
    const rewind = { msgIndex: state.value.messages.length, pending };
    const asked = pending.askId;
    const stoppedKind = lastAssistant(state.value.turns)?.error?.kind === "stopped";
    const reason = asked ? ASK_NOT_RUN : stoppedKind ? "stopped by the user" : "turn ended before this ran";
    const blocks = closePending({ reason, askAnswer: asked ? text : undefined });
    if (!asked) blocks.push({ type: "text", text: `${deps.context()}\n\n${text}` });
    const prevAsk = lastAssistant(state.value.turns)?.ask?.question;
    save({
      ...state.value,
      pending: { ...EMPTY_PENDING },
      turns: [...state.value.turns, { role: "user", text, rewind, ...(asked && prevAsk ? { pickedFrom: prevAsk } : {}) }],
      messages: [...state.value.messages, { role: "user", content: blocks }],
    });
    await loop();
  }

  async function retry() {
    if (state.value.busy) return;
    const err = lastAssistant(state.value.turns)?.error;
    const reason = err?.kind === "stopped" ? "stopped by the user" : "turn ended before this ran";
    const hadAsk = state.value.pending.askId !== null;
    // Closing is a no-op (empty blocks) when pending is already empty, which
    // is exactly the "nothing dangling" case (typically an upstream/network
    // error that never reached the tool loop): the transcript is untouched
    // and the retried POST body is byte-identical to the one that failed.
    const blocks = closePending({ reason });
    if (blocks.length > 0) {
      save({
        ...state.value,
        pending: { ...EMPTY_PENDING },
        messages: [...state.value.messages, { role: "user", content: blocks }],
      });
    }
    updateLastTurn((t) => ({ ...t, error: undefined, ...(hadAsk ? { ask: undefined } : {}) }));
    await loop();
  }

  function stop() {
    abort?.abort();
  }

  async function undoLast() {
    if (state.value.busy) return;
    const idx = undoableIndex(state.value.turns);
    if (idx === -1) return;
    patch({ busy: true, working: "Undoing" });
    try {
      const target = state.value.turns[idx] as Extract<Turn, { role: "assistant" }>;
      // Captured BEFORE the call: undoTurn mutates every change it reverts to
      // `undoable: false` in place (see below), so after a successful call
      // there is no way to tell a just-reverted change from one that was
      // already explicitly non-undoable. Only the former actually changed
      // the chart and belongs in the note sent to the model.
      const revertedLabels = target.changes.filter((c) => c.undoable !== false).map((c) => c.label);
      const ok = await deps.undo(target.changes);
      // Re-read rather than trust the turns array captured before the await:
      // nothing else can run while busy is set, but defend against reset().
      const turnsNow = state.value.turns;
      const current = turnsNow[idx] as Extract<Turn, { role: "assistant" }> | undefined;
      if (!current) return;
      if (!ok) {
        // undoTurn mutates each successfully-reverted Change in place
        // (clears `undo`, sets `undoable: false`) even when it stops partway
        // through on a refusal, so a retried undo doesn't replay those.
        // Persist that partial progress regardless of the overall result.
        save({ ...state.value, turns: turnsNow });
        return;
      }
      const nextTurns = [...turnsNow];
      nextTurns[idx] = { ...current, undone: true, ask: undefined };
      // A pending ask lives on whichever turn is CURRENTLY last, which need
      // not be the turn being undone (undoableIndex finds the newest
      // UNDOABLE turn - a later, change-less turn can hold the live ask).
      // Clear its chips there too, or they'd be left stale even though its
      // ask_user tool_use is about to be closed into the transcript below.
      if (state.value.pending.askId !== null) {
        const lastIdx = nextTurns.length - 1;
        const lastTurn = lastIdx !== idx ? nextTurns[lastIdx] : undefined;
        if (lastTurn?.role === "assistant") nextTurns[lastIdx] = { ...lastTurn, ask: undefined };
      }
      const note = `[the user undid these changes: ${revertedLabels.join("; ")}]`;
      // Close any pending ask/tool uses on this turn into the transcript (so
      // it stays a valid tool_use/tool_result pairing) before telling the
      // model what was undone; clearing `ask` above drops the chips too.
      const blocks: ContentBlock[] = [...closePending({ reason: "stopped by the user" }), { type: "text", text: note }];
      save({
        ...state.value,
        turns: nextTurns,
        pending: { ...EMPTY_PENDING },
        messages: [...state.value.messages, { role: "user", content: blocks }],
      });
    } finally {
      patch({ busy: false, working: null });
    }
  }

  async function redoLast() {
    if (state.value.busy) return;
    const idx = redoableIndex(state.value.turns);
    if (idx === -1) return;
    patch({ busy: true, working: "Redoing" });
    try {
      const target = state.value.turns[idx] as Extract<Turn, { role: "assistant" }>;
      const res = await deps.redo(target.changes);
      const turnsNow = state.value.turns;
      const current = turnsNow[idx] as Extract<Turn, { role: "assistant" }> | undefined;
      // Nothing ran (focus refusal, or the first call failed): the turn stays
      // undone, Redo stays offered, the model is told nothing.
      if (!current || res.changes.length === 0) return;
      // A partial redo still leaves the turn live: what did run carries real
      // undo closures, so Undo is the way back from it.
      const nextTurns = [...turnsNow];
      nextTurns[idx] = { ...current, changes: res.changes, undone: false };
      const renamed = Object.entries(res.ids).map(([a, b]) => `${a} is now ${b}`);
      const note = `[the user redid these changes: ${res.changes.map((c) => c.label).join("; ")}` +
        `${renamed.length ? `; new ids: ${renamed.join(", ")}` : ""}${res.ok ? "" : "; the rest failed and was not redone"}]`;
      const blocks: ContentBlock[] = [...closePending({ reason: "stopped by the user" }), { type: "text", text: note }];
      save({
        ...state.value,
        turns: nextTurns,
        pending: { ...EMPTY_PENDING },
        messages: [...state.value.messages, { role: "user", content: blocks }],
      });
    } finally {
      patch({ busy: false, working: null });
    }
  }

  /**
   * Edit an earlier user message and continue from there: revert every later
   * turn's live changes (newest first), cut `turns` and `messages` back to
   * just before that message, restore what was pending then, and send `text`
   * in its place. "blocked" means a later change could not be reverted (its
   * undo did not survive a reload, or another chart is focused); nothing is
   * cut, turns already reverted stay marked undone, and calling again with
   * `force` cuts and sends without reverting the rest.
   */
  async function editFrom(
    idx: number, text: string, opts: { force?: boolean; onCut?: () => void } = {},
  ): Promise<"sent" | "blocked" | "invalid"> {
    const target = state.value.turns[idx];
    if (state.value.busy || !text.trim() || target?.role !== "user" || !target.rewind) return "invalid";
    const { rewind } = target;
    patch({ busy: true, working: "Rewinding" });
    try {
      if (!opts.force) {
        for (let i = state.value.turns.length - 1; i > idx; i--) {
          const t = state.value.turns[i];
          if (t.role !== "assistant" || t.undone) continue;
          const live = t.changes.filter((c) => c.undoable !== false);
          if (live.length === 0) continue;
          if (live.some((c) => typeof c.undo !== "function")) return "blocked";
          const ok = await deps.undo(t.changes);
          const turns = [...state.value.turns];
          if (ok) turns[i] = { ...t, undone: true };
          save({ ...state.value, turns });
          if (!ok) return "blocked";
        }
      }
      save({
        ...state.value,
        turns: state.value.turns.slice(0, idx),
        messages: state.value.messages.slice(0, rewind.msgIndex),
        pending: rewind.pending,
      });
    } finally {
      patch({ busy: false, working: null });
    }
    // The cut is done: the caller can close its editor now rather than after
    // the whole reply (send resolves only when the model's turn ends).
    opts.onCut?.();
    await send(text);
    return "sent";
  }

  function reset() {
    abort?.abort();
    deps.storage.removeItem(KEY);
    state.set(fresh());
  }

  return { state, send, retry, stop, undoLast, redoLast, editFrom, reset };
}

function liveContext(): string {
  try {
    const f = focusedChart();
    return contextLine({
      epic: f.epic,
      resolution: f.resolution,
      indicators: f.controller.indicators.value.map((i: { id: string; type: string }) => ({ id: i.id, type: i.type })),
    });
  } catch {
    return contextLine(null);
  }
}

export const assistantSession = createSession({
  post: postMessages,
  tools: buildTools,
  exec: executeTool,
  undo: undoTurn,
  redo: redoTurn,
  context: liveContext,
  storage: typeof sessionStorage !== "undefined" ? sessionStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
