// @vitest-environment jsdom
//
// The Chrome side of the shell handoff: mint a sign-in token via the backend,
// then top-level-redirect it to the shell's loopback listener. A redirect,
// not a fetch: https-to-loopback fetches are blocked as mixed content.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { API_BASE } from "../lib/http";
import ShellAuthHandoff from "./ShellAuthHandoff";

const replace = vi.fn();

function stubLocation() {
  vi.stubGlobal("location", { ...window.location, replace });
}

afterEach(() => {
  cleanup();
  replace.mockClear();
  vi.unstubAllGlobals();
});

it("mints a token and redirects it to the loopback listener", async () => {
  stubLocation();
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ token: "sit_abc" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<ShellAuthHandoff params={{ port: 49213, state: "n0nce" }} />);
  await waitFor(() => expect(replace).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    `${API_BASE}/api/auth/shell-token`,
    expect.objectContaining({ method: "POST" }),
  );
  expect(replace).toHaveBeenCalledWith(
    "http://127.0.0.1:49213/callback?ticket=sit_abc&state=n0nce",
  );
});

it("shows the error and does not redirect when the mint fails", async () => {
  stubLocation();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  const { findByText } = render(
    <ShellAuthHandoff params={{ port: 49213, state: "n0nce" }} />,
  );
  await findByText(/failed \(503\)/);
  expect(replace).not.toHaveBeenCalled();
});

it("mints exactly once across a StrictMode double-mount", async () => {
  stubLocation();
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ token: "sit_abc" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { StrictMode } = await import("react");
  render(
    <StrictMode>
      <ShellAuthHandoff params={{ port: 49213, state: "n0nce" }} />
    </StrictMode>,
  );
  await waitFor(() => expect(replace).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
