// Finding 4 (public-demo fix wave): demo runs pinned to dukascopy, which has
// no upstream tick feed, and the demo principal carries no auth token for the
// WS to present, so a real dial would only ever get closed 4401 by verify_ws
// and retry forever with exponential backoff, spamming hosted logs.
// openLive must not dial a socket at all in demo mode.
//
// isDemoMode() is a one-way latch (see lib/demoMode.ts), so this lives in its
// own file/module graph rather than alongside feed.test.ts's other openLive
// cases, which rely on demo mode being off.
import { describe, it, expect, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { openLive } from "./feed";
import { setDemoMode } from "./demoMode";

describe("openLive in demo mode", () => {
  it("never opens a socket and reports non-live status", () => {
    const originalWebSocket = globalThis.WebSocket;
    const wsSpy = vi.fn();
    // @ts-expect-error test stub, not a real WebSocket constructor
    globalThis.WebSocket = wsSpy;
    try {
      setDemoMode();
      const onCandle = vi.fn();
      const onStatus = vi.fn();
      const h = openLive("OIL_CRUDE", "MINUTE", onCandle, onStatus, "mid", "dukascopy");
      expect(wsSpy).not.toHaveBeenCalled();
      expect(onCandle).not.toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledWith("down");
      expect(() => h.close()).not.toThrow();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
