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

const { DRAW_FAMILIES, toolLabel, familyOf } = await import("./drawTools");
const P = await import("./persist");

describe("draw-tool registry", () => {
  it("groups the existing 8 tools into lines/channels/fibs", () => {
    expect(DRAW_FAMILIES.map((f) => f.key)).toEqual(["lines", "channels", "fibs"]);
    const lines = DRAW_FAMILIES[0].tools.map((t) => t.name);
    expect(lines).toEqual([
      "segment", "rayLine", "straightLine",
      "horizontalStraightLine", "verticalStraightLine", "priceLine",
    ]);
    expect(DRAW_FAMILIES[1].tools.map((t) => t.name)).toEqual(["priceChannelLine"]);
    expect(DRAW_FAMILIES[2].tools.map((t) => t.name)).toEqual(["fibonacciLine"]);
  });

  it("toolLabel and familyOf resolve by overlay name", () => {
    expect(toolLabel("segment")).toBe("Trend line");
    expect(toolLabel("nope")).toBe("nope"); // graceful fallback
    expect(familyOf("priceChannelLine")?.key).toBe("channels");
    expect(familyOf("nope")).toBeUndefined();
  });
});

describe("draw-tool preferences (persist)", () => {
  it("favorite drawings round-trip (global key, star order preserved)", () => {
    expect(P.loadFavoriteDrawings()).toEqual([]);
    P.saveFavoriteDrawings(["segment", "priceLine"]);
    expect(P.loadFavoriteDrawings()).toEqual(["segment", "priceLine"]);
  });

  it("last-used-per-family round-trips", () => {
    expect(P.loadLastDrawTools()).toEqual({});
    P.saveLastDrawTools({ lines: "rayLine" });
    expect(P.loadLastDrawTools()).toEqual({ lines: "rayLine" });
  });
});
