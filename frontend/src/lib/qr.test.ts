import { describe, it, expect } from "vitest";
import { qrSvgPath } from "./qr";

const LINK = "https://t.me/chartkar_alerts_bot?start=Ab3xYz9QwErT";

describe("qrSvgPath", () => {
  it("sizes the viewBox to the module grid plus a quiet zone on both sides", () => {
    const { size } = qrSvgPath(LINK);
    // Every QR version is 4n+17 modules wide; +2 margin each side.
    expect((size - 4) % 4).toBe(1);
    expect(size).toBeGreaterThan(21);
  });

  it("emits one unit square per dark module", () => {
    const { path } = qrSvgPath(LINK);
    const squares = path.match(/M\d+ \d+h1v1h-1z/g) ?? [];
    // A QR is roughly half dark; assert it is populated but not solid.
    const { size } = qrSvgPath(LINK);
    const cells = (size - 4) ** 2;
    expect(squares.length).toBeGreaterThan(cells * 0.25);
    expect(squares.length).toBeLessThan(cells * 0.75);
  });

  it("offsets every module by the margin, so nothing touches the edge", () => {
    const { path } = qrSvgPath(LINK, 2);
    const coords = [...path.matchAll(/M(\d+) (\d+)h/g)].flatMap((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(Math.min(...coords)).toBe(2);
  });

  it("grows the grid for longer payloads", () => {
    const short = qrSvgPath("https://t.me/b?start=a");
    const long = qrSvgPath(`${LINK}${"x".repeat(200)}`);
    expect(long.size).toBeGreaterThan(short.size);
  });

  it("is deterministic for the same payload", () => {
    expect(qrSvgPath(LINK)).toEqual(qrSvgPath(LINK));
  });
});
