import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reconcileLinksForScope, relinkAlerts, syncAlertsAfterEdit, syncAlertsAfterRemove,
} from "./indicatorAlertSync";
import { getPersistBroker } from "./persist/core";
import * as alertsApi from "./alertsApi";
import {
  addIndicatorAlert, addLineAlert, alertLabel, findServerAlert, linkedAlerts, linkedLineAlerts,
  loadAllIndicatorAlerts, type IndicatorAlert, type LineAlert,
} from "./alertsApi";
import { confirmRequest } from "./signals";
import type { AlertInstance } from "./indicatorAlertInstance";

const INSTANCE: AlertInstance = { type: "RSI", calcParams: [21], extendData: {} };

// Fuller factory for tests that round-trip through the real alertsApi cache
// (relinkAlerts / syncAlertsAfterEdit / syncAlertsAfterRemove read and write
// the module-level indicator-alert cache via linkedAlerts/patchIndicatorAlert/
// deleteIndicatorAlert, not plain data).
function mkAlert(opts: {
  id: string; timeframe?: string; scope: string; instanceId: string; broker?: string;
}): IndicatorAlert {
  return {
    kind: "indicator", id: opts.id, epic: "US100", broker: opts.broker ?? "b", condition: "crossing", trigger: "every", message: "",
    expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true }, precision: 2,
    params: {
      type: "MA", config: { maType: "ema", source: "close" }, output: "ma", timeframe: opts.timeframe ?? "HOUR",
      target: "price", value: null, evalOn: "close", link: { scope: opts.scope, instanceId: opts.instanceId },
    },
  };
}

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
  vi.restoreAllMocks();
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
  it("re-points every linked alert to the pane's new settings", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-a", scope: "edit-scope", instanceId: "RSI" }));
    await addIndicatorAlert(mkAlert({ id: "al-b", scope: "edit-scope", instanceId: "RSI" }));
    const repoint = vi.spyOn(alertsApi, "repointIndicatorAlert").mockResolvedValue("ok");

    await syncAlertsAfterEdit("edit-scope", "RSI", INSTANCE);

    expect(repoint).toHaveBeenCalledWith("al-a", INSTANCE);
    expect(repoint).toHaveBeenCalledWith("al-b", INSTANCE);
    expect(confirmRequest.value).toBeNull();
  });

  it("asks delete or keep for the alerts the server refused", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-c", scope: "edit-scope-2", instanceId: "RSI" }));
    await addIndicatorAlert(mkAlert({ id: "al-d", scope: "edit-scope-2", instanceId: "RSI" }));
    vi.spyOn(alertsApi, "repointIndicatorAlert").mockImplementation(
      async (id: string) => (id === "al-d" ? "refused" : "ok"),
    );

    await syncAlertsAfterEdit("edit-scope-2", "RSI", INSTANCE);

    expect(confirmRequest.value?.title).toBe("Indicator alerts");
    expect(confirmRequest.value?.message).toContain("1 alert");
    confirmRequest.value?.onConfirm();
    expect(linkedAlerts("edit-scope-2", "RSI").map((a) => a.id)).toEqual(["al-c"]);
  });

  it("a failed request is not treated as a refusal", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-e", scope: "edit-scope-3", instanceId: "RSI" }));
    vi.spyOn(alertsApi, "repointIndicatorAlert").mockResolvedValue("failed");

    await syncAlertsAfterEdit("edit-scope-3", "RSI", INSTANCE);

    expect(confirmRequest.value).toBeNull();
  });

  it("does nothing without linked alerts", async () => {
    const repoint = vi.spyOn(alertsApi, "repointIndicatorAlert");
    await syncAlertsAfterEdit("no-such-scope", "RSI", INSTANCE);
    expect(repoint).not.toHaveBeenCalled();
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
    const repoint = vi.spyOn(alertsApi, "repointIndicatorAlert");
    await syncAlertsAfterEdit("line-ed", "TRENDLINES", INSTANCE);
    expect(repoint).not.toHaveBeenCalled();
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

describe("alertLabel still formats from the server-supplied label", () => {
  it("falls back to the output name when the server hasn't labeled it yet", async () => {
    await addIndicatorAlert(mkAlert({ id: "al-msg", scope: "msg-scope", instanceId: "EMA" }));
    const a = linkedAlerts("msg-scope", "EMA")[0];
    expect(a.message).toBe("");
    expect(alertLabel(a, 2)).toBe("Crossing ma");
  });
});
