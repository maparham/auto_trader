import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, contextLine, trimMessages, buildRequest } from "./prompt";
import type { MessageParam } from "./types";

const user = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });
const asst = (id: string): MessageParam => ({
  role: "assistant", content: [{ type: "tool_use", id, name: "indicator_list", input: {} }],
});
const result = (id: string): MessageParam => ({
  role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "{}" }],
});
const done = (text: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text }] });

describe("prompt", () => {
  it("is fixed text with no dates", () => {
    expect(SYSTEM_PROMPT).toMatch(/ask_user/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("formats the context line", () => {
    expect(contextLine({ epic: "US100", resolution: "HOUR", indicators: [{ id: "RSI", type: "RSI" }] }))
      .toBe("[context] focused chart US100 HOUR; indicators: RSI (RSI)");
    expect(contextLine(null)).toBe("[context] no chart is focused");
  });

  it("trims whole exchanges and never splits a tool pair", () => {
    const msgs = [user("a"), asst("t1"), result("t1"), done("ok"), user("b"), done("ok2")];
    const { messages, trimmed } = trimMessages(msgs, 3);
    expect(trimmed).toBe(true);
    expect(messages).toEqual([user("b"), done("ok2")]);
    expect(messages[0].role).toBe("user");
  });

  it("leaves a short transcript alone", () => {
    const msgs = [user("a"), done("ok")];
    expect(trimMessages(msgs)).toEqual({ messages: msgs, trimmed: false });
  });

  it("places three cache breakpoints without mutating the input", () => {
    const msgs = [user("a")];
    const tools = [
      { name: "x", description: "", input_schema: {} },
      { name: "y", description: "", input_schema: {} },
    ];
    const { body } = buildRequest(msgs, tools);
    expect(body.system.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(msgs[0].content[0].cache_control).toBeUndefined();
  });
});
