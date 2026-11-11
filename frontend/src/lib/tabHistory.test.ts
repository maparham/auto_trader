import { it, expect } from "vitest";
import { emptyHistory, recent, step, visit, type TabHistory } from "./tabHistory";

const live = (...ids: string[]) => new Set(ids);
const walk = (...ids: string[]): TabHistory => ids.reduce(visit, emptyHistory);

it("steps back and forward along the visits", () => {
  let h = walk("a", "b", "c");
  const back = step(h, -1, live("a", "b", "c"), "c");
  expect(back?.id).toBe("b");
  h = visit(back!.history, "b");
  expect(h.stack).toEqual(["a", "b", "c"]);
  expect(step(h, 1, live("a", "b", "c"), "b")?.id).toBe("c");
  expect(step(h, -1, live("a", "b", "c"), "b")?.id).toBe("a");
});

it("returns null at either end", () => {
  const h = walk("a", "b");
  expect(step(h, 1, live("a", "b"), "b")).toBeNull();
  expect(step(walk("a"), -1, live("a"), "a")).toBeNull();
});

it("a new visit after going back drops the forward trail", () => {
  let h = walk("a", "b", "c");
  h = visit(step(h, -1, live("a", "b", "c", "d"), "c")!.history, "b");
  h = visit(h, "d");
  expect(h.stack).toEqual(["a", "b", "d"]);
  expect(step(h, 1, live("a", "b", "c", "d"), "d")).toBeNull();
});

it("skips closed tabs and the active one", () => {
  const h = walk("a", "b", "a", "c");
  expect(step(h, -1, live("b", "c"), "c")?.id).toBe("b");
  expect(step(walk("a", "b", "c"), -1, live("a", "c"), "c")?.id).toBe("a");
});

it("recent lists live tabs newest first, without repeats or the active one", () => {
  const h = walk("a", "b", "a", "c", "d");
  expect(recent(h, live("a", "b", "c", "d"), "d")).toEqual(["c", "a", "b"]);
  expect(recent(h, live("a", "d"), "d")).toEqual(["a"]);
  expect(recent(h, live("a", "b", "c", "d"), "d", 2)).toEqual(["c", "a"]);
});
