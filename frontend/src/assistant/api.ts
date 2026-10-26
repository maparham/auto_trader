import { API_BASE, apiFetch } from "../lib/http";
import { Signal } from "../lib/signals";
import type { AssistantMessage, RequestBody } from "./types";

/** True once /api/assistant/status said the backend holds a key. */
export const assistantConfigured = new Signal<boolean>(false);

/** Asked once at boot, so a tab that boots while the backend restarts (a
 *  deploy) would hide the toolbar button for good. Transient failures retry
 *  with backoff; a definite answer (200, or 403 not admin / demo) ends it. */
export async function fetchAssistantStatus(
  retries = 5, delayMs = 2000,
): Promise<boolean> {
  for (let i = 0; ; i++) {
    let ok = false;
    let definite = false;
    try {
      const res = await apiFetch(`${API_BASE}/api/assistant/status`);
      definite = res.ok || res.status === 403;
      ok = res.ok && (await res.json()).configured === true;
    } catch {
      /* network or token wait: transient */
    }
    if (definite || i >= retries) {
      assistantConfigured.set(ok);
      return ok;
    }
    await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
  }
}

export type PostResult =
  | { ok: true; message: AssistantMessage }
  | { ok: false; status: number; body: string };

export async function postMessages(body: RequestBody, signal: AbortSignal): Promise<PostResult> {
  const res = await apiFetch(`${API_BASE}/api/assistant/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.ok) return { ok: true, message: (await res.json()) as AssistantMessage };
  const text = await res.text();
  try {
    const detail = JSON.parse(text).detail;
    if (detail && typeof detail === "object" && "upstream_status" in detail) {
      return { ok: false, status: Number(detail.upstream_status), body: String(detail.body) };
    }
    return { ok: false, status: res.status, body: typeof detail === "string" ? detail : text };
  } catch {
    return { ok: false, status: res.status, body: text };
  }
}
