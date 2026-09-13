// Admin preview of the published public demo, without signing out.
//
// A preview renders exactly what a signed-out visitor gets (DemoApp: demo
// mode latched on, the published snapshot seeded, dukascopy only), but in a
// SIGNED-IN tab. That is only safe because of the prefix swap below: demo
// seeding writes a curated layout over the workspace keys, and the tab doing
// it belongs to the admin whose own layout lives on those very keys. So a
// preview moves the whole workspace namespace aside instead
// (`auto-trader-preview.*`), leaving the admin's real keys untouched and
// invisible to it. Persist mirroring is off for the duration anyway
// (isDemoMode gates it), so nothing reaches the backend either.
//
// No imports, on purpose: workspaceKeys.ts is a leaf module (see its header)
// and imports this to pick its PREFIX, so this must not pull anything in.

/** The preview tab's workspace namespace: scratch, wiped on exit. */
export const PREVIEW_PREFIX = "auto-trader-preview";

const PARAM = "demo";
const VALUE = "preview";

/** True when this tab booted as an admin demo preview. Read from the URL, so
 *  it is decided before any module initializes its key constants - which is
 *  what lets PREFIX be a plain const rather than a runtime-mutable global.
 *  Defaults defensively: workspaceKeys.ts calls this at module-init time, and
 *  unit tests import it in vitest's `node` environment, where there is no
 *  `window` at all. */
export function isDemoPreview(search?: string): boolean {
  const q = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(q).get(PARAM) === VALUE;
}

/** Enter the preview: a full navigation, not a route change, because the
 *  namespace choice happens at module-init time. */
export function enterDemoPreview(): void {
  window.location.assign(`/?${PARAM}=${VALUE}`);
}

/** Leave the preview: drop everything the preview wrote (it is scratch by
 *  definition) and navigate back to the real app. */
export function exitDemoPreview(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(`${PREVIEW_PREFIX}.`)) localStorage.removeItem(key);
  }
  window.location.assign("/");
}
