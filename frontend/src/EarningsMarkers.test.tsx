// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import EarningsMarkers, { type EarningsMarkersHandle } from "./EarningsMarkers";
import type { EarningsMarker } from "./lib/earnings";

afterEach(cleanup);

const marker = (over: Partial<EarningsMarker> = {}): EarningsMarker => ({
  key: "earn:1",
  x: 40,
  label: "Earnings 30 Jul 2026",
  upcoming: false,
  lift: false,
  earnings: {
    timeMs: Date.UTC(2026, 6, 30, 20),
    epsEstimate: 1.89,
    epsActual: 2.02,
    surprisePct: 6.74,
    revenueEstimate: null,
    revenueActual: 109.417e9,
    session: "post",
    openTimeMs: Date.UTC(2026, 6, 30, 13, 30),
    closeTimeMs: Date.UTC(2026, 6, 30, 20),
  },
  ...over,
});

function setup(markers: EarningsMarker[] = [marker()]) {
  const ref = createRef<EarningsMarkersHandle>();
  const r = render(<EarningsMarkers handleRef={ref} timeZone="Europe/Berlin" clock="24h" />);
  act(() => ref.current!.setMarkers(markers, 200));
  return { ref, ...r };
}

describe("EarningsMarkers", () => {
  it("renders one chip per marker on the pane's bottom edge", () => {
    setup();
    const chip = screen.getByRole("button", { name: "Earnings 30 Jul 2026" });
    expect(chip.textContent).toBe("E");
    expect(chip.style.left).toBe("40px");
    expect(chip.style.top).toBe(`${200 - 18}px`);
    expect(chip.style.border).toContain("solid");
  });

  it("dashes an upcoming chip and lifts one off a split chip", () => {
    setup([marker({ upcoming: true, lift: true })]);
    const chip = screen.getByRole("button", { name: "Earnings 30 Jul 2026" });
    expect(chip.style.border).toContain("dashed");
    expect(chip.style.top).toBe(`${200 - 18 - 16}px`);
  });

  it("turns a missed estimate's chip red", () => {
    const miss = marker();
    miss.earnings = { ...miss.earnings, epsActual: 0.33, epsEstimate: 0.54, surprisePct: -39.1 };
    setup([miss]);
    const chip = screen.getByRole("button", { name: "Earnings 30 Jul 2026" });
    expect(chip.style.color).toBe("var(--neg)");
    expect(chip.style.border).toContain("var(--neg)");
  });

  it("turns a beat's chip green", () => {
    setup();
    const chip = screen.getByRole("button", { name: "Earnings 30 Jul 2026" });
    expect(chip.style.color).toBe("var(--pos)");
    expect(chip.style.border).toContain("var(--pos)");
  });

  it("keeps an in-line or upcoming chip neutral", () => {
    const flat = marker();
    flat.earnings = { ...flat.earnings, surprisePct: 0 };
    const up = marker({ key: "earn:2", label: "Earnings 2 Nov 2026", upcoming: true });
    up.earnings = { ...up.earnings, epsActual: null, surprisePct: null };
    setup([flat, up]);
    expect(screen.getByRole("button", { name: "Earnings 30 Jul 2026" }).style.color).toBe("var(--text)");
    expect(screen.getByRole("button", { name: "Earnings 2 Nov 2026" }).style.color).toBe("var(--text)");
  });

  it("opens the detail on a click, with estimate vs actual", () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Earnings 30 Jul 2026" }));
    const pop = screen.getByRole("dialog", { name: "Earnings 30 Jul 2026" });
    expect(pop.textContent).toContain("Reported");
    expect(pop.textContent).toContain("After close (22:00)");
    expect(pop.textContent).toContain("2.02");
    expect(pop.textContent).toContain("109.4B");
    expect(pop.textContent).toContain("+6.7%");
  });

  it("closes on the x, a press outside, Escape, or the chip again", () => {
    setup();
    const chip = screen.getByRole("button", { name: "Earnings 30 Jul 2026" });
    const reopen = () => {
      fireEvent.click(chip);
      expect(screen.getByRole("dialog")).toBeTruthy();
    };

    reopen();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    reopen();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();

    reopen();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    reopen();
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks EPS, Revenue and the surprise as explained terms", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Earnings 30 Jul 2026" }));
    const terms = [...screen.getByRole("dialog").querySelectorAll(".earn-pop-term")].map((n) => n.textContent);
    expect(terms).toEqual(["Estimate", "Actual", "EPS", "Revenue", "EPS surprise"]);
    expect(screen.getByRole("button", { name: "About EPS" })).toBeTruthy();
  });

  it("takes focus on open and hands it back to the chip on the x or Escape", () => {
    setup();
    const chip = screen.getByRole("button", { name: "Earnings 30 Jul 2026" });
    fireEvent.click(chip);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(chip);

    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(chip);
  });

  it("stays open on a press inside the popup", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Earnings 30 Jul 2026" }));
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes when its chip leaves the pane", () => {
    const { ref } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Earnings 30 Jul 2026" }));
    act(() => ref.current!.setMarkers([marker({ key: "earn:2", label: "Earnings 1 Aug 2026" })], 200));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing without markers", () => {
    const { container } = setup([]);
    expect(container.firstChild).toBeNull();
  });
});
