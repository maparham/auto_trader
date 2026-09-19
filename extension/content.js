// Relay between the page and the background worker. Accepts only requests
// posted by this same window (never an iframe or a cross-window opener), and
// only frames carrying our namespace, so unrelated postMessage traffic is
// ignored. Injects nothing into the page.
const NS = "tab-bridge";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const f = event.data;
  if (!f || f.ns !== NS || f.dir !== "req" || typeof f.id !== "string") return;
  chrome.runtime.sendMessage({ op: f.op, args: f.args ?? {} }, (reply) => {
    const err = chrome.runtime.lastError;
    const res = err
      ? { ok: false, error: { code: "EXTENSION_ERROR", message: err.message } }
      : reply;
    window.postMessage({ ns: NS, dir: "res", id: f.id, ...res }, "*");
  });
});
