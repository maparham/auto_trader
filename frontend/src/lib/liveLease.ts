export interface BroadcastChannelLike {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

export interface Lease {
  held: boolean;
  onLost: (fn: () => void) => void;
  release: () => void;
}

type Msg = { t: "claim" | "busy" | "release"; key: string };

/** Best-effort single-owner lock across same-browser tabs for one (epic+account)
 *  key. Not distributed — the derived client_order_id is the real dedupe. */
export function acquireLease(
  key: string,
  opts?: { channel?: BroadcastChannelLike },
): Lease {
  const ch: BroadcastChannelLike =
    opts?.channel ?? (new BroadcastChannel(`auto-trader.live.lease`) as BroadcastChannelLike);
  const lostCbs: Array<() => void> = [];
  const lease: Lease = {
    held: true,
    onLost(fn) {
      lostCbs.push(fn);
    },
    release() {
      ch.postMessage({ t: "release", key } as Msg);
      ch.close();
    },
  };

  ch.onmessage = (e) => {
    const m = e.data as Msg;
    if (m.key !== key) return;
    if (m.t === "claim" && lease.held) {
      ch.postMessage({ t: "busy", key } as Msg); // I already own this key
    } else if (m.t === "busy" && lease.held) {
      lease.held = false; // someone else owns it
      for (const fn of lostCbs) fn();
    }
  };
  ch.postMessage({ t: "claim", key } as Msg);
  return lease;
}
