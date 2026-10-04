// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { handleBackPress, pushBackCloser } from "./backStack";

it("back closes the sheet that registered", () => {
  const close = vi.fn();
  pushBackCloser(close);
  expect(handleBackPress()).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("closes only the topmost when two are stacked", () => {
  const bottom = vi.fn();
  const top = vi.fn();
  pushBackCloser(bottom);
  pushBackCloser(top);
  handleBackPress();
  expect(top).toHaveBeenCalledOnce();
  expect(bottom).not.toHaveBeenCalled();
  handleBackPress();
  expect(bottom).toHaveBeenCalledOnce();
});

it("a sheet closed from its own UI no longer takes the press", () => {
  const close = vi.fn();
  const release = pushBackCloser(close);
  release();
  expect(handleBackPress()).toBe(false);
  expect(close).not.toHaveBeenCalled();
});

it("release after a back press is a no-op", () => {
  const other = vi.fn();
  pushBackCloser(other);
  const close = vi.fn();
  const release = pushBackCloser(close);
  handleBackPress();
  release();
  // The sheet underneath is still registered.
  expect(handleBackPress()).toBe(true);
  expect(other).toHaveBeenCalledOnce();
});

it("with nothing open the press goes to the shell", () => {
  expect(handleBackPress()).toBe(false);
  expect((window as unknown as { __chartkarBack?: () => boolean }).__chartkarBack).toBe(handleBackPress);
});

it("never touches browser history", () => {
  const push = vi.spyOn(window.history, "pushState");
  const back = vi.spyOn(window.history, "back");
  const release = pushBackCloser(vi.fn());
  release();
  pushBackCloser(vi.fn());
  handleBackPress();
  expect(push).not.toHaveBeenCalled();
  expect(back).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
