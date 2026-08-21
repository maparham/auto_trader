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
  loadJumpPref,
  saveJumpPref,
  DEFAULT_JUMP_PREF,
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

  // The dead end that actually stops a jump is the broker's history floor, not a
  // holiday: minute candles run out after weeks. So each re-roll draws CLOSER to
  // now, converging on the floor from above. Widening (what this did before) walked
  // away from the only data there was.
  it("halves the window on each re-roll attempt, drawing closer to now", () => {
    const first = pickJumpTarget({ nowMs: NOW, windowMs: 8 * DAY, attempt: 0, random: () => 0 });
    const third = pickJumpTarget({ nowMs: NOW, windowMs: 8 * DAY, attempt: 2, random: () => 0 });
    expect(first.fromMs).toBe(NOW - 8 * DAY);
    expect(third.fromMs).toBe(NOW - 2 * DAY);
    // The headroom shrinks with the window, so a late attempt still leaves bars
    // to play instead of reserving a tenth of the ORIGINAL window it no longer uses.
    expect(third.toMs).toBe(NOW - 0.2 * DAY);
  });

  it("stays inside the requested window however many times it re-rolls", () => {
    for (let attempt = 0; attempt < MAX_JUMP_ATTEMPTS; attempt++) {
      const r = pickJumpTarget({ nowMs: NOW, windowMs: 30 * DAY, attempt, random: () => 0 });
      expect(r.fromMs).toBeGreaterThanOrEqual(NOW - 30 * DAY);
      expect(r.targetMs).toBeLessThan(NOW);
    }
  });

  it("bounds the re-roll budget", () => {
    expect(MAX_JUMP_ATTEMPTS).toBe(6);
  });

  it("offers the spec's window presets plus custom", () => {
    expect(JUMP_WINDOWS.map((w) => w.key)).toEqual(["1W", "1M", "3M", "1Y", "custom"]);
  });
});

// The picker unmounts on a successful jump, so its window choice cannot live in
// component state: without this, every session after the first silently re-armed
// the default month while the user believed they had asked for a year.
describe("the remembered jump window", () => {
  beforeEach(() => localStorage.clear());

  it("defaults before anything is chosen", () => {
    expect(loadJumpPref()).toEqual(DEFAULT_JUMP_PREF);
  });

  it("round-trips a choice", () => {
    saveJumpPref({ key: "1Y", days: 120 });
    expect(loadJumpPref()).toEqual({ key: "1Y", days: 120 });
  });

  it("is one global entry, not one per cell", () => {
    saveJumpPref({ key: "3M", days: 90 });
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    expect(keys).toEqual(["auto-trader.replayJumpWindow"]);
  });

  it("falls back on a preset that no longer exists, and on a nonsense day count", () => {
    // A stored key can outlive the list it came from; jumping into a zero-width
    // window would land at the live edge with nothing to play.
    localStorage.setItem(
      "auto-trader.replayJumpWindow",
      JSON.stringify({ key: "5Y", days: 0 }),
    );
    expect(loadJumpPref()).toEqual(DEFAULT_JUMP_PREF);
  });

  it("survives a backend hydrate (the key is registered device-local)", async () => {
    saveJumpPref({ key: "1Y", days: 90 });
    const fetchStub = vi.fn(async () => ({
      ok: true,
      json: async () => ({ "auto-trader.someOtherKey": JSON.stringify({ a: 1 }) }),
    }));
    vi.stubGlobal("fetch", fetchStub);
    await hydrateFromBackend();
    expect(loadJumpPref().key).toBe("1Y");
    vi.unstubAllGlobals();
  });
});
