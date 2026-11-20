// @vitest-environment jsdom
// index.html's inline head script: the static home page shows only for a
// signed-out visitor on chartkar.app's bare "/", never inside an app shell.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const gate = html.match(/<script>\s*(\/\/ Show the static home page[\s\S]*?)<\/script>/)![1];

function run(opts: { host?: string; android?: boolean; tauri?: boolean } = {}) {
  document.documentElement.removeAttribute("data-landing");
  const w = window as unknown as Record<string, unknown>;
  if (opts.android) w.ChartkarAndroid = { invoke: () => "null" };
  if (opts.tauri) w.__TAURI__ = {};
  const loc = { hostname: opts.host ?? "chartkar.app", pathname: "/", search: "", hash: "" };
  new Function("location", gate)(loc);
  return document.documentElement.hasAttribute("data-landing");
}

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.ChartkarAndroid;
  delete w.__TAURI__;
});

describe("landing gate", () => {
  it("shows the home page to a signed-out visitor on chartkar.app", () => {
    expect(run()).toBe(true);
  });

  it("never shows it inside the Android app or a Tauri shell", () => {
    expect(run({ android: true })).toBe(false);
    expect(run({ tauri: true })).toBe(false);
  });
});
