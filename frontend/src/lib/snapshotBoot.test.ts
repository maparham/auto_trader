import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";

// vitest runs in the 'node' env; snapshotBoot.ts imports ./persist, which
// touches localStorage at module-eval time — install the in-memory stand-in
// before importing it (see testMemStorage.ts).
installMemStorage();
const { parseSnapshotParams, resolveDescriptor } = await import("./snapshotBoot");
const { viewKey } = await import("./viewHeartbeat");

describe("parseSnapshotParams", () => {
  it("parses a full snapshot URL", () => {
    const p = parseSnapshotParams(
      "?snapshot=1&broker=capital&epic=US100&level=20000.5&price=20001&token=abc",
    );
    expect(p).toEqual({
      broker: "capital", epic: "US100", level: 20000.5, price: 20001, token: "abc",
    });
  });
  it("returns null without snapshot=1", () => {
    expect(parseSnapshotParams("?broker=capital&epic=US100")).toBeNull();
  });
  it("returns null when broker or epic is missing", () => {
    expect(parseSnapshotParams("?snapshot=1&epic=US100")).toBeNull();
    expect(parseSnapshotParams("?snapshot=1&broker=capital")).toBeNull();
  });
  it("tolerates missing level/price/token", () => {
    const p = parseSnapshotParams("?snapshot=1&broker=capital&epic=US100");
    expect(p).toEqual({ broker: "capital", epic: "US100", level: null, price: null, token: null });
  });
});

describe("resolveDescriptor", () => {
  beforeEach(() => localStorage.clear());
  it("reads the heartbeat descriptor for (broker, epic)", () => {
    localStorage.setItem(
      viewKey("capital", "US100"),
      JSON.stringify({
        scope: "tab.t1.cell.c1", epic: "US100", broker: "capital",
        resolution: "MINUTE_5", symbol: { epic: "US100", name: "US 100", status: null },
        barSpace: 8, width: 1280, height: 640, updatedAt: 1,
      }),
    );
    expect(resolveDescriptor("capital", "US100")?.scope).toBe("tab.t1.cell.c1");
  });
  it("null when absent or malformed", () => {
    expect(resolveDescriptor("capital", "NOPE")).toBeNull();
    localStorage.setItem(viewKey("capital", "BAD"), JSON.stringify({ nope: true }));
    expect(resolveDescriptor("capital", "BAD")).toBeNull();
  });
});
