// The Android app's push side, run by the mobile shell once signed in.
//
// - registerAppPush: hands the app's FCM device token (the bridge's
//   `fcm_token`) to the backend, which then sends alert fires to this phone.
//   Sent on every boot: the call is idempotent, and a token Firebase rotated
//   or a phone that changed account is fixed the next time the app opens.
// - handleAppLink: a tapped notification opens the app on
//   `?alertEpic=..&alertBroker=..` (go to that chart, as a History row does)
//   or `?removeLevel=<token>` (its Remove SL / Remove TP button: ask, then
//   remove through the same single-use token and checks as Telegram).
import { API_BASE, apiFetch } from "./http";
import { toast } from "./notify";
import { inAndroidApp, shellInvoke } from "./shellBridge";
import { requestConfirm } from "./signals";
import { openMobileAlert } from "../mobile/mobileChartState";

export async function registerAppPush(): Promise<void> {
  if (!inAndroidApp()) return;
  const token = await shellInvoke("fcm_token");
  if (typeof token !== "string" || !token) return;
  try {
    await apiFetch(`${API_BASE}/api/alerts/fcm/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Offline: the next boot sends it again.
  }
}

/** Reads and strips the notification params, then acts on them. */
export function handleAppLink(): void {
  const url = new URL(window.location.href);
  const epic = url.searchParams.get("alertEpic");
  const broker = url.searchParams.get("alertBroker") ?? undefined;
  const removeToken = url.searchParams.get("removeLevel");
  if (!epic && !removeToken) return;
  for (const k of ["alertEpic", "alertBroker", "removeLevel"]) url.searchParams.delete(k);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  if (removeToken) {
    void askRemoveLevel(removeToken);
    return;
  }
  if (epic) openMobileAlert(epic, broker || undefined, 2);
}

async function detail(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : fallback;
  } catch {
    return fallback;
  }
}

async function askRemoveLevel(token: string): Promise<void> {
  const path = `${API_BASE}/api/alerts/position-removal/${encodeURIComponent(token)}`;
  let question: string;
  try {
    const res = await apiFetch(path);
    if (!res.ok) {
      toast(await detail(res, "This warning was already used or has expired"));
      return;
    }
    question = ((await res.json()) as { question: string }).question;
  } catch {
    toast("Could not reach the server. Try again from the notification.");
    return;
  }
  requestConfirm({
    title: "Remove level?",
    message: question,
    confirmLabel: "Remove",
    onConfirm: () => {
      void (async () => {
        try {
          const res = await apiFetch(path, { method: "POST" });
          if (!res.ok) {
            toast(await detail(res, "Could not remove the level"));
            return;
          }
          toast(((await res.json()) as { answer: string }).answer);
        } catch {
          toast("Could not reach the server: check the position at the broker");
        }
      })();
    },
  });
}
