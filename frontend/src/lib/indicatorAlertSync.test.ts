import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  planSync, reconcileLinksForScope, relinkAlerts, syncAlertsAfterEdit, syncAlertsAfterRemove,
} from "./indicatorAlertSync";
import { getPersistBroker } from "./persist/core";
import { noteStreamingBrokers } from "./trading";
import {
  addIndicatorAlert, addLineAlert, alertLabel, findServerAlert, linkedAlerts, linkedLineAlerts,
  loadAllIndicatorAlerts, type IndicatorAlert, type LineAlert,
} from "./alertsApi";
import { confirmRequest } from "./signals";
import type { AlertableCheck } from "./alertableIndicators";

const ema = (n: number) => ({ indicator: "MA" as const, calcParams: [n], config: { maType: "ema", source: "close" }, priceTarget: true });
const alert = (id: string, n: number): IndicatorAlert => ({
  kind: "indicator", id, epic: "US100", broker: "b", condition: "crossing", trigger: "every", message: "",
  expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true }, precision: 2,
  params: { identity: ema(n), line: "value", timeframe: "HOUR", target: "price", value: null, evalOn: "close",
    link: { scope: "s", instanceId: "EMA" } },
});

// Fuller factory for tests that round-trip through the real alertsApi cache
// (relinkAlerts / syncAlertsAfterEdit / syncAlertsAfterRemove read and write
// the module-level indicator-alert cache via linkedAlerts/patchIndicatorAlert/
// deleteIndicatorAlert, not plain data).
function mkAlert(opts: {
  id: string; n?: number; timeframe?: string; scope: string; instanceId: string; broker?: string;
}): IndicatorAlert {
  return {
    kind: "indicator", id: opts.id, epic: "US100", broker: opts.broker ?? "b", condition: "crossing", trigger: "every", message: "",
    expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true }, precision: 2,
    params: {
      identity: ema(opts.n ?? 50), line: "value", timeframe: opts.timeframe ?? "HOUR", target: "price", value: null,
      evalOn: "close", link: { scope: opts.scope, instanceId: opts.instanceId },
    },
  };
}

describe("planSync", () => {
  it("patches only alerts whose identity changed", () => {
    const plan = planSync([alert("a", 50), alert("b", 100)], { ok: true, identity: ema(100) });
    expect(plan).toEqual({ patch: [{ id: "a", identity: ema(100) }], conflicted: [] });
  });
  it("flags a conflict when the new settings are not alertable", () => {
    const a = alert("a", 50);
    expect(planSync([a], { ok: false, reason: "x" })).toEqual({ patch: [], conflicted: [a] });
  });
  it("a hidden check is never a conflict (F6)", () => {
    // `hidden` means the chart's CURRENTLY DISPLAYED resolution is a
    // non-native/seconds view, not that the linked alert's own timeframe
    // stopped being alertable. Browsing a 5s chart while editing an EMA
    // must not prompt to delete its hourly alert.
    expect(planSync([alert("a", 50)], { ok: false, hidden: true })).toEqual({ patch: [], conflicted: [] });
  });
  it("does nothing without linked alerts", () => {
    expect(planSync([], { ok: false, reason: "x" })).toEqual({ patch: [], conflicted: [] });
  });
});

// The tests below exercise the real alertsApi module cache (addIndicatorAlert/
// linkedAlerts/patchIndicatorAlert/deleteIndicatorAlert), so writes need a
// stubbed fetch, and confirmRequest (a real module-level signal) needs
// resetting between tests.
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response));
  confirmRequest.set(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relinkAlerts", () => {
  it("re-points link.instanceId to the new id after a rename", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-relink", scope: "relink-scope", instanceId: "OLD_ID" }));

    relinkAlerts("relink-scope", "OLD_ID", "NEW_ID");

    expect(linkedAlerts("relink-scope", "OLD_ID")).toEqual([]);
    expect(linkedAlerts("relink-scope", "NEW_ID").map((a) => a.id)).toEqual(["al-relink"]);
  });

  it("does nothing when nothing is linked to the old id", () => {
    expect(() => relinkAlerts("no-such-scope", "OLD_ID", "NEW_ID")).not.toThrow();
  });
});

