// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Chart } from "klinecharts";
import type { OverlayManager } from "../lib/overlays";
import { chartMenuRequest } from "../lib/signals";
import MobileCrosshairHandle, { handleShows } from "./MobileCrosshairHandle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("handleShows", () => {
  const base = { point: { x: 10, y: 10 }, touch: true, fingerDown: false, hidden: false, drawing: false };
  it("shows for a touch crosshair once the finger lifts", () => {
    expect(handleShows(base)).toBe(true);
  });
  it("hides with no crosshair, a finger down, a mouse, a selected drawing or a drawing in progress", () => {
    expect(handleShows({ ...base, point: null })).toBe(false);
    expect(handleShows({ ...base, fingerDown: true })).toBe(false);
    expect(handleShows({ ...base, touch: false })).toBe(false);
    expect(handleShows({ ...base, hidden: true })).toBe(false);
    expect(handleShows({ ...base, drawing: true })).toBe(false);
  });
});

function pointer(type: string, pointerType: string): Event {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { pointerType });
  return e;
}

describe("MobileCrosshairHandle", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mount(hidden = false) {
    host = document.createElement("div");
    host.style.position = "relative";
    document.body.appendChild(host);
    const dom = document.createElement("div");
    host.appendChild(dom);
    Object.defineProperty(dom, "clientWidth", { value: 400 });
    Object.defineProperty(dom, "clientHeight", { value: 600 });
    const store = { setCrosshair: (_c?: unknown) => {} };
    const chart = { getDom: () => dom, getChartStore: () => store } as unknown as Chart;
    const overlays = { isDrawing: () => false } as unknown as OverlayManager;
    root = createRoot(host);
    act(() => root!.render(<MobileCrosshairHandle chart={chart} overlays={overlays} hidden={hidden} />));
    const btn = host.querySelector("button")!;
    return { chart, dom, store, btn };
  }

  it("appears after the long press lifts and hides when the crosshair clears", () => {
    const { dom, store, btn } = mount();
    expect(btn.hidden).toBe(true);
    act(() => {
      dom.dispatchEvent(pointer("pointerdown", "touch"));
      store.setCrosshair({ x: 200, y: 150, paneId: "candle_pane" });
    });
    expect(btn.hidden).toBe(true); // finger still down
    act(() => {
      window.dispatchEvent(pointer("pointerup", "touch"));
    });
    expect(btn.hidden).toBe(false);
    expect(btn.style.transform).toBe("translate(182px, 88px)");
    act(() => store.setCrosshair());
    expect(btn.hidden).toBe(true);
  });

  it("stays hidden while a drawing is selected", () => {
    const { dom, store, btn } = mount(true);
    act(() => {
      dom.dispatchEvent(pointer("pointerdown", "touch"));
      store.setCrosshair({ x: 200, y: 150, paneId: "candle_pane" });
      window.dispatchEvent(pointer("pointerup", "touch"));
    });
    expect(btn.hidden).toBe(true);
  });

  it("asks this chart for its menu at the crosshair point", () => {
    const { chart, dom, store, btn } = mount();
    act(() => {
      dom.dispatchEvent(pointer("pointerdown", "touch"));
      store.setCrosshair({ x: 200, y: 150, paneId: "candle_pane" });
      window.dispatchEvent(pointer("pointerup", "touch"));
    });
    let req: typeof chartMenuRequest.value = null;
    const off = chartMenuRequest.subscribe((r) => (req = r));
    act(() => btn.click());
    off();
    expect(req).toMatchObject({ chart, x: 200, y: 150 });
  });
});
