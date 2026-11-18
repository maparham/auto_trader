// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import AlertTags, { type AlertTagItem } from "./AlertTags";

const tag = (o: Partial<AlertTagItem> = {}): AlertTagItem => ({
  id: "al-1", y: 100, level: 50, condition: "crossing", trigger: "once", expiresAt: null,
  hovered: false, active: false, selected: false, ...o,
});

describe("AlertTags", () => {
  afterEach(cleanup);

  it("fired tag on the price row shows; a live one there is dropped", () => {
    const { container } = render(
      <AlertTags
        tags={[tag({ id: "live" }), tag({ id: "f", firedAt: Date.now() })]}
        priceTag={{ y: 100, countdown: null }}
        precision={2}
        onRearm={vi.fn()}
        onHide={vi.fn()}
      />,
    );
    const tags = container.querySelectorAll(".alert-tag");
    expect(tags).toHaveLength(1);
    expect(tags[0].classList.contains("fired")).toBe(true);
  });

  it("a fired tag re-arms on double click and its bell opens Re-arm / Hide", () => {
    const onRearm = vi.fn();
    const onHide = vi.fn();
    const { container, getByText } = render(
      <AlertTags tags={[tag({ firedAt: Date.now() })]} priceTag={null} precision={2} onRearm={onRearm} onHide={onHide} />,
    );
    const bell = container.querySelector(".alert-tag.fired .at-bell") as HTMLElement;
    fireEvent.doubleClick(bell);
    expect(onRearm).toHaveBeenCalledWith("al-1");
    fireEvent.contextMenu(bell);
    fireEvent.click(getByText("Hide"));
    expect(onHide).toHaveBeenCalledWith("al-1");
  });

  it("a live tag has no fired class and no handlers", () => {
    const onRearm = vi.fn();
    const { container } = render(
      <AlertTags tags={[tag()]} priceTag={null} precision={2} onRearm={onRearm} onHide={vi.fn()} />,
    );
    const el = container.querySelector(".alert-tag") as HTMLElement;
    expect(el.classList.contains("fired")).toBe(false);
    fireEvent.doubleClick(el.querySelector(".at-bell")!);
    expect(onRearm).not.toHaveBeenCalled();
  });
});