describe("syncAlertsAfterEdit", () => {
  it("checks each linked alert against ITS OWN timeframe: patches the alertable group, conflicts the other, in one edit", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-hour", timeframe: "HOUR", scope: "edit-scope", instanceId: "EMA" }));
    await addIndicatorAlert(mkAlert({ id: "al-day", timeframe: "DAY", scope: "edit-scope", instanceId: "EMA" }));

    const checkFor = (timeframe: string): AlertableCheck =>
      timeframe === "HOUR" ? { ok: true, identity: ema(100) } : { ok: false, reason: "no longer alertable" };

    syncAlertsAfterEdit("edit-scope", "EMA", checkFor);

    // The HOUR alert's identity changed (50 -> 100) and was patched...
    expect(linkedAlerts("edit-scope", "EMA").find((a) => a.id === "al-hour")?.params.identity).toEqual(ema(100));
    // ...while the DAY alert's own timeframe is no longer alertable, so a
    // single conflict confirm covers it (not the HOUR one, which is fine).
    expect(confirmRequest.value?.title).toBe("Indicator alerts");
    expect(confirmRequest.value?.message).toBe(
      "These settings can't be alerted on. Delete its 1 alert, or keep it on the old settings?",
    );
    confirmRequest.value?.onConfirm();
    expect(linkedAlerts("edit-scope", "EMA").map((a) => a.id)).toEqual(["al-hour"]);
  });

  it("Keep (onCancel) unlinks the conflicted alert instead of deleting it", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-keep", timeframe: "DAY", scope: "edit-scope-2", instanceId: "EMA" }));

    syncAlertsAfterEdit("edit-scope-2", "EMA", () => ({ ok: false, reason: "no longer alertable" }));

    confirmRequest.value?.onCancel?.();
    expect(linkedAlerts("edit-scope-2", "EMA")).toEqual([]); // unlinked, not findable by link anymore
    expect(loadAllIndicatorAlerts("b").find((a) => a.id === "al-keep")?.params.link).toBeNull();
  });
});

describe("syncAlertsAfterRemove", () => {
  it("Delete removes the linked alerts", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-rm-1", scope: "rm-scope", instanceId: "EMA" }));

    syncAlertsAfterRemove("rm-scope", "EMA");
    expect(confirmRequest.value?.message).toBe("Also delete its 1 alert?");
    confirmRequest.value?.onConfirm();

    expect(linkedAlerts("rm-scope", "EMA")).toEqual([]);
    expect(loadAllIndicatorAlerts("b").some((a) => a.id === "al-rm-1")).toBe(false);
  });

  it("Keep (onCancel) unlinks (link: null) rather than deleting", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-rm-2", scope: "rm-scope-2", instanceId: "EMA" }));

    syncAlertsAfterRemove("rm-scope-2", "EMA");
    confirmRequest.value?.onCancel?.();

    expect(linkedAlerts("rm-scope-2", "EMA")).toEqual([]); // no longer linked
    const kept = loadAllIndicatorAlerts("b").find((a) => a.id === "al-rm-2");
    expect(kept).toBeDefined(); // still exists...
    expect(kept?.params.link).toBeNull(); // ...just unlinked
  });

  it("pluralizes correctly for more than one linked alert", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-rm-3", scope: "rm-scope-3", instanceId: "EMA" }));
    await addIndicatorAlert(mkAlert({ id: "al-rm-4", timeframe: "DAY", scope: "rm-scope-3", instanceId: "EMA" }));

    syncAlertsAfterRemove("rm-scope-3", "EMA");
    expect(confirmRequest.value?.message).toBe("Also delete its 2 alerts?");
  });
});

describe("reconcileLinksForScope", () => {
  it("unlinks (never deletes, never asks) alerts whose instance is gone; live links stay", async () => {
    const broker = getPersistBroker();
    await addIndicatorAlert(mkAlert({ id: "al-rc-live", scope: "rc-scope", instanceId: "EMA", broker }));
    await addIndicatorAlert(mkAlert({ id: "al-rc-gone", scope: "rc-scope", instanceId: "EMA#x9", broker }));
    await addIndicatorAlert(mkAlert({ id: "al-rc-other", scope: "rc-other", instanceId: "RSI", broker }));

    await reconcileLinksForScope("rc-scope", new Set(["EMA"]));

    expect(confirmRequest.value).toBeNull();
    const all = loadAllIndicatorAlerts(broker);
    expect(all.find((a) => a.id === "al-rc-gone")?.params.link).toBeNull();
    expect(all.find((a) => a.id === "al-rc-live")?.params.link).toEqual({ scope: "rc-scope", instanceId: "EMA" });
    expect(all.find((a) => a.id === "al-rc-other")?.params.link).toEqual({ scope: "rc-other", instanceId: "RSI" });
  });

  it("leaves another broker's alerts on the same scope string alone", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-rc-xb", scope: "rc-scope-2", instanceId: "EMA", broker: "elsewhere" }));
    await reconcileLinksForScope("rc-scope-2", new Set());
    expect(loadAllIndicatorAlerts("elsewhere").find((a) => a.id === "al-rc-xb")?.params.link)
      .toEqual({ scope: "rc-scope-2", instanceId: "EMA" });
  });
});

describe("default-message alerts after an identity sync", () => {
  it("keep an empty message, so their display text is recomputed from the new identity", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-msg", scope: "msg-scope", instanceId: "EMA", n: 50 }));
    syncAlertsAfterEdit("msg-scope", "EMA", () => ({ ok: true, identity: ema(20) }));
    const a = linkedAlerts("msg-scope", "EMA")[0];
    expect(a.message).toBe("");
    expect(alertLabel(a, 2)).toContain("EMA 20");
    expect(alertLabel(a, 2)).not.toContain("EMA 50");
  });
});

