// Web push device enablement: register the `/alert-sw.js` service worker,
// subscribe/unsubscribe with the backend's VAPID key, and mirror the
// subscription to the backend (Task 8's /api/alerts/push/* endpoints). This
// is device-level ("does this browser/device get OS notifications"),
// distinct from the per-alert `notify.push` channel default in Settings.

import { API_BASE, apiFetch } from "./http";

const SW_PATH = "/alert-sw.js";

/** Feature-detect Push API + service worker support (Safari on some OSes,
 *  and any non-secure-context page, lack one or both). */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in globalThis
  );
}

// VAPID key arrives as URL-safe base64 (no padding); pushManager.subscribe
// wants a raw Uint8Array of the decoded bytes.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration(SW_PATH);
}

/** Whether this device already holds a live push subscription. */
export async function isSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}

/** Register the SW, subscribe with the backend's VAPID key, and POST the
 *  subscription so the backend can push to this device. */
export async function subscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.register(SW_PATH);

  const vapidRes = await apiFetch(`${API_BASE}/api/alerts/push/vapid`);
  if (!vapidRes.ok) {
    throw new Error(`GET /api/alerts/push/vapid failed: ${vapidRes.status}`);
  }
  const { key } = (await vapidRes.json()) as { key: string };

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };

  const res = await apiFetch(`${API_BASE}/api/alerts/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint ?? sub.endpoint, keys: json.keys }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/alerts/push/subscribe failed: ${res.status}`);
  }
}

/** Tell the backend to stop pushing to this device's current subscription,
 *  then tear it down locally. No-op if the device was never subscribed. */
export async function unsubscribePush(): Promise<void> {
  const reg = await getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  await apiFetch(`${API_BASE}/api/alerts/push/subscribe`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
}
