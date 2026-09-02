// vitest runs in the 'node' env (see vite.config.ts), so tests that import a module
// touching localStorage at module-eval time (persist.ts, trading.ts) need a tiny
// in-memory stand-in installed before that import.
export class MemStorage {
  #m = new Map<string, string>();
  [key: string]: any;

  get length(): number {
    return this.#m.size;
  }
  key(i: number): string | null {
    return [...this.#m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.#m.has(k) ? this.#m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.#m.set(k, v);
    // Make key accessible as a property for Object.keys() enumeration (e.g., AccountGate
    // wipes auto-trader.* keys by iterating Object.keys(localStorage)).
    this[k] = v;
  }
  removeItem(k: string): void {
    this.#m.delete(k);
    delete this[k];
  }
  clear(): void {
    this.#m.clear();
    for (const k of Object.keys(this)) {
      delete this[k];
    }
  }
}

export function installMemStorage(): MemStorage {
  const storage = new MemStorage();
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;
  // Session-scoped selections (activeAccount / activeLayoutId) read sessionStorage
  // first; give tests a separate in-memory instance so the two layers are distinct.
  (globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage =
    new MemStorage();
  return storage;
}
