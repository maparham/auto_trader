// Select before drag, for fingers and pens.
//
// A pan that happens to start on a drawing or alert line must not move it:
// the user taps it first, then drags. OverlayManager.lockUnselectedForPress
// locks every unselected one, and klinecharts then refuses to let the press
// grab it, so the gesture falls through to the chart's own pan. The hold only
// has to cover the touchstart klinecharts hit-tests on, and pointerdown comes
// before it, so this locks on pointerdown and unlocks right after that
// touchstart (a window listener, so it runs after the canvas's own), or at
// pointerup/pointercancel if no touchstart ever arrives.

export interface PressLockOverlays {
  lockUnselectedForPress(): () => void;
  /** A drawing is being placed: its clicks must reach the chart untouched. */
  isDrawing(): boolean;
}

/** Wire the hold onto the chart element. Returns the teardown. */
export function installPressLock(el: HTMLElement, overlays: PressLockOverlays): () => void {
  let release: (() => void) | null = null;
  const end = () => {
    release?.();
    release = null;
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    if (release || overlays.isDrawing()) return;
    release = overlays.lockUnselectedForPress();
    window.addEventListener("touchstart", end, { once: true, passive: true });
  };
  el.addEventListener("pointerdown", onDown, true);
  el.addEventListener("pointerup", end, true);
  el.addEventListener("pointercancel", end, true);
  return () => {
    el.removeEventListener("pointerdown", onDown, true);
    el.removeEventListener("pointerup", end, true);
    el.removeEventListener("pointercancel", end, true);
    window.removeEventListener("touchstart", end);
    end();
  };
}
