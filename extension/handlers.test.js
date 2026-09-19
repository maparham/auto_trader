import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandlers, OpError, OPS, VERSION } from "./handlers.js";
import { fakeChrome } from "./test-helpers.js";

test("hello reports version and ops", async () => {
  const { chrome } = fakeChrome();
  const h = makeHandlers(chrome);
  assert.deepEqual(await h.hello(5), { version: VERSION, ops: OPS });
});

test("screenshot attaches, captures with a scaled clip, detaches", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  const res = await h.screenshot(5, {
    clip: { x: 10, y: 20, width: 300, height: 200 }, format: "png", scale: 2,
  });
  assert.deepEqual(res, { mime: "image/png", image_base64: "QUJD", width: 300, height: 200 });
  assert.deepEqual(calls[0], ["attach", { tabId: 5 }, "1.3"]);
  assert.equal(calls[1][2], "Page.captureScreenshot");
  assert.deepEqual(calls[1][3], {
    format: "png", fromSurface: true,
    clip: { x: 10, y: 20, width: 300, height: 200, scale: 2 },
  });
  assert.deepEqual(calls[2], ["detach", { tabId: 5 }]);
});

test("screenshot passes jpeg quality and omits clip when absent", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  const res = await h.screenshot(5, { format: "jpeg", quality: 70 });
  assert.equal(res.mime, "image/jpeg");
  assert.deepEqual(calls[1][3], { format: "jpeg", quality: 70, fromSurface: true });
  assert.equal(res.width, null);
});

test("screenshot detaches even when capture throws, as CAPTURE_FAILED", async () => {
  const { chrome, calls } = fakeChrome();
  chrome.debugger.sendCommand = async () => { throw new Error("boom"); };
  const h = makeHandlers(chrome);
  await assert.rejects(h.screenshot(5, {}), (e) => e instanceof OpError && e.code === "CAPTURE_FAILED");
  assert.deepEqual(calls.at(-1), ["detach", { tabId: 5 }]);
});

test("screenshot reports DEBUGGER_BUSY when attach is refused", async () => {
  const { chrome, calls } = fakeChrome({ attachError: "Another debugger is already attached" });
  const h = makeHandlers(chrome);
  await assert.rejects(h.screenshot(5, {}), (e) => e instanceof OpError && e.code === "DEBUGGER_BUSY");
  assert.ok(!calls.some((c) => c[0] === "detach"), "no detach after a failed attach");
});

test("screenshot rejects a malformed clip with INVALID_ARGS before attaching", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  await assert.rejects(h.screenshot(5, { clip: { x: 0 } }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(h.screenshot(5, { format: "gif" }), (e) => e.code === "INVALID_ARGS");
  assert.equal(calls.length, 0);
});

test("focus activates the tab and raises its window", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  assert.deepEqual(await h.focus(5), { focused: true });
  assert.deepEqual(calls, [
    ["tabs.update", 5, { active: true }],
    ["windows.update", 77, { focused: true }],
  ]);
});
