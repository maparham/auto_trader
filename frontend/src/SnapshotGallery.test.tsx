// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";
import { saveSnapshot, loadSnapshot, loadSnapshotIndex } from "./lib/persist";
import { confirmRequest } from "./lib/signals";
import SnapshotGallery from "./SnapshotGallery";
import type { ChartSnapshot } from "./lib/persist";

function makeSnap(id: string, name: string): ChartSnapshot {
  return {
    id,
    name,
    epic: "US100",
    symbol: { epic: "US100", name: "US 100", status: "TRADEABLE" },
    period: { resolution: "MINUTE_15", label: "15m" },
    takenAt: 1_700_000_000_000,
    range: { from: 1, to: 2 },
    indicators: [],
    indicatorConfigs: {},
    drawings: [],
    avwapAnchors: {},
  };
}

beforeEach(() => {
  installMemStorage();
  confirmRequest.set(null);
});

afterEach(cleanup);

describe("SnapshotGallery", () => {
  it("shows an empty state when there are no snapshots", () => {
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no snapshots yet/i)).toBeTruthy();
  });

  it("lists snapshots newest-first and Restore passes the snapshot", () => {
    saveSnapshot(makeSnap("a", "Old one"));
    saveSnapshot(makeSnap("b", "New one"));
    const onRestore = vi.fn();
    render(<SnapshotGallery onRestore={onRestore} onClose={() => {}} />);
    const names = screen
      .getAllByDisplayValue(/one$/)
      .map((el) => (el as HTMLInputElement).value);
    expect(names).toEqual(["New one", "Old one"]);
    fireEvent.click(screen.getAllByText("Restore")[0]);
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("rename commits on blur", () => {
    saveSnapshot(makeSnap("a", "Old name"));
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    const input = screen.getByDisplayValue("Old name");
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);
    expect(loadSnapshot("a")?.name).toBe("New name");
  });

  it("Save current chart calls onSaveCurrent and shows the new card", async () => {
    const onSaveCurrent = vi.fn(async () => {
      const s = makeSnap("fresh", "Just saved");
      saveSnapshot(s);
      return s;
    });
    render(
      <SnapshotGallery onRestore={() => {}} onClose={() => {}} onSaveCurrent={onSaveCurrent} />,
    );
    fireEvent.click(screen.getByText("Save current chart"));
    expect(onSaveCurrent).toHaveBeenCalledOnce();
    expect(await screen.findByDisplayValue("Just saved")).toBeTruthy();
  });

  it("hides the save bar when onSaveCurrent is not provided", () => {
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    expect(screen.queryByText("Save current chart")).toBeNull();
  });

  it("delete asks for confirmation, then removes on confirm", () => {
    saveSnapshot(makeSnap("a", "Doomed"));
    render(<SnapshotGallery onRestore={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(loadSnapshotIndex()).toEqual(["a"]); // not deleted yet
    expect(confirmRequest.value).not.toBeNull();
    confirmRequest.value!.onConfirm();
    expect(loadSnapshotIndex()).toEqual([]);
  });
});
