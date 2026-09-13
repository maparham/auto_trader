import { useEffect, useState } from "react";
import App from "./App";
import { setDemoMode } from "./lib/demoMode";
import { setPersistBroker } from "./lib/persist/core";
import { fetchDemoSnapshot, seedDemoLayout } from "./lib/demoSnapshot";
import { exitDemoPreview } from "./lib/demoPreview";

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
 *  `preview` is the admin's "View" button from Settings > Public demo: the
 *  same component in a SIGNED-IN tab, so an admin can see what visitors get
 *  without signing out. Safe because the preview tab boots on its own key
 *  namespace (lib/demoPreview.ts) and demo mode keeps the backend mirror off,
 *  so the seeded layout cannot touch the admin's real workspace.
 *
 *  A published demo snapshot (backend `/api/demo/snapshot`) seeds a curated
 *  layout before `<App />` mounts. No snapshot yet (never published, or the
 *  fetch failed) still renders the app - it just opens on App's own default
 *  single chart instead of a curated one. */
export default function DemoApp({ preview = false }: { preview?: boolean } = {}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDemoMode();
    fetchDemoSnapshot().then((snapshot) => {
      if (cancelled) return;
      // The published payload names the broker it was captured for (yfinance
      // for new publishes); the persist broker must point there BEFORE the
      // seed so the layout keys land under the right broker family. No
      // snapshot (nothing published / fetch failed) keeps the old pin.
      setPersistBroker(snapshot?.broker ?? "dukascopy");
      if (snapshot) seedDemoLayout(snapshot.layout);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null; // same treatment AccountGate uses while its gate is pending
  return (
    <>
      {preview && (
        <div className="demo-preview-bar">
          <span>Previewing the public demo as a signed-out visitor sees it.</span>
          <button type="button" onClick={exitDemoPreview}>
            Exit preview
          </button>
        </div>
      )}
      <App />
    </>
  );
}
