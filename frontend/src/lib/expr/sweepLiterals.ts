// Literal-axis sweep target builders and utility functions. Maps expression
// literals to sweep axes and handles range re-anchoring when expressions edit.

import { analyze } from "./parser";
import type { LiteralSpan } from "./parser";
import type { SweepAxis } from "../sweep";

/** Builds a `lit:` sweep-axis target for an expression's numeric literal.
 * The target encodes the rule side (long/short), group (entry/exit), rule
 * index (rowIdx, the FULL-list row index counting disabled rows too, since the
 * expression request ships every row and the backend addresses rows by full
 * index), and literal ordinal (position in the expression's sorted literals
 * list). Must match the backend's `lit:` grammar.
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

/** Results-panel label for a `lit:` axis: the rule's expression with the swept
 * literal replaced by "x" — "SLOPE.14>x" says what the axis varies where the
 * literal's bare context label ("threshold") or the raw target path doesn't.
 * Same semantic-error tolerance as patchExprLiterals below (a bare analyze()
 * has no chart-indicator context, but literal spans survive semantic errors);
 * "" when the expression doesn't lex/parse or the ordinal no longer exists. */
export function literalAxisLabel(expr: string, ordinal: number): string {
  const { literals } = analyze(expr);
  const lit = literals.find((l) => l.ordinal === ordinal);
  if (!lit) return "";
  return expr.slice(0, lit.from) + "x" + expr.slice(lit.to);
}

/** Rewrites an expression's numeric literals in place: each patch addresses a
 * literal by ordinal (the `lit:` target's last segment) and substitutes the
 * swept value at that literal's source span. Splices run right-to-left so
 * earlier spans stay valid. An unparseable expression, or an ordinal that no
 * longer exists (rule edited since the sweep ran), is left untouched — same
 * tolerance as pruneLitAxes.
 *
 * `analyze`'s error is deliberately NOT checked: a bare analyze() has no
 * chart-indicator context, so a valid rule like "SLOPE.14>0.1" reports
 * unknown_indicator_ref — a SEMANTIC error whose literal spans are still
 * extracted and correct. Lex/parse failures return empty literals, so the
 * ordinal lookup already no-ops those.
 *
 * Values print like sweep.ts's fmtAxisValue (duplicated here because sweep.ts
 * imports this module — importing back would be a cycle): float-noise
 * near-zeros flush to 0, 12 significant digits otherwise — EXCEPT that
 * exponent notation is expanded to plain decimal, because the expression
 * lexer has no exponent syntax ("5e-7" would lex as an unknown name). */
// Token types that END a value: a "-" right after one of these is binary
// subtraction, after anything else (operator, comparison, "(", ",", start of
// the row) it's a unary minus on the literal that follows. "[" is excluded
// from unary treatment separately: the "-" in an offset "[-2]" is offset
// syntax, not a negation the backend's substitute() would preserve.
const VALUE_END_TOKENS: ReadonlySet<string> = new Set(["NUMBER", "NAME", "RPAREN", "RBRACKET"]);

// "1e+21" / "5e-7" → plain decimal digits (the lexer can't read exponents).
function expandExponent(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign, int, frac = "", expStr] = m;
  const digits = int + frac;
  const point = int.length + Number(expStr);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function patchExprLiterals(
  expr: string,
  patches: { ordinal: number; value: number }[],
): string {
  const { literals, tokens, error: baseError } = analyze(expr);
  const fmt = (v: number) =>
    expandExponent(String(Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(12))));
  let out = expr;
  const spans = patches
    .map((p) => ({ lit: literals.find((l) => l.ordinal === p.ordinal), value: p.value }))
    .filter((p): p is { lit: LiteralSpan; value: number } => p.lit !== undefined)
    .sort((a, b) => b.lit.from - a.lit.from);
  for (const { lit, value } of spans) {
    // The span must be a real NUMBER token: a bar-offset literal's span is
    // SYNTHESIZED from the Offset node's end (parser literalsOf), and with
    // whitespace inside the brackets ("[ -2 ]") it points at the wrong
    // characters — splicing there would corrupt the expression mid-token.
    const litIdx = tokens.findIndex(
      (t) => t.from === lit.from && t.to === lit.to && t.type === "NUMBER",
    );
    if (litIdx < 0) continue;
    // A literal under a unary minus keeps that minus at run time (the backend's
    // substitute() replaces only the Num node under the Unary), so a negative
    // value would naively splice to "--0.8". Fold instead: replace the minus
    // AND the literal with the positive magnitude, so -(-1) reads as the "1"
    // it evaluates to. Binary subtraction ("a - 0.4") must NOT fold — there the
    // negative value parenthesizes ("a - (-0.8)"). Neither does an offset's
    // bracket minus ("[-2]"): it's syntax, and a negative offset value has no
    // valid text form, so that splice fails the re-parse check below instead.
    const prev = litIdx > 0 ? tokens[litIdx - 1] : undefined;
    const prev2 = litIdx > 1 ? tokens[litIdx - 2] : undefined;
    const underUnaryMinus =
      prev?.type === "MINUS" &&
      (!prev2 || (!VALUE_END_TOKENS.has(prev2.type) && prev2.type !== "LBRACKET"));
    let next: string;
    if (value < 0 && underUnaryMinus) {
      next = out.slice(0, prev.from) + fmt(-value) + out.slice(lit.to);
    } else {
      let text = fmt(value);
      if (value < 0 && out.slice(0, lit.from).trimEnd().endsWith("-")) text = `(${text})`;
      next = out.slice(0, lit.from) + text + out.slice(lit.to);
    }
    // Never write a patch that makes the expression WORSE than it started:
    // accept the splice only if it analyzes clean or with the same error code
    // the original already had (e.g. unknown_indicator_ref on chart-registered
    // series). Anything else — like a negative bar offset, which has no valid
    // text form — reverts to a per-patch no-op.
    const nextError = analyze(next).error;
    if (nextError === null || nextError.code === baseError?.code) out = next;
  }
  return out;
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

/** Drop every `lit:` axis whose addressed literal no longer exists (row removed,
 *  or the expression edited so that ordinal is gone). Non-`lit:` axes pass through
 *  untouched. `groups` maps each (side, group) to its CURRENT expression row strings
 *  (full list, disabled included), so ordinals are checked against a fresh analyze. */
export function pruneLitAxes(
  axes: SweepAxis[],
  groups: { side: "long" | "short"; group: "entry" | "exit"; exprs: string[] }[],
): SweepAxis[] {
  const liveCount = new Map<string, number>(); // key `${side}.${group}.${rowIdx}` -> literal count
  for (const g of groups) {
    g.exprs.forEach((expr, rowIdx) => {
      liveCount.set(`${g.side}.${g.group}.${rowIdx}`, analyze(expr).literals.length);
    });
  }
  return axes.filter((a) => {
    const m = /^lit:(long|short)\.(entry|exit)\.(\d+)\.(\d+)$/.exec(a.target);
    if (!m) return true; // not a lit axis: keep
    const [, side, group, rowIdx, ordinal] = m;
    const n = liveCount.get(`${side}.${group}.${rowIdx}`) ?? 0;
    return Number(ordinal) < n; // keep only if that ordinal still exists
  });
}
