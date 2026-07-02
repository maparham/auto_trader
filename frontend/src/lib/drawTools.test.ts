import { describe, it, expect } from "vitest";

// node env: in-memory localStorage before importing persist (same idiom as
// persist.test.ts — the load/save helpers write through localStorage).
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { DRAW_TOOLS, toolLabel } = await import("./drawTools");
const P = await import("./persist");

describe("draw-tool registry", () => {
  it("is a single flat list of the 8 tools, in order", () => {
    expect(DRAW_TOOLS.map((t) => t.name)).toEqual([
      "segment", "rayLine", "straightLine",
      "horizontalStraightLine", "verticalStraightLine", "priceLine",
      "priceChannelLine", "fibonacciLine",
    ]);
  });

  it("toolLabel resolves by overlay name and falls back gracefully", () => {
    expect(toolLabel("segment")).toBe("Trend line");
    expect(toolLabel("nope")).toBe("nope"); // graceful fallback
  });
});

describe("draw-tool preferences (persist)", () => {
  it("favorite drawings round-trip (global key, star order preserved)", () => {
    expect(P.loadFavoriteDrawings()).toEqual([]);
    P.saveFavoriteDrawings(["segment", "priceLine"]);
    expect(P.loadFavoriteDrawings()).toEqual(["segment", "priceLine"]);
  });

  it("last-used-tool round-trips", () => {
    expect(P.loadLastDrawTools()).toEqual({});
    P.saveLastDrawTools({ tool: "rayLine" });
    expect(P.loadLastDrawTools()).toEqual({ tool: "rayLine" });
  });
});
