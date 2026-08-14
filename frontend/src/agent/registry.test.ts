import { describe, it, expect, beforeEach } from "vitest";
import type { AgentAction } from "./registry";
import {
  registerAction, listActions, invokeAction, clearRegistryForTest, ActionError,
} from "./registry";

const ECHO: AgentAction = {
  name: "test.echo",
  description: "Echo args back",
  kind: "read" as const,
  params: {
    type: "object" as const,
    properties: {
      msg: { type: "string" as const, description: "message" },
      n: { type: "number" as const },
      side: { type: "string" as const, enum: ["long", "short"] },
    },
    required: ["msg"],
  },
  handler: async (args: Record<string, unknown>) => ({ got: args }),
};

const CTX = { progress: () => {}, signal: new AbortController().signal };

describe("agent action registry", () => {
  beforeEach(() => clearRegistryForTest());

  it("lists registered actions without handlers", () => {
    registerAction(ECHO);
    const manifest = listActions();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe("test.echo");
    expect(manifest[0].kind).toBe("read");
    expect(manifest[0]).not.toHaveProperty("handler");
  });

  it("rejects duplicate registration", () => {
    registerAction(ECHO);
    expect(() => registerAction(ECHO)).toThrow(/already registered/);
  });

  it("invokes with valid args", async () => {
    registerAction(ECHO);
    const res = await invokeAction("test.echo", { msg: "hi" }, CTX);
    expect(res).toEqual({ got: { msg: "hi" } });
  });

  it("rejects unknown action with UNKNOWN_ACTION", async () => {
    await expect(invokeAction("nope", {}, CTX)).rejects.toMatchObject({
      code: "UNKNOWN_ACTION",
    });
  });

  it("rejects missing required arg and carries the schema", async () => {
    registerAction(ECHO);
    const err = await invokeAction("test.echo", {}, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe("INVALID_ARGS");
    expect((err as ActionError).expectedSchema).toEqual(ECHO.params);
  });

  it("rejects wrong type and bad enum value", async () => {
    registerAction(ECHO);
    await expect(invokeAction("test.echo", { msg: 5 }, CTX)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(
      invokeAction("test.echo", { msg: "x", side: "sideways" }, CTX),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it("rejects unknown extra keys", async () => {
    registerAction(ECHO);
    await expect(invokeAction("test.echo", { msg: "x", zzz: 1 }, CTX)).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });
});
