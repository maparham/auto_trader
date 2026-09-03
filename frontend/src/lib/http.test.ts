import { describe, it, expect, vi, afterEach } from "vitest";
import { apiFetch, errorDetail, setUnauthorizedHandler } from "./http";
import { setTokenGetter } from "./authToken";

function jsonRes(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), { status, statusText: "Unprocessable Entity" });
}

describe("errorDetail", () => {
  it("returns a plain string detail", async () => {
    expect(await errorDetail(jsonRes({ detail: "candles must not be empty" }))).toBe(
      "candles must not be empty",
    );
  });

  it("surfaces the message of a structured expr error, locating the rule", async () => {
    // /api/expr routes 422 with {code, message, start, end, group, row} — the
    // toast must show the parse message, not the generic fallback.
    const res = jsonRes({
      detail: {
        code: "unexpected_token", message: "Expected comma here.",
        start: 24, end: 25, group: "longExit", row: 0,
      },
    });
    expect(await errorDetail(res, "request failed (422)")).toBe(
      "long exit rule 1: Expected comma here.",
    );
  });

  it("surfaces a structured message without location when group/row are absent", async () => {
    const res = jsonRes({ detail: { code: "x", message: "Too few closed bars." } });
    expect(await errorDetail(res, "request failed (422)")).toBe("Too few closed bars.");
  });

  it("falls back when detail is neither string nor message-bearing", async () => {
    expect(await errorDetail(jsonRes({ detail: [{ loc: ["body"] }] }), "request failed (422)")).toBe(
      "request failed (422)",
    );
    expect(await errorDetail(new Response("oops", { status: 500, statusText: "Server Error" })))
      .toBe("500 Server Error");
  });
});

// A 401 is not always a dead session: the backend deliberately maps transient
// JWKS/network failures to 401 (it fails closed), and a ~60s Clerk token can
// expire in flight. apiFetch must retry once with a freshly minted token and
// only sign the user out when that retry also comes back unauthorized —
// before this, one server-side blip tore down the whole session.
describe("apiFetch 401 retry", () => {
  afterEach(() => {
    setTokenGetter(null);
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  const res = (status: number) => new Response("{}", { status });

  it("retries once with a fresh token and keeps the session on success", async () => {
    const getter = vi.fn(async (opts?: { fresh?: boolean }) =>
      opts?.fresh ? "t-fresh" : "t-cached",
    );
    setTokenGetter(getter);
    const signOut = vi.fn();
    setUnauthorizedHandler(signOut);
    const fetchMock = vi.fn(async () => res(fetchMock.mock.calls.length === 1 ? 401 : 200));
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiFetch("http://x/api/y");
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(retryHeaders.get("Authorization")).toBe("Bearer t-fresh");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out only when the retry is also unauthorized", async () => {
    setTokenGetter(async () => "t");
    const signOut = vi.fn();
    setUnauthorizedHandler(signOut);
    const fetchMock = vi.fn(async () => res(401));
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiFetch("http://x/api/y");
    expect(out.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("signs out without retrying when no fresh token can be minted", async () => {
    setTokenGetter(async (opts?: { fresh?: boolean }) => (opts?.fresh ? null : "t"));
    const signOut = vi.fn();
    setUnauthorizedHandler(signOut);
    const fetchMock = vi.fn(async () => res(401));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("http://x/api/y");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-401 failures", async () => {
    setTokenGetter(async () => "t");
    const signOut = vi.fn();
    setUnauthorizedHandler(signOut);
    const fetchMock = vi.fn(async () => res(500));
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiFetch("http://x/api/y");
    expect(out.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });
});
