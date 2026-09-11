import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import SnapshotApp from './SnapshotApp.tsx'
import MobileApp from './mobile/MobileApp.tsx'
import AdminApp from './admin/AdminApp.tsx'
import ClerkTokenBridge from './components/ClerkTokenBridge.tsx'
import AccountGate from './components/AccountGate.tsx'
import { CLERK_ENABLED } from './lib/authToken.ts'
import { parseSnapshotParams } from './lib/snapshotBoot.ts'
import { shouldBootMobile } from './lib/mobileBoot.ts'
import { shouldBootAdmin } from './lib/adminBoot.ts'
import { startShellStatusMirror } from './lib/shellStatus.ts'

// The publishable key doubles as the feature switch: unset (local dev) renders
// exactly the pre-auth tree — no provider, no sign-in, no behavior change.
const clerkKey = (
  import.meta as unknown as { env?: { VITE_CLERK_PUBLISHABLE_KEY?: string } }
).env?.VITE_CLERK_PUBLISHABLE_KEY

// The headless snapshot boot (?snapshot=1&broker=..&epic=..) renders OUTSIDE
// the Clerk tree in all cases — its auth token comes from the URL, not Clerk.
const snapshotParams = parseSnapshotParams(window.location.search)

// Decided once so both the Clerk-enabled and no-Clerk fallback branches agree.
const bootMobile = shouldBootMobile()

// The admin console at /admin. Unlike the snapshot boot it renders INSIDE the
// Clerk tree (it needs ClerkTokenBridge to have run so apiFetch carries a
// token), and the path wins over the mobile boot.
const bootAdmin = shouldBootAdmin()

// Colour the native shell's menu-bar glyph by live-engine status. No-op in a
// plain browser.
startShellStatusMirror()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {snapshotParams ? (
      <SnapshotApp />
    ) : CLERK_ENABLED && clerkKey ? (
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
        <ClerkTokenBridge />
        <SignedIn>
          <AccountGate>
            {bootAdmin ? <AdminApp /> : bootMobile ? <MobileApp /> : <App />}
          </AccountGate>
        </SignedIn>
        <SignedOut>
          <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
            <SignIn />
          </div>
        </SignedOut>
      </ClerkProvider>
    ) : bootAdmin ? (
      <AdminApp />
    ) : bootMobile ? (
      <MobileApp />
    ) : (
      <App />
    )}
  </StrictMode>,
)
