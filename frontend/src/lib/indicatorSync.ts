// Storage-level mirror for the "Sync indicators" layout toggle: copy one cell's
// persisted indicator state (instances + configs + AVWAP anchors) onto a sibling
// cell's scope. Same instance ids across cells is the invariant that makes
// settings edits addressable everywhere; anchors re-key to the sibling's own
// epic (a timestamp transfers cleanly across symbols — each cell anchors its
// own symbol's VWAP at the same moment in time).
//
// Runs inside withLayoutEventsSuppressed (a mirror write must not look like a
// user edit: no template autosave, and no re-entry into the App-level
// layout-changed subscription that calls us) and withHistorySuppressed (a
// sibling's undo stack must not record mirrored writes — same rule as
// template apply).
import {
  loadIndicators, saveIndicators,
  loadIndicatorConfigs, saveIndicatorConfig, deleteIndicatorConfig,
  loadAvwapAnchor, saveAvwapAnchor,
} from "./persist";
import { withLayoutEventsSuppressed } from "./persist/layoutEvents";
import { withHistorySuppressed } from "./history";

export interface SyncCellRef {
  scope: string;
  epic: string;
}

export function mirrorIndicatorState(origin: SyncCellRef, sibling: SyncCellRef): string[] {
  return withHistorySuppressed(() =>
    withLayoutEventsSuppressed(() => {
      const srcList = loadIndicators(origin.scope);
      const srcCfgs = loadIndicatorConfigs(origin.scope);
      const dstListBefore = loadIndicators(sibling.scope);
      const dstCfgs = loadIndicatorConfigs(sibling.scope);
      const dstById = new Map(dstListBefore.map((i) => [i.id, i]));

      const changed = new Set<string>();

      // Instance list: full replace (the sibling's set BECOMES the origin's).
      for (const inst of srcList) {
        const prev = dstById.get(inst.id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(inst)) changed.add(inst.id);
      }
      const srcIds = new Set(srcList.map((i) => i.id));
      // Ids leaving the set are "changed" too — the caller's live reconcile
      // (syncIndicatorsFromStorage) is what removes their panes, and it only
      // runs when something changed.
      for (const prev of dstListBefore) {
        if (!srcIds.has(prev.id)) changed.add(prev.id);
      }
      if (
        dstListBefore.length !== srcList.length ||
        dstListBefore.some((i, idx) => JSON.stringify(i) !== JSON.stringify(srcList[idx]))
      ) {
        saveIndicators(sibling.scope, srcList);
      }

      // Configs: copy per id; drop sibling configs whose id left the set.
      for (const inst of srcList) {
        const src = srcCfgs[inst.id];
        const dst = dstCfgs[inst.id];
        if (JSON.stringify(src ?? null) !== JSON.stringify(dst ?? null)) {
          changed.add(inst.id);
          if (src) saveIndicatorConfig(sibling.scope, inst.id, src);
          else deleteIndicatorConfig(sibling.scope, inst.id);
        }
      }
      for (const id of Object.keys(dstCfgs)) {
        if (!srcIds.has(id)) deleteIndicatorConfig(sibling.scope, id);
      }

      // AVWAP anchors: origin's per-epic anchor lands under the sibling's epic.
      for (const inst of srcList) {
        if (inst.type !== "AVWAP") continue;
        const a = loadAvwapAnchor(origin.scope, origin.epic, inst.id);
        if (loadAvwapAnchor(sibling.scope, sibling.epic, inst.id) !== a) {
          changed.add(inst.id);
          saveAvwapAnchor(sibling.scope, sibling.epic, inst.id, a);
        }
      }

      return [...changed];
    }),
  );
}
