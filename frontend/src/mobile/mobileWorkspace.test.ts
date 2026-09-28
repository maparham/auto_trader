// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, saveDefaultLayoutId, isDeviceLocalKey, type Workspace } from "../lib/persist";
import {
  mirroredWorkspace,
  setMobileLayout,
  mobileLayoutList,
  mobileWorkspaceVersion,
  MOBILE_LAYOUT_KEY,
} from "./mobileWorkspace";

installMemStorage();
const ws = (epic: string): Workspace =>
  ({
    tabs: [{ id: `t-${epic}`, layout: "1", activeCellId: "c", cells: [{ id: "c", symbol: { epic, name: epic }, period: { resolution: "HOUR", label: "1H" }, scope: `tab.t-${epic}` }] }],
    activeTabId: "",
  }) as unknown as Workspace;

describe("mobile layout choice", () => {
  beforeEach(() => {
    localStorage.clear();
    saveLayout("a", "Main", ws("US100"));
    saveLayout("b", "Swing", ws("GOLD"));
  });

  it("defaults to the desktop default layout, else the first", () => {
    expect(mirroredWorkspace()?.id).toBe("a");
    saveDefaultLayoutId("b");
    expect(mirroredWorkspace()?.id).toBe("b");
  });

  it("a mobile pick wins over the default, and bumps the version", () => {
    saveDefaultLayoutId("a");
    const v = mobileWorkspaceVersion.value;
    setMobileLayout("b");
    expect(mirroredWorkspace()).toMatchObject({ id: "b", name: "Swing" });
    expect(mobileWorkspaceVersion.value).toBe(v + 1);
  });

  it("falls back when the picked layout was deleted", () => {
    setMobileLayout("gone");
    expect(mirroredWorkspace()?.id).toBe("a");
  });

  it("the pick is device-local, never mirrored", () => {
    expect(isDeviceLocalKey(MOBILE_LAYOUT_KEY)).toBe(true);
  });

  it("lists the saved layouts", () => {
    expect(mobileLayoutList().map((l) => l.name)).toEqual(["Main", "Swing"]);
  });
});
