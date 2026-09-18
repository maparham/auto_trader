// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ContextMenu from "./ContextMenu";

afterEach(cleanup);

describe("ContextMenu outside-close", () => {
  it("closes on a touch outside (phones give no mousedown over the chart)", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={[{ label: "Paste", onClick: () => {} }]} onClose={onClose} />);
    fireEvent.touchStart(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a touch inside the menu", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={[{ label: "Paste", onClick: () => {} }]} onClose={onClose} />);
    fireEvent.touchStart(screen.getByText("Paste"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
