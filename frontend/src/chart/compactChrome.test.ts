import { describe, it, expect } from "vitest";
import { compactHides } from "./compactChrome";

describe("compactHides", () => {
  it("desktop hides nothing", () => {
    expect(compactHides(undefined)).toEqual({ rangeBar: false, replay: false, detachedPill: false, cacheStats: false });
    expect(compactHides(false)).toEqual({ rangeBar: false, replay: false, detachedPill: false, cacheStats: false });
  });
  it("compact hides desktop chrome", () => {
    expect(compactHides(true)).toEqual({ rangeBar: true, replay: true, detachedPill: true, cacheStats: true });
  });
});
