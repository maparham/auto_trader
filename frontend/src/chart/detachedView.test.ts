import { describe, it, expect } from "vitest";
import {
  shouldDetach, detachedWindows, DETACH_GAP_BARS, DETACH_CONTEXT_BARS,
} from "./detachedView";

const RES = 300; // 5m
const NOW = 1_700_000_000_000;

describe("shouldDetach", () => {
  it("detaches when the gap exceeds the bar budget", () => {
    const target = NOW - (DETACH_GAP_BARS + 10) * RES * 1000;
    expect(shouldDetach(target, NOW, RES)).toBe(true);
  });
  it("stays attached inside the budget (parallel cover handles it)", () => {
    const target = NOW - (DETACH_GAP_BARS - 10) * RES * 1000;
    expect(shouldDetach(target, NOW, RES)).toBe(false);
  });
  it("never detaches with no loaded data (initial load owns it)", () => {
    expect(shouldDetach(NOW - 10 ** 12, null, RES)).toBe(false);
  });
  it("never detaches for a target newer than the loaded oldest", () => {
    expect(shouldDetach(NOW + 1000, NOW, RES)).toBe(false);
  });
});

describe("detachedWindows", () => {
  it("covers target +/- context in 500-bar windows, oldest first", () => {
    const ws = detachedWindows(NOW, RES);
    const spanSec = 2 * DETACH_CONTEXT_BARS * RES;
    expect(ws.length).toBe(Math.ceil((2 * DETACH_CONTEXT_BARS) / 500));
    expect(ws[0].fromSec).toBe(Math.floor(NOW / 1000) - DETACH_CONTEXT_BARS * RES);
    expect(ws[ws.length - 1].toSec).toBe(ws[0].fromSec + spanSec);
    for (let i = 1; i < ws.length; i++) expect(ws[i].fromSec).toBe(ws[i - 1].toSec);
  });
});
