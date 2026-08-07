import { describe, it, expect } from "vitest";
import { errorDetail } from "./http";

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
