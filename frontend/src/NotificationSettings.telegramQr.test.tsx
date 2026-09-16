// @vitest-environment jsdom
// The Telegram "Show QR" path. The invariant worth pinning: Connect and Show QR
// share ONE minted link code, because every POST /api/alerts/telegram/link mints
// a fresh one and two live codes would leave the user guessing which they scanned.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const LINK = "https://t.me/test_bot?start=";

const getTelegramStatus = vi.fn();
const startTelegramLink = vi.fn();
const pollTelegramLink = vi.fn((..._a: unknown[]) => () => {});

vi.mock("./lib/telegramClient", () => ({
  getTelegramStatus: (...a: unknown[]) => getTelegramStatus(...a),
  startTelegramLink: (...a: unknown[]) => startTelegramLink(...a),
  unlinkTelegram: vi.fn(),
  sendTelegramTest: vi.fn(),
  pollTelegramLink: (...a: unknown[]) => pollTelegramLink(...a),
}));
vi.mock("./lib/pushClient", () => ({
  pushSupported: () => false,
  isSubscribed: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));

import NotificationSettings from "./NotificationSettings";

beforeEach(() => {
  getTelegramStatus.mockReset().mockResolvedValue({ linked: false, enabled: true });
  let n = 0;
  startTelegramLink.mockReset().mockImplementation(() => Promise.resolve(`${LINK}code${++n}`));
  pollTelegramLink.mockClear();
  vi.stubGlobal("open", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const showQr = async () => {
  render(<NotificationSettings />);
  const btn = await screen.findByRole("button", { name: "Show QR" });
  await userEvent.click(btn);
  return btn;
};

describe("Telegram QR", () => {
  it("renders a QR for the minted deep link", async () => {
    await showQr();
    await waitFor(() => expect(screen.getByRole("img", { name: /Telegram/ })).toBeTruthy());
    expect(startTelegramLink).toHaveBeenCalledTimes(1);
  });

  it("reuses the same code when Connect is clicked after the QR", async () => {
    await showQr();
    await waitFor(() => expect(startTelegramLink).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));
    expect(startTelegramLink).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(`${LINK}code1`, "_blank");
  });

  it("drops the code when the QR is dismissed, so the next open mints a fresh one", async () => {
    await showQr();
    const hide = await screen.findByRole("button", { name: "Hide QR" });
    await userEvent.click(hide);
    expect(screen.queryByRole("img", { name: /Telegram/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show QR" }));
    await waitFor(() => expect(startTelegramLink).toHaveBeenCalledTimes(2));
  });

  it("keeps Connect clickable while the QR is up, and says it is waiting", async () => {
    await showQr();
    await screen.findByText("Waiting for Telegram…");
    expect(screen.getByRole("button", { name: "Connect Telegram" })).not.toHaveProperty(
      "disabled",
      true,
    );
  });

  it("still offers the QR once the account is linked (relink a second phone)", async () => {
    getTelegramStatus.mockResolvedValue({ linked: true, enabled: true });
    render(<NotificationSettings />);
    await screen.findByText("Connected");
    await userEvent.click(screen.getByRole("button", { name: "Show QR" }));
    await screen.findByRole("button", { name: "Hide QR" });
    expect(startTelegramLink).toHaveBeenCalledTimes(1);
    // No poll: status already says linked, so a tick would hide the QR again.
    expect(pollTelegramLink).not.toHaveBeenCalled();
    expect(screen.queryByText("Waiting for Telegram…")).toBeNull();
  });
});
