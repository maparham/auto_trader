// Host-OS notifications + audible ping + in-page toasts for alert firing.
//
// The Web Notifications API (`new Notification`) renders a REAL native banner:
// macOS Notification Center, Windows Action Center, GNOME, etc. It only works
// while a tab is open and after the user grants permission, so we also keep the
// in-page toast as an always-visible fallback and play a sound on every fire.

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

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

// `tag` (when given) is a stable per-alert identity: a repeat fire REPLACES the
// previous banner in Notification Center instead of stacking, and `renotify`
// keeps it re-alerting (sound/banner) on each replacement. Without a tag, each
// call gets a distinct banner as before.
export function notify(title: string, body: string, onClick?: () => void, tag?: string): void {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, {
        body,
        icon: "/favicon.svg",
        tag: `auto-trader-alert-${tag ?? `${title}-${body}`}`,
        ...(tag ? { renotify: true } : null),
      } as NotificationOptions);
      // Click the banner -> focus the trading tab (and let the caller navigate,
      // e.g. jump to the chart the alert belongs to).
      n.onclick = () => {
        window.focus();
        onClick?.();
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

// Most toasts kept on screen at once. Eviction prefers the oldest NON-sticky
// toast (sticky alert toasts hold their "stays until acted on" contract as long
// as possible) and always goes through that toast's own dismiss() so its
// visibilitychange hook is removed and the fade-out runs.
const MAX_TOASTS = 5;
const dismissers = new WeakMap<Element, () => void>();
// Live keyed toasts (coalescing): key -> the on-screen toast element for that
// key, so a repeat fire updates it in place instead of stacking a duplicate.
const keyed = new Map<string, HTMLElement>();

function container(): HTMLElement {
  let el = document.getElementById("toast-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-container";
    document.body.appendChild(el);
  }
  return el;
}

// Toast. `onClick` makes it clickable (pointer cursor, dismisses immediately
// after running the handler); `duration` overrides the default auto-dismiss,
// and `duration: null` makes the toast STICKY — it stays until clicked or
// dismissed via the × button that a sticky toast always carries.
//
// `key` coalesces repeats: while a toast with the same key is still on screen,
// a new call updates it in place — message refreshed, a ×N badge incremented,
// a brief pulse to draw the eye — instead of stacking a duplicate. Once
// dismissed, the next fire for that key starts a fresh toast (count reset).
//
// Hidden-tab contract: alerts fire from the background engine, so a toast often
// lands while this browser tab is HIDDEN — where rAF never runs (the fade-in
// class is never applied, the toast stays at opacity 0) while plain timers keep
// running and would remove the never-painted toast before the user returns. So
// the fade-in class is applied synchronously (forced reflow, no rAF) and the
// auto-dismiss countdown only starts once the tab is visible.
export function toast(
  message: string,
  opts: { onClick?: () => void; duration?: number | null; key?: string } = {},
): void {
  const sticky = opts.duration === null;
  if (opts.key) {
    const live = keyed.get(opts.key);
    // `isConnected` guards against a stale entry whose element left the DOM
    // without going through its dismiss() (e.g. dropped as a foreign node).
    if (live && live.isConnected && !live.classList.contains("closing")) {
      // Repeat fire for an on-screen toast: update in place.
      const count = Number(live.dataset.count ?? "1") + 1;
      live.dataset.count = String(count);
      live.querySelector(".toast-msg")!.textContent = message;
      let badge = live.querySelector(".toast-count");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "toast-count";
        // Before the × button so the badge sits with the message text.
        live.insertBefore(badge, live.querySelector(".toast-close"));
      }
      badge.textContent = `×${count}`;
      // Re-trigger the pulse animation (forced reflow, same no-rAF contract as
      // the fade-in below — must work behind a hidden tab).
      live.classList.remove("bump");
      void live.offsetHeight;
      live.classList.add("bump");
      return;
    }
  }
  const el = document.createElement("div");
  el.className = "toast";
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.appendChild(msg);
  let onVis: (() => void) | null = null;
  const dismiss = () => {
    if (el.classList.contains("closing")) return; // already fading out
    if (onVis) document.removeEventListener("visibilitychange", onVis);
    // Release the key only if it still points at THIS element (a fresh toast
    // may already have re-claimed it while this one fades).
    if (opts.key && keyed.get(opts.key) === el) keyed.delete(opts.key);
    // `closing` excludes the fading toast from the cap count below.
    el.classList.add("closing");
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  };
  dismissers.set(el, dismiss);
  if (opts.key) keyed.set(opts.key, el);
  if (sticky) el.classList.add("sticky");
  if (opts.onClick) {
    el.classList.add("clickable");
    el.addEventListener("click", () => {
      opts.onClick?.();
      dismiss();
    });
  }
  if (sticky) {
    // A sticky toast needs an explicit dismissal path that doesn't trigger the
    // click action. pointer-events re-enabled on the button (the container is
    // none) so it stays clickable even on a toast without onClick.
    const x = document.createElement("button");
    x.className = "toast-close";
    x.textContent = "×";
    x.title = "Dismiss";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
    });
    el.appendChild(x);
  }
  const box = container();
  // Cap the stack: an "every" alert firing repeatedly behind a hidden tab would
  // otherwise pile up sticky toasts without bound and wall off the chart on
  // return. Fading (`closing`) toasts don't count — their slot is already
  // freeing. Evict the oldest non-sticky toast first; only when everything on
  // screen is a sticky alert does the oldest sticky one go.
  const live = () => [...box.children].filter((c) => !c.classList.contains("closing"));
  for (let l = live(); l.length >= MAX_TOASTS; l = live()) {
    const victim = l.find((c) => !c.classList.contains("sticky")) ?? l[0];
    const d = dismissers.get(victim);
    if (d) d();
    else victim.remove(); // foreign node in the container — drop it so the loop can't spin
  }
  box.appendChild(el);
  // Force a synchronous reflow so the fade-in transition runs — NOT rAF, which
  // never fires in a hidden tab (the toast would sit unpainted at opacity 0).
  void el.offsetHeight;
  el.classList.add("show");
  if (sticky) return;
  // The auto-dismiss countdown starts only once the tab is visible.
  const start = () => {
    setTimeout(dismiss, opts.duration ?? 4000);
  };
  if (document.visibilityState === "visible") start();
  else {
    onVis = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVis!);
      onVis = null;
      start();
    };
    document.addEventListener("visibilitychange", onVis);
  }
}
