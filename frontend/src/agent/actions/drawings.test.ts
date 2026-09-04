import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, listActions, invokeAction } from "../registry";
import { registerDrawingActions, setFocusedDrawingsProvider } from "./drawings";

const ctx = { progress: () => {}, signal: new AbortController().signal };

function fakeOverlays() {
  const store = new Map<string, { name: string; points: unknown; styles?: unknown; extendData?: unknown }>();
  let n = 0;
  return {
    listDrawings: () =>
      [...store.entries()].map(([id, d]) => ({
        id,
        name: d.name,
        points: d.points as Array<{ timestamp?: number; value?: number }>,
        text: (d.extendData as { text?: string } | undefined)?.text,
        color: "#1677FF",
      })),
    placeDrawing: (spec: { name: string; points: unknown; styles?: unknown; extendData?: unknown }) => {
      const id = `ov-${++n}`;
      store.set(id, spec);
      return id;
    },
    getDrawing: (id: string) => store.get(id) ?? null,
    remove: (id: string) => void store.delete(id),
    clearDrawings: () => store.clear(),
    setText: vi.fn(),
  };
}

describe("drawing actions", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerDrawingActions();
  });

  it("registers the four drawing actions", () => {
    expect(listActions().map((a) => a.name).sort()).toEqual([
      "drawing.add",
      "drawing.clear",
      "drawing.list",
      "drawing.remove",
    ]);
  });

  it("adds a horizontal S/R level with label and color", async () => {
    const overlays = fakeOverlays();
    setFocusedDrawingsProvider(() => ({ overlays: overlays as never, epic: "OIL_CRUDE", cellId: "c1" }));
    const res = (await invokeAction(
      "drawing.add",
      { tool: "horizontalStraightLine", points: [{ value: 91.72 }], text: "R", color: "#FF4D4F" },
      ctx,
    )) as { id: string };
    expect(res.id).toBe("ov-1");
    expect(overlays.listDrawings()).toHaveLength(1);
  });

  it("rejects unknown tools and empty points", async () => {
    const overlays = fakeOverlays();
    setFocusedDrawingsProvider(() => ({ overlays: overlays as never, epic: "OIL_CRUDE", cellId: "c1" }));
    await expect(invokeAction("drawing.add", { tool: "nope", points: [{ value: 1 }] }, ctx)).rejects.toThrow(
      /unknown tool/,
    );
    await expect(
      invokeAction("drawing.add", { tool: "horizontalStraightLine", points: [] }, ctx),
    ).rejects.toThrow(/non-empty/);
  });

  it("converts second timestamps to ms", async () => {
    const overlays = fakeOverlays();
    setFocusedDrawingsProvider(() => ({ overlays: overlays as never, epic: "OIL_CRUDE", cellId: "c1" }));
    await invokeAction(
      "drawing.add",
      {
        tool: "segment",
        points: [
          { timestamp: 1782950400, value: 67.01 },
          { timestamp: 1787702400, value: 79.23 },
        ],
      },
      ctx,
    );
    const pts = overlays.listDrawings()[0]!.points as Array<{ timestamp?: number }>;
    expect(pts[0]!.timestamp).toBe(1782950400000);
  });

  it("errors with NO_FOCUSED_CHART when no chart is focused", async () => {
    setFocusedDrawingsProvider(() => null);
    await expect(invokeAction("drawing.list", {}, ctx)).rejects.toThrow(/no focused chart/);
  });
});
