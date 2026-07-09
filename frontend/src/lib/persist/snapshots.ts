import { load, save, removeKeyEverywhere, root, ns } from "./core";
import type {
  IndicatorInstance,
  SavedIndicatorConfig,
  SavedOverlay,
} from "./artifacts";
import type { Instrument, Period } from "../feed";

/** Immutable saved chart state. Blob fields reuse the per-cell persisted shapes verbatim. */
export interface ChartSnapshot {
  id: string;
  name: string;
  note?: string;
  epic: string;
  symbol: Instrument;
  period: Period;
  takenAt: number; // ms
  range: { from: number; to: number }; // visible window at capture, ms
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  drawings: SavedOverlay[];
  avwapAnchors: Record<string, number>; // instance id -> anchor ms
  thumb?: string; // small JPEG data-URI
}

/** Per-restored-scope marker state; pendingRange is cleared after the first scroll-to-range. */
export interface SnapshotMeta {
  snapshotId: string;
  name: string;
  takenAt: number;
  pendingRange?: { from: number; to: number };
}

const snapshotKey = (id: string) => root(`snapshot.${id}`);
const indexKey = () => root("snapshots");
const metaKey = (scope: string) => ns(scope, "snapshotMeta");

export function loadSnapshotIndex(): string[] {
  return load<string[]>(indexKey(), []);
}

export function loadSnapshot(id: string): ChartSnapshot | null {
  return load<ChartSnapshot | null>(snapshotKey(id), null);
}

export function saveSnapshot(s: ChartSnapshot): void {
  save(snapshotKey(s.id), s);
  const idx = loadSnapshotIndex();
  if (!idx.includes(s.id)) save(indexKey(), [s.id, ...idx]);
}

export function deleteSnapshot(id: string): void {
  removeKeyEverywhere(snapshotKey(id));
  save(
    indexKey(),
    loadSnapshotIndex().filter((x) => x !== id),
  );
}

export function loadSnapshotMeta(scope: string): SnapshotMeta | null {
  return load<SnapshotMeta | null>(metaKey(scope), null);
}

export function saveSnapshotMeta(scope: string, m: SnapshotMeta): void {
  save(metaKey(scope), m);
}

export function deleteSnapshotMeta(scope: string): void {
  removeKeyEverywhere(metaKey(scope));
}
