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
});
