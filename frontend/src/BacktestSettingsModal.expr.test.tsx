// @vitest-environment jsdom
//
// Test-harness note (mirrors src/components/RuleExpressionInput.test.tsx): CM6
// edits a contenteditable that jsdom does not mutate, so `userEvent.type` into
// the editor is a no-op under jsdom. We therefore drive text in through the
// mounted `EditorView` (`view.dispatch(...)`), which still exercises the real
// wiring (CM updateListener -> RuleExpressionInput onChange -> RuleGroupSection
// write-back). The assertion is the brief's, unchanged.
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { RuleGroupSection } from "./BacktestSettingsModal";

describe("RuleGroupSection (expression mode)", () => {
  it("edits a row's expression text", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RuleGroupSection
        title="Buy to open"
        group={{ rules: [{ expr: "" }] }}
        onChange={onChange}
        emptyHint="none"
        baseResolution="HOUR"
        isExit={false}
      />,
    );

    // The editor is a lazy chunk (LazyRuleExpressionInput): wait for it.
    const editorEl = await waitFor(() => {
      const el = container.querySelector(".cm-editor") as HTMLElement | null;
      if (!el) throw new Error("editor not loaded yet");
      return el;
    });
    const view = EditorView.findFromDOM(editorEl)!;
    view.dispatch({ changes: { from: 0, insert: "EMA(9) > 0" } });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rules: [expect.objectContaining({ expr: "EMA(9) > 0" })],
      }),
    );
  });
});
