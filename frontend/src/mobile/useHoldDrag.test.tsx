// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  let h: { onTap: ReturnType<typeof vi.fn>; onHold: ReturnType<typeof vi.fn>; onOver: ReturnType<typeof vi.fn>; onDrop: ReturnType<typeof vi.fn> };
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
});
