// Per-symbol template AUTO-SAVE. Driven by layoutEvents: when a cell's persisted
// layout changes (a real user edit — merge-applies are suppressed at the emitter),
// ChartCore calls scheduleAutoSave(scope, epic). After a short debounce we capture
// the cell's layout into a SymbolTemplate and write it — but only if it actually
// differs from what's stored (styling edits count; savedAt does not), to avoid
// spraying redundant backend PUTs. An EMPTY capture is saved as an empty template
// (NOT deleted) so clearing a chart makes fresh cells of that symbol open blank.
import { captureSymbolTemplate } from "./templates";
import {
  loadSymbolTemplate,
  saveSymbolTemplate,
  type SymbolTemplate,
} from "./persist";
import { loadSettings } from "../theme";

// Content equality ignoring savedAt. Both sides are built by captureSymbolTemplate
// (or a prior capture round-tripped through JSON), so a stable stringify of the
// content fields is a sound comparison — instance ids are stable across genuine
// edits (only merge-apply mints new ids, and those writes are suppressed).
export function sameTemplate(
  a: SymbolTemplate | null,
  b: SymbolTemplate | null,
): boolean {
  if (!a || !b) return a === b;
  const norm = (t: SymbolTemplate) =>
    JSON.stringify({
      indicators: t.indicators,
      indicatorConfigs: t.indicatorConfigs,
      drawings: t.drawings,
      avwapAnchors: t.avwapAnchors,
    });
  return norm(a) === norm(b);
}

export function maybeAutoSaveTemplate(scope: string, epic: string): void {
  if (!loadSettings().autoSaveTemplates) return;
  const next = captureSymbolTemplate(scope, epic);
  const prev = loadSymbolTemplate(epic);
  if (sameTemplate(prev, next)) return;
  saveSymbolTemplate(next);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 800;

// Debounced per (scope+epic). Coalesces a drag / multi-step edit into one write.
export function scheduleAutoSave(scope: string, epic: string): void {
  const key = `${scope} ${epic}`;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      maybeAutoSaveTemplate(scope, epic);
    }, DEBOUNCE_MS),
  );
}

// Drop a pending debounced save. MUST run on cell/tab teardown: a timer that
// survives the unmount would fire AFTER the scope's storage is purged (closing a
// cell calls purgeScope), capturing an empty layout and overwriting the symbol's
// real template with a blank one (empty-saved-as-empty). Cancelling closes that
// data-loss window.
export function cancelAutoSave(scope: string, epic: string): void {
  const key = `${scope} ${epic}`;
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    timers.delete(key);
  }
}
