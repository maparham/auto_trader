import { describe, it, expect, vi, beforeEach } from "vitest";

// Drive the engine with a mocked live feed (capture the tick callback) and mocked
// storage (assert reads/writes). This exercises the orchestration the unit tests
// of evaluateAlert can't: setTabs → openFeed → onTick → arming-across-ticks →
// once-removal → saveAlertsFor / pushTriggered. This is THE feature test:
// background tabs (not the active one) must fire.

let emit: ((k: { close: number }) => void) | undefined;
const closeSpy = vi.fn();

vi.mock("./feed", () => ({
  DEFAULT_BROKER: "capital",
  openLive: (_epic: string, _res: string, onCandle: (k: { close: number }) => void) => {
    emit = onCandle;
    return { close: closeSpy };
  },
}));

// In-memory alert store keyed by epic (alerts are global per instrument).
const store = new Map<string, unknown[]>();
const saveSpy = vi.fn();
const pushSpy = vi.fn();

vi.mock("./persist", () => ({
  loadAlerts: (epic: string) => store.get(epic) ?? [],
  // Raw cache key for onTick: stringify the stored list so it flips whenever the
  // list changes (mirrors the real localStorage-backed getItem).
  loadAlertsRaw: (epic: string) => (store.has(epic) ? JSON.stringify(store.get(epic)) : null),
  saveAlerts: (epic: string, list: unknown[]) => {
    saveSpy(epic, list);
    store.set(epic, list);
  },
  pushTriggered: (e: unknown) => pushSpy(e),
  normalizeAlert: (a: Record<string, unknown>) => ({
    condition: "crossing",
    trigger: "every",
    message: "",
    ...a,
    // Mirror the real backfill: an absent id is derived from content (here, the
    // level) so each distinct fixture alert gets a stable, distinct id.
    id: a.id ?? `lg-${a.level}`,
  }),
}));

// Silence notifications/sound in the node test env.
vi.mock("./notify", () => ({ notify: vi.fn(), playPing: vi.fn(), toast: vi.fn() }));
vi.mock("./signals", () => ({ bumpAlerts: vi.fn() }));

// Import AFTER mocks are registered.
const { alertEngine } = await import("./alertEngine");

// Build a one-cell tab. Alerts are stored by epic (global), so the in-memory store
// is keyed by the cell's epic; the scope here is incidental.
const tab = (id: string, epic: string) => ({
  id,
  layout: "1" as const,
  activeCellId: `${id}-c0`,
  cells: [
    {
      id: `${id}-c0`,
      scope: id,
      symbol: { epic, name: epic, status: null, pricePrecision: 2 },
      period: { resolution: "HOUR", label: "1H" },
    },
  ],
});

beforeEach(() => {
  alertEngine.stop();
  store.clear();
  saveSpy.mockClear();
  pushSpy.mockClear();
  closeSpy.mockClear();
  emit = undefined;
});

describe("alertEngine (background firing)", () => {
  it("fires an alert on a BACKGROUND tab (the whole point)", () => {
    store.set("BTC", [{ level: 100, condition: "crossing", trigger: "every", message: "" }]);
    // Active tab is something else; the BTC tab is in the background.
    alertEngine.setTabs([tab("active", "US100"), tab("bg", "BTC")]);
    expect(emit).toBeTypeOf("function"); // a feed opened for BTC

    emit!({ close: 99 }); // first sample — arms the two-sample guard, no fire
    emit!({ close: 101 }); // crosses 100 upward → fires

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0]).toMatchObject({ epic: "BTC", level: 100, price: 101 });
  });

  it("a 'once' alert fires exactly once, is removed from storage, and never re-fires", () => {
    store.set("BTC", [{ level: 100, condition: "crossing", trigger: "once", message: "" }]);
    alertEngine.setTabs([tab("t", "BTC")]);

    emit!({ close: 99 });
    emit!({ close: 101 }); // fires once
    expect(pushSpy).toHaveBeenCalledTimes(1);
    // Persisted with the alert removed.
    expect(saveSpy).toHaveBeenCalledWith("BTC", []);

    // Subsequent crossings must NOT re-fire (it's gone from storage).
    emit!({ close: 99 });
    emit!({ close: 101 });
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("an 'every' alert disarms after firing and does not re-fire on jitter", () => {
    store.set("BTC", [{ level: 100, condition: "crossing", trigger: "every", message: "" }]);
    alertEngine.setTabs([tab("t", "BTC")]);

    emit!({ close: 99 });
    emit!({ close: 101 }); // fires, disarms
    expect(pushSpy).toHaveBeenCalledTimes(1);

    // Cross back and forth without clearing the re-arm band → no re-fire.
    emit!({ close: 100.01 });
    emit!({ close: 100.0 });
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes feeds by epic and closes them when alerts/tabs go away", () => {
    store.set("BTC", [{ level: 100 }]);
    store.set("BTC", [{ level: 200 }]);
    // Two tabs on BTC → exactly one feed (dedup by epic).
    alertEngine.setTabs([tab("a", "BTC"), tab("b", "BTC")]);
    expect(emit).toBeTypeOf("function");

    // Remove all BTC alerts → feed should close.
    store.set("BTC", []);
    store.set("BTC", []);
    alertEngine.setTabs([tab("a", "BTC"), tab("b", "BTC")]);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("prunes an expired alert WITHOUT firing it", () => {
    // Expires in the past → must be removed on the next tick, never fired, even
    // though the price crosses its level.
    store.set("BTC", [
      { level: 100, condition: "crossing", trigger: "every", message: "", expiresAt: 1 },
    ]);
    alertEngine.setTabs([tab("t", "BTC")]);

    emit!({ close: 99 });
    emit!({ close: 101 }); // crosses 100 — but the alert is expired
    expect(pushSpy).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalledWith("BTC", []); // pruned from storage
  });

  it("does not fire on the very first tick (two-sample crossing guard)", () => {
    store.set("BTC", [{ level: 100, condition: "crossing", trigger: "every", message: "" }]);
    alertEngine.setTabs([tab("t", "BTC")]);
    emit!({ close: 101 }); // only one sample so far
    expect(pushSpy).not.toHaveBeenCalled();
  });

  // Regression: dragging/editing a level must NOT manufacture a crossing off the
  // stale per-alert baseline. The alert keeps its stable id across the move, so the
  // engine re-seeds its baseline instead of reading the relocated level as a cross.
  it("does not fire when a level MOVES across the stale baseline (the drag-delete bug)", () => {
    const alert = (level: number) => [
      { id: "A1", level, condition: "crossing", trigger: "once", message: "" },
    ];
    store.set("BTC", alert(110));
    alertEngine.setTabs([tab("t", "BTC")]);

    emit!({ close: 105 }); // seed baseline
    emit!({ close: 106 }); // no crossing of 110; baseline now 106

    // User drags the alert down to 104 (overlay persists the new level).
    store.set("BTC", alert(104));
    emit!({ close: 103 }); // 106 -> 103 would cross a stale 104; must NOT fire
    expect(pushSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalledWith("BTC", []); // not wiped
    expect(store.get("BTC")).toHaveLength(1); // alert survives

    // A GENUINE crossing after the move still fires (we re-seeded, didn't mute).
    emit!({ close: 103.5 }); // baseline 103
    emit!({ close: 105 }); // 103 -> 105 crosses 104 upward → fires
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0]).toMatchObject({ epic: "BTC", level: 104 });
  });
});
