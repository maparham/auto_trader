import { describe, it, expect } from "vitest";
import corpus from "./corpus.json";
import { analyze } from "./parser";

describe("parser parity corpus (frontend)", () => {
  for (const c of corpus as any[]) {
    it(`matches: ${c.expr}`, () => {
      const { literals, error } = analyze(c.expr, { isExit: c.isExit });
      if (c.error) {
        expect(error?.code).toBe(c.error.code);
        expect([error?.from, error?.to]).toEqual([c.error.from, c.error.to]);
      } else {
        expect(error).toBeNull();
        expect(literals.map((l) => [l.ordinal, l.value, l.from, l.to, l.label]))
          .toEqual(c.literals.map((l: any) => [l.ordinal, l.value, l.from, l.to, l.label]));
      }
    });
  }
});
