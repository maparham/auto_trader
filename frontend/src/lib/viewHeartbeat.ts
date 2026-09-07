// Passive per-symbol "what is the user looking at" record, for the backend's
// alert-time headless chart snapshot (spec: 2026-09-07-telegram-live-chart-
// snapshot-design.md). Written through the MIRRORED persist save() so the
// backend can read it from app_state.db long after every tab is closed. The
// descriptor only IDENTIFIES the view (scope/timeframe/zoom/size); pixels are
// rendered fresh at fire time.
import type { Instrument } from "./feed";
import { brokerRoot, removeKeyEverywhere, save } from "./persist";

export interface ViewDescriptor {
  scope: string; // the cell's persist scope, e.g. "tab.<id>.cell.<id>"
  epic: string;
  broker: string;
  resolution: string; // Period.resolution, e.g. "MINUTE_5"
  symbol: Instrument; // full object so the snapshot page needs no lookup
  barSpace: number; // px per bar (zoom)
  width: number; // chart px size (aspect + zoom reproduction)
  height: number;
  updatedAt: number; // Date.now()
}

export const viewKey = (broker: string, epic: string) =>
  brokerRoot(broker, `view.${epic}`);

const DEBOUNCE_MS = 2000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const latest = new Map<string, Omit<ViewDescriptor, "updatedAt">>();

// Every distinct epic ever viewed gets its own `view.<epic>` key (see viewKey),
// and nothing ever expired one — a long-lived session across many symbols would
// grow this set without bound. Cap it per broker: on each committed write, keep
// only the MAX_HEARTBEATS most-recently-updated views for that broker and drop
// the rest (locally AND from the backend mirror, via removeKeyEverywhere).
const MAX_HEARTBEATS = 30;

function pruneHeartbeats(broker: string): void {
  const prefix = brokerRoot(broker, "view.");
  const entries: { key: string; updatedAt: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    let updatedAt = 0;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      if (parsed && typeof parsed.updatedAt === "number") updatedAt = parsed.updatedAt;
    } catch {
      /* treat as oldest (updatedAt 0) rather than fail the whole prune */
    }
    entries.push({ key, updatedAt });
  }
  if (entries.length <= MAX_HEARTBEATS) return;
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const { key } of entries.slice(MAX_HEARTBEATS)) removeKeyEverywhere(key);
}

function commit(key: string): void {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.delete(key);
  const d = latest.get(key);
  latest.delete(key);
  if (d) {
    save<ViewDescriptor>(key, { ...d, updatedAt: Date.now() });
    pruneHeartbeats(d.broker);
  }
}

export function reportView(d: Omit<ViewDescriptor, "updatedAt">): void {
  const key = viewKey(d.broker, d.epic);
  const t = timers.get(key);
  if (t) clearTimeout(t);
  latest.set(key, d);
  timers.set(
    key,
    setTimeout(() => commit(key), DEBOUNCE_MS),
  );
}

// Test seam: fire pending timers now, writing every debounced view immediately
// (used to flush outside vi.advanceTimersByTime flows, e.g. App unmount paths).
// Nothing calls this in production — a pending heartbeat is simply dropped if
// the tab closes inside the debounce window, which is fine: the previous
// commit for that epic is still on record for the snapshot to fall back on.
export function flushViewHeartbeat(): void {
  for (const key of Array.from(timers.keys())) commit(key);
}
