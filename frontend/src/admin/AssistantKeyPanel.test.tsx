// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AssistantKeyPanel from "./AssistantKeyPanel";
import * as api from "./api";
import { AdminHttpError, type AssistantKeyInfo } from "./api";

const ENV: AssistantKeyInfo = {
  source: "env", last4: "1111", disabled: false, envKeySet: true, setBy: null, setAt: null,
};
const SAVED: AssistantKeyInfo = {
  source: "dashboard", last4: "2222", disabled: false, envKeySet: true,
  setBy: "user_admin", setAt: 1_000,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AssistantKeyPanel", () => {
  it("shows where the key comes from and only its last 4", async () => {
    vi.spyOn(api, "fetchAssistantKey").mockResolvedValue(ENV);
    render(<AssistantKeyPanel refreshKey={0} />);
    expect(await screen.findByText(/server env/)).toBeTruthy();
    expect(screen.getByText(/••••1111/)).toBeTruthy();
    expect(screen.queryByText("Revert to env")).toBeNull();
  });

  it("saves a new key, then clears the field", async () => {
    vi.spyOn(api, "fetchAssistantKey").mockResolvedValue(ENV);
    const save = vi.spyOn(api, "saveAssistantKey").mockResolvedValue(SAVED);
    render(<AssistantKeyPanel refreshKey={0} />);
    const input = (await screen.findByLabelText("New gateway key")) as HTMLInputElement;
    await userEvent.type(input, " sk-new-2222 ");
    await userEvent.click(screen.getByText("Save"));
    expect(save).toHaveBeenCalledWith("sk-new-2222");
    await waitFor(() => expect(screen.getByText(/••••2222/)).toBeTruthy());
    expect(input.value).toBe("");
    expect(screen.getByText("Revert to env")).toBeTruthy();
  });

  it("shows why a key was refused and keeps the draft", async () => {
    vi.spyOn(api, "fetchAssistantKey").mockResolvedValue(ENV);
    vi.spyOn(api, "saveAssistantKey").mockRejectedValue(
      new AdminHttpError(422, "the gateway rejected this key"),
    );
    render(<AssistantKeyPanel refreshKey={0} />);
    const input = (await screen.findByLabelText("New gateway key")) as HTMLInputElement;
    await userEvent.type(input, "sk-typo");
    await userEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("the gateway rejected this key")).toBeTruthy();
    expect(input.value).toBe("sk-typo");
  });

  it("reverts to the env key after a confirm", async () => {
    vi.spyOn(api, "fetchAssistantKey").mockResolvedValue(SAVED);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const clear = vi.spyOn(api, "clearAssistantKey").mockResolvedValue(ENV);
    render(<AssistantKeyPanel refreshKey={0} />);
    await userEvent.click(await screen.findByText("Revert to env"));
    expect(clear).toHaveBeenCalled();
    expect(await screen.findByText(/••••1111/)).toBeTruthy();
  });
});
