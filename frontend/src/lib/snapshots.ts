import type { Chart } from "klinecharts";
import {
  loadIndicators,
  saveIndicators,
  loadIndicatorConfigs,
  saveIndicatorConfig,
  loadDrawings,
  saveDrawings,
  loadAvwapAnchor,
  saveAvwapAnchor,
  saveSnapshotMeta,
  type ChartSnapshot,
} from "./persist";
import type { Instrument, Period } from "./feed";

let snapSeq = 0;
function mintSnapshotId(): string {
  snapSeq += 1;
  return `snap-${Date.now().toString(36)}-${snapSeq}`;
}

export function defaultSnapshotName(
  symbol: Instrument,
  period: Period,
  takenAt: number,
): string {
  const d = new Date(takenAt);
  const date = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${symbol.epic} ${period.label} · ${date}`;
}

/** Assemble a snapshot from the PERSISTED scope stores (authoritative — kept
 *  current by OverlayManager.persist / saveIndicators on every edit). */
export function captureSnapshot(args: {
  scope: string;
  symbol: Instrument;
  period: Period;
  range: { from: number; to: number };
  thumb?: string;
}): ChartSnapshot {
  const { scope, symbol, period, range, thumb } = args;
  const epic = symbol.epic;
  const indicators = loadIndicators(scope);
  const avwapAnchors: Record<string, number> = {};
  for (const inst of indicators) {
    if (inst.type !== "AVWAP") continue;
    const anchor = loadAvwapAnchor(scope, epic, inst.id);
    if (anchor > 0) avwapAnchors[inst.id] = anchor;
  }
  const takenAt = Date.now();
  return {
    id: mintSnapshotId(),
    name: defaultSnapshotName(symbol, period, takenAt),
    epic,
    symbol,
    period,
    takenAt,
    range,
    indicators,
    indicatorConfigs: loadIndicatorConfigs(scope),
    drawings: loadDrawings(scope, epic),
    avwapAnchors,
    thumb,
  };
}

/** Pre-write a snapshot's blobs into a FRESH scope before its cell mounts.
 *  Order is load-bearing: AVWAP anchors must exist before indicator rehydrate reads them. */
export function writeSnapshotToScope(s: ChartSnapshot, scope: string): void {
  for (const [id, anchor] of Object.entries(s.avwapAnchors)) {
    saveAvwapAnchor(scope, s.epic, id, anchor);
  }
  saveIndicators(scope, s.indicators);
  for (const [id, cfg] of Object.entries(s.indicatorConfigs)) {
    saveIndicatorConfig(scope, id, cfg);
  }
  saveDrawings(scope, s.epic, s.drawings);
  saveSnapshotMeta(scope, {
    snapshotId: s.id,
    name: s.name,
    takenAt: s.takenAt,
    pendingRange: s.range,
  });
}

/** Full-size chart export downscaled to a small JPEG data-URI.
 *  Never throws — a failed thumbnail must not fail the snapshot. */
export function makeChartThumbnail(
  chart: Chart,
  maxWidth = 480,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const url = chart.getConvertPictureUrl(true, "jpeg", "#ffffff");
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxWidth / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const g = canvas.getContext("2d");
          if (!g) return resolve(undefined);
          g.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.75));
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = url;
    } catch {
      resolve(undefined);
    }
  });
}
