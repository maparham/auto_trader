import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const P = await import("./persist");
const M = await import("./mobileScope");

const desc = (epic: string, updatedAt: number, scope = `tab.t1.cell.c1`) => ({
  scope, epic, broker: "capital", resolution: "MINUTE_5",
  symbol: { epic, name: epic }, barSpace: 8, width: 390, height: 500, updatedAt,
});

describe("mobileScope", () => {
  beforeEach(() => localStorage.clear());

  it("freshestView picks the newest valid heartbeat", () => {
    localStorage.setItem(P.brokerRoot("capital", "view.US100"), JSON.stringify(desc("US100", 100)));
    localStorage.setItem(P.brokerRoot("capital", "view.GOLD"), JSON.stringify(desc("GOLD", 200)));
    localStorage.setItem(P.brokerRoot("capital", "view.BAD"), "{not json");
    expect(M.freshestView("capital")?.epic).toBe("GOLD");
  });

  it("freshestView returns null with no heartbeats", () => {
    expect(M.freshestView("capital")).toBeNull();
  });

  it("mobileDrawScope adopts the epic's heartbeat scope", () => {
    localStorage.setItem(P.brokerRoot("capital", "view.US100"), JSON.stringify(desc("US100", 100, "tab.x.cell.y")));
    expect(M.mobileDrawScope("capital", "US100")).toBe("tab.x.cell.y");
  });

  it("mobileDrawScope falls back to the mobile scope", () => {
    expect(M.mobileDrawScope("capital", "US100")).toBe("mobile");
  });
});