describe("edits the backend would refuse are conflicts, not silent PATCH failures", () => {
  it("a length past the alert warm-up cap is a conflict", async () => {
    const { checkAlertable } = await import("./alertableIndicators");
    await addIndicatorAlert(mkAlert({ id: "al-cap", scope: "cap-scope", instanceId: "EMA" }));
    syncAlertsAfterEdit("cap-scope", "EMA", (tf) => checkAlertable("EMA", [600], {}, tf, true));
    expect(confirmRequest.value?.message).toContain("can't be alerted on");
    expect(linkedAlerts("cap-scope", "EMA")[0].params.identity).toEqual(ema(50)); // not patched
  });

  it("an edit to VWMA under an intrabar alert on a quote-only broker is a conflict", async () => {
    const quoteOnly = { ...mkAlert({ id: "al-vw-q", scope: "vw-scope", instanceId: "MA" }), broker: "quotes" };
    quoteOnly.params = { ...quoteOnly.params, evalOn: "intrabar" };
    const streaming = { ...mkAlert({ id: "al-vw-s", scope: "vw-scope", instanceId: "MA" }), broker: "streams" };
    streaming.params = { ...streaming.params, evalOn: "intrabar" };
    const onClose = { ...mkAlert({ id: "al-vw-c", scope: "vw-scope", instanceId: "MA" }), broker: "quotes" };
    await addIndicatorAlert(quoteOnly);
    await addIndicatorAlert(streaming);
    await addIndicatorAlert(onClose);
    noteStreamingBrokers(["streams"]);
    const vwma = { indicator: "MA" as const, calcParams: [20], config: { maType: "vwma", source: "close" }, priceTarget: true };

    syncAlertsAfterEdit("vw-scope", "MA", () => ({ ok: true, identity: vwma }));

    const byId = (id: string) => linkedAlerts("vw-scope", "MA").find((a) => a.id === id);
    expect(byId("al-vw-s")?.params.identity).toEqual(vwma); // streaming broker: patched
    expect(byId("al-vw-c")?.params.identity).toEqual(vwma); // on close: patched
    expect(byId("al-vw-q")?.params.identity).toEqual(ema(50)); // left for the prompt
    expect(confirmRequest.value?.message).toBe(
      "These settings can't be alerted on. Delete its 1 alert, or keep it on the old settings?",
    );
    confirmRequest.value?.onCancel?.();
    expect(byId("al-vw-q")).toBeUndefined(); // kept, unlinked
    noteStreamingBrokers([]);
  });
});

// Line alerts share the server-alert cache; these go through the real
// addLineAlert / linkedLineAlerts like the indicator cases above.
function mkLine(id: string, scope: string, broker = "b"): LineAlert {
  return {
    kind: "line", id, epic: "US100", broker, condition: "crossing", trigger: "once", message: "",
    expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true }, precision: 2,
    params: {
      timeframe: "HOUR", evalOn: "close", tRef: 9, pRef: 13, slope: 0.5,
      anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: { scope, instanceId: "TRENDLINES", lineKey: "k" },
    },
  };
}

describe("line alerts follow pane removal, not settings edits", () => {
  it("syncAlertsAfterRemove offers to delete line alerts too; Keep unlinks them", async () => {
    await addLineAlert(mkLine("al-l", "line-rm"));
    syncAlertsAfterRemove("line-rm", "TRENDLINES");
    expect(confirmRequest.value?.message).toBe("Also delete its 1 alert?");
    confirmRequest.value?.onCancel?.();
    expect(linkedLineAlerts("line-rm", "TRENDLINES")).toEqual([]);
    const kept = findServerAlert("al-l");
    expect(kept?.kind).toBe("line");
    expect(kept?.params.link).toBeNull();
  });

  it("Delete removes a line alert with the pane", async () => {
    await addLineAlert(mkLine("al-l-del", "line-rm-2"));
    syncAlertsAfterRemove("line-rm-2", "TRENDLINES");
    confirmRequest.value?.onConfirm();
    expect(findServerAlert("al-l-del")).toBeUndefined();
  });

  it("syncAlertsAfterEdit leaves line alerts alone", async () => {
    await addLineAlert(mkLine("al-l-ed", "line-ed"));
    syncAlertsAfterEdit("line-ed", "TRENDLINES", () => ({ ok: false, reason: "x" }));
    expect(confirmRequest.value).toBeNull();
    expect(findServerAlert("al-l-ed")?.params.link).toEqual({ scope: "line-ed", instanceId: "TRENDLINES", lineKey: "k" });
  });

  it("relinkAlerts re-points a line alert and keeps its lineKey", async () => {
    await addLineAlert(mkLine("al-l-rl", "line-rl"));
    relinkAlerts("line-rl", "TRENDLINES", "TRENDLINES#2");
    expect(findServerAlert("al-l-rl")?.params.link).toEqual({ scope: "line-rl", instanceId: "TRENDLINES#2", lineKey: "k" });
  });

  it("reconcileLinksForScope unlinks a line alert whose pane is gone", async () => {
    const broker = getPersistBroker();
    await addLineAlert(mkLine("al-l-rc", "line-rc", broker));
    await reconcileLinksForScope("line-rc", new Set());
    expect(findServerAlert("al-l-rc")?.params.link).toBeNull();
  });
});
