// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

// vi.mock factories are hoisted above the rest of the file, so the shared
// fakes have to be created inside vi.hoisted (a plain `const state = ...`
// above the vi.mock call still throws "Cannot access before initialization",
// since the mock factory runs first once hoisted). A minimal inline
// Signal-alike avoids importing ./lib/signals here too, for the same reason.
const { state, send, undoLast, redoLast, editFrom } = vi.hoisted(() => {
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
    redoLast: vi.fn(async () => {}),
    editFrom: vi.fn(async (_i?: number, _t?: string, _o?: { onCut?: () => void; force?: boolean }): Promise<string> => "sent"),
  };
});
// Only the live session singleton is faked; `undoableIndex` comes through
// from the real module (importActual) so the panel test exercises the real
// rule (undoable !== false AND a live undo closure), not a simplified stand-in.
vi.mock("./assistant/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assistant/session")>();
  return {
    ...actual,
    assistantSession: { state, send, retry: vi.fn(), stop: vi.fn(), undoLast, redoLast, editFrom, reset: vi.fn() },
  };
});

import AssistantPanel from "./AssistantPanel";
import { collapseLabels, toBlocks } from "./assistant/format";

beforeEach(() => { send.mockClear(); undoLast.mockClear(); redoLast.mockClear(); editFrom.mockClear(); });
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

  it("renders bold and bullet lists instead of literal Markdown", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "I changed:\n- **Max Trendlines**: 3 to 6\n- `minTouches` 2", changes: [], undone: false },
    ] });
    const { container } = render(<AssistantPanel onClose={() => {}} />);
    expect(container.querySelector("strong")?.textContent).toBe("Max Trendlines");
    expect(container.querySelectorAll("ul.as-list li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("collapses repeated change labels", () => {
    expect(collapseLabels(["Drew a ray", "Drew a ray", "Added RSI", "Added RSI"]))
      .toEqual(["Drew 2 rays", "Added RSI (×2)"]);
  });

  it("splits numbered and bulleted lines into separate lists", () => {
    expect(toBlocks("Intro\n1. one\n2. two\n\n• a").map((b) => b.kind)).toEqual(["p", "ol", "ul"]);
  });

  it("shows Send only with a draft, and New chat in the head", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "user", text: "hi" },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/describe what you want/i), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
    expect((screen.getByRole("button", { name: /new chat/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Redo on an undone turn until the user sends again", () => {
    const undone = { role: "assistant", text: "a", undone: true,
      changes: [{ label: "Drew a ray", cellId: "c1", undoable: false, replay: { tool: "drawing_add", input: {} } }] };
    state.set({ ...state.value, busy: false, working: null, turns: [undone] });
    const { unmount } = render(<AssistantPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^redo$/i }));
    expect(redoLast).toHaveBeenCalled();
    unmount();
    state.set({ ...state.value, turns: [undone, { role: "user", text: "next" }] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^redo$/i })).toBeNull();
    expect(screen.getByText("Undone")).toBeTruthy();
  });

  it("edits an earlier message, and asks before continuing when later changes can't be undone", async () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "user", text: "first", rewind: { msgIndex: 0, pending: { toolUseIds: [], heldResults: [], askId: null } } },
      { role: "assistant", text: "ok", changes: [], undone: false },
      { role: "user", text: "legacy" },
    ] });
    render(<AssistantPanel onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: /edit message/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /edit message/i }));
    const box = screen.getByDisplayValue("first");
    fireEvent.change(box, { target: { value: "first, edited" } });
    editFrom.mockResolvedValueOnce("blocked");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await screen.findByText(/continue without reverting/i);
    expect(editFrom).toHaveBeenLastCalledWith(0, "first, edited", expect.objectContaining({ force: false }));
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(editFrom).toHaveBeenLastCalledWith(0, "first, edited", expect.objectContaining({ force: true }));
  });

  it("closes the editor once the chat is rewound, before the reply arrives", async () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "user", text: "first", rewind: { msgIndex: 0, pending: { toolUseIds: [], heldResults: [], askId: null } } },
    ] });
    let finish = () => {};
    editFrom.mockImplementationOnce(async (_i?: number, _t?: string, opts?: { onCut?: () => void }) => {
      opts?.onCut?.();
      await new Promise<void>((r) => { finish = r; });
      return "sent";
    });
    render(<AssistantPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /edit message/i }));
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await vi.waitFor(() => expect(screen.queryByDisplayValue("first")).toBeNull());
    finish();
  });
});
