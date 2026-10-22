// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./exprPick", () => ({ pickedIndicatorToken: vi.fn(() => "RSI.bullDiv") }));
vi.mock("./notify", () => ({ toast: vi.fn() }));

import { Signal } from "./signals";
import { useIndicatorPick } from "./useIndicatorPick";
import { pickedIndicatorToken } from "./exprPick";
import { toast } from "./notify";

function fakeController() {
  return {
    chart: {},
    indicatorPickArmed: new Signal<boolean>(false),
    indicatorPickResult: new Signal<unknown>(null),
  } as never;
}

describe("useIndicatorPick", () => {
  it("delivers one token to the armed target and disarms", () => {
    const c = fakeController() as { indicatorPickArmed: Signal<boolean>; indicatorPickResult: Signal<unknown> };
    const onToken = vi.fn();
    const { result } = renderHook(() => useIndicatorPick<string>(c as never, onToken));
    act(() => result.current!.arm("condition"));
    expect(c.indicatorPickArmed.value).toBe(true);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(onToken).toHaveBeenCalledWith("condition", "RSI.bullDiv");
    expect(result.current!.armed).toBeNull();
    expect(c.indicatorPickArmed.value).toBe(false);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks while unarmed", () => {
    const c = fakeController() as { indicatorPickResult: Signal<unknown> };
    const onToken = vi.fn();
    renderHook(() => useIndicatorPick<string>(c as never, onToken));
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(onToken).not.toHaveBeenCalled();
  });

  it("two mounted hooks: only the last armed one receives the click", () => {
    const c = fakeController() as { indicatorPickResult: Signal<unknown> };
    const a = vi.fn();
    const b = vi.fn();
    const ha = renderHook(() => useIndicatorPick<string>(c as never, a));
    const hb = renderHook(() => useIndicatorPick<string>(c as never, b));
    act(() => ha.result.current!.arm("x"));
    act(() => hb.result.current!.arm("y"));
    expect(ha.result.current!.armed).toBeNull();
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("y", "RSI.bullDiv");
  });

  it("disarm from a non-owner hook leaves the owner armed and the chart flag set", () => {
    const c = fakeController() as { indicatorPickArmed: Signal<boolean>; indicatorPickResult: Signal<unknown> };
    const a = vi.fn();
    const b = vi.fn();
    const ha = renderHook(() => useIndicatorPick<string>(c as never, a));
    const hb = renderHook(() => useIndicatorPick<string>(c as never, b));
    act(() => ha.result.current!.arm("x"));
    // hb never armed, so it does not own the pick; its disarm must not clear
    // the shared chart flag or affect ha's armed state.
    act(() => hb.result.current!.disarm());
    expect(c.indicatorPickArmed.value).toBe(true);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(a).toHaveBeenCalledWith("x", "RSI.bullDiv");
    expect(b).not.toHaveBeenCalled();
  });

  it("toasts when the pane has no expression form", () => {
    vi.mocked(pickedIndicatorToken).mockReturnValueOnce(null);
    const c = fakeController() as { indicatorPickResult: Signal<unknown> };
    const onToken = vi.fn();
    const { result } = renderHook(() => useIndicatorPick<string>(c as never, onToken));
    act(() => result.current!.arm("condition"));
    act(() => c.indicatorPickResult.set({ id: "MACD" }));
    expect(onToken).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("That indicator has no expression equivalent.");
  });

  it("returns undefined without a controller", () => {
    const { result } = renderHook(() => useIndicatorPick<string>(null, vi.fn()));
    expect(result.current).toBeUndefined();
  });
});
