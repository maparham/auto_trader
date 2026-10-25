import { API_BASE, apiFetch } from "../lib/http";
import { Signal } from "../lib/signals";
import type { AssistantMessage, RequestBody } from "./types";

/** True once /api/assistant/status said the backend holds a key. */
export const assistantConfigured = new Signal<boolean>(false);

export async function fetchAssistantStatus(): Promise<boolean> {
  let ok: boolean;
  try {
    const res = await apiFetch(`${API_BASE}/api/assistant/status`);
    ok = res.ok && (await res.json()).configured === true;
  } catch {
    ok = false;
  }
  assistantConfigured.set(ok);
  return ok;
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
