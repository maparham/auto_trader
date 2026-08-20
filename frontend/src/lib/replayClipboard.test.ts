import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { armMaskedReplay, maskedReplaySignal } from "./maskedReplay";

const toasts: string[] = [];
vi.mock("./notify", () => ({ toast: (m: string) => void toasts.push(m) }));

const { refuseClipboardCopy } = await import("./replayClipboard");

const arm = (cellId: string) =>
  maskedReplaySignal.set(
    armMaskedReplay(maskedReplaySignal.value, {
      cellId,
      startMs: Date.UTC(2026, 6, 10, 9, 30),
      clock: "24h",
      timezone: "UTC",
    }),
  );

beforeEach(() => {
  toasts.length = 0;
  maskedReplaySignal.set({});
});

describe("refuseClipboardCopy", () => {
  it("lets a copy through when nothing is masked", () => {
    expect(refuseClipboardCopy("cell-a")).toBe(false);
    expect(toasts).toEqual([]);
  });

  it("refuses, and says why, while this cell is masked", () => {
    arm("cell-a");
    expect(refuseClipboardCopy("cell-a")).toBe(true);
    expect(toasts.at(-1)).toMatch(/replay/i);
  });

  // Per-cell: a session on a sibling is no reason to stop copying from a live
  // chart, and the any-cell read would have withdrawn the command everywhere.
  it("ignores a masked session on another cell", () => {
    arm("cell-elsewhere");
    expect(refuseClipboardCopy("cell-a")).toBe(false);
  });

  it("uses no em dash (house style for user copy)", () => {
    arm("cell-a");
    refuseClipboardCopy("cell-a");
    expect(toasts.at(-1)).not.toMatch(/—/);
  });
});

// The defect this module exists for was not a missing check, it was a missing
// check in ONE OF TWO places: the drawing envelope is written both by ChartCore's
// Ctrl/Cmd+C and by the Toolbar's right-click menu, documented as
// interchangeable, and only the first was gated. A unit test of the gate cannot
// see that. This can: every file that writes a tagged clipboard envelope must
// also import the gate.
describe("every clipboard-envelope writer is gated", () => {
  const SRC = new URL("..", import.meta.url).pathname;
  const ENVELOPE = /__autoTrader(Drawing|Indicator)\b/;

  // Import lines stripped first: the identifier appearing in an import proves
  // nothing (the first version of this scan passed against a Toolbar whose CALL
  // had been deleted but whose import remained). What is asserted is a call.
  const bodyOf = (text: string) =>
    text
      .split("\n")
      .filter((line) => !/^\s*import\b/.test(line))
      .join("\n");

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });

  it("has no ungated writer", () => {
    const ungated = walk(SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      const body = bodyOf(text);
      if (!body.includes("clipboard?.writeText")) return false;
      if (!ENVELOPE.test(body)) return false;
      return !body.includes("refuseClipboardCopy(");
    });
    expect(ungated.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  // ...and the scan is only worth anything if it can actually see the writers.
  it("finds the writers it is meant to be guarding", () => {
    const writers = walk(SRC).filter((file) => {
      const body = bodyOf(readFileSync(file, "utf8"));
      return body.includes("clipboard?.writeText") && ENVELOPE.test(body);
    });
    expect(writers.length).toBeGreaterThanOrEqual(2);
  });
});
