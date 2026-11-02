// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";

// vi.mock factories are hoisted above the rest of the file, so the shared
// fakes have to be created inside vi.hoisted (a plain `const state = ...`
// above the vi.mock call still throws "Cannot access before initialization",
// since the mock factory runs first once hoisted). A minimal inline
// Signal-alike avoids importing ./lib/signals here too, for the same reason.
const { state, send, undoLast, redoLast, editFrom, fakeSession, shown } = vi.hoisted(() => {
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
  const state = new FakeSignal<any>({ turns: [], messages: [], pending: { toolUseIds: [], heldResults: [], askId: null }, busy: false, working: null });
  const send = vi.fn(async () => {});
  const undoLast = vi.fn(async () => {});
  const redoLast = vi.fn(async () => {});
  const editFrom = vi.fn(async (_i?: number, _t?: string, _o?: { onCut?: () => void; force?: boolean }): Promise<string> => "sent");
  const fakeSession = { state, send, undoLast, redoLast, editFrom, retry: vi.fn(), stop: vi.fn(), reset: vi.fn(), cellId: "c1" };
  // Which cell each render asked for, and a per-cell override for swap tests.
  const shown = { cells: [] as string[], byCell: new Map<string, any>() };
  return { state, send, undoLast, redoLast, editFrom, fakeSession, shown };
});
// Only the per-cell session lookup is faked; `undoableIndex` comes through
// from the real module (importActual) so the panel test exercises the real
// rule (undoable !== false AND a live undo closure), not a simplified stand-in.
vi.mock("./assistant/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assistant/session")>();
  return {
    ...actual,
    sessionToShow: (cellId: string) => { shown.cells.push(cellId); return shown.byCell.get(cellId) ?? fakeSession; },
    pruneSessions: vi.fn(),
  };
});

import AssistantPanel from "./AssistantPanel";
import { collapseLabels, toBlocks } from "./assistant/format";

beforeEach(() => { send.mockClear(); undoLast.mockClear(); redoLast.mockClear(); editFrom.mockClear(); });
afterEach(cleanup);

// Mirrors AUTO_RETRY_S in AssistantPanel.tsx (a component file exports only components).
const AUTO_RETRY_S = 10;

