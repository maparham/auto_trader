// The drawing context menu (Re-align/Settings/Clone/Copy/z-order/Lock/Delete),
// opened by a right-click on a drawing or alert line. Shared by the desktop
// Toolbar and the mobile chart view, where ChartCore turns a touch long press
// into the same right-click (see onTouchDown there) and the selection handle
// asks for it through drawingMenuRequest.
import { useEffect, useState } from "react";
import ContextMenu from "./ContextMenu";
import type { ChartController } from "./lib/chartController";
import { MenuIcons } from "./lib/menuIcons";
import { refuseClipboardCopy } from "./lib/replayClipboard";
import { drawingMenuRequest, drawingSettingsRequest } from "./lib/signals";

interface DrawMenu {
  x: number;
  y: number;
  id: string;
  locked: boolean;
}

export default function DrawingContextMenu({ controller }: { controller: ChartController | null }) {
  const [drawMenu, setDrawMenu] = useState<DrawMenu | null>(null);
  const overlays = controller?.overlays ?? null;

  // Right-clicking any overlay (drawn live or rehydrated) opens the menu.
  // Bound to the given cell's overlay manager; re-bind when it changes.
  useEffect(() => {
    const ov = controller?.overlays;
    if (!ov) return;
    ov.setRightClickHandler((e) =>
      setDrawMenu({
        x: e.pageX ?? 0,
        y: e.pageY ?? 0,
        id: e.overlay.id,
        locked: e.overlay.lock,
      }),
    );
    return () => ov.setRightClickHandler(null);
  }, [controller]);

  useEffect(
    () =>
      drawingMenuRequest.subscribe((req) => {
        const d = req && controller?.overlays.getDrawing(req.id);
        if (req && d) setDrawMenu({ x: req.x, y: req.y, id: req.id, locked: d.lock });
      }),
    [controller],
  );

  // Copy the right-clicked drawing to the system clipboard, in the same tagged
  // envelope ChartCore's Ctrl/Cmd+C uses, so menu-copy and keyboard-copy are
  // interchangeable (and a menu-copied drawing pastes with Ctrl/Cmd+V).
  //
  // Interchangeable includes REFUSING together: the payload's points are bar
  // timestamps, so on a blind cell this writes the session's real dates onto the
  // system clipboard. Same gate as the keyboard path, from one module, because
  // "the other one is gated" is what made this a hole the first time.
  function copyDrawing(id: string) {
    // No controller means no focused cell, so nothing can be masked either.
    if (controller && refuseClipboardCopy(controller.cellId)) return;
    const d = overlays?.getDrawing(id);
    if (!d) return;
    const payload = {
      __autoTraderDrawing: 1 as const,
      name: d.name,
      points: d.points,
      styles: d.styles,
      visible: d.visible,
      zLevel: d.zLevel,
      extendData: d.extendData,
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  }

  // Clone in place: duplicate the drawing offset a little (the chart-side ⌘-drag
  // clone reuses this via placeDrawing too). Offset by a small price delta only —
  // a menu clone has no drag, so just nudge it so it's visibly distinct.
  function cloneDrawing(id: string) {
    const d = overlays?.getDrawing(id);
    if (!d) return;
    overlays?.placeDrawing({
      name: d.name,
      points: d.points.map((p) => ({
        timestamp: p.timestamp,
        value: p.value != null ? p.value * 0.9975 : p.value,
      })),
      styles: d.styles,
      visible: d.visible,
      zLevel: d.zLevel,
      extendData: d.extendData,
    });
  }

  if (!drawMenu) return null;
  const items = [
    // Only a ghost the user has placed by hand: re-aligning one that is
    // already tracking the candles under it would do nothing visible.
    ...(overlays?.isPinnedGhost(drawMenu.id)
      ? [
          {
            label: "Re-align",
            icon: MenuIcons.realign,
            onClick: () => overlays?.realignGhost(drawMenu.id),
          },
        ]
      : []),
    { label: "Settings", icon: MenuIcons.settings, onClick: () => drawingSettingsRequest.set({ id: drawMenu.id }) },
    { label: "Clone", icon: MenuIcons.clone, onClick: () => cloneDrawing(drawMenu.id) },
    { label: "Copy", icon: MenuIcons.copy, onClick: () => copyDrawing(drawMenu.id) },
    { label: "Bring to front", icon: MenuIcons.bringFront, onClick: () => overlays?.bringToFront(drawMenu.id) },
    { label: "Send to back", icon: MenuIcons.sendBack, onClick: () => overlays?.sendToBack(drawMenu.id) },
    {
      label: drawMenu.locked ? "Unlock" : "Lock",
      icon: drawMenu.locked ? MenuIcons.unlock : MenuIcons.lock,
      onClick: () => overlays?.setLock(drawMenu.id, !drawMenu.locked),
    },
    {
      label: "Delete",
      icon: MenuIcons.remove,
      danger: true,
      onClick: () => overlays?.remove(drawMenu.id),
    },
  ];
  return <ContextMenu x={drawMenu.x} y={drawMenu.y} items={items} onClose={() => setDrawMenu(null)} />;
}
