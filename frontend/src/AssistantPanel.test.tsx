// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

// vi.mock factories are hoisted above the rest of the file, so the shared
// fakes have to be created inside vi.hoisted (a plain `const state = ...`
// above the vi.mock call still throws "Cannot access before initialization",
// since the mock factory runs first once hoisted). A minimal inline
// Signal-alike avoids importing ./lib/signals here too, for the same reason.
const { state, send, undoLast } = vi.hoisted(() => {
  class FakeSignal<T> {
    value: T;
    private listeners = new Set<(v: T) => void>();
    constructor(initial: T) { this.value = initial; }
    set(value: T): void {
      this.value = value;
      this.listeners.forEach((l) => l(value));
    }
    subscribe(fn: (v: T) => void): () => void {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
  }
  return {
    state: new FakeSignal<any>({ turns: [], messages: [], pending: { toolUseIds: [], heldResults: [], askId: null }, busy: false, working: null }),
    send: vi.fn(async () => {}),
    undoLast: vi.fn(async () => {}),
  };
});
// Only the live session singleton is faked; `undoableIndex` comes through
// from the real module (importActual) so the panel test exercises the real
// rule (undoable !== false AND a live undo closure), not a simplified stand-in.
vi.mock("./assistant/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assistant/session")>();
  return {
    ...actual,
    assistantSession: { state, send, retry: vi.fn(), stop: vi.fn(), undoLast, reset: vi.fn() },
  };
});

import AssistantPanel from "./AssistantPanel";

beforeEach(() => { send.mockClear(); undoLast.mockClear(); });
afterEach(cleanup);

describe("AssistantPanel", () => {
  it("shows example prompts when empty and sends one on click", () => {
    render(<AssistantPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add rising trendlines on the daily"));
    expect(send).toHaveBeenCalledWith("Add rising trendlines on the daily");
  });

  it("renders option chips for a pending question and answers with the label", () => {
    state.set({ ...state.value, turns: [
      { role: "user", text: "trendlines" },
      { role: "assistant", text: "", changes: [], undone: false, ask: { question: "Which direction?", options: [{ label: "Rising" }, { label: "Falling" }] } },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByText("Which direction?")).toBeTruthy();
    fireEvent.click(screen.getByText("Falling"));
    expect(send).toHaveBeenCalledWith("Falling");
  });

  it("offers Undo only on the newest turn with live changes", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "a", changes: [{ label: "Added RSI", cellId: "c1", undo: async () => {} }], undone: false },
      { role: "assistant", text: "b", changes: [{ label: "Added EMA", cellId: "c1", undo: async () => {} }], undone: false },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /undo this turn/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(undoLast).toHaveBeenCalled();
  });

  it("shows the upstream body verbatim on an error", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 403, body: "{\"error\":\"forbidden\"}" } },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByText(/403/)).toBeTruthy();
    expect(screen.getByText("{\"error\":\"forbidden\"}")).toBeTruthy();
  });

  // M3: a turn restored from storage has no live undo closures (functions
  // don't survive JSON), but the newest turn with changes still shows an
  // Undo button so the user isn't left wondering - just disabled, with a
  // tooltip explaining why.
  it("shows a disabled Undo with a reload tooltip when no undo closure survived a reload", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "a", changes: [{ label: "Added RSI", cellId: "c1" }], undone: false },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /undo this turn/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.focus(btn.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain("Undo is lost on reload");
    fireEvent.click(btn);
    expect(undoLast).not.toHaveBeenCalled();
  });

  // M10: the proxy's own busy semaphore (429, body "assistant busy") and an
  // upstream rate limit re-wrapped as a 502 (status 429, a different body)
  // read as two different, plain-English messages.
  it("shows the busy wording for the proxy semaphore and hides the raw body", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 429, body: "assistant busy" } },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByText("The assistant is busy, try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("assistant busy")).toBeNull();
  });

  it("shows the rate-limited wording plus body for an upstream 429", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 429, body: "{\"type\":\"rate_limit_error\"}" } },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByText("Rate limited, try again shortly.")).toBeTruthy();
    expect(screen.getByText("{\"type\":\"rate_limit_error\"}")).toBeTruthy();
  });

  // M10: Undo is not abortable, so Stop is hidden while undoLast is running.
  it("hides Stop while undoing, but shows a readable working label", () => {
    state.set({ ...state.value, busy: true, working: "Undoing", turns: [] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
    expect(screen.getByText(/undoing the last turn/i)).toBeTruthy();
  });

  it("shows a readable tool label while a round is in flight", () => {
    state.set({ ...state.value, busy: true, working: "indicator_add", turns: [] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy();
    expect(screen.getByText(/adding an indicator/i)).toBeTruthy();
  });
});
