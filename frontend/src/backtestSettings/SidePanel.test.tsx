// @vitest-environment jsdom
// The backtest editors always lint picked-line ids against the config's held
// lines, even before the first pick: a config with no lines flags every L<n>.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { defaultBacktestConfig } from "../lib/backtestConfig";
import { SidePanel } from "./SidePanel";

afterEach(cleanup);

async function entryDiagnostics() {
  const cfg = {
    ...defaultBacktestConfig(),
    longEntry: { combine: "AND" as const, rules: [{ expr: "candle.close > L1", enabled: true }] },
  };
  const { container } = render(
    <SidePanel
      side="long"
      cfg={cfg}
      setCfg={vi.fn()}
      setGroup={vi.fn()}
      defaultAvwapAnchor={0}
      baseResolution="HOUR"
      onCopy={vi.fn()}
      onPaste={async () => null}
    />,
  );
  const host = await waitFor(() => {
    const el = container.querySelector(".cm-editor");
    if (!el) throw new Error("editor not mounted yet");
    return el as HTMLElement;
  });
  const view = EditorView.findFromDOM(host)!;
  forceLinting(view);
  await new Promise((r) => setTimeout(r, 0));
  return diagnosticCount(view.state);
}

describe("SidePanel picked-line lint", () => {
  it("flags L1 when the config has never picked a line", async () => {
    expect(await entryDiagnostics()).toBe(1);
  });
});
