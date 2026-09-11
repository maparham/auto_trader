// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import {
  MOBILE_CHROME_KEY,
  mobileViewMode,
  setChromeHidden,
  setLandscape,
  setScreenAdapter,
  initViewMode,
  type ScreenAdapter,
} from "./mobileViewMode";

installMemStorage();

// A fake browser. jsdom implements neither the Fullscreen nor the Screen
// Orientation API, and on a real device either call can be refused, so the
// adapter is the seam that makes both the happy and the refused path testable.
function fakeScreen(over: Partial<ScreenAdapter> = {}) {
  const calls: string[] = [];
  let full = false;
  let onChange: (() => void) | null = null;
  const a: ScreenAdapter & { calls: string[]; fire(): void } = {
    calls,
    async requestFullscreen() {
      calls.push("requestFullscreen");
      full = true;
    },
    async exitFullscreen() {
      calls.push("exitFullscreen");
      full = false;
    },
    isFullscreen: () => full,
    async lockLandscape() {
      calls.push("lockLandscape");
    },
    unlockOrientation() {
      calls.push("unlockOrientation");
    },
    onFullscreenChange(fn) {
      onChange = fn;
      return () => {
        onChange = null;
      };
    },
    fire() {
      onChange?.();
    },
    ...over,
  };
  setScreenAdapter(a);
  return a;
}

beforeEach(() => {
  localStorage.clear();
  mobileViewMode.set({ chromeHidden: false, landscape: false });
});
afterEach(() => vi.restoreAllMocks());

describe("mobileViewMode chrome-only", () => {
  it("hides and restores the chrome without touching the browser", async () => {
    const screen = fakeScreen();
    await setChromeHidden(true);
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
    await setChromeHidden(false);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    // Portrait chart-only is pure layout: no full screen, no orientation lock.
    expect(screen.calls).toEqual([]);
  });

  it("persists the chrome preference", async () => {
    fakeScreen();
    await setChromeHidden(true);
    expect(localStorage.getItem(MOBILE_CHROME_KEY)).toBe("true");
  });
});

describe("mobileViewMode landscape", () => {
  it("goes full screen first, then locks, because Android Chrome requires that order", async () => {
    const screen = fakeScreen();
    await setLandscape(true);
    expect(screen.calls).toEqual(["requestFullscreen", "lockLandscape"]);
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: true });
  });

  it("still hides the chrome when full screen is refused", async () => {
    const screen = fakeScreen({
      requestFullscreen: async () => {
        throw new Error("denied");
      },
    });
    await setLandscape(true);
    // The lock is still attempted: refusing full screen does not mean the
    // platform refuses the lock, and a failure there is equally survivable.
    expect(screen.calls).toContain("lockLandscape");
    expect(mobileViewMode.value.chromeHidden).toBe(true);
  });

  it("still hides the chrome when the orientation lock is refused (iOS Safari)", async () => {
    fakeScreen({
      lockLandscape: async () => {
        throw new Error("not supported");
      },
    });
    await setLandscape(true);
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: true });
  });

  it("unlocks before leaving full screen on the way out", async () => {
    const screen = fakeScreen();
    await setLandscape(true);
    screen.calls.length = 0;
    await setLandscape(false);
    expect(screen.calls).toEqual(["unlockOrientation", "exitFullscreen"]);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
  });

  it("does not persist landscape: full screen cannot be restored without a gesture", async () => {
    fakeScreen();
    await setLandscape(true);
    expect(localStorage.getItem(MOBILE_CHROME_KEY)).not.toBe("true");
  });

  it("restoring the chrome also leaves landscape, since landscape implies it", async () => {
    const screen = fakeScreen();
    await setLandscape(true);
    screen.calls.length = 0;
    await setChromeHidden(false);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    expect(screen.calls).toEqual(["unlockOrientation", "exitFullscreen"]);
  });

  it("keeps a standing chart-only preference across a landscape excursion", async () => {
    fakeScreen();
    await setChromeHidden(true);
    await setLandscape(true);
    await setLandscape(false);
    // The user asked for chart-only before rotating. Leaving landscape returns
    // to that, not to a hardcoded "show the chrome".
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
    expect(localStorage.getItem(MOBILE_CHROME_KEY)).toBe("true");
  });

  it("an explicit show-the-chrome while in landscape clears the preference too", async () => {
    fakeScreen();
    await setChromeHidden(true);
    await setLandscape(true);
    await setChromeHidden(false);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    expect(localStorage.getItem(MOBILE_CHROME_KEY)).toBe("false");
  });
});

describe("mobileViewMode full-screen lifecycle", () => {
  it("clears the mode when full screen goes away underneath it", async () => {
    const screen = fakeScreen();
    const stop = initViewMode();
    await setLandscape(true);
    // The Android back gesture or Escape: the browser leaves full screen and
    // never tells us through our own call path.
    (screen as unknown as { isFullscreen: () => boolean }).isFullscreen = () => false;
    screen.fire();
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    stop();
  });

  it("leaves a portrait chart-only session alone when full screen changes", async () => {
    const screen = fakeScreen();
    const stop = initViewMode();
    await setChromeHidden(true);
    screen.fire();
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
    stop();
  });

  it("restores the standing preference when full screen goes away", async () => {
    const screen = fakeScreen();
    const stop = initViewMode();
    await setChromeHidden(true);
    await setLandscape(true);
    (screen as unknown as { isFullscreen: () => boolean }).isFullscreen = () => false;
    screen.fire();
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
    stop();
  });

  it("only reconciles state when full screen is lost: it makes no browser calls", async () => {
    const screen = fakeScreen();
    const stop = initViewMode();
    await setLandscape(true);
    screen.calls.length = 0;
    (screen as unknown as { isFullscreen: () => boolean }).isFullscreen = () => false;
    screen.fire();
    // Full screen is already gone and the orientation lock went with it, so
    // exiting or unlocking here is at best a no-op and at worst a call that
    // races the next entry into landscape.
    expect(screen.calls).toEqual([]);
    stop();
  });
});
