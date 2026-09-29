// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { useHoldDrag, HOLD_MS } from "./useHoldDrag";

function List(props: { h: Parameters<typeof useHoldDrag>[0] }) {
  const { onPointerDown, draggingId } = useHoldDrag(props.h);
  return (
    <div>
      {["a", "b"].map((id) => (
        <div key={id} data-drag-id={id} data-testid={id} data-dragging={draggingId === id}
             onPointerDown={(e) => onPointerDown(e, id)} />
      ))}
    </div>
  );
}

describe("useHoldDrag", () => {
  let h: { onTap: Mock<(id: string) => void>; onHold: Mock<(id: string) => void>; onOver: Mock<(id: string, overId: string) => void>; onDrop: Mock<(id: string) => void> };
  const originalElementFromPoint = document.elementFromPoint;
  beforeEach(() => {
    vi.useFakeTimers();
    h = { onTap: vi.fn(), onHold: vi.fn(), onOver: vi.fn(), onDrop: vi.fn() };
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.elementFromPoint = originalElementFromPoint;
  });

  const down = (el: HTMLElement, x = 0, y = 0) => fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1 });
  const move = (x: number, y: number) => fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 });
  const up = () => fireEvent.pointerUp(window, { pointerId: 1 });

  it("a quick release is a tap", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a")); up();
    expect(h.onTap).toHaveBeenCalledWith("a");
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("hold then release without moving is a hold", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    up();
    expect(h.onHold).toHaveBeenCalledWith("a");
    expect(h.onTap).not.toHaveBeenCalled();
  });

  it("moving past the slop before the hold cancels everything (a scroll)", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    move(0, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    up();
    expect(h.onTap).not.toHaveBeenCalled();
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("hold then drag reports the item under the finger and drops", () => {
    const { getByTestId } = render(<List h={h} />);
    document.elementFromPoint = vi.fn(() => getByTestId("b"));
    down(getByTestId("a"));
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    move(0, 30);
    expect(getByTestId("a").dataset.dragging).toBe("true");
    expect(h.onOver).toHaveBeenCalledWith("a", "b");
    up();
    expect(h.onDrop).toHaveBeenCalledWith("a");
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("pointercancel ends the gesture with no callbacks", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    fireEvent.pointerCancel(window, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(h.onTap).not.toHaveBeenCalled();
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("a second finger's pointerup during a hold is ignored; the original finger's up still completes the gesture", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(h.onHold).not.toHaveBeenCalled();
    expect(h.onTap).not.toHaveBeenCalled();
    up();
    expect(h.onHold).toHaveBeenCalledWith("a");
  });

  it("unmounting mid-hold fires no callback after the timer would elapse", () => {
    const { getByTestId, unmount } = render(<List h={h} />);
    down(getByTestId("a"));
    unmount();
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(h.onTap).not.toHaveBeenCalled();
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("swallows the click that trails a hold, but not a later tap", () => {
    const { getByTestId } = render(<List h={h} />);
    const clicked = vi.fn();
    document.body.addEventListener("click", clicked);
    try {
      down(getByTestId("a"));
      act(() => { vi.advanceTimersByTime(HOLD_MS); });
      up();
      fireEvent.click(document.body);
      expect(clicked).not.toHaveBeenCalled();
      fireEvent.click(document.body);
      expect(clicked).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener("click", clicked);
    }
  });

  it("does not swallow the click after a plain tap", () => {
    const { getByTestId } = render(<List h={h} />);
    const clicked = vi.fn();
    document.body.addEventListener("click", clicked);
    try {
      down(getByTestId("a")); up();
      fireEvent.click(document.body);
      expect(clicked).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener("click", clicked);
    }
  });

  it("registers the document touchmove(passive:false) listener only while lifted", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const touchmoveAdds = () => addSpy.mock.calls.filter((c) => c[0] === "touchmove");
    const touchmoveRemoves = () => removeSpy.mock.calls.filter((c) => c[0] === "touchmove");
    try {
      const { getByTestId } = render(<List h={h} />);
      down(getByTestId("a"));
      expect(touchmoveAdds()).toHaveLength(0);
      act(() => { vi.advanceTimersByTime(HOLD_MS); });
      expect(touchmoveAdds()).toHaveLength(1);
      expect(touchmoveAdds()[0][2]).toEqual({ passive: false });
      expect(touchmoveRemoves()).toHaveLength(0);
      up();
      expect(touchmoveRemoves()).toHaveLength(1);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
