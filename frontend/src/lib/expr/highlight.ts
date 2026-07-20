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
import { CROSS_FNS, INDICATOR_SPECS, TIMEFRAMES, WRAPPER_ARITY } from "./catalog";

const TF_ALIASES = new Set(TIMEFRAMES.map((t) => t.alias));
const CROSS_SET = new Set<string>(CROSS_FNS);

const OPERATOR_TYPES = new Set([
  "GT", "LT", "GE", "LE", "PLUS", "MINUS", "STAR", "SLASH",
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
};

function classify(tok: Token, prev: Token | undefined, value: string): string | null {
  if (tok.type === "NUMBER") return "number";
  if (OPERATOR_TYPES.has(tok.type)) return "operator";
  if (tok.type !== "NAME") return null;
  if (prev?.type === "AT") return TF_ALIASES.has(value) ? "timeframe" : "variable";
  if (prev?.type === "DOT") return "field";
  if (value in INDICATOR_SPECS) return "indicator";
  if (value in WRAPPER_ARITY) return "wrapper";
  if (CROSS_SET.has(value)) return "cross";
  return "variable";
}

function buildHighlight(view: EditorView): DecorationSet {
  const doc = view.state.doc.toString();
  const { tokens } = analyze(doc);
  const builder = new RangeSetBuilder<Decoration>();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const value = doc.slice(tok.from, tok.to);
    const cls = classify(tok, tokens[i - 1], value);
    if (cls) builder.add(tok.from, tok.to, marks[cls]);
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
