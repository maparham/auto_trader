import { describe, it, expect } from "vitest";
import { shouldBootAdmin } from "./adminBoot";

describe("shouldBootAdmin", () => {
  it("matches /admin", () => {
    expect(shouldBootAdmin("/admin")).toBe(true);
  });
  it("tolerates a trailing slash", () => {
    expect(shouldBootAdmin("/admin/")).toBe(true);
  });
  it("does not match the app root or lookalikes", () => {
    expect(shouldBootAdmin("/")).toBe(false);
    expect(shouldBootAdmin("/administrators")).toBe(false);
    expect(shouldBootAdmin("/x/admin")).toBe(false);
  });
});
