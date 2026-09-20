// Touch drawing tool strip (spec: 2026-09-07-mobile-companion-design.md,
// Task 8). A floating ✏️ FAB, bottom-right above the tab bar, that toggles a
// horizontal scrollable strip of drawing tools. Behavior mirrors
// DrawSidebar.arm() (DrawSidebar.tsx:225-249): tools klinecharts doesn't
// support are filtered out (recurringRange is signal-armed, not an overlay,
// so it's always kept in); timeRange/recurringRange arm a controller signal
// instead of going through OverlayManager; everything else calls
// controller.overlays.addDrawing(name). A magnet toggle and, when a drawing
// is selected, Edit/Delete actions round out the strip.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getSupportedOverlays } from "klinecharts";
import DrawGlyph from "../DrawIcons";
import { DRAW_TOOLS } from "../lib/drawTools";
import { magnetSignal, toggleMagnet } from "../lib/magnet";
import { drawingSettingsRequest, requestConfirm } from "../lib/signals";
import { mobileChartCtx } from "./mobileChartState";
import { isDemoMode } from "../lib/demoMode";
import { toast } from "../lib/notify";

export default function MobileDrawBar() {
  const ctx = useSyncExternalStore(
    (fn) => mobileChartCtx.subscribe(fn),
    () => mobileChartCtx.value,
  );
  const magnet = useSyncExternalStore(
    (fn) => magnetSignal.subscribe(fn),
    () => magnetSignal.value,
  );
  const [open, setOpen] = useState(false);
  // Demo drawings round-trip through localStorage only (persist/core gates
  // the mirror off), so the first open of the tool strip says so once.
  const [noted, setNoted] = useState(false);
  function toggleOpen() {
    setOpen((o) => !o);
    if (isDemoMode() && !noted) {
      setNoted(true);
      toast("Drawings stay on this phone. Sign up free to sync them.", {
        onClick: () => location.assign("/?sign_in=1"),
      });
    }
  }

  // OverlayManager.setDrawingListener is single-slot (verified: no other
  // caller in the tree occupies it — ChartCore does not call it as of this
  // task). We claim it while the strip is mounted so the selection-driven
  // action row (Edit/Delete) re-renders live. If that ever changes and the
  // slot is contested, poll on a 500ms interval instead (kept as a fallback
  // comment, not code, since the slot is free today).
  const [, forceRender] = useState(0);
  useEffect(() => {
    const overlays = ctx?.controller.overlays;
    if (!overlays?.setDrawingListener) return;
    const listener = () => forceRender((n) => n + 1);
    overlays.setDrawingListener(listener);
    return () => overlays.setDrawingListener(null);
  }, [ctx?.controller.overlays]);

  if (!ctx) return null;
  const { controller } = ctx;

  const supported = new Set(getSupportedOverlays());
  supported.add("recurringRange");
  const tools = DRAW_TOOLS.filter((t) => supported.has(t.name));
  const selectedId = controller.overlays.getSelectedDrawingId();

  function arm(name: string) {
    if (name === "timeRange" || name === "recurringRange") {
      const sig = name === "timeRange" ? controller.timeRangeArmed : controller.recurringHighlightArmed;
      sig?.set(true);
      controller.focusChart?.();
      setOpen(false);
      return;
    }
    controller.overlays.addDrawing(name);
    controller.focusChart?.();
    setOpen(false);
  }

  return (
    <>
      {open && (
        <div className="m-drawbar-strip">
          {tools.map((t) => (
            <button key={t.name} className="m-drawbar-tool" onClick={() => arm(t.name)}>
              <DrawGlyph name={t.name} />
              <span>{t.label}</span>
            </button>
          ))}
          <button
            className={"m-drawbar-tool m-drawbar-magnet" + (magnet.on ? " on" : "")}
            onClick={toggleMagnet}
          >
            Magnet
          </button>
          {selectedId != null && (
            <>
              <button
                className="m-drawbar-tool"
                onClick={() => drawingSettingsRequest.set({ id: selectedId })}
              >
                Edit
              </button>
              <button
                className="m-drawbar-tool m-drawbar-delete"
                onClick={() =>
                  requestConfirm({
                    message: "Delete this drawing?",
                    onConfirm: () => controller.overlays.remove(selectedId),
                  })
                }
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
      <button
        className="m-drawbar-fab"
        aria-label="Draw"
        onClick={toggleOpen}
      >
        ✏️
      </button>
    </>
  );
}
