// @vitest-environment jsdom
// Export/import of a whole layout from the LayoutManager dropdown.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";
import { saveLayout, primaryCellScope, ns } from "./lib/persist";
import LayoutManager from "./LayoutManager";

afterEach(cleanup);

beforeEach(() => {
  installMemStorage();
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
  localStorage.setItem(
    ns(primaryCellScope(tabId), "drawings"),
    JSON.stringify([{ name: "segment" }]),
  );
});

function renderMgr(onImport = vi.fn(() => true)) {
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
      onImport={onImport}
      revision={0}
    />,
  );
  fireEvent.click(screen.getByLabelText("Layout options"));
  return onImport;
}

describe("layout export", () => {
  it("downloads the layout as a JSON file from its row", () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:fake";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    renderMgr();
    fireEvent.click(screen.getByLabelText("Export Alpha"));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    click.mockRestore();
  });

  it("exports the ACTIVE layout from the top-level action and closes the menu", () => {
    const created: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        created.push(b);
        return "blob:fake";
      }),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    renderMgr();
    fireEvent.click(screen.getByText("Export layout…"));

    expect(created).toHaveLength(1);
    expect(document.querySelector(".layout-mgr-menu")).toBeNull();
    click.mockRestore();
  });
});

describe("layout import", () => {
  function pickFile(contents: string) {
    const input = document.querySelector(
      ".layout-mgr-menu input[type=file]",
    ) as HTMLInputElement;
    const file = new File([contents], "x.layout.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("hands a parsed export document to onImport and closes the menu", async () => {
    const onImport = renderMgr();
    const doc = {
      format: "auto-trader.layout",
      version: 1,
      name: "Beta",
      exportedAt: "2026-08-31T00:00:00.000Z",
      workspace: { tabs: [], activeTabId: "" },
      scopes: {},
    };
    fireEvent.click(screen.getByText("Import layout…"));
    pickFile(JSON.stringify(doc));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(doc));
    expect(document.querySelector(".layout-mgr-menu")).toBeNull();
  });

  it("shows an inline error for a file that is not valid JSON", async () => {
    const onImport = renderMgr();
    fireEvent.click(screen.getByText("Import layout…"));
    pickFile("{not json");
    await waitFor(() =>
      expect(screen.getByText("Not a layout export file")).toBeTruthy(),
    );
    expect(onImport).not.toHaveBeenCalled();
  });

  it("shows an inline error when onImport rejects the document", async () => {
    const onImport = renderMgr(vi.fn(() => false));
    fireEvent.click(screen.getByText("Import layout…"));
    pickFile(JSON.stringify({ format: "other" }));
    await waitFor(() =>
      expect(screen.getByText("Not a layout export file")).toBeTruthy(),
    );
    expect(onImport).toHaveBeenCalled();
  });
});
