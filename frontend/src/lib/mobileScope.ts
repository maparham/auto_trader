// Which market + drawings scope the mobile shell opens with (spec §1, §2).
import { brokerRoot } from "./persist";
import { resolveDescriptor } from "./snapshotBoot";
import type { ViewDescriptor } from "./viewHeartbeat";
import { fetchFavorites, type Instrument } from "./feed";

export const MOBILE_FALLBACK_SCOPE = "mobile";

function validDescriptor(v: unknown): v is ViewDescriptor {
  const d = v as ViewDescriptor | null;
  return !!d && typeof d.scope === "string" && !!d.scope &&
    typeof d.resolution === "string" && typeof d.epic === "string" &&
    !!d.symbol && typeof d.symbol === "object";
}

export function freshestView(broker: string): ViewDescriptor | null {
  const prefix = brokerRoot(broker, "view.");
  let best: ViewDescriptor | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      if (validDescriptor(parsed) && (best === null || (parsed.updatedAt ?? 0) > (best.updatedAt ?? 0)))
        best = parsed;
    } catch {
      /* junk entry — skip */
    }
  }
  return best;
}

export function mobileDrawScope(broker: string, epic: string): string {
  return resolveDescriptor(broker, epic)?.scope ?? MOBILE_FALLBACK_SCOPE;
}

export async function initialMarket(
  broker: string,
): Promise<{ symbol: Instrument; resolution: string } | null> {
  const d = freshestView(broker);
  if (d) return { symbol: d.symbol, resolution: d.resolution };
  try {
    const favs = await fetchFavorites(broker);
    if (favs.length) return { symbol: favs[0], resolution: "MINUTE_5" };
  } catch {
    /* backend down — caller shows symbol search */
  }
  return null;
}
