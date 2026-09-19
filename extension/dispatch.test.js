import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatcher } from "./dispatch.js";
import { makeHandlers, OpError } from "./handlers.js";
import { fakeChrome } from "./test-helpers.js";

function sender(tabId) {
  return tabId === undefined ? {} : { tab: { id: tabId } };
}

test("tabId always comes from sender.tab.id, never the message", async () => {
  const seen = [];
  const handlers = { hello: async () => ({ version: "x", ops: [] }), screenshot: async (tabId) => { seen.push(tabId); return {}; } };
  const dispatch = makeDispatcher(handlers);
  await dispatch({ op: "screenshot", tabId: 999, args: { tabId: 888 } }, sender(5));
  assert.deepEqual(seen, [5]);
});

test("NO_TAB when the sender has no tab", async () => {
  const dispatch = makeDispatcher({ hello: async () => ({}) });
  const res = await dispatch({ op: "hello" }, sender(undefined));
  assert.deepEqual(res, { ok: false, error: { code: "NO_TAB", message: "message did not come from a tab" } });
});

test("UNKNOWN_OP for an unrecognised op", async () => {
  const dispatch = makeDispatcher({ hello: async () => ({}) });
  const res = await dispatch({ op: "not-a-real-op" }, sender(5));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "UNKNOWN_OP");
});

test("hello answers", async () => {
  const dispatch = makeDispatcher({ hello: async () => ({ version: "1.0.0", ops: ["screenshot", "focus"] }) });
  const res = await dispatch({ op: "hello" }, sender(5));
  assert.deepEqual(res, { ok: true, result: { version: "1.0.0", ops: ["screenshot", "focus"] } });
});

test("an OpError from a handler maps to {ok:false, error:{code,message}}", async () => {
  const handlers = { screenshot: async () => { throw new OpError("CAPTURE_FAILED", "boom"); } };
  const dispatch = makeDispatcher(handlers);
  const res = await dispatch({ op: "screenshot" }, sender(5));
  assert.deepEqual(res, { ok: false, error: { code: "CAPTURE_FAILED", message: "boom" } });
});

test("a non-OpError from a handler maps to EXTENSION_ERROR", async () => {
  const handlers = { screenshot: async () => { throw new Error("plain failure"); } };
  const dispatch = makeDispatcher(handlers);
  const res = await dispatch({ op: "screenshot" }, sender(5));
  assert.deepEqual(res, { ok: false, error: { code: "EXTENSION_ERROR", message: "plain failure" } });
});

test("two screenshots on the same tab run one after the other (second attach after first detach)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { chrome, calls } = fakeChrome({ captureDelay: async () => { await gate; } });
  const handlers = makeHandlers(chrome);
  const dispatch = makeDispatcher(handlers);

  const p1 = dispatch({ op: "screenshot", args: {} }, sender(5));
  // Give the first call's attach/send a tick to run before starting the second.
  await new Promise((r) => setTimeout(r, 0));
  const p2 = dispatch({ op: "screenshot", args: {} }, sender(5));
  // At this point the first capture is still blocked on `gate`, so the
  // second call must not have attached yet.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c[0] === "attach").length, 1);

  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  const order = calls.map((c) => c[0]);
  const firstDetach = order.indexOf("detach");
  const secondAttach = order.indexOf("attach", firstDetach + 1);
  assert.ok(firstDetach !== -1 && secondAttach !== -1, "expected a detach then a second attach");
  assert.ok(secondAttach > firstDetach, "second attach must happen after the first detach");
});

test("two different tabs may interleave", async () => {
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const { chrome, calls } = fakeChrome({
    captureDelay: async (target) => { if (target.tabId === 5) await gateA; },
  });
  const handlers = makeHandlers(chrome);
  const dispatch = makeDispatcher(handlers);

  const pA = dispatch({ op: "screenshot", args: {} }, sender(5));
  await new Promise((r) => setTimeout(r, 0));
  const pB = dispatch({ op: "screenshot", args: {} }, sender(6));
  const resB = await pB;
  assert.equal(resB.ok, true);
  // Tab 6's full attach/send/detach cycle completed while tab 5's capture
  // was still gated, proving the two tabs did not serialise against each
  // other.
  const tab6Detach = calls.some((c) => c[0] === "detach" && c[1].tabId === 6);
  assert.ok(tab6Detach, "tab 6 should have completed independently of tab 5");

  releaseA();
  const resA = await pA;
  assert.equal(resA.ok, true);
});
