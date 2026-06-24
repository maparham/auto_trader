import { describe, it, expect } from "vitest";
import { evaluateAlert, RE_ARM_FRACTION } from "./alertEval";

const L = 100; // alert level used throughout

describe("evaluateAlert", () => {
  it("needs two samples — first tick (prev=null) never fires", () => {
    const r = evaluateAlert(null, 101, L, { condition: "crossing", trigger: "every", armed: true });
    expect(r.fired).toBe(false);
    expect(r.remove).toBe(false);
  });

  it("ignores non-finite price/level", () => {
    expect(evaluateAlert(99, NaN, L, { condition: "crossing", trigger: "every", armed: true }).fired).toBe(false);
    expect(evaluateAlert(99, 101, NaN, { condition: "crossing", trigger: "every", armed: true }).fired).toBe(false);
  });

  describe("crossing (either direction)", () => {
    const cfg = { condition: "crossing" as const, trigger: "every" as const, armed: true };
    it("fires crossing up", () => {
      expect(evaluateAlert(99, 101, L, cfg).fired).toBe(true);
    });
    it("fires crossing down", () => {
      expect(evaluateAlert(101, 99, L, cfg).fired).toBe(true);
    });
    it("does not fire without a crossing", () => {
      expect(evaluateAlert(101, 102, L, cfg).fired).toBe(false);
    });
    it("fires exactly at the level boundary (prev<=L, price>L)", () => {
      expect(evaluateAlert(100, 100.5, L, cfg).fired).toBe(true);
    });
  });

  describe("directional conditions", () => {
    it("crossing_up / greater fire only upward", () => {
      for (const condition of ["crossing_up", "greater"] as const) {
        expect(evaluateAlert(99, 101, L, { condition, trigger: "every", armed: true }).fired).toBe(true);
        expect(evaluateAlert(101, 99, L, { condition, trigger: "every", armed: true }).fired).toBe(false);
      }
    });
    it("crossing_down / less fire only downward", () => {
      for (const condition of ["crossing_down", "less"] as const) {
        expect(evaluateAlert(101, 99, L, { condition, trigger: "every", armed: true }).fired).toBe(true);
        expect(evaluateAlert(99, 101, L, { condition, trigger: "every", armed: true }).fired).toBe(false);
      }
    });
    it("greater/less fire when already satisfied — no fresh crossing needed", () => {
      // Both samples on the satisfied side: a crossing alert would NOT fire,
      // but a level check must.
      expect(evaluateAlert(105, 106, L, { condition: "greater", trigger: "once", armed: true }).fired).toBe(true);
      expect(evaluateAlert(95, 94, L, { condition: "less", trigger: "once", armed: true }).fired).toBe(true);
      expect(evaluateAlert(105, 106, L, { condition: "crossing_up", trigger: "once", armed: true }).fired).toBe(false);
    });
    it("an every greater does not re-fire every tick while satisfied", () => {
      // Fired once and disarmed; staying above the level must NOT re-arm.
      const r = evaluateAlert(106, 107, L, { condition: "greater", trigger: "every", armed: false });
      expect(r.nextArmed).toBe(false);
      // Re-arms only after price drops back below the level (past the margin).
      const reArmed = evaluateAlert(106, 99, L, { condition: "greater", trigger: "every", armed: false });
      expect(reArmed.nextArmed).toBe(true);
    });
  });

  describe("once trigger", () => {
    it("fires then asks to be removed", () => {
      const r = evaluateAlert(99, 101, L, { condition: "crossing", trigger: "once", armed: true });
      expect(r.fired).toBe(true);
      expect(r.remove).toBe(true);
      expect(r.nextArmed).toBe(false);
    });
    it("a disarmed once never fires (defensive — once is removed on fire)", () => {
      const r = evaluateAlert(99, 101, L, { condition: "crossing", trigger: "once", armed: false });
      expect(r.fired).toBe(false);
      expect(r.remove).toBe(false);
    });
  });

  describe("every trigger: disarm + re-arm debounce", () => {
    it("fires and disarms (does not remove)", () => {
      const r = evaluateAlert(99, 101, L, { condition: "crossing", trigger: "every", armed: true });
      expect(r.fired).toBe(true);
      expect(r.remove).toBe(false);
      expect(r.nextArmed).toBe(false);
    });

    it("stays disarmed while price hovers near the level (no re-fire on jitter)", () => {
      // Disarmed, price wiggles just under the re-arm threshold → no fire, no re-arm.
      const justUnder = L + L * RE_ARM_FRACTION * 0.5;
      const r = evaluateAlert(L, justUnder, L, { condition: "crossing", trigger: "every", armed: false });
      expect(r.fired).toBe(false);
      expect(r.nextArmed).toBe(false);
    });

    it("re-arms once price clears the level by RE_ARM_FRACTION", () => {
      const cleared = L + L * RE_ARM_FRACTION * 2;
      const r = evaluateAlert(L, cleared, L, { condition: "crossing", trigger: "every", armed: false });
      expect(r.nextArmed).toBe(true);
      expect(r.fired).toBe(false);
    });

    it("full cycle: fire → disarm → clear → re-arm → fire again", () => {
      // 1. cross up: fires, disarms
      let r = evaluateAlert(99, 101, L, { condition: "crossing", trigger: "every", armed: true });
      expect(r.fired).toBe(true);
      let armed = r.nextArmed; // false
      // 2. price clears upward by > threshold: re-arms (no fire)
      const cleared = L + L * RE_ARM_FRACTION * 2;
      r = evaluateAlert(101, cleared, L, { condition: "crossing", trigger: "every", armed });
      armed = r.nextArmed; // true
      expect(armed).toBe(true);
      // 3. cross back down: fires again
      r = evaluateAlert(cleared, 99, L, { condition: "crossing", trigger: "every", armed });
      expect(r.fired).toBe(true);
    });
  });
});
