// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import FloatingModal from "./FloatingModal";

afterEach(cleanup);

describe("FloatingModal", () => {
  it("renders title, body and footer", () => {
    render(
      <FloatingModal title="Hi" onClose={vi.fn()} footer={<button>Add</button>}>
        <p>body</p>
      </FloatingModal>,
    );
    expect(screen.getByText("Hi")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<FloatingModal title="t" onClose={onClose}>x</FloatingModal>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("✕ closes", () => {
    const onClose = vi.fn();
    render(<FloatingModal title="t" onClose={onClose}>x</FloatingModal>);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a click inside the panel keeps it open", () => {
    const onClose = vi.fn();
    render(<FloatingModal title="t" onClose={onClose}><p>body</p></FloatingModal>);
    fireEvent.mouseDown(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a document mousedown on the chart (.chart-cells) closes it — any outside click dismisses", () => {
    const onClose = vi.fn();
    const chart = document.createElement("div");
    chart.className = "chart-cells";
    document.body.appendChild(chart);
    render(<FloatingModal title="t" onClose={onClose}>x</FloatingModal>);
    fireEvent.mouseDown(chart);
    expect(onClose).toHaveBeenCalled();
    chart.remove();
  });

  it("a document mousedown on a portaled role=dialog popover keeps it open", () => {
    const onClose = vi.fn();
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    document.body.appendChild(popover);
    render(<FloatingModal title="t" onClose={onClose}>x</FloatingModal>);
    fireEvent.mouseDown(popover);
    expect(onClose).not.toHaveBeenCalled();
    popover.remove();
  });

  it("a document mousedown on unrelated chrome closes it", () => {
    const onClose = vi.fn();
    const chrome = document.createElement("div");
    chrome.className = "toolbar";
    document.body.appendChild(chrome);
    render(<FloatingModal title="t" onClose={onClose}>x</FloatingModal>);
    fireEvent.mouseDown(chrome);
    expect(onClose).toHaveBeenCalled();
    chrome.remove();
  });

  it("dragging the header applies a transform offset", () => {
    render(<FloatingModal title="grab" onClose={vi.fn()}>x</FloatingModal>);
    const head = screen.getByText("grab").closest(".floating-modal-head")!;
    fireEvent.mouseDown(head, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 20 });
    fireEvent.mouseUp(window);
    const panel = document.querySelector(".floating-modal") as HTMLElement;
    expect(panel.style.transform).toContain("translate(40px, 20px)");
  });
});
