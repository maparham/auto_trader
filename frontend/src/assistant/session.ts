// The assistant's conversation loop. One session per browser tab, mirrored to
// sessionStorage. Invariant: no new user content is ever appended while the
// last assistant message holds a tool_use without a result (closeDangling).
import { Signal } from "../lib/signals";
import { PREFIX } from "../lib/workspaceKeys";
import { postMessages, type PostResult } from "./api";
import { buildTools } from "./tools";
import { buildRequest, contextLine } from "./prompt";
import { executeTool, undoTurn, type Change } from "./undo";
import { focusedChart } from "../agent/actions/chart";
import {
  isText, isToolUse,
  type ContentBlock, type MessageParam, type ToolDef, type ToolResultBlock, type ToolUseBlock,
} from "./types";

export const MAX_ROUNDS = 12;
const KEY = `${PREFIX}.assistant.session`;

export type TurnError = {
  kind: "upstream" | "network" | "refusal" | "max_tokens" | "rounds" | "stopped";
  status?: number; body?: string;
};
export type Turn =
  | { role: "user"; text: string; pickedFrom?: string }
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
  context: () => string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/**
 * Index of the newest, not-yet-undone assistant turn that still has at least
 * one change worth reverting, or -1. A turn whose changes are ALL
 * `undoable === false` (e.g. a market.select with no prior epic to go back
 * to) has nothing to revert, so it's skipped rather than offered as the undo
 * target.
 */
export function undoableIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "assistant" && !t.undone && t.changes.some((c) => c.undoable !== false)) return i;
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

  /** Results that close every unanswered tool_use, plus the held ones. */
  function closingBlocks(reason: string): ContentBlock[] {
    const { pending } = state.value;
    return [
      ...pending.heldResults,
      ...pending.toolUseIds.map((id) => result(id, reason, true)),
    ];
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
          patch({ pending: { toolUseIds: uses.map((u) => u.id), heldResults: [], askId: null } });
          updateLastTurn((t) => ({ ...t, error: { kind: m.stop_reason as "refusal" | "max_tokens" } }));
          return;
        }
        if (m.stop_reason !== "tool_use" || uses.length === 0) return;

        const results: ToolResultBlock[] = [];
        for (let i = 0; i < uses.length; i++) {
          const u = uses[i];
          if (u.name === "ask_user") {
            const input = u.input as { question?: string; options?: Array<{ label: string; description?: string }> };
            patch({
              pending: {
                toolUseIds: uses.slice(i + 1).map((x) => x.id),
                heldResults: results,
                askId: u.id,
              },
            });
            updateLastTurn((t) => ({ ...t, ask: { question: String(input.question ?? ""), options: input.options ?? [] } }));
            return;
          }
          patch({ working: u.name, pending: { toolUseIds: uses.slice(i).map((x) => x.id), heldResults: results, askId: null } });
          const r = await deps.exec(u.name, u.input, { progress: () => {}, signal });
          results.push(result(u.id, r.content, r.isError));
          if (r.change) updateLastTurn((t) => ({ ...t, changes: [...t.changes, r.change!] }));
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
    const asked = pending.askId;
    const stopped = lastAssistant(state.value.turns)?.error?.kind === "stopped";
    const blocks: ContentBlock[] = closingBlocks(
      asked ? "not run: the assistant stopped to ask the user"
        : stopped ? "stopped by the user"
        : "turn ended before this ran",
    );
    if (asked) blocks.push(result(asked, text));
    else blocks.push({ type: "text", text: `${deps.context()}\n\n${text}` });
    const prevAsk = lastAssistant(state.value.turns)?.ask?.question;
    save({
      ...state.value,
      pending: { ...EMPTY_PENDING },
      turns: [...state.value.turns, { role: "user", text, ...(asked && prevAsk ? { pickedFrom: prevAsk } : {}) }],
      messages: [...state.value.messages, { role: "user", content: blocks }],
    });
    await loop();
  }

  async function retry() {
    if (state.value.busy) return;
    updateLastTurn((t) => ({ ...t, error: undefined }));
    await loop();
  }

  function stop() {
    abort?.abort();
  }

  async function undoLast() {
    if (state.value.busy) return;
    const turns = state.value.turns;
    const idx = undoableIndex(turns);
    if (idx === -1) return;
    const t = turns[idx] as Extract<Turn, { role: "assistant" }>;
    if (!(await deps.undo(t.changes))) return;
    const next = [...turns];
    next[idx] = { ...t, undone: true };
    const note = `[the user undid these changes: ${t.changes.map((c) => c.label).join("; ")}]`;
    const blocks: ContentBlock[] = [...closingBlocks("stopped by the user"), { type: "text", text: note }];
    save({
      ...state.value,
      turns: next,
      pending: { ...EMPTY_PENDING },
      messages: [...state.value.messages, { role: "user", content: blocks }],
    });
  }

  function reset() {
    abort?.abort();
    deps.storage.removeItem(KEY);
    state.set(fresh());
  }

  return { state, send, retry, stop, undoLast, reset };
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
  context: liveContext,
  storage: typeof sessionStorage !== "undefined" ? sessionStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
