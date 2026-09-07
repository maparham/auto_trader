// Pure logic for the headless snapshot boot (SnapshotApp): URL params and
// heartbeat-descriptor resolution, split from the component for unit tests.
import { load } from "./persist";
import { viewKey, type ViewDescriptor } from "./viewHeartbeat";

export interface SnapshotParams {
  broker: string;
  epic: string;
  level: number | null;
  price: number | null;
  token: string | null;
}

export function parseSnapshotParams(search: string): SnapshotParams | null {
  const q = new URLSearchParams(search);
  if (q.get("snapshot") !== "1") return null;
  const broker = q.get("broker");
  const epic = q.get("epic");
  if (!broker || !epic) return null;
  const num = (k: string) => {
    const v = q.get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return { broker, epic, level: num("level"), price: num("price"), token: q.get("token") };
}

export function resolveDescriptor(broker: string, epic: string): ViewDescriptor | null {
  const d = load<ViewDescriptor | null>(viewKey(broker, epic), null);
  if (!d || typeof d.scope !== "string" || !d.scope || typeof d.resolution !== "string")
    return null;
  return d;
}
