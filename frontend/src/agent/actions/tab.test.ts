// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearRegistryForTest, listActions, invokeAction } from "../registry";
import { registerTabActions, AGENT_TAB_MARK } from "./tab";

const ctx = { progress: () => {}, signal: new AbortController().signal };

describe("tab.title.set", () => {
  beforeEach(() => { clearRegistryForTest(); registerTabActions(); document.title = "Chartkar"; });
  afterEach(() => { document.title = "Chartkar"; });

  it("is a write action that stamps the robot mark in front of the title", async () => {
    expect(listActions().find((a) => a.name === "tab.title.set")?.kind).toBe("write");
    const res = await invokeAction("tab.title.set", { title: "US100 4H backtest" }, ctx);
    expect(res).toEqual({ title: `${AGENT_TAB_MARK} US100 4H backtest` });
    expect(document.title).toBe(`${AGENT_TAB_MARK} US100 4H backtest`);
  });

  it("does not double the mark when the agent already included it", async () => {
    await invokeAction("tab.title.set", { title: `${AGENT_TAB_MARK} already marked` }, ctx);
    expect(document.title).toBe(`${AGENT_TAB_MARK} already marked`);
  });

  it("trims and rejects a blank title", async () => {
    await invokeAction("tab.title.set", { title: "  spaced  " }, ctx);
    expect(document.title).toBe(`${AGENT_TAB_MARK} spaced`);
    await expect(invokeAction("tab.title.set", { title: "   " }, ctx)).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });
});
