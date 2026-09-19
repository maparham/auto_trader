// Shared test double for the chrome extension APIs Tab Bridge touches.
// Used by handlers.test.js and dispatch.test.js so the fake shape doesn't
// drift between the two suites.
export function fakeChrome({ captureResult = { data: "QUJD" }, attachError = null, captureDelay = null } = {}) {
  const calls = [];
  const chrome = {
    debugger: {
      attach: async (target, version) => {
        calls.push(["attach", target, version]);
        if (attachError) throw new Error(attachError);
      },
      sendCommand: async (target, method, params) => {
        calls.push(["send", target, method, params]);
        if (method !== "Page.captureScreenshot") throw new Error("unexpected " + method);
        if (captureDelay) await captureDelay(target);
        return captureResult;
      },
      detach: async (target) => { calls.push(["detach", target]); },
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 77 }),
      update: async (tabId, props) => { calls.push(["tabs.update", tabId, props]); },
    },
    windows: {
      update: async (windowId, props) => { calls.push(["windows.update", windowId, props]); },
    },
  };
  return { chrome, calls };
}
