// @vitest-environment jsdom
//
// The picker is rendered on `mode === "picking"`, so a successful jump UNMOUNTS
// it. That is what made the window choice a bug rather than a preference: local
// state put every session after the first back on the default month, and a user
// who had asked for a year kept landing a few days ago and could not see why.
// So: remount, and the choice is still there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReplayStartPanel from "./ReplayStartPanel";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const DAY = 86_400_000;

function mount(onJump = vi.fn()) {
  render(
    <ReplayStartPanel
      loading={false}
      error={null}
      masked
      onMaskedChange={vi.fn()}
      onJump={onJump}
      onCancel={vi.fn()}
    />,
  );
  return {
    onJump,
    select: () => screen.getByLabelText("Random jump window") as HTMLSelectElement,
    jump: () => screen.getByText("Jump"),
  };
}

describe("ReplayStartPanel's jump window", () => {
  it("jumps over the window the user chose", () => {
    const p = mount();
    fireEvent.change(p.select(), { target: { value: "1Y" } });
    fireEvent.click(p.jump());
    expect(p.onJump).toHaveBeenCalledWith(365 * DAY, true);
  });

  it("still has that window after the panel unmounts and comes back", () => {
    const first = mount();
    fireEvent.change(first.select(), { target: { value: "1Y" } });
    cleanup();

    const second = mount();
    expect(second.select().value).toBe("1Y");
    fireEvent.click(second.jump());
    expect(second.onJump).toHaveBeenCalledWith(365 * DAY, true);
  });

  it("remembers a custom day count too", () => {
    const first = mount();
    fireEvent.change(first.select(), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Days back"), { target: { value: "200" } });
    cleanup();

    const second = mount();
    expect((screen.getByLabelText("Days back") as HTMLInputElement).value).toBe("200");
    fireEvent.click(second.jump());
    expect(second.onJump).toHaveBeenCalledWith(200 * DAY, true);
  });

  // The field is briefly empty mid-edit; that must not be written down as the
  // remembered window.
  it("does not remember a half-typed day count", () => {
    const first = mount();
    fireEvent.change(first.select(), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Days back"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Days back"), { target: { value: "" } });
    cleanup();

    mount();
    expect((screen.getByLabelText("Days back") as HTMLInputElement).value).toBe("200");
  });
});
