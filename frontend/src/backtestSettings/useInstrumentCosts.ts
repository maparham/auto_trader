// The Costs tab's instrument cost profile: prefill from the broker once per
// epic per session, mirror spread/slippage/financing edits back on a debounce,
// and re-pull on demand. The profile note itself stays the modal's state.
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { getCostProfile, putCostProfile, refetchCostProfile, type CostProfile } from "../api";
import type { BacktestConfig, Costs } from "../lib/backtestConfig";
import { costProfileCache, profileToCostsPatch } from "./shared";

// The subset of Costs that mirrors the broker profile — the only fields the
// debounced PUT sends (quantity/commission/starting cash are panel-only).
type InstrumentCostPatch = Partial<
  Pick<Costs, "spread" | "slippage" | "finLongDailyPct" | "finShortDailyPct">
>;

export function useInstrumentCosts({ epic, brokerId, setCfg, setCosts, setCostProfile }: {
  epic: string;
  brokerId: string;
  setCfg: Dispatch<SetStateAction<BacktestConfig>>;
  setCosts: (patch: Partial<Costs>) => void;
  setCostProfile: (p: CostProfile) => void;
}) {
  const pendingCostPatch = useRef<InstrumentCostPatch>({});
  const costPutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The epic the pending patch belongs to. The modal is docked and reused across
  // symbol switches (no remount), so a patch must PUT to the epic it was edited
  // on, NOT whatever epic is current when the debounce timer fires.
  const pendingEpicRef = useRef(epic);
  const currentEpicRef = useRef(epic);
  currentEpicRef.current = epic;

  function flushCostPut() {
    if (costPutTimer.current) {
      clearTimeout(costPutTimer.current);
      costPutTimer.current = null;
    }
    const patch = pendingCostPatch.current;
    if (Object.keys(patch).length === 0) return;
    pendingCostPatch.current = {};
    const targetEpic = pendingEpicRef.current;
    putCostProfile(targetEpic, patch)
      .then((p) => {
        costProfileCache.set(targetEpic, p);
        // Only reflect the returned profile if the modal is still on that epic —
        // a late save for a previous epic must not overwrite the current one's note.
        if (currentEpicRef.current === targetEpic) setCostProfile(p);
      })
      .catch(() => {
        // Transient save failure: the value already lives in cfg.costs and is
        // snapshotted into the run, so the edit is not lost — only the mirror is.
      });
  }

  // Prefill the instrument-cost fields from the broker profile the first time the
  // Costs tab is shown for an epic (once per epic per session). A failed fetch
  // (broker 502/503/504 or network) keeps the current cfg values and does not
  // retry-loop: the effect only re-runs on epic/broker change and a failure is
  // not cached.
  useEffect(() => {
    const cached = costProfileCache.get(epic);
    if (cached) {
      // Already fetched this epic this session (its cache stays current because
      // every edit's PUT writes the returned profile back). Re-apply it so a
      // switch back to this epic on the same mounted modal restores its costs.
      setCostProfile(cached);
      setCfg((prev) => ({ ...prev, costs: { ...prev.costs, ...profileToCostsPatch(cached) } }));
      return;
    }
    let cancelled = false;
    getCostProfile(epic, brokerId)
      .then((p) => {
        if (cancelled) return;
        costProfileCache.set(epic, p);
        setCostProfile(p);
        setCfg((prev) => ({ ...prev, costs: { ...prev.costs, ...profileToCostsPatch(p) } }));
      })
      .catch(() => {
        /* keep current cfg; no retry */
      });
    return () => {
      cancelled = true;
    };
  }, [epic, brokerId, setCfg, setCostProfile]);

  // Flush any pending profile edit when the modal unmounts, so an edit made inside
  // the debounce window right before closing still reaches the broker profile.
  // flushCostPut reads only refs and a state setter, so the first render's copy is as good as any.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flushCostPut(), []);

  // An instrument-cost edit: write it into cfg.costs immediately and mirror it back
  // to the broker profile on a short debounce (coalescing rapid keystrokes).
  function setInstrumentCost(patch: InstrumentCostPatch) {
    setCosts(patch);
    // An epic switch happened while a patch was pending: flush the old epic's
    // patch to its own profile before starting this epic's, so patches never
    // coalesce across instruments or PUT to the wrong one.
    if (Object.keys(pendingCostPatch.current).length && pendingEpicRef.current !== epic) {
      flushCostPut();
    }
    pendingEpicRef.current = epic;
    pendingCostPatch.current = { ...pendingCostPatch.current, ...patch };
    if (costPutTimer.current) clearTimeout(costPutTimer.current);
    costPutTimer.current = setTimeout(flushCostPut, 400);
  }

  // Re-pull spread and financing from the broker and apply the new profile.
  function refetchCosts() {
    refetchCostProfile(epic, brokerId)
      .then(({ new: fresh }) => {
        costProfileCache.set(epic, fresh);
        setCostProfile(fresh);
        setCfg((prev) => ({ ...prev, costs: { ...prev.costs, ...profileToCostsPatch(fresh) } }));
      })
      .catch(() => {
        /* broker error: keep current values */
      });
  }
  return { setInstrumentCost, refetchCosts };
}
