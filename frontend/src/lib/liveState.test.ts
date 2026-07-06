import { describe, it, expect } from "vitest";
import {
  initialLiveState, armSnapshot, editDraft, markLost, activeRules, setPositionVintage,
} from "./liveState";
import { defaultBacktestConfig } from "./backtestConfig";

const cfg = defaultBacktestConfig();

describe("liveState reducer", () => {
  it("arm freezes a snapshot copy independent of later draft edits", () => {
    let s = initialLiveState(cfg, "capital:demo", 1);
    s = armSnapshot(s, "s1", 1700);
    expect(s.status).toBe("armed");
    const edited = { ...cfg, longEnabled: false };
    s = editDraft(s, edited);
    expect(s.pendingEdits).toBe(true);
    expect(s.snapshot!.cfg.longEnabled).not.toBe(false); // snapshot is a frozen copy
  });

  it("re-arm clears pendingEdits and adopts the draft", () => {
    let s = initialLiveState(cfg, "capital:demo", 1);
    s = armSnapshot(s, "s1", 1700);
    s = editDraft(s, { ...cfg, shortEnabled: false });
    s = armSnapshot(s, "s1", 1800); // re-arm
    expect(s.pendingEdits).toBe(false);
    expect(s.snapshot!.cfg.shortEnabled).toBe(false);
  });

  it("an open position keeps its opening vintage across a re-arm", () => {
    let s = initialLiveState(cfg, "capital:demo", 1);
    s = armSnapshot(s, "s1", 1700);
    const opening = s.snapshot!;
    s = setPositionVintage(s, opening);       // position opened under v1
    s = armSnapshot(s, "s1", 1800);            // re-arm to v2 while holding
    expect(activeRules(s)!.armedAtSec).toBe(1700); // exits still use v1
  });

  it("clearing the vintage (flat) falls back to the current snapshot", () => {
    let s = initialLiveState(cfg, "capital:demo", 1);
    s = armSnapshot(s, "s1", 1700);
    s = setPositionVintage(s, s.snapshot!);
    s = armSnapshot(s, "s1", 1800);
    s = setPositionVintage(s, null);           // position closed
    expect(activeRules(s)!.armedAtSec).toBe(1800);
  });

  it("markLost transitions to lost-lease", () => {
    let s = initialLiveState(cfg, "capital:demo", 1);
    s = armSnapshot(s, "s1", 1700);
    s = markLost(s);
    expect(s.status).toBe("lost-lease");
  });
});
