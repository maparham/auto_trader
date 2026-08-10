// Fallback broker/account for code that runs before (or without) a live
// /api/brokers fetch: state initializers, persistence namespacing, default
// params. Derived from the last-good cached broker list, so a deployment whose
// backend has no capital creds (e.g. a data-only demo host serving just
// dukascopy/yfinance) defaults onto a broker that actually exists there.
//
// Deliberately zero-dependency (raw localStorage read) so persist/core, feed
// and trading can all import it without a cycle. Capital stays the preferred
// default when registered — the historical behavior.

export const BROKERS_CACHE_KEY = "brokersCache";

interface CachedAccount {
  key: string;
  broker: string;
  env: string;
}
interface CachedInfo {
  data?: string[];
  exec?: CachedAccount[];
}

function cachedInfo(): CachedInfo | null {
  try {
    const raw = localStorage.getItem(BROKERS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedInfo) : null;
  } catch {
    return null; // storage unavailable (node/tests/partitioned iframe) or corrupt
  }
}

/** The broker id to assume when none is known: capital when the backend has it,
 * else the first registered data broker, else capital (first-ever visit). */
export function defaultBrokerId(): string {
  const data = cachedInfo()?.data;
  if (!data?.length || data.includes("capital")) return "capital";
  return data[0];
}

/** The account key to assume when none is persisted: capital:paper when
 * registered, else the first paper account, else the first account at all. */
export function defaultAccount(): string {
  const exec = cachedInfo()?.exec;
  if (!exec?.length) return "capital:paper";
  if (exec.some((a) => a.key === "capital:paper")) return "capital:paper";
  return (exec.find((a) => a.env === "paper") ?? exec[0]).key;
}
