// Dispatches ops to handlers.js. The tab acted on is ALWAYS sender.tab.id,
// so a page can only affect itself. Ops for one tab are serialised: a
// second debugger attach on the same tab would fail.
import { makeHandlers, OpError, OPS } from "./handlers.js";

const handlers = makeHandlers(chrome);
const queues = new Map(); // tabId -> promise chain

function serialised(tabId, fn) {
  const prev = queues.get(tabId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(tabId, next);
  next.catch(() => {}).finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); });
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  if (tabId === undefined) {
    sendResponse({ ok: false, error: { code: "NO_TAB", message: "message did not come from a tab" } });
    return false;
  }
  const op = msg?.op;
  const known = op === "hello" || OPS.includes(op);
  if (!known) {
    sendResponse({ ok: false, error: { code: "UNKNOWN_OP", message: `unknown op: ${String(op)}` } });
    return false;
  }
  serialised(tabId, () => handlers[op](tabId, msg.args ?? {}))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({
      ok: false,
      error: e instanceof OpError
        ? { code: e.code, message: e.message }
        : { code: "EXTENSION_ERROR", message: String(e?.message ?? e) },
    }));
  return true; // keep the channel open for the async reply
});
