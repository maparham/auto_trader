// Telegram alert delivery: link/unlink this account's chat to the backend's
// bot, check link+enablement status, and fire a test message (Task 7's
// /api/alerts/telegram/* endpoints). Mirrors pushClient.ts's fetch pattern.

import { API_BASE, apiFetch, errorDetail } from "./http";

const BASE_URL = `${API_BASE}/api/alerts/telegram`;

/** Current link/enablement state. `enabled` reflects whether the backend has
 *  a bot token configured at all; `linked` whether this account has
 *  completed the Telegram deep-link flow. */
export async function getTelegramStatus(): Promise<{ linked: boolean; enabled: boolean }> {
  const res = await apiFetch(BASE_URL);
  if (!res.ok) {
    throw new Error(await errorDetail(res, `GET /api/alerts/telegram failed: ${res.status}`));
  }
  return (await res.json()) as { linked: boolean; enabled: boolean };
}

/** Start the link flow: returns the `t.me/<bot>?start=<code>` deep link for
 *  the caller to open. 503 when the backend has no bot token configured. */
export async function startTelegramLink(): Promise<string> {
  const res = await apiFetch(`${BASE_URL}/link`, { method: "POST" });
  if (!res.ok) {
    throw new Error(await errorDetail(res, `POST /api/alerts/telegram/link failed: ${res.status}`));
  }
  const { url } = (await res.json()) as { url: string };
  return url;
}

/** Unlink this account's Telegram chat. */
export async function unlinkTelegram(): Promise<void> {
  const res = await apiFetch(BASE_URL, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await errorDetail(res, `DELETE /api/alerts/telegram failed: ${res.status}`));
  }
}

/** Fire a test message to the linked chat. 404 if unlinked. */
export async function sendTelegramTest(): Promise<void> {
  const res = await apiFetch(`${BASE_URL}/test`, { method: "POST" });
  if (!res.ok) {
    throw new Error(await errorDetail(res, `POST /api/alerts/telegram/test failed: ${res.status}`));
  }
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Poll `getTelegramStatus` on an interval while the user completes the
 * Telegram deep-link flow in the tab we opened for them. Calls `onLinked`
 * once the backend reports `linked: true`, then stops. Also stops after
 * `timeoutMs` elapses (default 2 min) — including when a poll rejects, so a
 * flaky status call can't pin the interval alive forever. Returns a cancel
 * function the caller can invoke to stop early (e.g. on unmount).
 */
export function pollTelegramLink(
  onLinked: (status: { linked: boolean; enabled: boolean }) => void,
  opts?: { intervalMs?: number; timeoutMs?: number; onTimeout?: () => void },
): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const timer = setInterval(() => {
    if (Date.now() >= deadline) {
      clearInterval(timer);
      opts?.onTimeout?.();
      return;
    }
    void getTelegramStatus().then(
      (status) => {
        if (status.linked) {
          clearInterval(timer);
          onLinked(status);
        }
      },
      () => {
        // Transient failure: keep polling until the deadline check above
        // stops us (or the caller cancels).
      },
    );
  }, intervalMs);

  return () => clearInterval(timer);
}
