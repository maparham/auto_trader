// Autocomplete source for the rule expression editor. `completionsFor(doc, pos)`
// is a pure function (unit-tested) that inspects the text just before the cursor
// and returns the ranked completion set for that context:
//   `candle.`  -> candle fields
//   trailing `@` -> timeframes
//   bare word  -> indicators / wrappers / crosses / entry / candle, prefix-ranked
// `cmCompletionSource` wraps it into the shape `@codemirror/autocomplete` wants
// (a `from`/`options` result anchored at the cursor), and gives indicators an
// `apply` that inserts e.g. `EMA(9)` with the first argument selected for overtype.

import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  CANDLE_FIELDS,
  CONDITIONS,
  CROSSES,
  INDICATORS,
  TIMEFRAMES,
  WRAPPERS,
  type CatalogEntry,
} from "./catalog";

// A "value word" that can start an expression fragment. Keeps `candle` and
// `entry` alongside the catalog functions so a bare prefix offers all of them.
interface WordCandidate {
  label: string;
  type: string;
  detail?: string;
  insert: string;
  /** Position of the first argument inside `insert`, if any (for overtype). */
  argFrom?: number;
  argTo?: number;
}

function fnCandidate(entry: CatalogEntry, type: string): WordCandidate {
  // Select the first argument of the inserted signature (the digits inside the
  // first parens), so accepting `EMA` lands the cursor over `9` ready to type.
  const open = entry.insert.indexOf("(");
  let argFrom: number | undefined;
  let argTo: number | undefined;
  if (open !== -1) {
    argFrom = open + 1;
    // Depth-aware scan so nested parens (e.g. slope(EMA(9), 3)) don't cut the
    // first argument short: stop at the first top-level comma or closing paren.
    let depth = 0;
    let j = argFrom;
    for (; j < entry.insert.length; j += 1) {
      const ch = entry.insert[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === "," && depth === 0) break;
    }
    argTo = j;
  }
  return { label: entry.name, type, detail: entry.detail, insert: entry.insert, argFrom, argTo };
}

const WORD_CANDIDATES: WordCandidate[] = [
  ...INDICATORS.map((e) => fnCandidate(e, "indicator")),
  ...WRAPPERS.map((e) => fnCandidate(e, "wrapper")),
  ...CROSSES.map((e) => fnCandidate(e, "cross")),
  ...CONDITIONS.map((e) => fnCandidate(e, "cross")),
  { label: "candle", type: "variable", detail: "Current bar", insert: "candle." },
  { label: "entry", type: "variable", detail: "Entry price (exit rules only)", insert: "entry" },
];

function applyFor(cand: WordCandidate): Completion["apply"] {
  if (cand.argFrom === undefined || cand.argTo === undefined) {
    return cand.insert;
  }
  const insert = cand.insert;
  const selFrom = cand.argFrom;
  const selTo = cand.argTo;
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + selFrom, head: from + selTo },
    });
  };
}

function toCompletion(cand: WordCandidate, boost: number): Completion {
  return {
    label: cand.label,
    type: cand.type,
    detail: cand.detail,
    apply: applyFor(cand),
    boost,
  };
}

/**
 * Completions for the cursor context in `doc` at offset `pos`. Pure and
 * order-significant: the first element is the best-ranked candidate.
 */
export function completionsFor(doc: string, pos: number): Completion[] {
  const before = doc.slice(0, pos);

  // `candle.` -> fields. Match `candle` optionally followed by a partial field.
  const fieldMatch = /candle\.([A-Za-z]*)$/.exec(before);
  if (fieldMatch) {
    const prefix = fieldMatch[1].toLowerCase();
    return CANDLE_FIELDS.filter((f) => f.toLowerCase().startsWith(prefix)).map((f) => ({
      label: f,
      type: "property",
    }));
  }

  // Trailing `@` (optionally with a partial alias) -> timeframes.
  const tfMatch = /@([A-Za-z0-9]*)$/.exec(before);
  if (tfMatch) {
    const prefix = tfMatch[1].toLowerCase();
    return TIMEFRAMES.filter((t) => t.alias.toLowerCase().startsWith(prefix)).map((t) => ({
      label: t.alias,
      type: "keyword",
      detail: t.resolution,
    }));
  }

  // Bare word: rank catalog names by how well they match the current prefix.
  const wordMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  const prefix = wordMatch ? wordMatch[1] : "";
  const lower = prefix.toLowerCase();

  const ranked = WORD_CANDIDATES
    .map((cand) => {
      let rank: number;
      if (prefix === "") rank = 1;
      else if (cand.label.startsWith(prefix)) rank = 3; // case-sensitive prefix
      else if (cand.label.toLowerCase().startsWith(lower)) rank = 2; // case-insensitive prefix
      else if (cand.label.toLowerCase().includes(lower)) rank = 0; // substring
      else rank = -1; // no match
      return { cand, rank };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => (b.rank - a.rank) || a.cand.label.localeCompare(b.cand.label));

  // Boost mirrors rank so CM6's own ordering agrees with the returned order.
  return ranked.map(({ cand, rank }) => toCompletion(cand, rank));
}

/** CM6 completion source: anchors the result at the current word/token start. */
export function cmCompletionSource(context: CompletionContext): CompletionResult | null {
  const pos = context.pos;
  const doc = context.state.doc.toString();
  const before = doc.slice(0, pos);

  let from = pos;
  const fieldMatch = /candle\.([A-Za-z]*)$/.exec(before);
  const tfMatch = /@([A-Za-z0-9]*)$/.exec(before);
  const wordMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  if (fieldMatch) {
    from = pos - fieldMatch[1].length;
  } else if (tfMatch) {
    from = pos - tfMatch[1].length;
  } else if (wordMatch) {
    from = pos - wordMatch[1].length;
  } else if (!context.explicit) {
    return null;
  }

  const options = completionsFor(doc, pos);
  if (options.length === 0) return null;
  return { from, to: pos, options, validFor: /[A-Za-z0-9_.]*$/ };
}
