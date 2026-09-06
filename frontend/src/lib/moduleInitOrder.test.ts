// Guards the persist/core <-> signals <-> alertsApi import CYCLE against a
// module-init TDZ crash.
//
// The cycle is real: signals.ts imports PREFIX/load from persist/core, and
// persist/core reaches back into signals transitively (core -> alertsApi ->
// signals). In an ES module cycle, whichever member the bundler evaluates FIRST
// sees the other's bindings uninitialized, so ANY top-level statement that
// *calls* across the cycle throws "Cannot access 'X' before initialization" —
// and at app boot that is a white screen, not a caught error.
//
// This bit once: persist/core imported alertsApi (for the `__alerts__:` ws
// routing), alertsApi imports signals, and signals reads core's PREFIX at module
// scope — so core evaluating first crashed the live app at boot while the whole
// test suite stayed green (every other suite happens to import signals first).
// The fix inverts that edge: alertsApi REGISTERS its router with core, so core
// imports nothing that leads back to signals and the cycle does not exist.
//
// Vitest gives each test FILE a fresh module registry, so importing persist/core
// FIRST here really does reproduce the bad order. Keep this file free of any
// other import of these modules — a stray one would pre-warm the registry in the
// safe order and quietly make the whole test vacuous.

import { describe, it, expect } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
// Seeded BEFORE any of the modules under test are imported: the sweepTarget read
// is deferred by exactly one microtask, so it lands during the first import
// below and there is no later window in which to set this up.
localStorage.setItem("auto-trader.sweepTarget", JSON.stringify("remote"));

describe("persist/core -> signals module-init order", () => {
  it("evaluates cleanly with persist/core imported FIRST, and seeds off storage", async () => {
    // A TDZ violation rejects the dynamic import rather than throwing here.
    await expect(import("./persist/core")).resolves.toBeDefined();
    await expect(import("./alertsApi")).resolves.toBeDefined();
    const signals = await import("./signals");
    // Not just "it didn't throw": signals' module-scope seed must have actually
    // READ core's PREFIX/load successfully. A swallowed TDZ (or a deferral that
    // fires before core finishes) leaves the default "local" here instead.
    expect(signals.sweepTargetSignal.value).toBe("remote");
  });

  it("persist/core does not import the alerts client (the edge that closed the cycle)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./persist/core.ts", import.meta.url), "utf8"),
    );
    // alertsApi registers ITSELF with core; core must never import it (nor
    // ./signals, which alertsApi pulls in) or the cycle comes back.
    expect(src).not.toMatch(/^\s*import\s[^;]*from\s+"\.\.\/alertsApi"/m);
    expect(src).not.toMatch(/^\s*import\s[^;]*from\s+"\.\.\/signals"/m);
  });
});
