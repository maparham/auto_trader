// @vitest-environment jsdom
// jsdom (not the suite's default `node` env): session.ts imports
// agent/actions/chart.ts, which imports lib/indicators.ts, which pulls in
// klinecharts, which touches `window` at module-load time (same reason
// tools.test.ts / undo.test.ts / describe.test.ts need it).
import { describe, it, expect, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { createSession, undoableIndex, MAX_ROUNDS, type Turn } from "./session";
import type { AssistantMessage, ContentBlock } from "./types";
import type { PostResult } from "./api";

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const msg = (content: ContentBlock[], stop_reason = "end_turn"): PostResult =>
  ({ ok: true, message: { id: "m", role: "assistant", content, stop_reason } as AssistantMessage });
const tu = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

function setup(replies: Array<PostResult | (() => Promise<PostResult>)>, storage = mem()) {
  const bodies: unknown[] = [];
  const post = vi.fn(async (body: unknown) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const r = replies.shift()!;
    return typeof r === "function" ? r() : r;
  });
  const exec = vi.fn(async (tool: string) => ({
    content: `${tool} ok`, isError: false,
    change: tool === "indicator_add" ? { label: "Added RSI", cellId: "c1", undo: vi.fn(async () => {}) } : undefined,
  }));
  const undo = vi.fn(async () => true);
  const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage });
  return { s, post, exec, undo, bodies, storage };
}
const lastUser = (bodies: unknown[]) => {
  const b = bodies.at(-1) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  return b.messages.at(-1)!;
};

