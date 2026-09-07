import { describe, it, expect, vi, beforeEach } from "vitest";

// theme.ts reads the stored blob through persist's localStorage-backed cache, so
// give it an in-memory store before importing (same idiom as persist.test.ts).
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const store = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = store;
(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
  async () => new Response("{}", { status: 200 }),
) as unknown as typeof fetch;

const { loadSettings, saveSettings } = await import("./../theme");

describe("alertDefaults.startAtCreation", () => {
  beforeEach(() => store.clear());

  it("defaults ON, so a fresh install shortens alert lines to their creation bar", () => {
    expect(loadSettings().alertDefaults.startAtCreation).toBe(true);
  });

  it("defaults ON for a settings blob saved before the key existed", () => {
    // A pre-existing blob carrying only SOME alertDefaults keys: the deep merge
    // must fill this one in rather than leave it undefined (which the modal would
    // then read as an unchecked box).
    saveSettings({
      ...loadSettings(),
      alertDefaults: {
        condition: "greater",
        trigger: "every",
      } as unknown as ReturnType<typeof loadSettings>["alertDefaults"],
    });
    const ad = loadSettings().alertDefaults;
    expect(ad.startAtCreation).toBe(true);
    expect(ad.condition).toBe("greater"); // the stored keys still win
  });

  it("round-trips an explicit OFF", () => {
    const s = loadSettings();
    saveSettings({ ...s, alertDefaults: { ...s.alertDefaults, startAtCreation: false } });
    expect(loadSettings().alertDefaults.startAtCreation).toBe(false);
  });
});
