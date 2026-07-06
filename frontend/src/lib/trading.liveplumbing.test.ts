import { describe, it, expect, vi, beforeEach } from "vitest";
import { placeOrder } from "./trading";

describe("placeOrder client_order_id passthrough", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a provided client_order_id instead of minting one", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ client_order_id: "x", status: "filled" }), { status: 200 }),
    );
    await placeOrder({
      epic: "EURUSD", side: "buy", quantity: 1,
      client_order_id: "strat-1:1700:long:buy",
    });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.client_order_id).toBe("strat-1:1700:long:buy");
  });

  it("still mints a uuid when none is provided", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ client_order_id: "x", status: "filled" }), { status: 200 }),
    );
    await placeOrder({ epic: "EURUSD", side: "buy", quantity: 1 });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.client_order_id).toMatch(/[0-9a-f-]{36}/);
  });
});
