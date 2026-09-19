// Message dispatch for the Tab Bridge background worker, split out of
// background.js so it can be imported under node's test runner (no `chrome`
// global needed here; `handlers` is passed in already bound to a real or
// fake chrome).
//
// Security invariant: the tab acted on is ALWAYS sender.tab.id, never a
// value carried in the message itself, so a page can only ever affect its
// own tab. Ops for one tab are serialised: a second debugger attach on the
// same tab while one is in flight would fail.
import { OpError, OPS } from "./handlers.js";

export function makeDispatcher(handlers) {
  const queues = new Map(); // tabId -> promise chain

  function serialised(tabId, fn) {
    const prev = queues.get(tabId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(tabId, next);
    next.catch(() => {}).finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); });
    return next;
  }

  return async function handleMessage(msg, sender) {
    const tabId = sender?.tab?.id;
    if (tabId === undefined) {
      return { ok: false, error: { code: "NO_TAB", message: "message did not come from a tab" } };
    }
    const op = msg?.op;
    const known = op === "hello" || OPS.includes(op);
    if (!known) {
      return { ok: false, error: { code: "UNKNOWN_OP", message: `unknown op: ${String(op)}` } };
    }
    try {
      const result = await serialised(tabId, () => handlers[op](tabId, msg?.args ?? {}));
      return { ok: true, result };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof OpError
          ? { code: e.code, message: e.message }
          : { code: "EXTENSION_ERROR", message: String(e?.message ?? e) },
      };
    }
  };
}
