// Web Push service worker for price alerts. Shows the OS notification unless a
// client tab is focused (the focused tab already showed a toast + played the ping).
self.addEventListener("push", (event) => {
  const p = event.data ? event.data.json() : {};
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    if (clients.some((c) => c.focused)) return;
    const prec = p.precision ?? 2;
    const detail = p.message || `@ ${Number(p.level).toFixed(prec)}`;
    await self.registration.showNotification(`🔔 ${p.epic}`, {
      body: `${detail} · now ${Number(p.price).toFixed(prec)}`,
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
