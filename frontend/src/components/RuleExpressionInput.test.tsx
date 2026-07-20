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
});
