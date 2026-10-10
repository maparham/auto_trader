// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("Cancel runs onCancel then onClose; Confirm runs onConfirm then onClose, and never calls onCancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Delete"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
    // The confirm button deliberately calls onConfirm/onClose directly, never
    // handleCancel - confirming is not canceling.
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it("Confirm never calls onCancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
  it("renders a custom cancelLabel and calls onCancel from it", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog message="x" cancelLabel="Keep" onConfirm={() => {}} onClose={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Keep"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it("Escape runs onCancel then onClose, never onConfirm", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("a backdrop click runs onCancel then onClose, never onConfirm", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />,
    );

    fireEvent.mouseDown(container.querySelector(".modal-backdrop")!);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("clicking inside the modal body does not trigger the backdrop's onCancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />,
    );

    fireEvent.mouseDown(container.querySelector(".confirm-modal")!);

    expect(onCancel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
