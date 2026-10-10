// Web Push service worker for price alerts. Shows the OS notification unless a
// client tab is focused (the focused tab already showed a toast + played the ping).
self.addEventListener("push", (event) => {
  const p = event.data ? event.data.json() : {};
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    if (clients.some((c) => c.focused)) return;
    const prec = p.precision ?? 2;
    const conds = {
      crossing: "crossed",
      crossing_up: "crossed up",
      crossing_down: "crossed down",
      greater: "above",
      less: "below",
    };
    const cond = conds[p.condition] ?? p.condition ?? "";
    let detail;
    if (p.message) {
      detail = p.message;
    } else if (p.label) {
      const lvl = p.target === "value" ? Number(Number(p.level).toPrecision(6)).toString() : Number(p.level).toFixed(prec);
      detail = `${p.label} ${cond} ${lvl}`;
    } else {
      const lvl = Number(p.level).toFixed(prec);
      detail = `@ ${lvl}`;
    }
    const now = p.target === "value" ? Number(Number(p.subject).toPrecision(6)).toString() : Number(p.price).toFixed(prec);
    await self.registration.showNotification(`🔔 ${p.epic}`, {
      body: `${detail} · now ${now}`,
      tag: `${p.epic}|${p.id}`,
      data: { epic: p.epic, id: p.id },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    if (clients.length) return clients[0].focus();
    return self.clients.openWindow("/");
  })());
});

// --- App-shell cache (mobile PWA; spec 2026-09-07-mobile-companion-design.md).
// Network-first for navigations with a cached fallback, cache-first for hashed
// /assets/ files. This SW must remain the ONLY root-scope SW (push lives here).
const SHELL_CACHE = "shell-v1";
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// Drop stale caches from older SW versions so a future SHELL_CACHE bump doesn't
// leave orphaned caches behind forever.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n))),
    ),
  );
});
