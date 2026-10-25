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
vi.mock("./assistant/session", () => ({
  assistantSession: { state, send, retry: vi.fn(), stop: vi.fn(), undoLast, reset: vi.fn() },
  undoableIndex: (turns: Array<{ role: string; undone?: boolean; changes?: unknown[] }>) => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant" && !t.undone && (t.changes?.length ?? 0) > 0) return i;
    }
    return -1;
  },
}));

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
});
