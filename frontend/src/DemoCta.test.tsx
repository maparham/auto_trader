// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DemoCta from "./DemoCta";

describe("DemoCta", () => {
  it("renders a sign-up link to /?sign_in=1", () => {
    render(<DemoCta />);
    const link = screen.getByRole("link", { name: /sign up/i });
    expect(link.getAttribute("href")).toBe("/?sign_in=1");
  });

  it("uses the given label in the inline variant", () => {
    render(<DemoCta inline label="Sign up to run backtests" />);
    const link = screen.getByRole("link", { name: "Sign up to run backtests" });
    expect(link.getAttribute("href")).toBe("/?sign_in=1");
  });
});
