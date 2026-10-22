import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenSpecError, deleteScreen, listScreens, saveScreen, startScreen } from "./screens";

const draft = { broker: "yfinance", resolution: "DAY", symbols: ["AAPL"], expression: "RSI(14) < 30", columns: [] };

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("screens client", () => {
  it("lists screens", async () => {
    stubFetch(200, { screens: [{ id: "s1", name: "x", ...draft, created_at: 1, updated_at: 1 }] });
    expect((await listScreens())[0].id).toBe("s1");
  });

  it("creates with POST and updates with PUT", async () => {
    const fn = stubFetch(200, { id: "s1" });
    await saveScreen("x", draft);
    expect(String(fn.mock.calls[0][0])).toMatch(/\/api\/screens$/);
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe("POST");
    await saveScreen("x", draft, "s1");
    expect(String(fn.mock.calls[1][0])).toMatch(/\/api\/screens\/s1$/);
    expect((fn.mock.calls[1][1] as RequestInit).method).toBe("PUT");
  });

  it("turns an expression 422 into ScreenSpecError", async () => {
    stubFetch(422, { detail: { code: "unexpected_token", message: "Expected a value here.", start: 14, end: 14, field: "expression", index: 0 } });
    await expect(startScreen(draft, "mid")).rejects.toBeInstanceOf(ScreenSpecError);
  });

  it("delete throws on 404", async () => {
    stubFetch(404, { detail: "no such screen" });
    await expect(deleteScreen("nope")).rejects.toThrow("no such screen");
  });
});
