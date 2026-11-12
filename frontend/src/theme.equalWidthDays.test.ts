// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { saveSettingsRaw } from "./lib/persist/core";
import { DEFAULT_SETTINGS, loadSettings } from "./theme";

describe("equalWidthDays setting", () => {
  it("defaults to off, also for settings saved before it existed", () => {
    saveSettingsRaw({});
    expect(loadSettings().equalWidthDays).toBe(false);
    const { equalWidthDays: _drop, ...old } = { ...DEFAULT_SETTINGS, equalWidthDays: true };
    saveSettingsRaw(old);
    expect(loadSettings().equalWidthDays).toBe(false);
  });
});
