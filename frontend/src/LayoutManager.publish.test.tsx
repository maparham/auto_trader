// @vitest-environment jsdom
// The layout menu's admin-only quick publish: a top-level action that
// publishes the ACTIVE layout as the public demo, behind an inline confirm
// (publishing replaces the live demo, so a stray click must not fire it).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

let isAdmin = true;
const publishDemoLayoutOnly = vi.fn();
vi.mock("./admin/useIsAdmin", () => ({ useIsAdmin: () => isAdmin }));
vi.mock("./lib/demoMode", () => ({ isDemoMode: () => false }));
vi.mock("./lib/demoPublish", () => ({
  publishDemoLayoutOnly: (...args: unknown[]) => publishDemoLayoutOnly(...args),
}));

import { saveLayout, primaryCellScope } from "./lib/persist";
import LayoutManager from "./LayoutManager";

beforeEach(() => {
  installMemStorage();
  isAdmin = true;
  const tabId = "T1";
  saveLayout("L1", "Alpha", {
    tabs: [
      {
        id: tabId,
        layout: "1",
        activeCellId: `${tabId}-c0`,
        cells: [
          {
            id: `${tabId}-c0`,
            symbol: { epic: "US100", name: "US 100", status: null } as never,
            period: { resolution: "MINUTE_15", label: "15m" } as never,
            scope: primaryCellScope(tabId),
          },
        ],
      },
    ],
    activeTabId: "",
  });
});

afterEach(() => {
  cleanup();
  publishDemoLayoutOnly.mockReset();
});

function renderMgr() {
  render(
    <LayoutManager
      activeLayoutId="L1"
      hasWorkspace
      autosave
      isDirty={false}
      onToggleAutosave={() => {}}
      onSwitch={() => {}}
      onSave={() => {}}
      onSaveAs={() => {}}
      onDelete={() => {}}
      onImport={() => true}
      revision={0}
    />,
  );
  fireEvent.click(screen.getByLabelText("Layout options"));
}

describe("layout menu quick publish", () => {
  it("publishes the active layout after an inline confirm", async () => {
    publishDemoLayoutOnly.mockResolvedValue(7);
    renderMgr();

    fireEvent.click(screen.getByText("Publish as public demo…"));
    expect(publishDemoLayoutOnly).not.toHaveBeenCalled(); // confirm first
    expect(screen.getByText('Replace the live demo with "Alpha"?')).toBeTruthy();

    fireEvent.click(screen.getByText("Publish"));
    await waitFor(() => expect(screen.getByText('Live demo is now "Alpha".')).toBeTruthy());
    expect(publishDemoLayoutOnly).toHaveBeenCalledWith("L1");
  });

  it("cancel closes the confirm without publishing", () => {
    renderMgr();
    fireEvent.click(screen.getByText("Publish as public demo…"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText('Replace the live demo with "Alpha"?')).toBeNull();
    expect(publishDemoLayoutOnly).not.toHaveBeenCalled();
  });

  it("surfaces the publish error (e.g. an unmappable symbol) in the menu", async () => {
    publishDemoLayoutOnly.mockRejectedValue(
      new Error("not available on Yahoo Finance: NOPE"),
    );
    renderMgr();
    fireEvent.click(screen.getByText("Publish as public demo…"));
    fireEvent.click(screen.getByText("Publish"));
    expect(await screen.findByText(/not available on Yahoo Finance: NOPE/)).toBeTruthy();
  });

  it("is hidden for non-admins", () => {
    isAdmin = false;
    renderMgr();
    expect(screen.queryByText("Publish as public demo…")).toBeNull();
  });
});
