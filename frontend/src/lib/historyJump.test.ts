import { beforeEach, describe, expect, it } from "vitest";
import { beginHistoryJump, historyJumpSignal } from "./historyJump";

describe("beginHistoryJump", () => {
  beforeEach(() => {
    historyJumpSignal.set(null);
  });

  it("publishes the cell with no progress on begin", () => {
    beginHistoryJump("cell-1");
    expect(historyJumpSignal.value).toEqual({ cellId: "cell-1", progress: null });
  });

  it("update publishes progress for the owning jump", () => {
    const jump = beginHistoryJump("cell-1");
    jump.update({ done: 3, total: 40 });
    expect(historyJumpSignal.value).toEqual({
      cellId: "cell-1",
      progress: { done: 3, total: 40 },
    });
  });

  it("update keeps the furthest done seen (parallel lanes answer out of order)", () => {
    const jump = beginHistoryJump("cell-1");
    jump.update({ done: 12, total: 40 });
    jump.update({ done: 5, total: 40 });
    expect(historyJumpSignal.value?.progress).toEqual({ done: 12, total: 40 });
  });

  it("end clears the signal", () => {
    const jump = beginHistoryJump("cell-1");
    jump.end();
    expect(historyJumpSignal.value).toBeNull();
  });

  it("a superseded jump's end does not clear the newer jump", () => {
    const old = beginHistoryJump("cell-1");
    beginHistoryJump("cell-2");
    old.end();
    expect(historyJumpSignal.value).toEqual({ cellId: "cell-2", progress: null });
  });

  it("a superseded jump's update does not overwrite the newer jump", () => {
    const old = beginHistoryJump("cell-1");
    beginHistoryJump("cell-2");
    old.update({ done: 9, total: 10 });
    expect(historyJumpSignal.value).toEqual({ cellId: "cell-2", progress: null });
  });

  it("end after update still clears (identity survives updates)", () => {
    const jump = beginHistoryJump("cell-1");
    jump.update({ done: 1, total: 2 });
    jump.end();
    expect(historyJumpSignal.value).toBeNull();
  });
});
