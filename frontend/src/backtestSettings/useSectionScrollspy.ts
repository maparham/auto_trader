import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { SCROLL_TABS, type BacktestTab, type ScrollTab } from "./shared";

export function useSectionScrollspy(tab: BacktestTab, setTab: Dispatch<SetStateAction<BacktestTab>>) {
  // Continuous scroll: every SCROLL_TABS section lives in one scroll pane
  // (bodyRef). The tab bar jumps to a section and highlights whichever is
  // currently at the top (scrollspy). setRef registers each section;
  // suppressSpyUntil silences the spy during the smooth jump so it lands on the
  // clicked tab, not the ones it scrolls past. `results` is null while the
  // results are in the side column, which is exactly when its tab is not
  // rendered either. Presets has no entry here — it is its own pane.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<ScrollTab, HTMLElement | null>>({
    period: null,
    strategy: null,
    costs: null,
    results: null,
  });
  const suppressSpyUntil = useRef(0);
  const setRef = (t: ScrollTab) => (el: HTMLElement | null) => {
    sectionRefs.current[t] = el;
  };
  function scrollToSection(t: ScrollTab, smooth: boolean) {
    const el = sectionRefs.current[t];
    const c = bodyRef.current;
    if (!el || !c) return;
    suppressSpyUntil.current = Date.now() + 700;
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    // "instant", not "auto" — "auto" defers to .bt-body's own
    // `scroll-behavior: smooth`, which is the animation we mean to skip.
    c.scrollTo?.({ top, behavior: smooth ? "smooth" : "instant" });
  }
  // A jump made while the Presets pane holds the body has to wait: the scroll
  // pane is still display:none, so its sections have no geometry and the jump
  // would silently land at the top. The layout effect below runs it against the
  // commit that reveals the pane.
  const pendingJump = useRef<ScrollTab | null>(null);
  // `smooth: false` for jumps fired right after kicking off a run: the animated
  // scroll is main-thread work and gets dropped when the chart is mid-redraw,
  // stranding the pane a few pixels down instead of at the results. A click has
  // no such contention and keeps the animation.
  function jumpToTab(t: BacktestTab, smooth = true) {
    const fromPresets = tab === "presets";
    setTab(t);
    if (t === "presets") return;
    // Revealing the pane and scrolling in one paint would flash the top of the
    // settings; deferred jumps are always instant for that reason.
    if (fromPresets) pendingJump.current = t;
    else scrollToSection(t, smooth);
  }
  useLayoutEffect(() => {
    if (tab === "presets" || !pendingJump.current) return;
    const t = pendingJump.current;
    pendingJump.current = null;
    scrollToSection(t, false);
  });
  function onBodyScroll() {
    if (Date.now() < suppressSpyUntil.current) return;
    const c = bodyRef.current;
    if (!c) return;
    // The active tab is the last section whose top has passed just below the
    // pane's top edge (a small 24px lead-in feels natural).
    const ctop = c.getBoundingClientRect().top;
    let current: ScrollTab = SCROLL_TABS[0].value;
    for (const t of SCROLL_TABS) {
      const el = sectionRefs.current[t.value];
      if (el && el.getBoundingClientRect().top - ctop <= 24) current = t.value;
    }
    setTab((prev) => (prev === current ? prev : current));
  }
  return { bodyRef, setRef, jumpToTab, onBodyScroll };
}
