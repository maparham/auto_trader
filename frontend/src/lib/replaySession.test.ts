import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const {
  loadReplaySession,
  saveReplaySession,
  clearReplaySession,
  pickJumpTarget,
  JUMP_WINDOWS,
  MAX_JUMP_ATTEMPTS,
} = await import("./replaySession");

const { hydrateFromBackend } = await import("./persist/core");

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const DAY = 86_400_000;

const rec = (over: Partial<Parameters<typeof saveReplaySession>[1]> = {}) => ({
  epic: "US100",
  resolution: "HOUR",
  startMs: NOW - 30 * DAY,
  cursorMs: NOW - 29 * DAY,
  highWaterMs: NOW - 29 * DAY,
  masked: true,
  showStrategy: false,
  ledger: null,
  savedAt: NOW,
  ...over,
});

describe("replay session persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a session per cell scope", () => {
    saveReplaySession("tab.t1.cell.a", rec());
    expect(loadReplaySession("tab.t1.cell.a")?.cursorMs).toBe(NOW - 29 * DAY);
    expect(loadReplaySession("tab.t1.cell.b")).toBe(null);
  });

  it("keeps cells independent and clears only the named scope", () => {
    saveReplaySession("s1", rec());
    saveReplaySession("s2", rec({ epic: "OIL_CRUDE" }));
    clearReplaySession("s1");
    expect(loadReplaySession("s1")).toBe(null);
    expect(loadReplaySession("s2")?.epic).toBe("OIL_CRUDE");
  });

  it("writes exactly one storage key, whatever the session count", () => {
    saveReplaySession("s1", rec());
    saveReplaySession("s2", rec({ epic: "OIL_CRUDE" }));
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    expect(keys.filter((k) => k.includes("replay"))).toEqual(["auto-trader.replaySessions"]);
  });

  it("survives a backend hydrate (the key is registered device-local)", async () => {
    // A saveLocal-only flat key is never in the backend snapshot, so the prune
    // loop deletes it unless it is in DEVICE_LOCAL_FLAT_KEYS — the failure the
    // backtest panel already hit ("reopened once, then stayed closed").
    saveReplaySession("s1", rec());
    const fetchStub = vi.fn(async () => ({
      ok: true,
      json: async () => ({ "auto-trader.someOtherKey": JSON.stringify({ a: 1 }) }),
    }));
    vi.stubGlobal("fetch", fetchStub);
    await hydrateFromBackend();
    expect(loadReplaySession("s1")).not.toBe(null);
    vi.unstubAllGlobals();
  });

  it("prunes the oldest sessions beyond the cap", () => {
    for (let i = 0; i < 45; i++) saveReplaySession(`s${i}`, rec({ savedAt: NOW + i }));
    expect(loadReplaySession("s0")).toBe(null);
    expect(loadReplaySession("s44")).not.toBe(null);
  });
});

describe("pickJumpTarget", () => {
  it("picks uniformly inside the requested window, ending one window-tenth before now", () => {
    const r = pickJumpTarget({ nowMs: NOW, windowMs: 30 * DAY, attempt: 0, random: () => 0.5 });
    expect(r.fromMs).toBe(NOW - 30 * DAY);
    expect(r.toMs).toBe(NOW - 3 * DAY); // 10% headroom so the session has bars to play
    expect(r.targetMs).toBe(r.fromMs + (r.toMs - r.fromMs) * 0.5);
  });

  it("widens the window on each re-roll attempt so dead zones cannot trap it", () => {
    const first = pickJumpTarget({ nowMs: NOW, windowMs: 7 * DAY, attempt: 0, random: () => 0 });
    const third = pickJumpTarget({ nowMs: NOW, windowMs: 7 * DAY, attempt: 2, random: () => 0 });
    expect(third.fromMs).toBeLessThan(first.fromMs);
    expect(third.toMs).toBeGreaterThanOrEqual(first.toMs); // strict superset, never a retreating head
  });

  it("bounds the re-roll budget", () => {
    expect(MAX_JUMP_ATTEMPTS).toBe(6);
  });

  it("offers the spec's window presets plus custom", () => {
    expect(JUMP_WINDOWS.map((w) => w.key)).toEqual(["1W", "1M", "3M", "1Y", "custom"]);
  });
});
