// Candle-cache stats popover — opened by clicking the cache badge in the chart
// legend. Shows this chart's own series stats (coverage/hit-rate/freshness) plus
// a global cache summary underneath. Modeled on InstrumentDetailsModal: draggable,
// Escape-closable, generic label/value rows.

import { useEffect, useState } from "react";
import CloseButton from "./CloseButton";
import {
  fetchCandleCacheStats,
  fetchCandleCacheGlobalStats,
  type CandleCacheStats,
  type CandleCacheGlobalStats,
} from "./lib/feed";
import type { PriceSide } from "./theme";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";

interface Props {
  epic: string;
  resolution: string;
  priceSide: PriceSide;
  brokerId: string;
  title?: string;
  onClose: () => void;
}

function fmtTs(ts: number | null): string {
  if (ts == null) return "never";
  const secs = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function fmtRange(oldest: number | null, newest: number | null): string {
  if (oldest == null || newest == null) return "no cache data";
  const days = Math.max(0, Math.round((newest - oldest) / 86400));
  return `${new Date(oldest * 1000).toISOString().slice(0, 10)} → ${new Date(
    newest * 1000,
  )
    .toISOString()
    .slice(0, 10)} (${days}d)`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hitRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total === 0) return "n/a";
  return `${Math.round((hits / total) * 100)}% (${hits}/${total})`;
}

export default function CandleCacheStatsModal({
  epic,
  resolution,
  priceSide,
  brokerId,
  title,
  onClose,
}: Props) {
  const drag = useDraggable();
  const [series, setSeries] = useState<CandleCacheStats | null>(null);
  const [global, setGlobal] = useState<CandleCacheGlobalStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  // One fetch on open (not polled) — this is a point-in-time debug snapshot.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void Promise.all([
      fetchCandleCacheStats(epic, resolution, priceSide, brokerId),
      fetchCandleCacheGlobalStats(),
    ]).then(([s, g]) => {
      if (cancelled) return;
      if (s || g) {
        setSeries(s);
        setGlobal(g);
        setState("ready");
      } else {
        setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [epic, resolution, priceSide, brokerId]);

  useCloseOnEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal cache-stats-modal"
        style={drag.style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head" {...drag.handleProps}>
          <span className="instrument-title">{title || "Cache stats"}</span>
          <CloseButton onClick={onClose} />
        </div>
        <div className="instrument-body">
          {state === "loading" && <p className="instrument-note">Loading…</p>}
          {state === "error" && (
            <p className="instrument-note">Couldn't load cache stats.</p>
          )}
          {state === "ready" && (
            <>
              <div className="instrument-section">
                <div className="instrument-section-title">This chart</div>
                <dl className="instrument-grid">
                  <div className="instrument-row">
                    <dt>Coverage</dt>
                    <dd>{fmtRange(series?.oldestTs ?? null, series?.newestTs ?? null)}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Cached bars</dt>
                    <dd>{series?.cachedBarCount ?? 0}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Hit rate</dt>
                    <dd>{hitRate(series?.hits ?? 0, series?.misses ?? 0)}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Last fetch</dt>
                    <dd>{fmtTs(series?.lastFetchTs ?? null)}</dd>
                  </div>
                </dl>
              </div>
              <div className="instrument-section">
                <div className="instrument-section-title">Cache overall</div>
                <dl className="instrument-grid">
                  <div className="instrument-row">
                    <dt>Total bars</dt>
                    <dd>{global?.totalBars ?? 0}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>Hit rate</dt>
                    <dd>{hitRate(global?.totalHits ?? 0, global?.totalMisses ?? 0)}</dd>
                  </div>
                  <div className="instrument-row">
                    <dt>DB size</dt>
                    <dd>{fmtBytes(global?.dbSizeBytes ?? 0)}</dd>
                  </div>
                </dl>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
