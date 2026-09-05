// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import DrawGlyph from "./DrawIcons";

afterEach(cleanup);

const glyph = (name: string) => render(<DrawGlyph name={name} />).container.innerHTML;

describe("Trade box glyph", () => {
  it("draws the trade tool its own picture, not the trend-line fallback", () => {
    expect(glyph("tradeBox")).not.toBe(glyph("no-such-tool"));
  });

  it("shows both sides of the trade, since one tool draws longs and shorts", () => {
    const g = glyph("tradeBox");
    expect(g).toContain("#26a69a"); // reward
    expect(g).toContain("#ef5350"); // risk
  });
});
