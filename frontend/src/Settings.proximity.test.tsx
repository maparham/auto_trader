// @vitest-environment jsdom
// Settings > Trading "Warn near SL/TP": the default ATR multiple keeps a local
// draft so it can be cleared and retyped, commits only valid values, and
// reverts to the saved value on blur.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("./admin/useIsAdmin", () => ({ useIsAdmin: () => false }));
vi.mock("./lib/demoMode", () => ({ isDemoMode: () => false }));

import SettingsModal from "./Settings";
import { DEFAULT_SETTINGS } from "./theme";

afterEach(cleanup);

function setup() {
  const onChange = vi.fn();
  render(<SettingsModal settings={DEFAULT_SETTINGS} onChange={onChange} onClose={() => {}} initialTab="trading" />);
  const input = screen.getByLabelText("Warn near SL/TP ATR multiple") as HTMLInputElement;
  return { onChange, input };
}

describe("Settings warn near SL/TP default", () => {
  it("can be cleared and retyped to 1.5", () => {
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "1." } });
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input.value).toBe("1.5");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ proximityAtrMult: 1.5 }));
  });

  it("reverts an invalid draft on blur without committing", () => {
    const { onChange, input } = setup();
    const saved = String(DEFAULT_SETTINGS.proximityAtrMult);
    fireEvent.change(input, { target: { value: "0.01" } });
    fireEvent.blur(input);
    expect(input.value).toBe(saved);
    expect(onChange).not.toHaveBeenCalled();
  });
});
