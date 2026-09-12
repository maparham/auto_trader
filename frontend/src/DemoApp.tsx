import { useEffect, useState } from "react";
import App from "./App";
import { setDemoMode } from "./lib/demoMode";
import { setPersistBroker } from "./lib/persist/core";
import { fetchDemoSnapshot, seedDemoLayout } from "./lib/demoSnapshot";

/** Signed-out visitors boot the real app in a read-only demo instead of the
 *  sign-in card. `setDemoMode()` / `setPersistBroker()` run at the top of the
 *  boot effect (NOT during render): Clerk's `<SignedOut>` can render
 *  transiently while a session is still resolving, and `setDemoMode()` is a
 *  one-way latch, so a render-phase call would permanently kill
 *  mirroring/hydrate for a visit that turns out to be signed in. The effect
 *  only ever runs once this component is actually committed, and the
 *  `if (!ready) return null` gate below keeps `<App />` from mounting (and
 *  touching persistence) before it does.
 *
 *  A published demo snapshot (backend `/api/demo/snapshot`) seeds a curated
 *  layout before `<App />` mounts. No snapshot yet (never published, or the
 *  fetch failed) still renders the app - it just opens on App's own default
 *  single chart instead of a curated one. */
export default function DemoApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDemoMode();
    setPersistBroker("dukascopy");
    fetchDemoSnapshot().then((snapshot) => {
      if (cancelled) return;
      if (snapshot) seedDemoLayout(snapshot.layout);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null; // same treatment AccountGate uses while its gate is pending
  return <App />;
}
