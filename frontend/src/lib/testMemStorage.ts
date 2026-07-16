// vitest runs in the 'node' env (see vite.config.ts), so tests that import a module
// touching localStorage at module-eval time (persist.ts, trading.ts) need a tiny
// in-memory stand-in installed before that import.
export class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
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
