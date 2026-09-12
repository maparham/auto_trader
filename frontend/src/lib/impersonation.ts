// Admin impersonation: the ONE place that answers "am I viewing the app as
// someone else, and as whom". Every transport reads it from here, so a dialer
// added later cannot silently miss it and produce a split-brain session that
// reads as the target but writes live state as the admin.
//
// sessionStorage, deliberately: per-tab, and it dies with the tab. An
// impersonation that outlived the tab, or leaked into another window, is the
// failure mode worth engineering against.

import { wipeWorkspaceKeys } from "./workspaceKeys";

const KEY = "auto-trader.impersonateUserId";
const EMAIL_KEY = "auto-trader.impersonateEmail";

/** The Clerk id being impersonated, or null. */
export function impersonatedUserId(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const id = (raw ?? "").trim();
    return id || null;
  } catch {
    // Private-mode / disabled storage: treat as "not impersonating" rather
    // than throwing on every request.
    return null;
  }
}

export function isImpersonating(): boolean {
  return impersonatedUserId() !== null;
}

/** Set or clear the target. Callers are enter/exit only (see the banner). */
export function setImpersonatedUserId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* see impersonatedUserId */
  }
}

/** The header the backend reads on HTTP (auth.IMPERSONATE_HEADER). */
export const IMPERSONATE_HEADER = "X-Impersonate-User";

/** Add the impersonation query param to a WebSocket URL. Browsers cannot set
 *  headers on a handshake, which is why the token travels this way too. */
export function withImpersonation(url: string): string {
  const id = impersonatedUserId();
  if (!id) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}impersonate=${encodeURIComponent(id)}`;
}

/** The impersonated user's email, for the banner. Display only. */
export function impersonatedEmail(): string | null {
  try {
    return sessionStorage.getItem(EMAIL_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Start viewing the app as `userId`, then hard-reload.
 *
 * The reload is deliberate: re-plumbing a live app's dialers, caches and
 * hydrated stores mid-flight half-works, and a reload guarantees every module
 * boots in one mode.
 *
 * The wipe is required because the workspace keys are broker-keyed, not
 * user-keyed, and the Clerk client identity does NOT change under this
 * approach, so AccountGate never fires. Without it the target's hydrated
 * workspace would land on top of the admin's own keys. It is safe because the
 * admin's workspace lives on the backend and hydrate is backend-wins-on-load,
 * so it returns on exit. The device-local set (activeLayoutId, scratch,
 * autosave) genuinely does not survive, exactly as when signing in on a new
 * browser, and the confirm dialog says so.
 */
export function enterImpersonation(userId: string, email: string | null): void {
  wipeWorkspaceKeys();
  setImpersonatedUserId(userId);
  try {
    if (email) sessionStorage.setItem(EMAIL_KEY, email);
    else sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* see impersonatedUserId */
  }
  location.assign("/");
}

/** Stop impersonating and return to the console. Wipes again: the target's
 *  workspace is sitting in localStorage right now. */
export function exitImpersonation(): void {
  wipeWorkspaceKeys();
  setImpersonatedUserId(null);
  try {
    sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* see impersonatedUserId */
  }
  location.assign("/admin");
}
