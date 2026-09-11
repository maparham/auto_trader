// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useIsAdmin } from "./useIsAdmin";
import * as api from "./api";

function Probe({ enabled = true }: { enabled?: boolean }) {
  return <span data-testid="flag">{String(useIsAdmin(enabled))}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useIsAdmin", () => {
  it("is true when whoami answers", async () => {
    vi.spyOn(api, "fetchWhoami").mockResolvedValue({
      userId: "u", email: null, isAdmin: true, hostedMode: true,
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("flag").textContent).toBe("true"));
  });

  it("stays false when whoami 403s", async () => {
    vi.spyOn(api, "fetchWhoami").mockRejectedValue(
      new api.AdminHttpError(403, "admin access required"),
    );
    render(<Probe />);
    await waitFor(() => expect(api.fetchWhoami).toHaveBeenCalled());
    expect(screen.getByTestId("flag").textContent).toBe("false");
  });

  it("does not probe at all when disabled", () => {
    const spy = vi.spyOn(api, "fetchWhoami");
    render(<Probe enabled={false} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("flag").textContent).toBe("false");
  });
});
