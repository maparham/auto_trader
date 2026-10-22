import { AuthTokenTimeoutError, getAuthToken, hasTokenGetter } from "./authToken";
import { IMPERSONATE_HEADER, impersonatedUserId } from "./impersonation";

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

/** Who a failure is on, from the backend's X-Failure-Cause header: the broker
 * itself, our own server (it stalled), or the user's network path. */
export type FailureCause = "broker" | "server" | "blocked";

/** The X-Failure-Cause a response carries, or null when it names none. */
export function failureCause(res: Response): FailureCause | null {
  // Optional chaining: test stubs may carry no headers at all.
  const v = res.headers?.get("X-Failure-Cause");
  return v === "broker" || v === "server" || v === "blocked" ? v : null;
}

/**
 * The broker (or our own server) failed, as opposed to the user's network
 * blocking it. `who` names which, so poll loops can say "Capital.com isn't
 * responding" or "our server is overloaded" instead of a generic failure.
 */
export class BrokerOutageError extends Error {
  readonly who: "broker" | "server";
  constructor(who: "broker" | "server", message: string) {
    super(message);
    this.name = "BrokerOutageError";
    this.who = who;
  }
}

/**
 * A non-2xx API response, carrying the HTTP status. The status is the part a
 * caller cannot reconstruct from the message: "Not Found" reads the same for a
 * genuine 404 (this epic has no history) and for the 401/403 a dead session
 * gets, but they demand opposite things from the user — refresh later vs sign
 * in again — so callers that must tell them apart branch on `status` instead
 * of string-matching the detail.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The same `errorDetail` text, as an ApiError that keeps the status. */
export async function apiError(res: Response, fallback?: string): Promise<ApiError> {
  return new ApiError(res.status, await errorDetail(res, fallback));
}

/** Throw BrokerBlockedError if a failed response carries the broker-blocked
 *  marker header, or BrokerOutageError if it names the broker or our server as
 *  the cause; otherwise return so the caller raises its usual error. */
export async function throwIfBrokerBlocked(res: Response): Promise<void> {
  if (res.headers.get("X-Broker-Blocked") === "1") {
    throw new BrokerBlockedError(await errorDetail(res));
  }
  const cause = failureCause(res);
  if (cause === "broker" || cause === "server") {
    throw new BrokerOutageError(cause, await errorDetail(res));
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
/** apiFetch for the boot-time pulls (workspace snapshot, alerts) whose
 *  failure has lasting effects: a failed workspace hydrate leaves backend
 *  mirroring off for the whole session. A token wait that timed out is
 *  retried, so a slow first token mint (cold Clerk, poor network) waits up to
 *  `attempts` timeouts instead of failing the boot after one. */
export async function apiFetchPatient(
  input: RequestInfo | URL,
  init?: RequestInit,
  attempts = 3,
): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      return await apiFetch(input, init);
    } catch (err) {
      if (!(err instanceof AuthTokenTimeoutError) || i >= attempts) throw err;
    }
  }
}

function rethrowTimeout(err: unknown): null {
  if (err instanceof AuthTokenTimeoutError) throw err;
  return null;
}

export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const asUser = impersonatedUserId();
  // No getter registered (local dev, most tests): dial fetch directly and
  // synchronously — no `await getAuthToken()` microtask in between — so this
  // really IS fetch, not just "fetch a tick later with no header."
  if (!hasTokenGetter()) {
    if (!asUser) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set(IMPERSONATE_HEADER, asUser);
    return fetch(input, { ...init, headers });
  }
  return (async () => {
    // getAuthToken() (Clerk's getToken()) can reject (network blip, torn-down
    // session): fall back to a tokenless request and let the backend's 401
    // (and the retry machinery around callers) take over — same stance as the
    // three WebSocket dialers (feed / persist / agent bridge).
    // A token wait that timed out is the exception: rethrow it, so the caller
    // sees a transport-style failure and retries, instead of a tokenless 401
    // whose retry would wait on the same hung getter and then sign out.
    const token = await getAuthToken().catch(rethrowTimeout);
    if (!token) {
      if (!asUser) return fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set(IMPERSONATE_HEADER, asUser);
      return fetch(input, { ...init, headers });
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (asUser) headers.set(IMPERSONATE_HEADER, asUser);
    const res = await fetch(input, { ...init, headers });
    if (res.status !== 401) return res;
    // A 401 is not always a dead session: the backend deliberately maps
    // transient JWKS/network failures to 401 (it fails closed), and a ~60s
    // Clerk token can expire in flight. Retry ONCE with a freshly minted
    // token — safe even for writes, since the auth middleware rejected the
    // request before it executed — and sign out only when that retry is also
    // unauthorized. No fresh token at all means the session really is gone.
    const fresh = await getAuthToken({ fresh: true }).catch(rethrowTimeout);
    if (fresh) {
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${fresh}`);
      if (asUser) retryHeaders.set(IMPERSONATE_HEADER, asUser);
      const retry = await fetch(input, { ...init, headers: retryHeaders });
      if (retry.status !== 401) return retry;
      onUnauthorized?.();
      return retry;
    }
    onUnauthorized?.();
    return res;
  })();
}
