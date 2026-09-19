// Page-side client for the Tab Bridge Chrome extension (extension/ at the
// repo root). The extension lets this page screenshot or focus its own tab
// while backgrounded, which page JS cannot do (rAF is paused in hidden tabs,
// and pages may not steal focus). Frames travel over window.postMessage on
// this window; the extension's content script relays them. Protocol and
// error codes: extension/README.md.

const NS = "tab-bridge";
const HELLO_TIMEOUT_MS = 300;
const OP_TIMEOUT_MS = 10_000;

export class TabBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TabBridgeHello { version: string; ops: string[] }

export interface ScreenshotArgs {
  clip?: { x: number; y: number; width: number; height: number };
  scale?: number;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface ScreenshotResult {
  mime: string; image_base64: string; width: number | null; height: number | null;
}

interface ResFrame {
  ns: string; dir: string; id: string; ok: boolean;
  result?: unknown; error?: { code: string; message: string };
}

let seq = 0;
let hello: TabBridgeHello | null = null;

export function resetTabBridgeForTest(): void {
  hello = null;
  seq = 0;
}

/** Clears the cached hello so the next probeTabBridge() re-sends one.
 * Call this when a request to an already-detected extension fails in a way
 * that suggests it went away (its content script got orphaned by an
 * unpacked-extension reload, for example): a stale cache would otherwise
 * make every later call wait out the full op timeout forever. */
export function invalidateTabBridge(): void {
  hello = null;
}

function request<T>(op: string, args: object, timeoutMs: number): Promise<T> {
  if (typeof window === "undefined") {
    return Promise.reject(new TabBridgeError("NO_WINDOW", "no window"));
  }
  const id = `tb-${Date.now()}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      fn();
    };
    const onMessage = (e: MessageEvent) => {
      // e.source is the sender window; postMessage to our own window sets it
      // to `window`, but jsdom reports it as null, so only reject a message
      // known to come from a different window rather than requiring a match.
      if (e.source !== null && e.source !== window) return;
      const f = e.data as ResFrame | null;
      if (!f || f.ns !== NS || f.dir !== "res" || f.id !== id) return;
      if (f.ok) done(() => resolve(f.result as T));
      else done(() => reject(new TabBridgeError(f.error?.code ?? "EXTENSION_ERROR", f.error?.message ?? "extension error")));
    };
    const timer = setTimeout(
      () => done(() => {
        // A non-hello op that times out likely means the extension went away
        // mid-page-life (an unpacked reload orphans the content script, whose
        // sendMessage then throws synchronously and never replies): drop the
        // cached hello so the caller's next probe re-detects it instead of
        // assuming it is still there.
        if (op !== "hello") invalidateTabBridge();
        reject(new TabBridgeError("EXTENSION_TIMEOUT", `${op}: no reply from the Tab Bridge extension within ${timeoutMs}ms`));
      }),
      timeoutMs,
    );
    window.addEventListener("message", onMessage);
    window.postMessage({ ns: NS, dir: "req", id, op, args }, "*");
  });
}

/** Detects the extension. A found answer is cached until invalidateTabBridge()
 * clears it (the timeout path above does this when the extension stops
 * answering); a null answer is re-probed next call (the user may install it
 * later). */
export async function probeTabBridge(): Promise<TabBridgeHello | null> {
  if (hello) return hello;
  try {
    hello = await request<TabBridgeHello>("hello", {}, HELLO_TIMEOUT_MS);
  } catch {
    hello = null;
  }
  return hello;
}

export function tabBridgeScreenshot(args: ScreenshotArgs): Promise<ScreenshotResult> {
  return request<ScreenshotResult>("screenshot", args, OP_TIMEOUT_MS);
}

export function tabBridgeFocus(): Promise<{ focused: true }> {
  return request<{ focused: true }>("focus", {}, OP_TIMEOUT_MS);
}
