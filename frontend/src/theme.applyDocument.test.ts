// @vitest-environment jsdom
// applyThemeToDocument: the one shared path that stamps the active theme onto
// the DOM (data-theme + the --chart-bg override). App's theme effect and the
// headless SnapshotApp must both go through it — the snapshot bug this guards
// against: SnapshotApp rendered outside App, nothing set data-theme, and the
// CSS dark default painted a light-themed chart on a dark page.
import { beforeEach, describe, expect, it } from "vitest";
import { applyThemeToDocument, DEFAULT_SETTINGS, type Settings } from "./theme";

const settings = (over: Partial<Settings>): Settings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--chart-bg");
});

describe("applyThemeToDocument", () => {
  it("stamps data-theme on <html>", () => {
    applyThemeToDocument(settings({ theme: "light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    applyThemeToDocument(settings({ theme: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("sets --chart-bg when a chart background override is chosen", () => {
    applyThemeToDocument(
      settings({ theme: "light", chartBg: "#e8f0e8", chartBgOpacity: 1 }),
    );
    // jsdom normalizes hex to rgb(); compare channel values, not spelling.
    expect(
      document.documentElement.style.getPropertyValue("--chart-bg"),
    ).toMatch(/^(#e8f0e8|rgb\(232,\s*240,\s*232\))$/i);
  });

  it("clears --chart-bg when no override is chosen", () => {
    document.documentElement.style.setProperty("--chart-bg", "#123456");
    applyThemeToDocument(settings({ theme: "light" }));
    expect(
      document.documentElement.style.getPropertyValue("--chart-bg"),
    ).toBe("");
  });

  it("caps the wash opacity in dark theme (never replaces the dark bg)", () => {
    applyThemeToDocument(
      settings({ theme: "dark", chartBg: "#e8f0e8", chartBgOpacity: 1 }),
    );
    const capped = document.documentElement.style.getPropertyValue("--chart-bg");
    expect(capped).not.toBe("");
    expect(capped.toLowerCase()).not.toBe("#e8f0e8"); // dark cap kicked in
  });
});
