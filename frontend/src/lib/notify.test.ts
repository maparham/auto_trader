// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toast } from "./notify";

// The hidden-tab contract: a toast fired while the browser tab is HIDDEN (alerts
// fire from a background engine; rAF doesn't run and timers would silently remove
// the never-painted toast) must WAIT — visible and undismissed — until the tab is
// shown again, then fade in and start its dismiss countdown.

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no rAF by default in the node-flavoured setup; map it onto timers.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(0), 16) as unknown as number;
  });
  setVisibility("visible");
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.getElementById("toast-container")?.remove();
});

describe("toast visibility lifecycle", () => {
  it("visible tab: shows, then dismisses after the duration", () => {
    toast("hello", { duration: 4000 });
    const el = document.querySelector(".toast")!;
    vi.advanceTimersByTime(100);
    expect(el.classList.contains("show")).toBe(true);
    vi.advanceTimersByTime(4400);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("hidden tab: holds the toast (no dismiss) until the tab becomes visible", () => {
    setVisibility("hidden");
    toast("fired in background", { duration: 4000 });
    // Paintable immediately — the fade-in class must NOT depend on rAF, which
    // never runs in a hidden tab.
    expect(document.querySelector(".toast")!.classList.contains("show")).toBe(true);
    // Way past the nominal duration while still hidden — must still be in the DOM.
    vi.advanceTimersByTime(60_000);
    expect(document.querySelector(".toast")).not.toBeNull();

    // Tab becomes visible: toast fades in, then dismisses after its duration.
    setVisibility("visible");
    vi.advanceTimersByTime(100);
    const el = document.querySelector(".toast")!;
    expect(el.classList.contains("show")).toBe(true);
    vi.advanceTimersByTime(4400);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("sticky toast (duration: null): stays until closed; × dismisses without the click action", () => {
    const onClick = vi.fn();
    toast("alert", { onClick, duration: null });
    // Never auto-dismisses.
    vi.advanceTimersByTime(600_000);
    const el = document.querySelector(".toast") as HTMLElement;
    expect(el).not.toBeNull();
    // The × closes it WITHOUT triggering navigation.
    (el.querySelector(".toast-close") as HTMLElement).click();
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("caps the stack: a 6th toast dismisses the oldest (through its fade-out)", () => {
    for (let i = 0; i < 6; i++) toast(`t${i}`, { duration: null });
    // The evicted toast fades (`closing`) rather than vanishing abruptly.
    expect(document.querySelectorAll(".toast.closing").length).toBe(1);
    vi.advanceTimersByTime(400);
    const texts = [...document.querySelectorAll(".toast .toast-msg")].map((e) => e.textContent);
    expect(texts).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("eviction prefers transient toasts over sticky alert toasts", () => {
    toast("sticky-alert", { onClick: () => {}, duration: null });
    for (let i = 0; i < 4; i++) toast(`transient${i}`, { duration: 60_000 });
    toast("newcomer", { duration: null }); // 6th — must NOT evict the sticky
    vi.advanceTimersByTime(400);
    const texts = [...document.querySelectorAll(".toast .toast-msg")].map((e) => e.textContent);
    expect(texts).toContain("sticky-alert");
    expect(texts).not.toContain("transient0"); // oldest transient went instead
  });

  it("evicting a hidden-tab transient toast unhooks its visibilitychange wait", () => {
    setVisibility("hidden");
    // 5 transients queued behind a hidden tab, then a 6th evicts the oldest.
    for (let i = 0; i < 6; i++) toast(`t${i}`, { duration: 4000 });
    vi.advanceTimersByTime(400);
    expect(document.querySelectorAll(".toast").length).toBe(5);
    // Tab becomes visible: survivors dismiss normally; the evicted toast's
    // listener is gone (no stray timers on detached elements → no throw).
    setVisibility("visible");
    vi.advanceTimersByTime(5000);
    expect(document.querySelectorAll(".toast").length).toBe(0);
  });

  it("clickable toast: click runs the handler and dismisses immediately", () => {
    const onClick = vi.fn();
    toast("clicky", { onClick, duration: 4000 });
    const el = document.querySelector(".toast") as HTMLElement;
    expect(el.classList.contains("clickable")).toBe(true);
    el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".toast")).toBeNull();
  });
});
