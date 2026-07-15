// The legend / indicator / drawing command callbacks for a ChartCore cell,
// extracted verbatim from ChartCore. Owns the DOM-legend action-icon handlers
// (toggle-visible / open-settings / remove / select-row), the indicator + drawing
// clipboards (copy/paste/delete), the pane-aware visibility/remove variants, the
// sub-pane reorder (menu + drag), and the shared right-click MenuItem builder.
//
// It is `(handle, deps)`-shaped: EVERY value the moved bodies read from ChartCore's
// closure is supplied via `handle.*` (chartRef, redrawRef, epicRef, overlays and
// the controller-owned signals selectedIndicator/indicatorRemoved), a module import,
// or an explicit `deps` field (snapViewRef, wrapRef, setPaneDropTop, setIndMenu,
// scope, period). Dependency arrays + effect cleanup are preserved exactly.
//
// Returns the callbacks the JSX + <ChartLegend> and the (still-in-ChartCore)
// onKeyDown handler consume.
import { useCallback, useEffect, useRef } from "react";
import { DomPosition, type Indicator } from "klinecharts";
import {
  removeIndicatorById,
  addIndicatorInstance,
  isSubPaneIndicator,
  reorderSubPanes,
  subPaneOrder,
  mirrorAccelCompanion,
} from "../lib/indicators";
import { indTypeOf } from "../lib/customIndicators";
import { saveIndicators, saveIndicatorVisible, type SavedIndicatorConfig } from "../lib/persist";
import { type VisibilityModel, defaultVisibility, isVisibleOnResolution } from "../lib/visibility";
import { indicatorSettingsRequest } from "../lib/signals";
import { toast } from "../lib/notify";
import { MenuIcons } from "../lib/menuIcons";
import { type MenuItem } from "../ContextMenu";
import type { ChartHandle } from "./chartHandle";

export interface IndicatorCommandsDeps {
  // Props / value the callbacks read.
  scope: string;
  period: { resolution: string };
  // ChartCore-local refs the moved bodies read.
  snapViewRef: React.MutableRefObject<boolean>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  // ChartCore-local state setters the moved bodies write.
  setPaneDropTop: React.Dispatch<React.SetStateAction<number | null>>;
  setIndMenu: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; paneId: string; name: string } | null>
  >;
}

