// Lint source for the rule expression editor. Maps the single advisory error
// from `analyze(doc, { isExit })` onto a CM6 `Diagnostic`. All message text
// comes straight from `analyze` (which mirrors the backend's plain-language
// wording), so this module adds no copy of its own.

import type { Diagnostic } from "@codemirror/lint";
import { linter, type LintSource } from "@codemirror/lint";
import { analyze } from "./parser";

/**
 * Diagnostics for `doc`. Pure so it can be unit-tested without mounting CM6.
 * An empty doc yields no diagnostics (nothing to complain about yet).
 */
export function diagnosticsFor(doc: string, isExit: boolean): Diagnostic[] {
  if (doc.trim() === "") return [];
  const { error } = analyze(doc, { isExit });
  if (!error) return [];
  // Clamp to the doc length; a zero-width span at EOF still needs from<to to
  // render, so widen it by one when the error points past the last char.
  const len = doc.length;
  let from = Math.max(0, Math.min(error.from, len));
  let to = Math.max(from, Math.min(error.to, len));
  if (from === to) {
    if (from > 0) from -= 1;
    else to = Math.min(len, to + 1);
  }
  return [{ from, to, severity: "error", message: error.message, source: error.code }];
}

/** CM6 linter extension whose validity depends on the current `isExit` flag. */
export function exprLinter(getIsExit: () => boolean) {
  const source: LintSource = (view) =>
    diagnosticsFor(view.state.doc.toString(), getIsExit());
  return linter(source, { delay: 150 });
}
