// Pure op handlers for the Tab Bridge extension. Every op acts on the tab
// id the caller passes, which background.js always takes from sender.tab.id,
// so a page can only ever screenshot or focus itself. The `chrome` API is
// injected so these run under node's test runner with a fake.

export const VERSION = "1.0.0";
export const OPS = ["screenshot", "focus"];

const CDP_VERSION = "1.3";
const FORMATS = new Set(["png", "jpeg"]);

export class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function validateScreenshotArgs(args) {
  const { clip, format = "png", quality, scale } = args ?? {};
  if (!FORMATS.has(format)) throw new OpError("INVALID_ARGS", `format must be png or jpeg, got ${format}`);
  if (quality !== undefined && !(isFiniteNum(quality) && quality >= 0 && quality <= 100)) {
    throw new OpError("INVALID_ARGS", "quality must be 0..100");
  }
  if (scale !== undefined && !(isFiniteNum(scale) && scale > 0)) {
    throw new OpError("INVALID_ARGS", "scale must be a positive number");
  }
  if (clip !== undefined) {
    const ok = clip && ["x", "y", "width", "height"].every((k) => isFiniteNum(clip[k]))
      && clip.width > 0 && clip.height > 0;
    if (!ok) throw new OpError("INVALID_ARGS", "clip needs numeric x, y, width > 0, height > 0");
  }
  return { clip, format, quality, scale };
}

export function makeHandlers(chrome) {
  return {
    async hello() {
      return { version: VERSION, ops: OPS };
    },

    async screenshot(tabId, rawArgs) {
      const { clip, format, quality, scale } = validateScreenshotArgs(rawArgs);
      const target = { tabId };
      const params = { format, fromSurface: true };
      if (quality !== undefined) params.quality = quality;
      if (clip) params.clip = { ...clip, scale: scale ?? 1 };

      try {
        await chrome.debugger.attach(target, CDP_VERSION);
      } catch (e) {
        throw new OpError("DEBUGGER_BUSY", `cannot attach debugger to this tab (DevTools open?): ${e?.message ?? e}`);
      }
      try {
        const res = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params);
        return {
          mime: format === "png" ? "image/png" : "image/jpeg",
          image_base64: res.data,
          width: clip ? clip.width : null,
          height: clip ? clip.height : null,
        };
      } catch (e) {
        throw new OpError("CAPTURE_FAILED", `Page.captureScreenshot failed: ${e?.message ?? e}`);
      } finally {
        await chrome.debugger.detach(target).catch(() => {});
      }
    },

    async focus(tabId) {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { focused: true };
    },
  };
}
