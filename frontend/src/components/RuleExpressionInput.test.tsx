// @vitest-environment jsdom
//
// Test-harness adaptations (see task-10 report):
//   1. This suite needs a DOM. The repo's vitest defaults to the `node`
//      environment; `.tsx` suites opt into jsdom via the directive above (same
//      pattern as the other component tests, e.g. NumberField.test.tsx).
//   2. CodeMirror edits a contenteditable that jsdom does not actually mutate,
//      so `userEvent.type` into it is a no-op under jsdom (and CM6's lint message
//      lives in a hover tooltip, not the content DOM, so `findByText` can't see
//      it). We therefore drive text in through the mounted `EditorView`
//      (`view.dispatch(...)`) which still exercises the real wiring
//      (transactionFilter -> updateListener -> onChange), and we assert the lint
//      diagnostic against the pure lint source `diagnosticsFor`, which is what
//      the linter renders. The assertions (onChange full string; message
//      mentions the unknown name) are unchanged from the brief.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import RuleExpressionInput from "./RuleExpressionInput";
import { diagnosticsFor } from "../lib/expr/lint";
import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import type { ExprInstance } from "../lib/expr/catalog";

afterEach(cleanup);

describe("RuleExpressionInput", () => {
  it("emits changes when the document is edited", () => {
    const onChange = vi.fn();
    const onLiteralsChange = vi.fn();
    const { container } = render(
      <RuleExpressionInput
        value=""
        onChange={onChange}
        isExit={false}
        onLiteralsChange={onLiteralsChange}
      />,
    );

    const editorEl = container.querySelector(".cm-editor") as HTMLElement;
    expect(editorEl).toBeTruthy();
    const view = EditorView.findFromDOM(editorEl);
    expect(view).toBeTruthy();

    view!.dispatch({ changes: { from: 0, insert: "FOO(9) > 0" } });

    expect(onChange).toHaveBeenLastCalledWith("FOO(9) > 0");
    // Literals emitted alongside the change. FOO is unknown so its arg isn't a
    // recognized knob; only the right-hand threshold 0 is collected.
    const lastLits = onLiteralsChange.mock.calls.at(-1)?.[0];
    expect(lastLits?.map((l: { value: number }) => l.value)).toEqual([0]);
  });

  it("renders a single-line, textbox-role editor and blocks newlines", () => {
    const onChange = vi.fn();
    const { container } = render(
      <RuleExpressionInput value="EMA(9) > 0" onChange={onChange} isExit={false} />,
    );
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("role")).toBe("textbox");

    const editorEl = container.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(editorEl)!;
    // A change that would introduce a newline is rejected by the transaction
    // filter, leaving the doc single-line.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nSMA(20) > 0" } });
    expect(view.state.doc.lines).toBe(1);
  });

  it("renders token highlight and literal-underline decorations", () => {
    const onChange = vi.fn();
    const { container } = render(
      <RuleExpressionInput value="EMA(9) > 0" onChange={onChange} isExit={false} />,
    );
    // Indicator token highlighted, and both numeric literals underlined.
    expect(container.querySelector(".cm-tok-indicator")?.textContent).toBe("EMA");
    const lits = Array.from(container.querySelectorAll(".cm-sweep-literal")).map(
      (el) => el.textContent,
    );
    expect(lits).toEqual(["9", "0"]);
  });

  it("lints an unknown indicator name via the lint source", () => {
    const diags = diagnosticsFor("FOO(9) > 0", false);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toMatch(/Unknown name/i);
  });
  // --- live chart instances injected into the editor -------------------------
  const SLOPE_PANE: ExprInstance[] = [
    { id: "SLOPE", outputs: ["9", "accel9"], timeframe: null },
  ];

  it("lints an instance reference against the INJECTED chart panes", () => {
    // With no panes injected the same text is an unknown reference — which is
    // exactly the false underline the injection exists to remove.
    const blind = diagnosticsFor("SLOPE.9 > 0", false);
    expect(blind).toHaveLength(1);
    expect(blind[0].source).toBe("unknown_indicator_ref");
    expect(diagnosticsFor("SLOPE.9 > 0", false, SLOPE_PANE)).toEqual([]);
    // An output the pane does not expose still errors.
    const bad = diagnosticsFor("SLOPE.13 > 0", false, SLOPE_PANE);
    expect(bad).toHaveLength(1);
    expect(bad[0].source).toBe("unknown_indicator_output");
  });

  it("does not underline a valid pane reference in the mounted editor", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RuleExpressionInput
        value="SLOPE.9 > 0"
        onChange={onChange}
        isExit={false}
        instances={SLOPE_PANE}
      />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    forceLinting(view);
    await new Promise((r) => setTimeout(r, 0));
    expect(diagnosticCount(view.state)).toBe(0);
  });

  it("re-lints when the chart's pane list changes", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <RuleExpressionInput value="SLOPE.9 > 0" onChange={onChange} isExit={false} />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    forceLinting(view);
    await new Promise((r) => setTimeout(r, 0));
    expect(diagnosticCount(view.state)).toBe(1); // no panes yet: unknown ref
    rerender(
      <RuleExpressionInput
        value="SLOPE.9 > 0"
        onChange={onChange}
        isExit={false}
        instances={SLOPE_PANE}
      />,
    );
    // No forceLinting here on purpose: the pane-list change must itself trigger
    // a re-lint (the linter is reconfigured), or the stale underline lingers
    // until the next keystroke. 250ms clears the linter's 150ms debounce.
    await new Promise((r) => setTimeout(r, 250));
    expect(diagnosticCount(view.state)).toBe(0);
  });

  it("offers the injected pane's outputs after a dot", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RuleExpressionInput
        value="SLOPE."
        onChange={onChange}
        isExit={false}
        instances={SLOPE_PANE}
      />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    // The editor registers cmCompletionSource through a closure over the live
    // list, so the configured source sees the panes (a bare registration would
    // only ever offer the static catalog).
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 60));
    // CM6 re-sorts within a boost band, so compare as a set.
    expect(currentCompletions(view.state).map((o) => o.label).sort()).toEqual([
      "SLOPE.9",
      "SLOPE.accel9",
    ]);
  });
});