describe("session loop", () => {
  it("runs tools, batches results in one user message, ends on end_turn", async () => {
    const { s, exec, bodies } = setup([
      msg([tu("a", "indicator_list"), tu("b", "indicator_add", { type: "RSI" })], "tool_use"),
      msg([text("Added RSI.")]),
    ]);
    await s.send("add rsi");
    expect(exec).toHaveBeenCalledTimes(2);
    const results = lastUser(bodies).content;
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    const turn = s.state.value.turns.at(-1)!;
    expect(turn).toMatchObject({ role: "assistant", text: "Added RSI." });
    expect(turn.role === "assistant" && turn.changes.map((c) => c.label)).toEqual(["Added RSI"]);
  });

  it("prefixes the context line to a new user message", async () => {
    const { s, bodies } = setup([msg([text("hi")])]);
    await s.send("hello");
    const first = (bodies[0] as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0];
    expect(first.content[0].text).toBe("[context] x\n\nhello");
  });

  it("ask_user in the middle holds earlier results and closes the rest on answer", async () => {
    const { s, exec, bodies } = setup([
      msg([tu("a", "indicator_list"), tu("q", "ask_user", { question: "Which way?", options: [{ label: "Rising" }, { label: "Falling" }] }), tu("c", "indicator_add")], "tool_use"),
      msg([text("Done.")]),
    ]);
    await s.send("trendlines");
    expect(exec).toHaveBeenCalledTimes(1);
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.ask?.question).toBe("Which way?");
    await s.send("Rising");
    const content = lastUser(bodies).content;
    expect(content.map((b) => [b.tool_use_id, b.is_error ?? false])).toEqual([["a", false], ["c", true], ["q", false]]);
    expect(content[2].content).toBe("Rising");
  });

  it("pending ask survives a reload", async () => {
    const storage = mem();
    const first = setup([msg([tu("q", "ask_user", { question: "Q?", options: [{ label: "A" }, { label: "B" }] })], "tool_use")], storage);
    await first.s.send("x");
    const second = setup([msg([text("ok")])], storage);
    await second.s.send("A");
    const content = lastUser(second.bodies).content;
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "q", content: "A" });
  });

  it("stops after MAX_ROUNDS and still answers the last tool uses", async () => {
    const replies = Array.from({ length: MAX_ROUNDS }, () => msg([tu("x", "indicator_list")], "tool_use"));
    const { s, post } = setup([...replies, msg([text("never")])]);
    await s.send("loop");
    expect(post).toHaveBeenCalledTimes(MAX_ROUNDS);
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.error?.kind).toBe("rounds");
    const last = s.state.value.messages.at(-1)!;
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "x" });
  });

  it("refusal and max_tokens set error badges and close tool uses on the next send", async () => {
    const { s, bodies } = setup([msg([text("no")], "refusal"), msg([text("half"), tu("z", "indicator_list")], "max_tokens"), msg([text("ok")])]);
    await s.send("a");
    expect((s.state.value.turns.at(-1) as { error?: { kind: string } }).error?.kind).toBe("refusal");
    await s.send("b");
    expect((s.state.value.turns.at(-1) as { error?: { kind: string } }).error?.kind).toBe("max_tokens");
    await s.send("c");
    const content = lastUser(bodies).content;
    expect(content[0]).toMatchObject({ tool_use_id: "z", is_error: true });
    expect(content[1]).toMatchObject({ type: "text" });
  });

  it("upstream errors become an error turn and retry re-posts the same transcript", async () => {
    const { s, bodies } = setup([{ ok: false, status: 401, body: "bad key" }, msg([text("ok")])]);
    await s.send("a");
    expect(s.state.value.turns.at(-1)).toMatchObject({ error: { kind: "upstream", status: 401, body: "bad key" } });
    await s.retry();
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("stop aborts and marks the turn stopped", async () => {
    let release!: () => void;
    const { s } = setup([() => new Promise((res, rej) => { release = () => rej(new DOMException("aborted", "AbortError")); })]);
    const p = s.send("slow");
    await Promise.resolve();
    s.stop();
    release();
    await p;
    expect(s.state.value.turns.at(-1)).toMatchObject({ error: { kind: "stopped" } });
    expect(s.state.value.busy).toBe(false);
  });

  it("undoLast reverts the newest turn and tells the model", async () => {
    const { s } = setup([msg([tu("b", "indicator_add")], "tool_use"), msg([text("ok")])]);
    await s.send("add");
    await s.undoLast();
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.undone).toBe(true);
    const note = s.state.value.messages.at(-1)!;
    expect(note.role).toBe("user");
    expect(JSON.stringify(note.content)).toMatch(/undid these changes: Added RSI/);
  });

  it("undoLast leaves the turn undone:false when deps.undo refuses (bad focus), so retry works", async () => {
    const storage = mem();
    const undo = vi.fn(async () => false);
    const post = vi.fn(async () => msg([tu("b", "indicator_add")], "tool_use"));
    const exec = vi.fn(async () => ({ content: "ok", isError: false, change: { label: "Added RSI", cellId: "c1", undo: vi.fn(async () => {}) } }));
    const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage });
    await s.send("add");
    await s.undoLast();
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.undone).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("undoableIndex skips a turn whose only change is marked undoable:false", () => {
    const turns: Turn[] = [
      { role: "user", text: "switch" },
      { role: "assistant", text: "ok", changes: [{ label: "Opened X (nothing to go back to)", cellId: "c1", undoable: false }], undone: false },
    ];
    expect(undoableIndex(turns)).toBe(-1);

    const withRevertible: Turn[] = [
      ...turns,
      { role: "user", text: "add rsi" },
      {
        role: "assistant", text: "ok", undone: false,
        changes: [
          { label: "Opened Y (nothing to go back to)", cellId: "c2", undoable: false },
          { label: "Added RSI", cellId: "c2", undo: vi.fn(async () => {}) },
        ],
      },
    ];
    expect(undoableIndex(withRevertible)).toBe(3);
  });

  it("persisted changes keep label/cellId/epic/undoable but drop the undo closure", async () => {
    const storage = mem();
    const { s } = setup([msg([tu("b", "indicator_add")], "tool_use"), msg([text("ok")])], storage);
    await s.send("add");
    const saved = JSON.parse(storage.getItem(`auto-trader.assistant.session`)!) as { turns: Turn[] };
    const t = saved.turns.at(-1)!;
    expect(t.role === "assistant" && t.changes[0]).toMatchObject({ label: "Added RSI", cellId: "c1" });
    expect(t.role === "assistant" && (t.changes[0] as { undo?: unknown }).undo).toBeUndefined();
  });

  // --- fix round 1 (task-8-findings-r1.md) -----------------------------------

  it("[finding 1] undoLast while an ask is pending closes it into the transcript and clears the chips", async () => {
    const { s, bodies } = setup([
      msg([tu("b", "indicator_add"), tu("q", "ask_user", { question: "Which way?", options: [{ label: "Up" }, { label: "Down" }] })], "tool_use"),
      msg([text("ok")]),
    ]);
    await s.send("add rsi then ask");
    let t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.ask?.question).toBe("Which way?");
    await s.undoLast();
    t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.undone).toBe(true);
    expect(t.role === "assistant" && t.ask).toBeUndefined();
    await s.send("something new");
    const lastBody = bodies.at(-1) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const allIds = lastBody.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(allIds).toContain("q");
  });

  it("[finding 2] stop mid-tool-batch then retry closes every pending tool_use before continuing", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((res) => { started = res; });
    let release!: (v: { content: string; isError: boolean }) => void;
    let execCalls = 0;
    const exec = vi.fn((tool: string) => {
      execCalls++;
      if (execCalls === 1) {
        started();
        return new Promise<{ content: string; isError: boolean }>((res) => { release = res; });
      }
      return Promise.resolve({ content: `${tool} ok`, isError: false });
    });
    const bodies: unknown[] = [];
    let postCalls = 0;
    const post = vi.fn(async (body: unknown) => {
      postCalls++;
      bodies.push(JSON.parse(JSON.stringify(body)));
      return postCalls === 1
        ? msg([tu("a", "indicator_list"), tu("b", "indicator_list"), tu("c", "indicator_list")], "tool_use")
        : msg([text("ok")]);
    });
    const undo = vi.fn(async () => true);
    const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage: mem() });
    const p = s.send("go");
    await startedPromise;
    s.stop();
    release({ content: "indicator_list ok", isError: false });
    await p;
    expect(s.state.value.turns.at(-1)).toMatchObject({ error: { kind: "stopped" } });
    await s.retry();
    const lastBody = bodies.at(-1) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const lastMsg = lastBody.messages.at(-1)!;
    expect(lastMsg.role).toBe("user");
    const ids = lastMsg.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("[finding 3] stop halts before the next tool: later tools never run and the turn shows stopped", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((res) => { started = res; });
    let release!: (v: { content: string; isError: boolean }) => void;
    let execCalls = 0;
    const exec = vi.fn((tool: string) => {
      execCalls++;
      if (execCalls === 1) {
        started();
        return new Promise<{ content: string; isError: boolean }>((res) => { release = res; });
      }
      return Promise.resolve({ content: `${tool} ok`, isError: false });
    });
    const post = vi.fn(async () => msg([tu("a", "indicator_list"), tu("b", "indicator_list"), tu("c", "indicator_list")], "tool_use"));
    const undo = vi.fn(async () => true);
    const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage: mem() });
    const p = s.send("go");
    await startedPromise;
    s.stop();
    release({ content: "indicator_list ok", isError: false });
    await p;
    expect(execCalls).toBe(1);
    expect(s.state.value.turns.at(-1)).toMatchObject({ error: { kind: "stopped" } });
    expect(s.state.value.busy).toBe(false);
  });

  it("[finding 4] undoLast is exclusive: concurrent calls run deps.undo once; send is ignored meanwhile", async () => {
    const storage = mem();
    let releaseUndo!: (v: boolean) => void;
    const undo = vi.fn(() => new Promise<boolean>((res) => { releaseUndo = res; }));
    let postCalls = 0;
    const post = vi.fn(async () => {
      postCalls++;
      return postCalls === 1 ? msg([tu("b", "indicator_add")], "tool_use") : msg([text("ok")]);
    });
    const exec = vi.fn(async () => ({ content: "ok", isError: false, change: { label: "Added RSI", cellId: "c1", undo: vi.fn(async () => {}) } }));
    const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage });
    await s.send("add");
    const p1 = s.undoLast();
    const p2 = s.undoLast();
    await s.send("ignored while undoing");
    expect(s.state.value.turns.some((t) => t.role === "user" && t.text === "ignored while undoing")).toBe(false);
    releaseUndo(true);
    await Promise.all([p1, p2]);
    expect(undo).toHaveBeenCalledTimes(1);
    const t = s.state.value.turns.at(-1)!;
    expect(t.role === "assistant" && t.undone).toBe(true);
  });

  it("[finding 5] undoableIndex skips a restored turn whose change lost its undo function to serialization", () => {
    const restored: Turn[] = [
      { role: "assistant", text: "ok", undone: false, changes: [{ label: "Added RSI", cellId: "c1" }] },
    ];
    expect(undoableIndex(restored)).toBe(-1);
  });

  it("[finding 6] pending.heldResults handed out mid-round is a snapshot, not a live alias of the growing results array", async () => {
    const ref: { current?: ReturnType<typeof createSession> } = {};
    let capturedRef: unknown[] | undefined;
    let execCalls = 0;
    const exec = vi.fn(async (tool: string) => {
      execCalls++;
      if (execCalls === 2) {
        capturedRef = ref.current!.state.value.pending.heldResults as unknown[];
      }
      return { content: `${tool} ok`, isError: false };
    });
    let postCalls = 0;
    const post = vi.fn(async () => {
      postCalls++;
      return postCalls === 1
        ? msg([tu("a", "indicator_list"), tu("b", "indicator_list")], "tool_use")
        : msg([text("done")]);
    });
    const undo = vi.fn(async () => true);
    ref.current = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage: mem() });
    await ref.current.send("go");
    expect(capturedRef).toBeDefined();
    expect((capturedRef as unknown[]).length).toBe(1);
  });

  // --- fix round 2 (task-8-findings-r2.md) -----------------------------------

  it("[finding r2-1] a tool that completes after Stop keeps its change and real result; later tools close as stopped", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((res) => { started = res; });
    let release!: (v: { content: string; isError: boolean; change?: unknown }) => void;
    let execCalls = 0;
    const exec = vi.fn((tool: string) => {
      execCalls++;
      if (execCalls === 1) {
        started();
        return new Promise((res) => { release = res; });
      }
      return Promise.resolve({ content: `${tool} ok`, isError: false });
    });
    const bodies: unknown[] = [];
    let postCalls = 0;
    const post = vi.fn(async (body: unknown) => {
      postCalls++;
      bodies.push(JSON.parse(JSON.stringify(body)));
      return postCalls === 1
        ? msg([tu("a", "indicator_add"), tu("b", "indicator_list"), tu("c", "indicator_list")], "tool_use")
        : msg([text("ok")]);
    });
    const undo = vi.fn(async () => true);
    const s = createSession({ post: post as never, tools: () => [], exec: exec as never, undo, context: () => "[context] x", storage: mem() });
    const p = s.send("go");
    await startedPromise;
    s.stop();
    release({ content: "a added", isError: false, change: { label: "Added RSI", cellId: "c1", undo: vi.fn(async () => {}) } });
    await p;
    expect(execCalls).toBe(1);
    const turns = s.state.value.turns;
    const t = turns.at(-1)!;
    expect(t.role === "assistant" && t.error?.kind).toBe("stopped");
    expect(t.role === "assistant" && t.changes.map((c) => c.label)).toEqual(["Added RSI"]);
    expect(undoableIndex(turns)).toBe(turns.length - 1);
    expect(s.state.value.pending.heldResults).toEqual([{ type: "tool_result", tool_use_id: "a", content: "a added" }]);

    await s.retry();
    const lastBody = bodies.at(-1) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const closing = lastBody.messages.find((m) => m.role === "user" && m.content.some((b) => b.tool_use_id === "a"))!;
    const byId = Object.fromEntries(closing.content.map((b) => [b.tool_use_id, b]));
    expect(byId.a).toMatchObject({ content: "a added" });
    expect(byId.a.is_error).toBeFalsy();
    expect(byId.b).toMatchObject({ is_error: true });
    expect(byId.c).toMatchObject({ is_error: true });
  });

  it("[finding r2-2] undoLast on an earlier turn clears a pending ask living on a later, change-less turn", async () => {
    const { s } = setup([
      msg([tu("b", "indicator_add")], "tool_use"),
      msg([text("ok")]),
      msg([tu("q", "ask_user", { question: "Which way?", options: [{ label: "Up" }, { label: "Down" }] })], "tool_use"),
    ]);
    await s.send("add rsi");
    await s.send("ask something");
    const beforeTurns = s.state.value.turns;
    expect(beforeTurns.some((t) => t.role === "assistant" && t.ask)).toBe(true);
    const idx = undoableIndex(beforeTurns);
    expect(idx).toBeLessThan(beforeTurns.length - 1);
    await s.undoLast();
    const afterTurns = s.state.value.turns;
    expect(afterTurns.some((t) => t.role === "assistant" && t.ask)).toBe(false);
    const undone = afterTurns[idx];
    expect(undone.role === "assistant" && undone.undone).toBe(true);
  });
});
