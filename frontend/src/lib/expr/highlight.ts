// Syntax highlighting for the rule expression editor.
//
// The brief sketches a Lezer grammar, but wiring `@lezer/generator` into the
// Vite build is heavy and buys nothing the tests need. Instead we highlight from
// the advisory tokenizer directly: `analyze(doc).tokens` already gives token
// spans, and we classify each `NAME` by its neighbours (a `@`/`.` before it) and
// the catalog. That keeps highlighting in lockstep with the same analyzer that
// drives lint and the literal underline, with no grammar-compilation step.

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { analyze, type Token } from "./parser";
import { CROSS_FNS, INDICATOR_SPECS, TIMEFRAMES, WRAPPER_ARITY, PREDICATE_FNS, COUNT_FN } from "./catalog";

const TF_ALIASES = new Set(TIMEFRAMES.map((t) => t.alias));
const CROSS_SET = new Set<string>(CROSS_FNS);
const PREDICATE_SET = new Set<string>(PREDICATE_FNS);

// Names the parser gives their own node kind before the IndicatorRef rule can
// fire, so `candle.close` is never a ref. (`entry`/`barsSinceEntry` take no
// field at all, but they are listed for the same reason: they are known names.)
const BUILTIN_VALUES = new Set(["candle", "entry", "barsSinceEntry"]);

const OPERATOR_TYPES = new Set([
  "GT", "LT", "GE", "LE", "EQ", "PLUS", "MINUS", "STAR", "SLASH",
]);

const marks: Record<string, Decoration> = {
  indicator: Decoration.mark({ class: "cm-tok-indicator" }),
  wrapper: Decoration.mark({ class: "cm-tok-wrapper" }),
  cross: Decoration.mark({ class: "cm-tok-cross" }),
  field: Decoration.mark({ class: "cm-tok-field" }),
  number: Decoration.mark({ class: "cm-tok-number" }),
  operator: Decoration.mark({ class: "cm-tok-operator" }),
  timeframe: Decoration.mark({ class: "cm-tok-timeframe" }),
  variable: Decoration.mark({ class: "cm-tok-variable" }),
  logic: Decoration.mark({ class: "cm-tok-logic" }),
  instanceRef: Decoration.mark({ class: "cm-tok-instance-ref" }),
};

// The boolean keywords. The lexer specializes `and`/`or`/`not` — lowercase or
// ALL-uppercase — into their own token types, so they never reach the NAME
// branch below; without this set they classify as null and paint as plain text.
// Keyed off the TOKEN TYPE, which is the same for both spellings, so the
// highlighter never has to care which one the user typed.
const LOGIC_TYPES = new Set(["AND", "OR", "NOT"]);

/** True when `value`, followed by `next`, is a chart-instance reference —
 * `SLOPE#a1b2c3` in `SLOPE#a1b2c3.9`.
 *
 * This is the token-level twin of the parser's IndicatorRef rule
 * (parser.ts::parsePostfix): an unregistered bare name carrying a field. The
 * two condition lists mirror each other on purpose — if they drift, a ref is
 * highlighted as an unknown variable (or vice versa) even though the analyzer
 * accepts it. Keep them in step. `next.type === "DOT"` stands in for the
 * parser's `args.length === 0`: a NAME followed by `.` is never a call.
 *
 * Deliberately does NOT consult the live instance list: highlighting is
 * syntactic, and an unknown-instance ref is reported by lint, not by colour. */
function isInstanceRef(value: string, next: Token | undefined): boolean {
  return (
    next?.type === "DOT"
    && !Object.hasOwn(INDICATOR_SPECS, value)
    && !Object.hasOwn(WRAPPER_ARITY, value)
    && !CROSS_SET.has(value)
    && !PREDICATE_SET.has(value)
    && value !== COUNT_FN
    && !BUILTIN_VALUES.has(value)
  );
}

function classify(
  tok: Token,
  prev: Token | undefined,
  next: Token | undefined,
  value: string,
): string | null {
  // A chart pane's outputs are named by its MA lengths (SLOPE.9), so a NUMBER
  // straight after a "." is a field name, not a numeric literal. Narrowed to
  // NUMBER rather than hoisting the whole `prev is DOT` test above the type
  // checks: mid-typing, a "." can be followed by an operator, and that must
  // still paint as an operator.
  if (tok.type === "NUMBER") return prev?.type === "DOT" ? "field" : "number";
  if (tok.type === "XGT" || tok.type === "XLT") return "cross";
  if (OPERATOR_TYPES.has(tok.type)) return "operator";
  if (LOGIC_TYPES.has(tok.type)) return "logic";
  if (tok.type !== "NAME") return null;
  if (prev?.type === "AT") return TF_ALIASES.has(value) ? "timeframe" : "variable";
  if (prev?.type === "DOT") return "field";
  // Object.hasOwn (not `in`) so inherited Object.prototype members — a token
  // literally named `toString` or `constructor` — never count as registered.
  if (Object.hasOwn(INDICATOR_SPECS, value)) return "indicator";
  if (Object.hasOwn(WRAPPER_ARITY, value)) return "wrapper";
  if (CROSS_SET.has(value)) return "cross";
  if (value === COUNT_FN) return "wrapper";
  if (PREDICATE_SET.has(value)) return "cross";
  if (isInstanceRef(value, next)) return "instanceRef";
  return "variable";
}

export interface ClassifiedToken {
  from: number;
  to: number;
  cls: string;
}

/** Every classified token in `doc`, in document order. Pure (no CodeMirror
 * involved), so highlighting is unit-testable on its own. */
export function classifyTokens(doc: string): ClassifiedToken[] {
  const { tokens } = analyze(doc);
  const out: ClassifiedToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const cls = classify(tok, tokens[i - 1], tokens[i + 1], doc.slice(tok.from, tok.to));
    if (cls) out.push({ from: tok.from, to: tok.to, cls });
  }
  return out;
}

function buildHighlight(view: EditorView): DecorationSet {
  const doc = view.state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  for (const tok of classifyTokens(doc)) {
    builder.add(tok.from, tok.to, marks[tok.cls]);
  }
  return builder.finish();
}

export const exprHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHighlight(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildHighlight(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
