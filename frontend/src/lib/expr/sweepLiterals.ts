// Literal-axis sweep target builders and utility functions. Maps expression
// literals to sweep axes and handles range re-anchoring when expressions edit.

import { analyze } from "./parser";
import type { LiteralSpan } from "./parser";

/** Builds a `lit:` sweep-axis target for an expression's numeric literal.
 * The target encodes the rule side (long/short), group (entry/exit), rule
 * index (rowIdx, counting enabled rules only), and literal ordinal (position
 * in the expression's sorted literals list). Must match the backend's `lit:`
 * grammar added in Task 13.
 *
 * Example: sweepLiteralTarget("long", "entry", 0, 2) => "lit:long.entry.0.2"
 */
export function sweepLiteralTarget(
  side: "long" | "short",
  group: "entry" | "exit",
  rowIdx: number,
  ordinal: number,
): string {
  return `lit:${side}.${group}.${rowIdx}.${ordinal}`;
}

/** Returns the context label for a literal within an expression.
 * Reuses the label logic from analyze() (which mirrors the backend's
 * literal-extraction algorithm). Returns an empty string if the expression
 * cannot be parsed or the ordinal is out of range.
 *
 * Examples:
 *   literalLabel("EMA(50) > 30", 0) => "EMA length"
 *   literalLabel("EMA(50) > 30", 1) => "threshold"
 */
export function literalLabel(expr: string, ordinal: number): string {
  const result = analyze(expr);
  if (result.error || ordinal < 0 || ordinal >= result.literals.length) {
    return "";
  }
  return result.literals[ordinal].label;
}

/** Re-anchors ranges after an expression edit: returns ranges whose ordinals
 * still exist, and lists ordinals that vanished. Ordinals are stable and
 * sorted (added in order by the parser), so any ordinal that existed before
 * but not after is dropped entirely.
 *
 * Returns { kept, dropped } where:
 *   - kept: subset of ranges (same keys) whose ordinals are in nextLiterals
 *   - dropped: list of range-key strings ("lit:side.group.rowIdx.ordinal")
 *     that were in ranges but whose ordinals no longer exist
 *
 * When ordinals drop, the panel shows: "Removed sweep ranges no longer match this rule."
 */
export function reanchorRanges(
  _prevLiterals: LiteralSpan[],
  nextLiterals: LiteralSpan[],
  ranges: Record<string, any>,
  side: "long" | "short",
  group: "entry" | "exit",
  rowIdx: number,
): { kept: Record<string, any>; dropped: string[] } {
  // Build a set of ordinals that exist in nextLiterals for fast lookup
  const nextOrdinals = new Set(nextLiterals.map((lit) => lit.ordinal));

  // Build the prefix for this row to identify which keys belong to it
  const rowPrefix = `lit:${side}.${group}.${rowIdx}.`;

  const kept: Record<string, any> = {};
  const dropped: string[] = [];

  // Iterate through the current ranges
  for (const [key, value] of Object.entries(ranges)) {
    // If the key doesn't belong to this row, pass it through unchanged
    if (!key.startsWith(rowPrefix)) {
      kept[key] = value;
      continue;
    }

    // Extract ordinal from the key (format: lit:side.group.rowIdx.ordinal)
    const match = key.match(/^lit:[^.]+\.[^.]+\.\d+\.(\d+)$/);
    if (!match) {
      // If the key doesn't match the expected format, keep it as-is
      kept[key] = value;
      continue;
    }

    const ordinal = parseInt(match[1], 10);
    if (nextOrdinals.has(ordinal)) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }

  return { kept, dropped };
}
