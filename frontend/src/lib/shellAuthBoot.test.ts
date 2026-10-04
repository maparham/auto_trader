import { describe, expect, it } from "vitest";
import { appReturnIntentUrl, parseClerkTicket, parseShellAuthParams } from "./shellAuthBoot";

describe("parseShellAuthParams", () => {
  it("parses a valid handoff boot", () => {
    expect(parseShellAuthParams("?shell_auth=1&port=49213&state=abc123")).toEqual({
      kind: "loopback",
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

describe("parseShellAuthParams, Android app shape", () => {
  it("parses return=app with a state and no port", () => {
    expect(parseShellAuthParams("?shell_auth=1&return=app&state=s1")).toEqual({ kind: "app", state: "s1" });
  });
  it("ignores a stray port on the app shape", () => {
    expect(parseShellAuthParams("?shell_auth=1&return=app&port=49213&state=s1")).toEqual({ kind: "app", state: "s1" });
  });
  it("rejects the app shape without a state", () => {
    expect(parseShellAuthParams("?shell_auth=1&return=app")).toBeNull();
  });
});

describe("appReturnIntentUrl", () => {
  it("pins the package and carries no ticket in the fallback", () => {
    const u = appReturnIntentUrl("sit_abc", "s1");
    expect(u.startsWith("intent://chartkar.app/app-auth/callback?")).toBe(true);
    expect(u).toContain("#Intent;scheme=https;package=app.chartkar.android;");
    expect(u.endsWith(";end")).toBe(true);
    const fallback = decodeURIComponent(u.split("S.browser_fallback_url=")[1].split(";")[0]);
    expect(fallback).toBe("https://chartkar.app/app-auth/callback");
  });
  it("round-trips awkward characters", () => {
    const u = appReturnIntentUrl("a&b=c+d#e", "s/1?");
    const query = u.slice(u.indexOf("?") + 1, u.indexOf("#Intent"));
    const q = new URLSearchParams(query);
    expect(q.get("ticket")).toBe("a&b=c+d#e");
    expect(q.get("state")).toBe("s/1?");
  });
});

describe("parseClerkTicket", () => {
  it("returns the ticket when present, null otherwise", () => {
    expect(parseClerkTicket("?__clerk_ticket=sit_abc")).toBe("sit_abc");
    expect(parseClerkTicket("?__clerk_ticket=")).toBeNull();
    expect(parseClerkTicket("?foo=1")).toBeNull();
  });
});