export function useIndicatorCommands(handle: ChartHandle, deps: IndicatorCommandsDeps) {
  const { scope, period, snapViewRef, wrapRef, setPaneDropTop, setIndMenu } = deps;
  const { chartRef, epicRef, overlays, controller } = handle;
  const { selectedIndicator, indicatorRemoved } = controller;

  const paneIdOf = useCallback((name: string): string => {
    const c = chartRef.current;
    const all = c?.getIndicatorByPaneId() as
      | Map<string, Map<string, unknown>>
      | null
      | undefined;
    for (const [paneId, inds] of all ?? []) if (inds.has(name)) return paneId;
    return "candle_pane";
  }, []);

  // DOM legend action-icon handlers (mirror the OnTooltipIconClick routing used by
  // sub-pane indicators): gear opens the settings modal, eye toggles visibility,
  // trash removes (and announces via indicatorRemoved so the Toolbar stays in sync).
  // Each resolves the owning pane via paneIdOf, so they work for candle-pane overlays
  // AND sub-pane indicators (Volume/MACD/RSI) alike.
  const onLegendToggleVisible = useCallback((name: string) => {
    const c = chartRef.current;
    if (!c || snapViewRef.current) return; // read-only snapshot view
    const paneId = paneIdOf(name);
    const ind = c.getIndicatorByPaneId(paneId, name) as
      | { visible?: boolean; extendData?: unknown }
      | null;
    const next = !(ind?.visible ?? true);
    // Also write extendData.userVisible in the SAME operation (never separately) —
    // applyIndicatorIntervalVisibility (lib/indicators.ts) recomputes intent from
    // extendData.userVisible on every period change and does NOT fall back to the
    // live `visible` flag once userVisible has ever been explicitly set. Toggling
    // only the live flag here would make this eye icon appear to self-revert on the
    // next timeframe switch, since the stale userVisible would win again.
    const ext = { ...((ind?.extendData as object) ?? {}), userVisible: next };
    const vis = (ext as { visibility?: VisibilityModel }).visibility ?? defaultVisibility();
    c.overrideIndicator(
      { name, extendData: ext, visible: next && isVisibleOnResolution(vis, period.resolution) },
      paneId,
    );
    // Visibility persists by scope+name (pane-agnostic) and is re-applied on hydrate,
    // so sub-pane indicators now keep their hidden state across reloads too.
    saveIndicatorVisible(scope, name, next);
    // A Slope's accel companion follows its parent's visibility. Mirror the flag
    // directly rather than re-running syncAccelCompanion: a pane teardown and
    // recreate on every eye click would flicker.
    mirrorAccelCompanion(c, name, {
      extendData: ext,
      visible: next && isVisibleOnResolution(vis, period.resolution),
    });
    handle.redrawRef.current();
  }, [paneIdOf, period.resolution]);
  const onLegendOpenSettings = useCallback((name: string) => {
    if (snapViewRef.current) return; // read-only snapshot view
    indicatorSettingsRequest.set({ paneId: paneIdOf(name), name });
  }, [paneIdOf]);
  const onLegendRemove = useCallback((name: string) => {
    const c = chartRef.current;
    if (!c || snapViewRef.current) return; // read-only snapshot view
    removeIndicatorById(c, scope, name);
    const next = controller.indicators.value.filter((i) => i.id !== name);
    controller.indicators.set(next);
    saveIndicators(scope, next);
    indicatorRemoved.set(name);
    // Refresh the row list now (indicatorRemoved only repaints when the removed
    // indicator was the selected one; an unselected removal would otherwise linger
    // until the next 1s tick).
    handle.redrawRef.current();
  }, [controller, scope, indicatorRemoved]);
  const onLegendSelectRow = useCallback((name: string) => {
    const paneId = paneIdOf(name);
    const cur = selectedIndicator.value;
    if (cur?.paneId === paneId && cur?.name === name) return;
    selectedIndicator.set({ paneId, name });
    handle.redrawRef.current();
  }, [paneIdOf]);

  // Copy an indicator's full live config (type + calcParams / visibility / per-line
  // styles / extendData inputs) to the clipboard as JSON. Paste creates a fresh
  // instance of that type with this exact config (TradingView-style). The config
  // shape matches SavedIndicatorConfig so it round-trips through persisted storage.
  const copyIndicator = useCallback((paneId: string, name: string) => {
    const c = chartRef.current;
    if (!c) return;
    const ind = c.getIndicatorByPaneId(paneId, name) as Indicator | null;
    if (!ind) return;
    const payload = {
      __autoTraderIndicator: 1 as const,
      type: indTypeOf(ind), // the real type (EMA/MA/…), NOT the instance id
      config: {
        calcParams: ind.calcParams as number[] | undefined,
        visible: ind.visible,
        styles: ind.styles?.lines
          ? { lines: ind.styles.lines.map((l) => ({ color: l.color, size: l.size })) }
          : undefined,
        extendData: ind.extendData as Record<string, unknown> | undefined,
      } satisfies SavedIndicatorConfig,
    };
    const json = JSON.stringify(payload, null, 2);
    navigator.clipboard?.writeText(json).then(
      () => toast(`Copied ${ind.shortName ?? indTypeOf(ind)} settings`),
      () => toast("Copy failed (clipboard blocked)"),
    );
  }, []);

  // Paste: read the clipboard, and if it holds a copied indicator, ALWAYS add a
  // fresh instance of that type with the copied config (never dedupe — TradingView
  // behaviour). The anchor (AVWAP's calcParams[0]) rides along literally in the
  // config, so a pasted AVWAP keeps the source's exact anchor.
  const pasteIndicator = useCallback(async () => {
    const c = chartRef.current;
    if (!c || snapViewRef.current) return; // read-only snapshot view: no paste
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      toast("Paste failed (clipboard blocked)");
      return;
    }
    let parsed: { __autoTraderIndicator?: number; type?: string; config?: SavedIndicatorConfig };
    try {
      parsed = JSON.parse(text);
    } catch {
      toast("Clipboard has no indicator to paste");
      return;
    }
    if (parsed.__autoTraderIndicator !== 1 || !parsed.type) {
      toast("Clipboard has no indicator to paste");
      return;
    }
    const inst = addIndicatorInstance(c, scope, epicRef.current, parsed.type, {
      config: parsed.config,
      forceHidden: controller.indicatorsHidden.value,
    });
    if (!inst) {
      toast(`Can't paste ${parsed.type}`);
      return;
    }
    // Auto-expand collapsed sub-panes when pasting one in (mirrors the toolbar add).
    if (controller.subPanesHidden.value && isSubPaneIndicator(parsed.type))
      controller.subPanesHidden.set(false);
    const next = [...controller.indicators.value, inst];
    controller.indicators.set(next);
    saveIndicators(scope, next);
    handle.redrawRef.current();
    toast(`Pasted ${parsed.type}`);
  }, [controller, scope]);

  // Ctrl/Cmd+C: copy the SELECTED indicator (if any). Returns true when it acted, so
  // the key handler only swallows the event when there's a selection to copy (else
  // normal text copy still works). Mirrors the legend ⋯ → Copy.
  const copySelectedIndicator = useCallback((): boolean => {
    const sel = selectedIndicator.value;
    if (!sel) return false;
    copyIndicator(sel.paneId, sel.name);
    return true;
  }, [copyIndicator]);

  // --- drawing clipboard (mirrors the indicator clipboard: system clipboard +
  // a tagged JSON envelope, so copy/paste works across cells and tabs) ----------

  // Ctrl/Cmd+C: copy the SELECTED drawing. Returns true when it acted (so the key
  // handler only swallows the event when there was a drawing to copy).
  const copySelectedDrawing = useCallback((): boolean => {
    const id = overlays.getSelectedDrawingId();
    if (!id) return false;
    const d = overlays.getDrawing(id);
    if (!d) return false;
    const payload = {
      __autoTraderDrawing: 1 as const,
      name: d.name,
      points: d.points,
      styles: d.styles,
      visible: d.visible,
      zLevel: d.zLevel,
      extendData: d.extendData,
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(
      () => toast("Copied drawing"),
      () => toast("Copy failed (clipboard blocked)"),
    );
    return true;
  }, [overlays]);

  // Ctrl/Cmd+V: if the clipboard holds a copied drawing, place a duplicate offset a
  // few bars right + a small price delta down so it's visibly distinct from the
  // source (TradingView-style). Returns true when it consumed a drawing payload.
  const pasteDrawing = useCallback(async (): Promise<boolean> => {
    const c = chartRef.current;
    if (!c || snapViewRef.current) return false; // read-only snapshot view: no paste
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      return false;
    }
    let parsed: {
      __autoTraderDrawing?: number;
      name?: string;
      points?: Array<{ timestamp?: number; value?: number }>;
      styles?: unknown;
      visible?: boolean;
      zLevel?: number;
      extendData?: unknown;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (parsed.__autoTraderDrawing !== 1 || !parsed.name || !parsed.points) return false;
    // Offset: +2 bars on the time axis, −0.25% on price, so the paste doesn't land
    // exactly on top of the original. barMs from the smallest adjacent-bar gap.
    const dl = c.getDataList();
    let barMs = 60_000;
    for (let i = 1; i < dl.length; i++) {
      const g = dl[i].timestamp - dl[i - 1].timestamp;
      if (g > 0) {
        barMs = Math.min(barMs === 60_000 ? g : barMs, g);
      }
    }
    const dt = barMs * 2;
    const points = parsed.points.map((p) => ({
      timestamp: p.timestamp != null ? p.timestamp + dt : p.timestamp,
      value: p.value != null ? p.value * 0.9975 : p.value,
    }));
    const id = overlays.placeDrawing({
      name: parsed.name,
      points,
      styles: parsed.styles as never,
      visible: parsed.visible,
      zLevel: parsed.zLevel,
      extendData: parsed.extendData,
    });
    if (id) toast("Pasted drawing");
    return true;
  }, [overlays]);

  // Delete/Backspace: remove the selected drawing (TradingView behaviour).
  const deleteSelectedDrawing = useCallback((): boolean => {
    const id = overlays.getSelectedDrawingId();
    if (!id) return false;
    overlays.remove(id);
    return true;
  }, [overlays]);

  // Pane-aware versions of the legend handlers (the legend ones hardcode
  // candle_pane; a curve right-click can target a sub-pane like RSI/MACD).
  const toggleVisibleOn = useCallback((paneId: string, name: string) => {
    const c = chartRef.current;
    if (!c) return;
    const ind = c.getIndicatorByPaneId(paneId, name) as { visible?: boolean } | null;
    const next = !(ind?.visible ?? true);
    c.overrideIndicator({ name, visible: next }, paneId);
    // A Slope's accel companion follows its parent's visibility. No-ops if absent.
    mirrorAccelCompanion(c, name, { visible: next });
    if (paneId === "candle_pane") saveIndicatorVisible(scope, name, next);
    handle.redrawRef.current();
  }, []);
  const removeOn = useCallback(
    (_paneId: string, name: string) => {
      const c = chartRef.current;
      if (!c) return;
      removeIndicatorById(c, scope, name);
      const next = controller.indicators.value.filter((i) => i.id !== name);
      controller.indicators.set(next);
      saveIndicators(scope, next);
      indicatorRemoved.set(name);
      handle.redrawRef.current();
    },
    [controller, scope, indicatorRemoved],
  );

  // Move a sub-pane to a new slot: rebuild panes, persist the new order, and re-resolve
  // the current selection's paneId (recreate mints new paneIds). No-op for candle_pane.
  const reorderPaneByName = useCallback(
    (name: string, targetIndex: number) => {
      const c = chartRef.current;
      if (!c) return;
      const paneId = paneIdOf(name);
      if (paneId === "candle_pane") return;
      const next = reorderSubPanes(
        c,
        scope,
        epicRef.current,
        controller.indicators.value,
        paneId,
        targetIndex,
      );
      if (!next) return;
      controller.indicators.set(next);
      saveIndicators(scope, next);
      const sel = selectedIndicator.value;
      if (sel) selectedIndicator.set({ paneId: paneIdOf(sel.name), name: sel.name });
      handle.redrawRef.current();
    },
    [paneIdOf, scope, controller, selectedIndicator],
  );

  // Drag a sub-pane by its legend handle: track the pointer against each reorderable
  // pane's vertical band, show a drop-indicator line, and on release move the pane to
  // the hovered slot. Rebuild happens via reorderPaneByName (shared with the menu).
  // Abort an in-flight pane drag if the cell unmounts (tab switch, layout change) —
  // its window listeners would otherwise outlive the chart they close over.
  const paneDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => paneDragCleanupRef.current?.(), []);
  const startPaneReorderDrag = useCallback(
    (paneId: string, name: string) => {
      const c = chartRef.current;
      const wrap = wrapRef.current;
      if (!c || !wrap) return;
      const order = subPaneOrder(c);
      if (order.length < 2 || order.indexOf(paneId) < 0) return;
      const rootTop = wrap.getBoundingClientRect().top;
      const bounds = order.map((pid) => {
        const s = c.getSize(pid, DomPosition.Main);
        const top = s?.top ?? 0;
        return { top, bottom: top + (s?.height ?? 0) };
      });
      const from = order.indexOf(paneId);
      let target = from;
      const move = (ev: PointerEvent) => {
        const y = ev.clientY - rootTop;
        let t = 0;
        for (const b of bounds) {
          if ((b.top + b.bottom) / 2 < y) t++;
          else break;
        }
        // Visual insertion line among the CURRENT panes (includes the moving pane).
        const last = bounds[bounds.length - 1];
        setPaneDropTop(t >= bounds.length ? last.bottom : bounds[t].top);
        // arrayMove target is the final index AFTER removal, so discount the moving
        // pane's own slot when the cursor is below it (downward drag).
        target = Math.max(0, Math.min(order.length - 1, t > from ? t - 1 : t));
      };
      // Shared teardown: pointerup commits, pointercancel (touch/OS gesture
      // takeover — pointerup never follows) and a mid-drag unmount just abort.
      // Without the cancel path the drop indicator sticks and the next unrelated
      // pointerup anywhere would commit a reorder the user never dropped.
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        paneDragCleanupRef.current = null;
        setPaneDropTop(null);
      };
      const cancel = () => cleanup();
      const up = () => {
        cleanup();
        if (target !== from) reorderPaneByName(name, target);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      paneDragCleanupRef.current = cleanup;
    },
    [reorderPaneByName],
  );

  // The shared TradingView-style menu, used by both triggers (legend row + curve).
  const indicatorMenuItems = useCallback(
    (paneId: string, name: string): MenuItem[] => {
      const ind = chartRef.current?.getIndicatorByPaneId(paneId, name) as
        | { visible?: boolean }
        | null;
      const visible = ind?.visible ?? true;
      const order = paneId === "candle_pane" ? [] : subPaneOrder(chartRef.current!);
      const idx = order.indexOf(paneId);
      const moveItems: MenuItem[] =
        idx < 0 || order.length < 2
          ? []
          : [
              ...(idx > 0
                ? [{ label: "Move up", icon: MenuIcons.moveUp, onClick: () => reorderPaneByName(name, idx - 1) }]
                : []),
              ...(idx < order.length - 1
                ? [{ label: "Move down", icon: MenuIcons.moveDown, onClick: () => reorderPaneByName(name, idx + 1) }]
                : []),
            ];
      return [
        {
          label: "Settings",
          icon: MenuIcons.settings,
          onClick: () => indicatorSettingsRequest.set({ paneId, name }),
        },
        { label: "Copy", icon: MenuIcons.copy, onClick: () => copyIndicator(paneId, name) },
        {
          label: visible ? "Hide" : "Show",
          icon: visible ? MenuIcons.hide : MenuIcons.show,
          onClick: () => toggleVisibleOn(paneId, name),
        },
        ...moveItems,
        { label: "Remove", icon: MenuIcons.remove, danger: true, onClick: () => removeOn(paneId, name) },
      ];
    },
    [copyIndicator, toggleVisibleOn, removeOn, reorderPaneByName],
  );

  // The legend's ⋯ "more" button opens the menu (anchored below the button).
  const onLegendOpenMenu = useCallback((name: string, x: number, y: number) => {
    if (snapViewRef.current) return; // read-only snapshot view: no ⋯ edit menu
    setIndMenu({ x, y, paneId: paneIdOf(name), name });
  }, [paneIdOf]);

  return {
    paneIdOf,
    onLegendToggleVisible,
    onLegendOpenSettings,
    onLegendRemove,
    onLegendSelectRow,
    copyIndicator,
    pasteIndicator,
    copySelectedIndicator,
    copySelectedDrawing,
    pasteDrawing,
    deleteSelectedDrawing,
    toggleVisibleOn,
    removeOn,
    reorderPaneByName,
    startPaneReorderDrag,
    indicatorMenuItems,
    onLegendOpenMenu,
  };
}
