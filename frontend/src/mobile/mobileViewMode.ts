// Mobile view modes (spec: 2026-09-11-mobile-chart-tools-design.md, Phase 1).
//
// Two flags. `chromeHidden` drops the top bar and the tab bar, worth about
// 94px of 764 in portrait. `landscape` additionally turns the REAL viewport
// sideways, where that same 94px would otherwise be 23% of the height.
//
// Rotation locks the viewport rather than transforming the shell with CSS: a
// rotated element's getBoundingClientRect() reports its axis-aligned box, which
// would invalidate every `clientX - rect.left` in the chart (27 call sites in
// our code, 2 more inside klinecharts, which we cannot patch).
import { Signal } from "../lib/signals";
import { load, saveLocal } from "../lib/persist/core";

export interface ViewMode {
  chromeHidden: boolean;
  landscape: boolean;
}

/** Only the chrome preference persists. A restored `landscape` would claim a
 *  state the device is not in: full screen cannot be re-entered on load
 *  without a user gesture. */
export const MOBILE_CHROME_KEY = "auto-trader.mobileChromeHidden";

export const mobileViewMode = new Signal<ViewMode>({
  chromeHidden: load<boolean>(MOBILE_CHROME_KEY, false),
  landscape: false,
});

/** The browser calls this module makes, behind a seam. jsdom implements
 *  neither API, and on a device either can be refused, so both the wiring and
 *  the refusal paths are testable only if they are injectable. */
export interface ScreenAdapter {
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;
  lockLandscape(): Promise<void>;
  unlockOrientation(): void;
  onFullscreenChange(fn: () => void): () => void;
}

const domScreen: ScreenAdapter = {
  requestFullscreen: () => document.documentElement.requestFullscreen(),
  exitFullscreen: () => document.exitFullscreen(),
  isFullscreen: () => document.fullscreenElement != null,
  lockLandscape: async () => {
    // Typed loosely: lock() is absent from lib.dom in some TS versions and
    // absent from Safari at runtime.
    const o = screen.orientation as unknown as { lock?: (s: string) => Promise<void> };
    if (!o?.lock) throw new Error("orientation lock unsupported");
    await o.lock("landscape");
  },
  unlockOrientation: () => {
    const o = screen.orientation as unknown as { unlock?: () => void };
    o?.unlock?.();
  },
  onFullscreenChange: (fn) => {
    document.addEventListener("fullscreenchange", fn);
    return () => document.removeEventListener("fullscreenchange", fn);
  },
};

let adapter: ScreenAdapter = domScreen;

export function setScreenAdapter(a: ScreenAdapter): void {
  adapter = a;
}

/** Every browser call here is best-effort: a refusal must still leave a
 *  coherent mode, never a half-applied one. */
async function attempt(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch {
    /* refused: the mode applies whatever it achieved */
  }
}

export async function setChromeHidden(on: boolean): Promise<void> {
  // Always persist the preference first.
  saveLocal(MOBILE_CHROME_KEY, on);

  // Landscape implies hidden chrome, so restoring the chrome leaves landscape.
  if (!on && mobileViewMode.value.landscape) {
    await setLandscape(false);
    return;
  }
  mobileViewMode.set({ ...mobileViewMode.value, chromeHidden: on });
}

/** Update state when leaving landscape: restore the standing chrome preference. */
function updateLeaveLandscape(): void {
  const chromeHidden = load<boolean>(MOBILE_CHROME_KEY, false);
  mobileViewMode.set({ chromeHidden, landscape: false });
}

/** Leave landscape and restore the standing chrome preference. Factored so
 *  setLandscape and initViewMode cannot drift apart. */
async function leaveLandscape(): Promise<void> {
  await attempt(() => adapter.unlockOrientation());
  await attempt(() => adapter.exitFullscreen());
  updateLeaveLandscape();
}

export async function setLandscape(on: boolean): Promise<void> {
  if (on) {
    // Full screen FIRST: Android Chrome refuses an orientation lock outside it.
    await attempt(() => adapter.requestFullscreen());
    await attempt(() => adapter.lockLandscape());
    mobileViewMode.set({ chromeHidden: true, landscape: true });
    return;
  }
  await leaveLandscape();
}

/** Watch for full screen ending outside our control (the Android back gesture,
 *  Escape). Reconciles state only; full screen and orientation lock are already
 *  gone. Making browser calls here would race against a new landscape entry.
 *  Returns an unsubscribe. */
export function initViewMode(): () => void {
  return adapter.onFullscreenChange(() => {
    if (!mobileViewMode.value.landscape) return;
    if (adapter.isFullscreen()) return;
    updateLeaveLandscape();
  });
}
