import { getAuthToken, hasTokenGetter } from "./authToken";

// Shared HTTP plumbing for the FastAPI backend: the single base-URL definition
// and the response-error extractor, so every caller (api / feed / trading /
// persist) resolves the same host and surfaces errors identically. The
// `import.meta as unknown` dance (rather than `import.meta.env.*`) keeps this
// usable in the test/node env, where `import.meta.env` may be absent.
export const API_BASE =
  (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env
    ?.VITE_API_BASE ?? "http://localhost:8000";

/**
 * The backend marked this failure as "the user's network blocks the broker"
 * (WAF interstitial upstream — see deps.guarded / X-Broker-Blocked). Typed so
 * poll loops can surface a specific "restricted connection" state instead of
 * treating it as a transient broker hiccup.
 */
export class BrokerBlockedError extends Error {}

/** Throw BrokerBlockedError if a failed response carries the broker-blocked
 *  marker header; otherwise return so the caller raises its usual error. */
export async function throwIfBrokerBlocked(res: Response): Promise<void> {
  if (res.headers.get("X-Broker-Blocked") === "1") {
    throw new BrokerBlockedError(await errorDetail(res));
  }
}

/** "longExit" → "long exit", for prefixing expr rule errors with their group. */
function groupLabel(group: string): string {
  return group.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * Pull the FastAPI `{detail}` from a failed response. Handles the plain string
 * form and the /api/expr structured form ({code, message, start, end, group,
 * row}), where the message is prefixed with the offending rule's location.
 * Falls back to `fallback` when neither fits, else to status + statusText.
 */
export async function errorDetail(res: Response, fallback?: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
    if (body && typeof body.detail?.message === "string") {
      const { message, group, row } = body.detail;
      if (typeof group === "string" && typeof row === "number") {
        return `${groupLabel(group)} rule ${row + 1}: ${message}`;
      }
      return message;
    }
  } catch {
    /* non-JSON body — fall through */
  }
  return fallback ?? `${res.status} ${res.statusText}`.trim();
}

let onUnauthorized: (() => void) | null = null;

/** Called when an authed request gets a 401 (session expired). main.tsx's
 *  ClerkTokenBridge registers Clerk's signOut here. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * fetch with the Clerk session token attached (when signed in). Every backend
 * call goes through this so hosted mode authenticates uniformly; with no
 * token (local dev) it IS fetch. A 401 on an authed call means the session
 * died — notify so the app can sign out cleanly rather than error-spam.
 */
export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // No getter registered (local dev, most tests): dial fetch directly and
  // synchronously — no `await getAuthToken()` microtask in between — so this
  // really IS fetch, not just "fetch a tick later with no header."
  if (!hasTokenGetter()) return fetch(input, init);
  return (async () => {
    // getAuthToken() (Clerk's getToken()) can reject (network blip, torn-down
    // session): fall back to a tokenless request and let the backend's 401
    // (and the retry machinery around callers) take over — same stance as the
    // three WebSocket dialers (feed / persist / agent bridge).
    const token = await getAuthToken().catch(() => null);
    if (!token) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(input, { ...init, headers });
    if (res.status !== 401) return res;
    // A 401 is not always a dead session: the backend deliberately maps
    // transient JWKS/network failures to 401 (it fails closed), and a ~60s
    // Clerk token can expire in flight. Retry ONCE with a freshly minted
    // token — safe even for writes, since the auth middleware rejected the
    // request before it executed — and sign out only when that retry is also
    // unauthorized. No fresh token at all means the session really is gone.
    const fresh = await getAuthToken({ fresh: true }).catch(() => null);
    if (fresh) {
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${fresh}`);
      const retry = await fetch(input, { ...init, headers: retryHeaders });
      if (retry.status !== 401) return retry;
      onUnauthorized?.();
      return retry;
    }
    onUnauthorized?.();
    return res;
  })();
}
