import { describe, it, expect } from "vitest";
import { acquireLease, type BroadcastChannelLike } from "./liveLease";

// A tiny in-memory bus wiring N fake channels together synchronously.
function makeBus() {
  const peers: Array<{ ch: BroadcastChannelLike }> = [];
  function make(): BroadcastChannelLike {
    const self = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(m: unknown) {
        for (const p of peers) if (p.ch !== self) p.ch.onmessage?.({ data: m });
      },
      close() {},
    };
    peers.push({ ch: self });
    return self;
  }
  return { make };
}

describe("acquireLease", () => {
  it("first holder is granted", () => {
    const bus = makeBus();
    const a = acquireLease("EURUSD|capital:demo", { channel: bus.make() });
    expect(a.held).toBe(true);
  });

  it("second holder for the same key is denied", () => {
    const bus = makeBus();
    acquireLease("EURUSD|capital:demo", { channel: bus.make() });
    const b = acquireLease("EURUSD|capital:demo", { channel: bus.make() });
    expect(b.held).toBe(false);
  });

  it("different keys don't conflict", () => {
    const bus = makeBus();
    acquireLease("EURUSD|capital:demo", { channel: bus.make() });
    const b = acquireLease("GBPUSD|capital:demo", { channel: bus.make() });
    expect(b.held).toBe(true);
  });
});
