// Single-line CodeMirror 6 editor for a strategy rule expression.
//
// Wires together the expr-editor support modules: catalog-driven autocomplete,
// `analyze`-backed lint underlines, per-token highlighting, and a dotted
// underline on numeric literals (the sweepable knobs). The editor is forced to a
// single line by a transaction filter that rejects any change producing more
// than one line. On every doc change it emits the new expression via `onChange`
// and the current literal spans via `onLiteralsChange`.
//
// This component renders no tooltips of its own; all user-facing diagnostic text
// comes from `analyze` (plain language, no em dashes).

import { useEffect, useRef } from "react";
import { autocompletion } from "@codemirror/autocomplete";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { cmCompletionSource } from "../lib/expr/complete";
import { exprLinter } from "../lib/expr/lint";
import { literalUnderline } from "../lib/expr/literalDeco";
import { exprHighlight } from "../lib/expr/highlight";
import { analyze, type LiteralSpan } from "../lib/expr/parser";
import type { ExprInstance } from "../lib/expr/catalog";
import "./RuleExpressionInput.css";

export interface RuleExpressionInputProps {
  value: string;
  onChange: (expr: string) => void;
  /** Gates whether `entry` is valid, passed through to lint. */
  isExit: boolean;
  /** Emits the ordered numeric-literal spans (for the sweep panel). */
  onLiteralsChange?: (lits: LiteralSpan[]) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** The live chart's referenceable panes, for `<instance>.<output>` lint and
   * completion. INJECTED (never imported): the pane's own settings are the
   * source of truth, so the editor is told what exists right now. Omitted (Live
   * panel, tests) means "no panes", and any reference reads as unknown. */
  instances?: readonly ExprInstance[];
}

// Reject any transaction whose result spans more than one line: this keeps the
// editor single-line (blocks Enter and pasted newlines) without swallowing the
// rest of a paste.
const singleLine = EditorState.transactionFilter.of((tr) =>
  tr.newDoc.lines > 1 ? [] : tr,
);

export default function RuleExpressionInput(props: RuleExpressionInputProps) {
  const {
    value, onChange, isExit, onLiteralsChange, readOnly = false, placeholder, instances,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Keep the latest callbacks / flags reachable from CM6 extensions without
  // rebuilding the editor on every render.
  const onChangeRef = useRef(onChange);
  const onLiteralsChangeRef = useRef(onLiteralsChange);
  const isExitRef = useRef(isExit);
  const instancesRef = useRef(instances);
  onChangeRef.current = onChange;
  onLiteralsChangeRef.current = onLiteralsChange;
  isExitRef.current = isExit;
  // Unlike the three above (kept as the file's existing render-time assignment),
  // this one is written in an effect: the lint/completion closures that read it
  // only ever run after commit, and the reconfigure effect below is declared
  // after this one, so it always sees the new list.
  useEffect(() => {
    instancesRef.current = instances;
  }, [instances]);

  // Identity of the pane list as the editor cares about it (ids + outputs +
  // pinned timeframe). The parent rebuilds the array on every chart poll, so
  // depending on the array itself would reconfigure the linter constantly.
  const instKey = (instances ?? [])
    .map((i) => `${i.id}:${i.outputs.join(",")}:${i.timeframe ?? ""}`)
    .join("|");

  const readOnlyComp = useRef(new Compartment());
  const linterComp = useRef(new Compartment());

  // Build the editor once.
  useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const doc = update.state.doc.toString();
      onChangeRef.current(doc);
      onLiteralsChangeRef.current?.(analyze(doc, { instances: instancesRef.current }).literals);
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        singleLine,
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
        ]),
        exprHighlight,
        literalUnderline,
        updateListener,
        // cmCompletionSource takes its options as a SECOND argument, which CM6
        // never passes — so wrap it in a closure over the live pane list rather
        // than registering it bare, or chart panes are never offered.
        autocompletion({
          override: [(ctx) => cmCompletionSource(ctx, { instances: instancesRef.current })],
          activateOnTyping: true,
        }),
        linterComp.current.of(
          exprLinter(() => isExitRef.current, () => instancesRef.current),
        ),
        readOnlyComp.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        EditorView.contentAttributes.of({
          role: "textbox",
          "aria-label": "Rule expression",
          "aria-multiline": "false",
        }),
        placeholder ? cmPlaceholder(placeholder) : [],
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally build once; prop syncs happen in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync the `value` prop into the editor when it diverges from the doc (e.g. a
  // reset from a parent). Skips echoes of the user's own edits.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // Reconfigure lint when `isExit` flips or the chart's pane list changes (the
  // linter closure reads the refs, but reconfiguring forces an immediate re-lint
  // rather than leaving stale underlines until the next keystroke — adding or
  // retuning a pane changes which references are valid).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: linterComp.current.reconfigure(
        exprLinter(() => isExitRef.current, () => instancesRef.current),
      ),
    });
  }, [isExit, instKey]);

  // Reconfigure read-only state on prop change.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyComp.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return (
    <div
      ref={hostRef}
      className={`rule-expr-input${readOnly ? " is-readonly" : ""}`}
    />
  );
}
