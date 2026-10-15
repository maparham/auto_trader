// Bridge between Clerk (which only exists inside <ClerkProvider>) and the
// plain-module API/WS clients. main.tsx's ClerkTokenBridge registers Clerk's
// getToken here; apiFetch and the WS dialers pull from it. With no getter
// registered (local dev, tests) getAuthToken resolves null and everything
// behaves exactly as before auth existed.

export const CLERK_ENABLED = Boolean(
  (import.meta as unknown as { env?: { VITE_CLERK_PUBLISHABLE_KEY?: string } })
    .env?.VITE_CLERK_PUBLISHABLE_KEY,
);

/** `fresh` asks for a newly minted token, bypassing any cache (Clerk's
 *  getToken({skipCache: true})) — the 401-retry path in apiFetch needs a token
 *  that provably post-dates the rejection. */
type TokenGetter = (opts?: { fresh?: boolean }) => Promise<string | null>;

let getter: TokenGetter | null = null;

export function setTokenGetter(fn: TokenGetter | null): void {
  getter = fn;
}

/** True once a token getter is registered (ClerkTokenBridge mounted, or a test
 *  wired one directly via setTokenGetter). Lets apiFetch/the WS dialers take a
 *  fully synchronous no-auth path — not just a null-token one — so dev/test
 *  behavior is byte-identical to before auth existed (no extra microtask
 *  before the underlying fetch/WebSocket call). */
export function hasTokenGetter(): boolean {
  return getter !== null;
}

/** How long a token wait may take. Clerk's getToken() has no timeout of its
 *  own: after a laptop wake or network change its refresh request can sit on
 *  a dead connection for minutes, and every API call waits behind it. */
export const TOKEN_TIMEOUT_MS = 5_000;

/** The token wait outran TOKEN_TIMEOUT_MS. A transport failure, not a dead
 *  session: callers retry rather than sign out. */
export class AuthTokenTimeoutError extends Error {
  constructor() {
    super(`Sign-in token timed out after ${TOKEN_TIMEOUT_MS / 1000}s`);
    this.name = "AuthTokenTimeoutError";
  }
}

export async function getAuthToken(opts?: { fresh?: boolean }): Promise<string | null> {
  if (!getter) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthTokenTimeoutError()), TOKEN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([getter(opts), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
