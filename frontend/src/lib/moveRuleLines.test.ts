// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ rules: [] as unknown[] }));
vi.mock("./alertsApi", async (orig) => ({
  ...(await orig<typeof import("./alertsApi")>()),
  patchMoveRule: vi.fn(async () => null),
  loadMoveRules: vi.fn(() => saved.rules),
}));

import { patchMoveRule, type MoveRule } from "./alertsApi";
import { moveDraftSignal, type MoveDraftState } from "./moveRuleDraft";
import {
  applyMoveLineDrag,
  endMoveLineDrag,
  moveLineOverrides,
  moveLineSpecs,
  moveRuleText,
  parseTradeLineKey,
} from "./moveRuleLines";

const longDraft = (over: Partial<MoveDraftState> = {}): MoveDraftState => ({
  epic: "EURUSD",
  dealId: null,
  side: "buy",
  sl: { on: true, level: 1.1, condition: "crossing_up", target: { type: "breakeven", offset: 0 } },
  tp: null,
  ...over,
});

const rule = (over: Partial<MoveRule> = {}): MoveRule => ({
  id: "R1",
  broker: "capital",
  epic: "EURUSD",
  triggerKind: "price_level",
  params: { level: 1.2, condition: "crossing_down", trigger: "once" },
  action: { account: "A", dealId: "D1", field: "tp", target: { type: "price", value: 1.095 } },
  precision: 4,
  notify: { toast: true, push: true, telegram: true, browser: false, sound: false },
  ...over,
});

beforeEach(() => {
  moveDraftSignal.set(null);
  moveLineOverrides.set({});
  saved.rules = [];
  vi.mocked(patchMoveRule).mockClear();
});

describe("parseTradeLineKey", () => {
  it("keeps a move line's full key as its id", () => {
    expect(parseTradeLineKey("move:draft:sl:trigger")).toEqual({ id: "move:draft:sl:trigger", field: "price" });
  });
  it("splits a trade line key at the last colon", () => {
    expect(parseTradeLineKey("D1:stop")).toEqual({ id: "D1", field: "stop" });
  });
});

describe("moveLineSpecs", () => {
  it("draws one trigger line for a long draft with a breakeven target", () => {
    const specs = moveLineSpecs({ epic: "EURUSD", draft: longDraft(), saved: [], precision: 4 });
    expect(specs).toHaveLength(1);
    expect(specs[0].key).toBe("move:draft:sl:trigger");
    expect(specs[0].label).toBe("Move SL → BE ↑");
    expect(specs[0].level).toBe(1.1);
    expect(specs[0].draggable).toBe(true);
    expect(specs[0].fullWidth).toBe(true);
  });
  it("adds a target line for a price target", () => {
    const draft = longDraft({
      sl: { on: true, level: 1.1, condition: "crossing_up", target: { type: "price", value: 1.05 } },
    });
    const specs = moveLineSpecs({ epic: "EURUSD", draft, saved: [], precision: 4 });
    expect(specs.map((s) => s.label)).toEqual(["Move SL → 1.0500 ↑", "New SL"]);
    expect(specs[1].key).toBe("move:draft:sl:target");
    expect(specs[1].level).toBe(1.05);
  });
  it("skips drafts that are off or on another epic", () => {
    const off = longDraft({ sl: { on: false, level: 1.1, condition: "crossing_up", target: { type: "breakeven", offset: 0 } } });
    expect(moveLineSpecs({ epic: "EURUSD", draft: off, saved: [], precision: 4 })).toEqual([]);
    expect(moveLineSpecs({ epic: "GBPUSD", draft: longDraft(), saved: [], precision: 4 })).toEqual([]);
  });
  it("draws a saved price rule, not one on another epic, not an indicator rule", () => {
    const specs = moveLineSpecs({ epic: "EURUSD", draft: null, saved: [rule()], precision: 4 });
    expect(specs.map((s) => [s.key, s.label])).toEqual([
      ["move:R1:tp:trigger", "Move TP → 1.0950 ↓"],
      ["move:R1:tp:target", "New TP"],
    ]);
    expect(moveLineSpecs({ epic: "EURUSD", draft: null, saved: [rule({ epic: "GBPUSD" })], precision: 4 })).toEqual([]);
    expect(moveLineSpecs({ epic: "EURUSD", draft: null, saved: [rule({ triggerKind: "indicator" })], precision: 4 })).toEqual([]);
  });
  it("draws only the draft when it edits the saved rule's field", () => {
    const draft = longDraft({
      dealId: "D1",
      sl: null,
      tp: { on: true, level: 1.15, condition: "crossing", target: { type: "breakeven", offset: 0 } },
    });
    const specs = moveLineSpecs({ epic: "EURUSD", draft, saved: [rule()], precision: 4 });
    expect(specs.map((s) => [s.key, s.label])).toEqual([["move:draft:tp:trigger", "Move TP → BE ↕"]]);
  });
  it("applies a drag override to a saved line", () => {
    moveLineOverrides.set({ "move:R1:tp:trigger": 1.21 });
    const specs = moveLineSpecs({ epic: "EURUSD", draft: null, saved: [rule()], precision: 4 });
    expect(specs[0].level).toBe(1.21);
  });
});

