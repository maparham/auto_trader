// Thin registration: wires the real chrome API into handlers.js and
// dispatch.js. Dispatch logic (tabId-from-sender, serialisation, error
// shaping) lives in dispatch.js, which is plain and importable under node;
// see dispatch.test.js.
import { makeHandlers } from "./handlers.js";
import { makeDispatcher } from "./dispatch.js";

const handleMessage = makeDispatcher(makeHandlers(chrome));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse);
  return true; // keep the channel open for the async reply
});
