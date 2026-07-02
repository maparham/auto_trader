import { describe, expect, it } from "vitest";
import { isInvertShortcut } from "./invertShortcut";

const ev = (over: Partial<Parameters<typeof isInvertShortcut>[0]> = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: "KeyI",
  ...over,
});

describe("isInvertShortcut", () => {
  it("matches plain Alt/Option + I by physical key code", () => {
    expect(isInvertShortcut(ev())).toBe(true);
  });
  it("matches on code so the macOS dead-key (key='Dead') still works", () => {
    // e.key is irrelevant by design — the predicate never reads it.
    expect(isInvertShortcut(ev({ code: "KeyI" }))).toBe(true);
  });
  it("rejects other keys", () => {
    expect(isInvertShortcut(ev({ code: "KeyL" }))).toBe(false);
  });
  it("rejects when Alt is not held", () => {
    expect(isInvertShortcut(ev({ altKey: false }))).toBe(false);
  });
  it("rejects extra modifiers (Ctrl / Cmd / Shift chords are other shortcuts)", () => {
    expect(isInvertShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isInvertShortcut(ev({ metaKey: true }))).toBe(false);
    expect(isInvertShortcut(ev({ shiftKey: true }))).toBe(false);
  });
});
