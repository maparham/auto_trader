// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { pushBackCloser } from "./backStack";

afterEach(() => vi.restoreAllMocks());

function pressBack() {
  window.dispatchEvent(new PopStateEvent("popstate"));
}

it("back closes the sheet that registered", () => {
  const close = vi.fn();
  pushBackCloser(close);
  pressBack();
  expect(close).toHaveBeenCalledOnce();
});

it("closes only the topmost when two are stacked", () => {
  const bottom = vi.fn();
  const top = vi.fn();
  pushBackCloser(bottom);
  pushBackCloser(top);
  pressBack();
  expect(top).toHaveBeenCalledOnce();
  expect(bottom).not.toHaveBeenCalled();
  pressBack();
  expect(bottom).toHaveBeenCalledOnce();
});

it("closing from the UI pops its history entry without calling the closer", () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => pressBack());
  const close = vi.fn();
  const release = pushBackCloser(close);
  release();
  expect(back).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("release after a back press is a no-op", () => {
  const back = vi.spyOn(window.history, "back");
  const close = vi.fn();
  const release = pushBackCloser(close);
  pressBack();
  release();
  expect(back).not.toHaveBeenCalled();
});
