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
import { type Indicator } from "klinecharts";
import {
  removeIndicatorById,
  addIndicatorInstance,
  applyIndicator,
  applyIndicatorVisibility,
  isSubPaneIndicator,
  reorderSubPanes,
  subPaneOrder,
  mirrorAccelCompanion,
  getIndicator,
  getIndicatorsByPane,
} from "../lib/indicators";
import { refuseClipboardCopy } from "../lib/replayClipboard";
import { INSET_CAPABLE, isInsetInstance, withInset } from "../lib/indicators/inset";
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
  cellId: string;
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
  const { cellId, scope, period, snapViewRef, wrapRef, setPaneDropTop, setIndMenu } = deps;
  const { chartRef, epicRef, overlays, controller } = handle;
  const { selectedIndicator, indicatorRemoved } = controller;

  const paneIdOf = useCallback((name: string): string => {
    const c = chartRef.current;
    const all = c ? getIndicatorsByPane(c) : undefined;
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
    const ind = getIndicator(c, paneId, name) as
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
    c.overrideIndicator({ paneId, name, extendData: ext, visible: next && isVisibleOnResolution(vis, period.resolution) });
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
  const onLegendSelectRow = useCallback((name: string, figureKey?: string) => {
    const paneId = paneIdOf(name);
    if (controller.indicatorPickArmed.value) {
      // "Pick from chart" is armed: publish the clicked instance for the panel
      // instead of selecting it (mirrors the curve-hit path in ChartCore). The
      // figure key, when the click landed on a legend readout (ATR%), picks
      // that figure's output; unarmed clicks ignore it — a figure click is
      // just a row click for selection purposes.
      controller.indicatorPickResult.set({
        paneId, name, ...(figureKey ? { figureKey } : {}),
      });
      return;
    }
    const cur = selectedIndicator.value;
    if (cur?.paneId === paneId && cur?.name === name) return;
    selectedIndicator.set({ paneId, name });
    handle.redrawRef.current();
  }, [paneIdOf, controller]);

  // Snapshot an indicator's full live config (type + calcParams / visibility /
  // per-line styles / extendData inputs). Shared by Copy (→ clipboard JSON) and
  // Duplicate (→ straight back into addFromConfig). The config shape matches
  // SavedIndicatorConfig so it round-trips through persisted storage.
  const liveIndicatorConfig = useCallback(
    (paneId: string, name: string): { type: string; config: SavedIndicatorConfig; label: string } | null => {
      const c = chartRef.current;
      if (!c) return null;
      const ind = getIndicator(c, paneId, name) as Indicator | null;
      if (!ind) return null;
      return {
        type: indTypeOf(ind), // the real type (EMA/MA/…), NOT the instance id
        label: ind.shortName ?? indTypeOf(ind),
        config: {
          calcParams: ind.calcParams as number[] | undefined,
          visible: ind.visible,
          styles: ind.styles?.lines
            ? { lines: ind.styles.lines.map((l) => ({ color: l.color, size: l.size })) }
            : undefined,
          extendData: ind.extendData as Record<string, unknown> | undefined,
        } satisfies SavedIndicatorConfig,
      };
    },
    [],
  );

  // Add a fresh instance of `type` carrying `config`, and do everything a new
  // instance needs: honour the hide-all mask, un-collapse the sub-pane stack,
  // publish + persist the new instance list, redraw. Shared by Paste and
  // Duplicate so neither can drift out of the other's steps.
  const addFromConfig = useCallback(
    (type: string, config: SavedIndicatorConfig | undefined): boolean => {
      const c = chartRef.current;
      if (!c) return false;
      const inst = addIndicatorInstance(c, scope, epicRef.current, type, {
        config,
        forceHidden: controller.indicatorsHidden.value,
        resolution: period.resolution,
      });
      if (!inst) return false;
      // Auto-expand collapsed sub-panes when adding one in (mirrors the toolbar add).
      if (controller.subPanesHidden.value && isSubPaneIndicator(type))
        controller.subPanesHidden.set(false);
      const next = [...controller.indicators.value, inst];
      controller.indicators.set(next);
      saveIndicators(scope, next);
      handle.redrawRef.current();
      return true;
    },
    [controller, scope, period.resolution],
  );

  // Both clipboard copies below go through the shared gate in
  // lib/replayClipboard — the drawing envelope is also written from the Toolbar's
  // right-click menu, and the two must refuse together.
  const refuseCopyWhileMasked = useCallback(() => refuseClipboardCopy(cellId), [cellId]);

  // Copy an indicator's live config to the clipboard as JSON. Paste creates a fresh
  // instance of that type with this exact config (TradingView-style).
  const copyIndicator = useCallback((paneId: string, name: string) => {
    if (refuseCopyWhileMasked()) return;
    const snap = liveIndicatorConfig(paneId, name);
    if (!snap) return;
    const payload = { __autoTraderIndicator: 1 as const, type: snap.type, config: snap.config };
    const json = JSON.stringify(payload, null, 2);
    navigator.clipboard?.writeText(json).then(
      () => toast(`Copied ${snap.label} settings`),
      () => toast("Copy failed (clipboard blocked)"),
    );
  }, [liveIndicatorConfig, refuseCopyWhileMasked]);

  // Duplicate: a second instance of this indicator with the SAME live settings,
  // without going through the clipboard (so it neither needs clipboard permission
  // nor clobbers what the user has copied). Same add path as Paste, so the copy
  // lands with the hide-all mask, sub-pane un-collapse and persistence applied.
  const duplicateIndicator = useCallback(
    (paneId: string, name: string) => {
      if (snapViewRef.current) return; // read-only snapshot view: no duplicate
      const snap = liveIndicatorConfig(paneId, name);
      if (!snap) return;
      toast(addFromConfig(snap.type, snap.config) ? `Duplicated ${snap.label}` : `Can't duplicate ${snap.label}`);
    },
    [liveIndicatorConfig, addFromConfig],
  );

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
    if (!addFromConfig(parsed.type, parsed.config)) {
      toast(`Can't paste ${parsed.type}`);
      return;
    }
    toast(`Pasted ${parsed.type}`);
  }, [addFromConfig]);

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
    // Returns TRUE: the key press was for this drawing and must not fall through
    // to the browser's own copy, which would put the page selection on the
    // clipboard instead.
    if (refuseCopyWhileMasked()) return true;
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
  }, [overlays, refuseCopyWhileMasked]);

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
    const ind = getIndicator(c, paneId, name) as
      | { visible?: boolean; extendData?: unknown }
      | null;
    const next = !(ind?.visible ?? true);
    // Write the SAME extendData.userVisible + isVisibleOnResolution pair the legend
    // eye path writes (onLegendToggleVisible above). Writing only the live `visible`
    // flag leaves a stale userVisible behind, and applyIndicatorVisibility computes
    // intent as `ext.userVisible ?? ind.visible` — so the next visibility sweep
    // re-hides an indicator the user just Showed from this menu. setIndicatorInset
    // runs such a sweep, which made "toggle inset" silently undo a menu Show.
    const ext = { ...((ind?.extendData as object) ?? {}), userVisible: next };
    const vis = (ext as { visibility?: VisibilityModel }).visibility ?? defaultVisibility();
    const visible = next && isVisibleOnResolution(vis, period.resolution);
    c.overrideIndicator({ paneId, name, extendData: ext, visible });
    // Persist for EVERY pane, matching the legend eye path above (which has always
    // been pane-agnostic). Inset moves an instance between panes, so a candle-pane
    // guard here would make the same indicator's Hide persist or not depending on
    // which mode it happened to be in.
    saveIndicatorVisible(scope, name, next);
    // A Slope's accel companion follows its parent's visibility. No-ops if absent.
    // mirrorAccelCompanion strips the inset marker itself (withoutInset), so the
    // parent's ext can be forwarded as-is. Ordered after the persist so the whole
    // body reads in the same sequence as onLegendToggleVisible.
    mirrorAccelCompanion(c, name, { extendData: ext, visible });
    handle.redrawRef.current();
    // period.resolution is read above, so it has to be a dependency (the legend eye
    // path lists it for the same reason); an empty array would freeze it at the
    // first-render value and stale it on every timeframe switch.
  }, [period.resolution]);
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

  // Move an instance between its own sub-pane and the candle pane's inset band.
  // klinecharts has no "change an indicator's pane" API, so this is a teardown +
  // recreate, exactly like reorderSubPanes. chart.removeIndicator directly, NOT
  // removeIndicatorById: that one also deletes the persisted config, which would
  // throw away the instance's params and colors on every toggle.
  const setIndicatorInset = useCallback(
    (_paneId: string, name: string, on: boolean) => {
      const c = chartRef.current;
      if (!c) return;
      const next = withInset(controller.indicators.value, name, on);
      const inst = next.find((i) => i.id === name);
      if (!inst) return;
      // Resolve the pane LIVE rather than trusting the one captured when the menu
      // opened (reorderPaneByName takes only `name` for the same reason). A tab
      // sync, a template apply or a resolution change can recreate panes while a
      // menu is open, and a stale id makes removeIndicator silently no-op — the
      // applyIndicator below would then mint a SECOND live indicator under this
      // name, breaking the uniqueness invariant mintInstanceId depends on.
      const paneId = paneIdOf(name);
      c.removeIndicator({ paneId, name });
      controller.indicators.set(next);
      saveIndicators(scope, next);
      // Leaving inset materializes a sub-pane, so un-collapse if the master
      // "hide sub-panes" switch is on — otherwise the recreated pane lands in a
      // collapsed stack and the indicator reads as gone (same one-liner the
      // toolbar add / paste / template-apply paths use for the same reason).
      if (!on && controller.subPanesHidden.value) controller.subPanesHidden.set(false);
      applyIndicator(c, scope, epicRef.current, inst, { rehydrate: true });
      // A recreated instance comes back at its CONFIG's visibility, which knows
      // nothing about the sidebar's hide-all mask or the per-resolution visibility
      // model — both are view state that applyIndicatorVisibility computes and
      // deliberately never persists. Without this sweep, toggling inset while
      // "Hide indicators" is on brings the indicator back on screen under a switch
      // that says hidden. syncIndicatorsFromStorage re-asserts it after its own
      // teardown + rehydrate rebuild for exactly this reason.
      applyIndicatorVisibility(c, period.resolution, controller.indicatorsHidden.value);
      // A recreate mints a new paneId, so a selection pointing at this instance
      // (or at a pane the recreate reshuffled) must be re-resolved — same reason
      // reorderPaneByName does it below.
      const sel = selectedIndicator.value;
      if (sel) selectedIndicator.set({ paneId: paneIdOf(sel.name), name: sel.name });
      handle.redrawRef.current();
    },
    [controller, scope, paneIdOf, selectedIndicator, period.resolution],
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
        const s = c.getSize(pid, 'main');
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
      const c = chartRef.current;
      const ind = c
        ? (getIndicator(c, paneId, name) as { visible?: boolean; extendData?: unknown } | null)
        : null;
      const visible = ind?.visible ?? true;
      const inset = isInsetInstance({ name, extendData: ind?.extendData });
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
        { label: "Duplicate", icon: MenuIcons.clone, onClick: () => duplicateIndicator(paneId, name) },
        {
          label: visible ? "Hide" : "Show",
          icon: visible ? MenuIcons.hide : MenuIcons.show,
          onClick: () => toggleVisibleOn(paneId, name),
        },
        ...moveItems,
        ...(INSET_CAPABLE.has(indTypeOf({ name, extendData: ind?.extendData }))
          ? [
              {
                label: inset ? "Show in own pane" : "Show as inset",
                icon: MenuIcons.inset,
                onClick: () => setIndicatorInset(paneId, name, !inset),
              },
            ]
          : []),
        { label: "Remove", icon: MenuIcons.remove, danger: true, onClick: () => removeOn(paneId, name) },
      ];
    },
    [copyIndicator, duplicateIndicator, toggleVisibleOn, removeOn, reorderPaneByName, setIndicatorInset],
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
    duplicateIndicator,
    pasteIndicator,
    copySelectedIndicator,
    copySelectedDrawing,
    pasteDrawing,
    deleteSelectedDrawing,
    toggleVisibleOn,
    removeOn,
    setIndicatorInset,
    reorderPaneByName,
    startPaneReorderDrag,
    indicatorMenuItems,
    onLegendOpenMenu,
  };
}