describe("drag", () => {
  it("a draft drag sets the draft level", () => {
    moveDraftSignal.set(longDraft());
    applyMoveLineDrag("move:draft:sl:trigger", 1.2);
    expect(moveDraftSignal.value?.sl?.level).toBe(1.2);
  });
  it("a draft target drag makes the target a price", () => {
    moveDraftSignal.set(longDraft());
    applyMoveLineDrag("move:draft:sl:target", 1.07);
    expect(moveDraftSignal.value?.sl?.target).toEqual({ type: "price", value: 1.07 });
  });
  it("a saved trigger drop patches params.level and clears the override", async () => {
    saved.rules = [rule()];
    applyMoveLineDrag("move:R1:tp:trigger", 1.25);
    expect(moveLineOverrides.value["move:R1:tp:trigger"]).toBe(1.25);
    await endMoveLineDrag("move:R1:tp:trigger");
    expect(patchMoveRule).toHaveBeenCalledWith("R1", {
      params: { level: 1.25, condition: "crossing_down", trigger: "once" },
    });
    expect(moveLineOverrides.value).toEqual({});
  });
  it("a saved target drop patches the target as a price", async () => {
    saved.rules = [rule()];
    applyMoveLineDrag("move:R1:tp:target", 1.09);
    await endMoveLineDrag("move:R1:tp:target");
    expect(patchMoveRule).toHaveBeenCalledWith("R1", { target: { type: "price", value: 1.09 } });
  });
  it("a draft drop patches nothing", async () => {
    moveDraftSignal.set(longDraft());
    applyMoveLineDrag("move:draft:sl:trigger", 1.2);
    await endMoveLineDrag("move:draft:sl:trigger");
    expect(patchMoveRule).not.toHaveBeenCalled();
  });
});

describe("moveRuleText", () => {
  const base = (over: Partial<MoveRule>): MoveRule => ({
    id: "r1", broker: "capital", epic: "EURUSD", triggerKind: "price_level",
    params: { level: 1.105, condition: "crossing_up" },
    action: { account: "capital:demo", dealId: "d1", field: "sl", target: { type: "breakeven", offset: 0 } },
    precision: 4, notify: { toast: true, browser: false, sound: false, push: true, telegram: true },
    ...over,
  });
  it("writes a price trigger with breakeven", () => {
    expect(moveRuleText(base({}))).toBe("Move SL to BE when \u2191 1.1050");
  });
  it("writes BE+offset, a price target and the down arrow", () => {
    const a = base({ action: { ...base({}).action, field: "tp", target: { type: "breakeven", offset: 0.5 } }, params: { level: 2, condition: "less" } });
    expect(moveRuleText(a)).toBe("Move TP to BE+0.5 when \u2193 2.0000");
    const b = base({ action: { ...base({}).action, target: { type: "price", value: 1.1 } }, params: { level: 1, condition: "crossing" } });
    expect(moveRuleText(b)).toBe("Move SL to 1.1000 when \u2195 1.0000");
  });
  it("uses the label for indicator and line rules, with a fallback", () => {
    expect(moveRuleText(base({ triggerKind: "indicator", params: {}, label: "RSI > 70" }))).toBe("Move SL to BE when RSI > 70");
    expect(moveRuleText(base({ triggerKind: "indicator", params: {} }))).toBe("Move SL to BE when indicator");
    expect(moveRuleText(base({ triggerKind: "line", params: {} }))).toBe("Move SL to BE when line");
  });
});
