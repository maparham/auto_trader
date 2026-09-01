// Bridge between Clerk (which only exists inside <ClerkProvider>) and the
// plain-module API/WS clients. main.tsx's ClerkTokenBridge registers Clerk's
// getToken here; apiFetch and the WS dialers pull from it. With no getter
// registered (local dev, tests) getAuthToken resolves null and everything
// behaves exactly as before auth existed.

export const CLERK_ENABLED = Boolean(
  (import.meta as unknown as { env?: { VITE_CLERK_PUBLISHABLE_KEY?: string } })
    .env?.VITE_CLERK_PUBLISHABLE_KEY,
);

type TokenGetter = () => Promise<string | null>;

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

export async function getAuthToken(): Promise<string | null> {
  return getter ? getter() : null;
}
