// Browser fallback for the Android sign-in return link. The URL may carry a
// single-use ticket: drop it from the address bar and history before
// anything else, and never render it.
import { useState } from "react";

export default function AppAuthCallbackPage() {
  useState(() => {
    window.history.replaceState(null, "", window.location.pathname);
    return null;
  });
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 16 }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        Open the Chartkar app and sign in again from there.
      </div>
    </div>
  );
}
