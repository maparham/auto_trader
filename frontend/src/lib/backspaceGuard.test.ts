// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installBackspaceGuard } from "./backspaceGuard";

function press(target: HTMLElement, key = "Backspace"): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("backspace guard", () => {
  let uninstall = () => {};
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  it("swallows Backspace outside text fields", () => {
    uninstall = installBackspaceGuard();
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(press(div).defaultPrevented).toBe(true);
  });

  it("leaves text fields and other keys alone", () => {
    uninstall = installBackspaceGuard();
    const input = document.createElement("input");
    const ta = document.createElement("textarea");
    const div = document.createElement("div");
    document.body.append(input, ta, div);
    expect(press(input).defaultPrevented).toBe(false);
    expect(press(ta).defaultPrevented).toBe(false);
    expect(press(div, "Delete").defaultPrevented).toBe(false);
  });

  it("runs after document handlers, so they still see a clean event", () => {
    uninstall = installBackspaceGuard();
    let sawPrevented: boolean | null = null;
    const onDoc = (e: KeyboardEvent) => { sawPrevented = e.defaultPrevented; };
    document.addEventListener("keydown", onDoc);
    const div = document.createElement("div");
    document.body.appendChild(div);
    const e = press(div);
    document.removeEventListener("keydown", onDoc);
    expect(sawPrevented).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });
});
