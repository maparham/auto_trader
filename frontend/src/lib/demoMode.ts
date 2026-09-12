// Anonymous demo boot flag. Set ONCE in main.tsx before React renders when a
// signed-out visitor gets the demo home page; read by the persist layer (no
// backend mirror, no hydrate) and by App feature gates. One-way by design so
// no code path can accidentally re-enable mirroring mid-session.
let demo = false;

export function setDemoMode(): void {
  demo = true;
}

export function isDemoMode(): boolean {
  return demo;
}
