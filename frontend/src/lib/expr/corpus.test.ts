import { describe, it, expect } from "vitest";
import corpus from "./corpus.json";
import { analyze } from "./parser";
import { exprInstancesFor, type LiveInstance } from "../exprInstances";

/** A case's raw pane map, converted by the SAME function the editor uses. Both
 * stacks convert with their own real converter (Python: resolve_instances), so a
 * row also guards slopeOutputs vs slope_outputs agreement — an output one side
 * exposes and the other doesn't shows up as an error-code mismatch here. */
interface CorpusCase {
  expr: string;
  isExit: boolean;
  error: { code: string; from: number; to: number } | null;
  literals: Array<{ ordinal: number; value: number; from: number; to: number; label: string }>;
  /** Raw pane settings, present only on rows that reference an instance. */
  instances?: Record<string, Omit<LiveInstance, "id">>;
}

const CASES = corpus as CorpusCase[];

function instancesOf(raw: CorpusCase["instances"]) {
  if (!raw) return undefined;
  return exprInstancesFor(
    Object.entries(raw).map(([id, v]) => ({ ...v, id })),
  );
}

describe("parser parity corpus (frontend)", () => {
  for (const c of CASES) {
    it(`matches: ${c.expr}`, () => {
      const { literals, error } = analyze(c.expr, {
        isExit: c.isExit,
        instances: instancesOf(c.instances),
      });
      if (c.error) {
        expect(error?.code).toBe(c.error.code);
        expect([error?.from, error?.to]).toEqual([c.error.from, c.error.to]);
      } else {
        expect(error).toBeNull();
        expect(literals.map((l) => [l.ordinal, l.value, l.from, l.to, l.label]))
          .toEqual(c.literals.map((l) => [l.ordinal, l.value, l.from, l.to, l.label]));
      }
    });
  }

  it("covers indicator references, or the corpus stopped guarding them", () => {
    const withRefs = CASES.filter((c) => c.instances);
    expect(withRefs.length).toBeGreaterThanOrEqual(4);
    expect(withRefs.some((c) => c.expr.includes("#"))).toBe(true);
    expect(withRefs.some((c) => c.expr.includes("x>"))).toBe(true);
    expect(withRefs.some((c) => c.error)).toBe(true);
  });
});
