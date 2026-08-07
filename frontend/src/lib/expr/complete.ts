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
  CROSS_OPS,
  CROSSES,
  INDICATORS,
  LOGIC,
  PATTERNS,
  TIMEFRAMES,
  WRAPPERS,
  type CatalogEntry,
  type ExprInstance,
} from "./catalog";

/** Options for `completionsFor`. The live chart's panes are INJECTED here,
 * never imported: the pane's own settings are the source of truth, and
 * `catalog.ts` stays static and dependency-free. Same contract as
 * `analyze(src, { instances })` in parser.ts. */
export interface CompleteOptions {
  instances?: readonly ExprInstance[];
}

/** Chart-instance refs get their own section, ranked after the (unsectioned)
 * static catalog, and a negative boost so they also sort last within a rank. */
const CHART_SECTION = { name: "Chart indicators", rank: 2 };
const CHART_BOOST = -1;

// An instance id may contain "#" (mintInstanceId produces "SLOPE#a1b2c3"), so
// ref matching needs its own patterns — the plain word regex stops at the "#".
const REF_DOT_RE = /([A-Za-z_][A-Za-z0-9_#]*)\.([A-Za-z0-9_]*)$/;
const REF_WORD_RE = /([A-Za-z_][A-Za-z0-9_#]*)$/;

function refCompletion(inst: ExprInstance, output: string): Completion {
  return {
    label: `${inst.id}.${output}`,
    type: "property",
    // The pane's own summary ("SMA · % / hour"), plus its pin when it has one.
    // Was the constant "chart pane" on every row, which said nothing the
    // section header didn't; the label now carries the length, so the detail
    // spends itself on the settings the label can't show. Falls back to the
    // An injector that supplies no detail keeps the old "chart pane" wording,
    // so a future referenceable pane type degrades rather than showing blank.
    detail: [inst.detail ?? "chart pane", inst.timeframe && `@${inst.timeframe}`]
      .filter(Boolean).join(" "),
    section: CHART_SECTION,
    boost: CHART_BOOST,
  };
}

/** The instance whose id is exactly `base`, or undefined. */
function instanceById(
  instances: readonly ExprInstance[],
  base: string,
): ExprInstance | undefined {
  return instances.find((i) => i.id === base);
}

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
  ...CROSS_OPS.map((e): WordCandidate => ({
    label: e.name,
    type: "cross",
    detail: e.detail,
    insert: e.insert,
    // Select the placeholder operand ("EMA(50)") for overtype, like fn args:
    // the operand starts one space past the operator, whatever its length.
    argFrom: e.name.length + 1,
    argTo: e.insert.length,
  })),
  ...CROSSES.map((e) => fnCandidate(e, "cross")),
  ...CONDITIONS.map((e) => fnCandidate(e, "cross")),
  ...PATTERNS.map((e) => fnCandidate(e, "cross")),
  // The boolean keywords rank by prefix like any other word — no context
  // narrowing in v1. Their inserts carry no "(", so `fnCandidate` leaves
  // argFrom/argTo undefined and `applyFor` inserts the plain string.
  ...LOGIC.map((e) => fnCandidate(e, "logic")),
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
export function completionsFor(
  doc: string,
  pos: number,
  opts?: CompleteOptions,
): Completion[] {
  const before = doc.slice(0, pos);
  const instances = opts?.instances ?? [];

  // `<instance>.` -> that instance's outputs, and nothing else: a catalog name
  // can never follow a dot. Checked before `candle.` so a pane whose id ends in
  // "candle" still resolves to its own outputs.
  const refDot = REF_DOT_RE.exec(before);
  const dotted = refDot ? instanceById(instances, refDot[1]) : undefined;
  if (refDot && dotted) {
    const prefix = refDot[2].toLowerCase();
    return dotted.outputs
      .filter((o) => o.toLowerCase().startsWith(prefix))
      .map((o) => refCompletion(dotted, o));
  }

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

  // Chart instances match on the id (which may carry a "#", so use the wider
  // pattern), and every output of a matching pane is offered.
  const refWord = REF_WORD_RE.exec(before);
  const refPrefix = (refWord ? refWord[1] : "").toLowerCase();
  const refs = instances
    .filter((i) => i.id.toLowerCase().startsWith(refPrefix))
    .flatMap((i) => i.outputs.map((o) => refCompletion(i, o)));

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
  return [...ranked.map(({ cand, rank }) => toCompletion(cand, rank)), ...refs];
}

/**
 * Where a completion accepted at `pos` should start replacing, or `null` when
 * there is no token to complete.
 *
 * Kept in step with `completionsFor`'s context branches: a ref completion
 * carries the WHOLE `<instance>.<output>` as its label, so the anchor has to
 * cover the instance id (and its "#") too — anchoring at the plain word start
 * would splice the label into the middle of the id.
 */
export function completionAnchor(
  doc: string,
  pos: number,
  opts?: CompleteOptions,
): number | null {
  const before = doc.slice(0, pos);
  const instances = opts?.instances ?? [];

  const refDot = REF_DOT_RE.exec(before);
  if (refDot && instanceById(instances, refDot[1])) {
    return pos - refDot[0].length;
  }
  const fieldMatch = /candle\.([A-Za-z]*)$/.exec(before);
  if (fieldMatch) return pos - fieldMatch[1].length;
  const tfMatch = /@([A-Za-z0-9]*)$/.exec(before);
  if (tfMatch) return pos - tfMatch[1].length;
  const refWord = REF_WORD_RE.exec(before);
  if (refWord) return pos - refWord[1].length;
  return null;
}

/** CM6 completion source: anchors the result at the current word/token start. */
export function cmCompletionSource(
  context: CompletionContext,
  opts?: CompleteOptions,
): CompletionResult | null {
  const pos = context.pos;
  const doc = context.state.doc.toString();

  const anchor = completionAnchor(doc, pos, opts);
  if (anchor === null && !context.explicit) return null;
  const from = anchor ?? pos;

  const options = completionsFor(doc, pos, opts);
  if (options.length === 0) return null;
  return { from, to: pos, options, validFor: /[A-Za-z0-9_#.]*$/ };
}
