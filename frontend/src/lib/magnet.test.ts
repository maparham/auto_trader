import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

// The three klinecharts OverlayMode string values (see magnet.ts for why we use the
// literals rather than the runtime enum, which the CJS test build drops).
const NORMAL = "normal";
const WEAK = "weak_magnet";
const STRONG = "strong_magnet";

// vitest runs in the 'node' env; magnet.ts reads localStorage at module-eval time,
// so install the in-memory stand-in before importing it.
installMemStorage();

const {
  DEFAULT_MAGNET,
  magnetMode,
  invertMode,
  magnetSignal,
  magnetInvertSignal,
  setMagnet,
  toggleMagnet,
  setMagnetStrength,
  currentMagnetMode,
  effectiveMagnetMode,
} = await import("./magnet");

beforeEach(() => {
  localStorage.clear();
  setMagnet(DEFAULT_MAGNET);
  magnetInvertSignal.set(false);
});

describe("magnetMode", () => {
  it("maps off to Normal regardless of strength", () => {
    expect(magnetMode({ on: false, strength: "weak" })).toBe(NORMAL);
    expect(magnetMode({ on: false, strength: "strong" })).toBe(NORMAL);
  });
  it("maps on+weak to WeakMagnet and on+strong to StrongMagnet", () => {
    expect(magnetMode({ on: true, strength: "weak" })).toBe(WEAK);
    expect(magnetMode({ on: true, strength: "strong" })).toBe(STRONG);
  });
});

describe("invertMode (hold Ctrl/Cmd momentary override)", () => {
  it("off → snaps at the last-used strength", () => {
    expect(invertMode({ on: false, strength: "weak" })).toBe(WEAK);
    expect(invertMode({ on: false, strength: "strong" })).toBe(STRONG);
  });
  it("on → stops snapping (Normal)", () => {
    expect(invertMode({ on: true, strength: "weak" })).toBe(NORMAL);
    expect(invertMode({ on: true, strength: "strong" })).toBe(NORMAL);
  });
});

describe("default", () => {
  it("starts off with weak strength", () => {
    expect(DEFAULT_MAGNET).toEqual({ on: false, strength: "weak" });
  });
});

describe("toggleMagnet", () => {
  it("flips on/off while keeping strength, and persists", () => {
    setMagnet({ on: false, strength: "strong" });
    toggleMagnet();
    expect(magnetSignal.value).toEqual({ on: true, strength: "strong" });
    // persisted: a fresh raw read from storage reflects the change
    expect(currentMagnetMode()).toBe(STRONG);
    toggleMagnet();
    expect(magnetSignal.value).toEqual({ on: false, strength: "strong" });
  });
});

describe("setMagnetStrength", () => {
  it("selecting a strength turns magnet on", () => {
    setMagnet(DEFAULT_MAGNET); // off/weak
    setMagnetStrength("strong");
    expect(magnetSignal.value).toEqual({ on: true, strength: "strong" });
    expect(currentMagnetMode()).toBe(STRONG);
  });
});

describe("effectiveMagnetMode (global mode with the hold-invert modifier)", () => {
  it("no modifier held → the plain magnet mode", () => {
    setMagnet({ on: true, strength: "weak" });
    magnetInvertSignal.set(false);
    expect(effectiveMagnetMode()).toBe(WEAK);
  });
  it("modifier held → inverted (off↔snap), keeping strength", () => {
    setMagnet({ on: false, strength: "strong" });
    magnetInvertSignal.set(true);
    expect(effectiveMagnetMode()).toBe(STRONG); // off + hold → snaps strong
    setMagnet({ on: true, strength: "weak" });
    expect(effectiveMagnetMode()).toBe(NORMAL); // on + hold → stops snapping
  });
});

describe("persistence", () => {
  it("setMagnet writes to storage so a reload restores it", async () => {
    setMagnet({ on: true, strength: "strong" });
    // Re-import the module fresh (as on a page reload) — it reads from storage.
    vi.resetModules();
    const fresh = await import("./magnet");
    expect(fresh.magnetSignal.value).toEqual({ on: true, strength: "strong" });
  });
});
