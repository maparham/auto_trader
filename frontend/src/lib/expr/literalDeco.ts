// Subtle dotted underline on every numeric-literal span in the expression, so a
// user can see at a glance which numbers become sweepable knobs. Spans come from
// `analyze(doc).literals` (the same source the sweep panel reads), keeping the
// underline and the knob list in lockstep.

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { analyze } from "./parser";

const literalMark = Decoration.mark({ class: "cm-sweep-literal" });

function buildLiteralDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc.toString();
  const { literals } = analyze(doc);
  const len = doc.length;
  const builder = new RangeSetBuilder<Decoration>();
  for (const lit of literals) {
    const from = Math.max(0, Math.min(lit.from, len));
    const to = Math.max(from, Math.min(lit.to, len));
    if (to > from) builder.add(from, to, literalMark);
  }
  return builder.finish();
}

export const literalUnderline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLiteralDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildLiteralDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
