// @vitest-environment jsdom
// The select-before-drag hold (OverlayManager.lockUnselectedForPress) must be
// on for exactly the touchstart klinecharts hit-tests on. These drive the real
// DOM wiring: when it locks, what releases it, and what never locks.
import { describe, it, expect, vi, afterEach } from "vitest";
import { installPressLock } from "./touchPressLock";

function setup(drawing = false) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const release = vi.fn();
  const overlays = { lockUnselectedForPress: vi.fn(() => release), isDrawing: () => drawing };
  const uninstall = installPressLock(el, overlays);
  const down = (pointerType: string) =>
    el.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType }));
  const fire = (type: string, target: EventTarget = el) => target.dispatchEvent(new Event(type, { bubbles: true }));
  return { el, overlays, release, uninstall, down, fire };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

describe("installPressLock", () => {
  it("locks on a finger press and releases right after the touchstart", () => {
    const t = setup();
    cleanup = t.uninstall;
    t.down("touch");
    expect(t.overlays.lockUnselectedForPress).toHaveBeenCalledTimes(1);
    expect(t.release).not.toHaveBeenCalled();
    t.fire("touchstart");
    expect(t.release).toHaveBeenCalledTimes(1);
    t.fire("pointerup"); // already released: no second call
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it("holds a pen like a finger, and never a mouse", () => {
    const t = setup();
    cleanup = t.uninstall;
    t.down("mouse");
    expect(t.overlays.lockUnselectedForPress).not.toHaveBeenCalled();
    t.down("pen");
    expect(t.overlays.lockUnselectedForPress).toHaveBeenCalledTimes(1);
  });

  it("falls back to pointerup or pointercancel when no touchstart comes", () => {
    for (const end of ["pointerup", "pointercancel"]) {
      const t = setup();
      t.down("touch");
      t.fire(end);
      expect(t.release).toHaveBeenCalledTimes(1);
      t.uninstall();
    }
  });

  it("takes one hold per gesture, so a second finger doesn't stack another", () => {
    const t = setup();
    cleanup = t.uninstall;
    t.down("touch");
    t.down("touch");
    expect(t.overlays.lockUnselectedForPress).toHaveBeenCalledTimes(1);
    t.fire("touchstart");
    t.down("touch"); // the next gesture holds afresh
    expect(t.overlays.lockUnselectedForPress).toHaveBeenCalledTimes(2);
  });

  it("never holds while a drawing is being placed", () => {
    const t = setup(true);
    cleanup = t.uninstall;
    t.down("touch");
    expect(t.overlays.lockUnselectedForPress).not.toHaveBeenCalled();
  });

  it("releases a live hold on teardown and stops listening", () => {
    const t = setup();
    t.down("touch");
    t.uninstall();
    expect(t.release).toHaveBeenCalledTimes(1);
    t.down("touch");
    expect(t.overlays.lockUnselectedForPress).toHaveBeenCalledTimes(1);
  });
});
