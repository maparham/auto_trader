import { describe, expect, it } from "vitest";
import { parseClerkTicket, parseShellAuthParams } from "./shellAuthBoot";

describe("parseShellAuthParams", () => {
  it("parses a valid handoff boot", () => {
    expect(parseShellAuthParams("?shell_auth=1&port=49213&state=abc123")).toEqual({
      port: 49213,
      state: "abc123",
    });
  });

  it("returns null without the shell_auth flag", () => {
    expect(parseShellAuthParams("?port=49213&state=abc")).toBeNull();
    expect(parseShellAuthParams("")).toBeNull();
  });

  it("rejects a missing or invalid port", () => {
    expect(parseShellAuthParams("?shell_auth=1&state=abc")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=0&state=abc")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=65536&state=abc")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=12.5&state=abc")).toBeNull();
  });

  it("rejects a missing state", () => {
    expect(parseShellAuthParams("?shell_auth=1&port=49213")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=49213&state=")).toBeNull();
  });
});

describe("parseClerkTicket", () => {
  it("returns the ticket when present, null otherwise", () => {
    expect(parseClerkTicket("?__clerk_ticket=sit_abc")).toBe("sit_abc");
    expect(parseClerkTicket("?__clerk_ticket=")).toBeNull();
    expect(parseClerkTicket("?foo=1")).toBeNull();
  });
});
