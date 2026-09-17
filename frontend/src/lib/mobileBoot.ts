// Boot-branch decision for the mobile PWA shell (spec:
// 2026-09-07-mobile-companion-design.md). Pure half + a window-reading wrapper
// so main.tsx stays declarative and the logic is unit-testable.

const STORE_KEY = "auto-trader.mobileBoot";

export function decideMobileBoot(
  search: string,
  stored: string | null,
  coarseSmall: boolean,
): { mobile: boolean; persist: "1" | "0" | null } {
  const m = new URLSearchParams(search).get("m");
  if (m === "1") return { mobile: true, persist: "1" };
  if (m === "0") return { mobile: false, persist: "0" };
  // Stored "0" is a standing opt-out (a phone user who chose desktop). A
  // stored "1" only holds on a device that would plausibly want the mobile
  // shell: one ?m=1 visit on a desktop browser (QR link, emulator testing)
  // must not flip every future normal tab on this origin to mobile.
  if (stored === "0") return { mobile: false, persist: null };
  return { mobile: coarseSmall, persist: null };
}

export function shouldBootMobile(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORE_KEY);
  } catch {
    /* storage unavailable */
  }
  // Width OR height: a phone held sideways is ~900px wide but ~400px tall,
  // and a load in that posture (Chrome restoring a discarded tab, a link
  // opened while rotated) must still boot the mobile shell.
  const coarseSmall =
    typeof window.matchMedia === "function" &&
    window.matchMedia(
      "(pointer: coarse) and ((max-width: 768px) or (max-height: 768px))",
    ).matches;
  const d = decideMobileBoot(window.location.search, stored, coarseSmall);
  if (d.persist) {
    try {
      localStorage.setItem(STORE_KEY, d.persist);
    } catch {
      /* best-effort */
    }
  }
  return d.mobile;
}