describe("AssistantPanel", () => {
  it("shows example prompts when empty and sends one on click", () => {
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add rising trendlines on the daily"));
    expect(send).toHaveBeenCalledWith("Add rising trendlines on the daily");
  });

  it("renders option chips for a pending question and answers with the label", () => {
    state.set({ ...state.value, turns: [
      { role: "user", text: "trendlines" },
      { role: "assistant", text: "", changes: [], undone: false, ask: { question: "Which direction?", options: [{ label: "Rising" }, { label: "Falling" }] } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getByText("Which direction?")).toBeTruthy();
    fireEvent.click(screen.getByText("Falling"));
    expect(send).toHaveBeenCalledWith("Falling");
  });

  it("folds an ask's details behind More", () => {
    state.set({ ...state.value, turns: [
      { role: "user", text: "why" },
      { role: "assistant", text: "", changes: [], undone: false,
        ask: { lead: "It skips your line.", question: "What now?", details: "Max Pierce is 0.1 ATR.", options: [{ label: "Allow small dips", description: "Max Pierce 0.1 to 0.6 ATR" }, { label: "Leave it as is" }] } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getByText("It skips your line.")).toBeTruthy();
    const fold = screen.getByText("More").closest("details")!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain("Max Pierce is 0.1 ATR.");
    fireEvent.click(screen.getByText("Allow small dips"));
    expect(send).toHaveBeenCalledWith("Allow small dips");
  });

  it("keeps an answered question's options, greyed, with the pick marked and no echo", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "It skips your line.", changes: [], undone: false,
        ask: { question: "What now?", options: [{ label: "Allow dips" }, { label: "Leave it as is" }] } },
      { role: "user", text: "Allow dips", pickedFrom: "What now?" },
      { role: "assistant", text: "Done.", changes: [], undone: false },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getAllByText("What now?")).toHaveLength(1);
    const pick = screen.getByRole("button", { name: "Allow dips", pressed: true }) as HTMLButtonElement;
    expect(pick.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Leave it as is", pressed: false }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Something else…")).toBeNull();
  });

  it("picks an open question's option with its number key while the composer is empty", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "", changes: [], undone: false,
        ask: { lead: "Done.", question: "Next?", options: [{ label: "Show on 1H" }, { label: "Leave it as is" }] } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Show on 1H" }).className).toContain("as-chip-primary");
    const input = screen.getByPlaceholderText("Describe what you want…");
    fireEvent.keyDown(input, { key: "3" });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "2" });
    expect(send).toHaveBeenCalledWith("Leave it as is");
  });

  it("types a digit normally once the composer has text", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "", changes: [], undone: false,
        ask: { question: "Next?", options: [{ label: "A" }, { label: "B" }] } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Describe what you want…");
    fireEvent.change(input, { target: { value: "switch to " } });
    fireEvent.keyDown(input, { key: "1" });
    expect(send).not.toHaveBeenCalled();
  });

  it("names the focused chart above the composer", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [] });
    render(<AssistantPanel cellId="c1" chart={{ epic: "US100", resolution: "HOUR_4" }} onClose={() => {}} />);
    expect(screen.getByText("US100 · 4H")).toBeTruthy();
  });

  it("asks for a chart when none is focused", () => {
    render(<AssistantPanel cellId={null} onClose={() => {}} />);
    expect(screen.getByText("Open a chart to use the assistant.")).toBeTruthy();
    expect((screen.getByPlaceholderText("Open a chart first") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows the focused chart's own chat and swaps when focus moves", () => {
    const other = { ...fakeSession, state: { value: { ...state.value, turns: [{ role: "user", text: "gold chat" }] }, subscribe: () => () => {} } };
    shown.byCell.set("c2", other);
    try {
      state.set({ ...state.value, busy: false, working: null, turns: [{ role: "user", text: "us100 chat" }] });
      const { rerender } = render(<AssistantPanel cellId="c1" onClose={() => {}} />);
      expect(screen.getByText("us100 chat")).toBeTruthy();
      rerender(<AssistantPanel cellId="c2" onClose={() => {}} />);
      expect(screen.getByText("gold chat")).toBeTruthy();
      expect(screen.queryByText("us100 chat")).toBeNull();
    } finally {
      shown.byCell.clear();
    }
  });

  it("explains a switch-stop and offers Continue on the chart", () => {
    fakeSession.retry.mockClear();
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "stopped", cause: "switch" } },
    ] });
    render(<AssistantPanel cellId="c1" chart={{ epic: "US100", resolution: "HOUR" }} onClose={() => {}} />);
    expect(screen.getByText(/you switched charts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fakeSession.retry).toHaveBeenCalled();
  });

  it("offers Continue and Shorter answer when a reply was cut short", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "user", text: "explain" },
      { role: "assistant", text: "Long", changes: [], undone: false, error: { kind: "max_tokens" } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Shorter answer" }));
    expect(send).toHaveBeenCalledWith("Answer again, shorter.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(send).toHaveBeenCalledWith("Continue where you stopped.");
  });

  it("retries a rate limit on its own after a countdown, and Cancel stops it", () => {
    vi.useFakeTimers();
    try {
      const retry = fakeSession.retry as ReturnType<typeof vi.fn>;
      retry.mockClear();
      state.set({ ...state.value, busy: false, working: null, turns: [
        { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 429, body: "assistant busy" } },
      ] });
      const { unmount } = render(<AssistantPanel cellId="c1" onClose={() => {}} />);
      expect(screen.getByText(`Retrying in ${AUTO_RETRY_S}s`)).toBeTruthy();
      for (let k = 0; k < AUTO_RETRY_S; k++) act(() => { vi.advanceTimersByTime(1000); });
      expect(retry).toHaveBeenCalledTimes(1);
      unmount();
      retry.mockClear();
      render(<AssistantPanel cellId="c1" onClose={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => { vi.advanceTimersByTime(AUTO_RETRY_S * 1000); });
      expect(retry).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying on its own after three automatic retries in a row", () => {
    vi.useFakeTimers();
    try {
      const retry = fakeSession.retry as ReturnType<typeof vi.fn>;
      retry.mockClear();
      const limited = { ...state.value, busy: false, working: null, turns: [
        { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 429, body: "assistant busy" } },
      ] };
      state.set(limited);
      render(<AssistantPanel cellId="c1" onClose={() => {}} />);
      for (let n = 0; n < 3; n++) {
        for (let k = 0; k < AUTO_RETRY_S; k++) act(() => { vi.advanceTimersByTime(1000); });
        act(() => { state.set({ ...limited, busy: true }); });
        act(() => { state.set({ ...limited }); });
      }
      expect(retry).toHaveBeenCalledTimes(3);
      expect(screen.queryByText(/Retrying in/)).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Keep going after too many steps", () => {
    const retry = fakeSession.retry as ReturnType<typeof vi.fn>;
    retry.mockClear();
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "rounds" } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(retry).toHaveBeenCalled();
  });

  it("offers Undo only on the newest turn with live changes", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "a", changes: [{ label: "Added RSI", cellId: "c1", undo: async () => {} }], undone: false },
      { role: "assistant", text: "b", changes: [{ label: "Added EMA", cellId: "c1", undo: async () => {} }], undone: false },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /undo this turn/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(undoLast).toHaveBeenCalled();
  });

  it("shows the upstream body verbatim on an error", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 403, body: "{\"error\":\"forbidden\"}" } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
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
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /undo this turn/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.focus(btn.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain("Undo is lost on reload");
    fireEvent.click(btn);
    expect(undoLast).not.toHaveBeenCalled();
  });

  // M10: the proxy's own busy semaphore (429, body "assistant busy") and an
  // upstream rate limit re-wrapped as a 424 (status 429, a different body)
  // read as two different, plain-English messages.
  it("shows the busy wording for the proxy semaphore and hides the raw body", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 429, body: "assistant busy" } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getByText("The assistant is busy, try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("assistant busy")).toBeNull();
  });

  it("shows the rate-limited wording plus body for an upstream 429", () => {
    state.set({ ...state.value, turns: [
      { role: "assistant", text: "", changes: [], undone: false, error: { kind: "upstream", status: 429, body: "{\"type\":\"rate_limit_error\"}" } },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getByText("Rate limited, try again shortly.")).toBeTruthy();
    expect(screen.getByText("{\"type\":\"rate_limit_error\"}")).toBeTruthy();
  });

  // M10: Undo is not abortable, so Stop is hidden while undoLast is running.
  it("hides Stop while undoing, but shows a readable working label", () => {
    state.set({ ...state.value, busy: true, working: "Undoing", turns: [] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
    expect(screen.getByText(/undoing the last turn/i)).toBeTruthy();
  });

  it("shows a readable tool label while a round is in flight", () => {
    state.set({ ...state.value, busy: true, working: "indicator_add", turns: [] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy();
    expect(screen.getByText(/adding an indicator/i)).toBeTruthy();
  });

  it("renders bold and bullet lists instead of literal Markdown", () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "assistant", text: "I changed:\n- **Max Trendlines**: 3 to 6\n- `minTouches` 2", changes: [], undone: false },
    ] });
    const { container } = render(<AssistantPanel cellId="c1" onClose={() => {}} />);
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
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/describe what you want/i), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
    expect((screen.getByRole("button", { name: /new chat/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Redo on an undone turn until the user sends again", () => {
    const undone = { role: "assistant", text: "a", undone: true,
      changes: [{ label: "Drew a ray", cellId: "c1", undoable: false, replay: { tool: "drawing_add", input: {} } }] };
    state.set({ ...state.value, busy: false, working: null, turns: [undone] });
    const { unmount } = render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^redo$/i }));
    expect(redoLast).toHaveBeenCalled();
    unmount();
    state.set({ ...state.value, turns: [undone, { role: "user", text: "next" }] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^redo$/i })).toBeNull();
    expect(screen.getByText("Undone")).toBeTruthy();
  });

  it("edits an earlier message, and asks before continuing when later changes can't be undone", async () => {
    state.set({ ...state.value, busy: false, working: null, turns: [
      { role: "user", text: "first", rewind: { msgIndex: 0, pending: { toolUseIds: [], heldResults: [], askId: null } } },
      { role: "assistant", text: "ok", changes: [], undone: false },
      { role: "user", text: "legacy" },
    ] });
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
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
    render(<AssistantPanel cellId="c1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /edit message/i }));
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await vi.waitFor(() => expect(screen.queryByDisplayValue("first")).toBeNull());
    finish();
  });
});
