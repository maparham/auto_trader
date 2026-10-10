// @vitest-environment jsdom
// Indicator "price vs line" bells: a price-less, clickable alert tag.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import AlertTags from "./AlertTags";

describe("AlertTags bells", () => {
  it("renders a bell-only pill per bell and opens its alert on click", () => {
    const onBellClick = vi.fn();
    const { container, getByLabelText } = render(
      <AlertTags tags={[]} bells={[{ id: "al-9", y: 42 }]} onBellClick={onBellClick} priceTag={null} precision={2} />,
    );
    const bell = container.querySelector(".alert-tag.ind-bell") as HTMLElement;
    expect(bell).not.toBeNull();
    expect(bell.style.top).toBe("42px");
    expect(bell.querySelector(".at-price")).toBeNull();
    fireEvent.click(getByLabelText("Edit indicator alert"));
    expect(onBellClick).toHaveBeenCalledWith("al-9");
  });
});
