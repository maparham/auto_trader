// Host-OS notifications + audible ping + in-page toasts for alert firing.
//
// The Web Notifications API (`new Notification`) renders a REAL native banner:
// macOS Notification Center, Windows Action Center, GNOME, etc. It only works
// while a tab is open and after the user grants permission, so we also keep the
// in-page toast as an always-visible fallback and play a sound on every fire.

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

// Current permission, normalized. "unsupported" when the API is missing (e.g.
// some embedded webviews) so the UI can hint at toast-only mode.
export function notifyPermission(): NotifyPermission {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

// Ask for notification permission. Must be called from a user gesture (e.g. the
// "Add alert" click), or browsers ignore it. Resolves to the resulting state so
// the caller can react (e.g. toast "alerts will show in this tab only").
export async function ensureNotifyPermission(): Promise<NotifyPermission> {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function notify(title: string, body: string): void {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, {
        body,
        icon: "/favicon.svg",
        // Tag distinct per fire (timestamp) so each alert surfaces its own
        // banner rather than silently replacing the previous one.
        tag: `auto-trader-alert-${title}-${body}`,
      } as NotificationOptions);
      // Click the banner -> focus the trading tab.
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* some platforms throw if construction isn't allowed; toast still shows */
    }
  }
}

// --- Audible ping ----------------------------------------------------------
// Synthesized with Web Audio so there's no asset to bundle/ship. A short
// two-tone chime, gain-ramped to avoid clicks. The context is created lazily
// and resumed on demand (browsers start it "suspended" until a user gesture).

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// Call once from a user gesture (the bell click) so the AudioContext is unlocked
// and later programmatic plays (from a WS tick) are allowed to make sound.
export function primeSound(): void {
  ctx()?.resume().catch(() => {});
}

export function playPing(): void {
  const ac = ctx();
  if (!ac) return;
  ac.resume().catch(() => {});
  const now = ac.currentTime;
  const gain = ac.createGain();
  gain.connect(ac.destination);
  // Two quick notes (a rising "ding-dong").
  [880, 1175].forEach((freq, i) => {
    const t = now + i * 0.13;
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(g);
    g.connect(gain);
    osc.start(t);
    osc.stop(t + 0.26);
  });
}

function container(): HTMLElement {
  let el = document.getElementById("toast-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-container";
    document.body.appendChild(el);
  }
  return el;
}

// Transient toast that fades out and removes itself.
export function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container().appendChild(el);
  // Force reflow so the fade-in transition runs, then schedule removal.
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4000);
}
