import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import SnapshotApp from './SnapshotApp.tsx'
import MobileApp from './mobile/MobileApp.tsx'
import AdminApp from './admin/AdminApp.tsx'
import ClerkTokenBridge from './components/ClerkTokenBridge.tsx'
import AccountGate from './components/AccountGate.tsx'
import ImpersonationBanner from './components/ImpersonationBanner.tsx'
import ShellAuthHandoff from './components/ShellAuthHandoff.tsx'
import ShellTicketSignIn from './components/ShellTicketSignIn.tsx'
import DemoApp from './DemoApp.tsx'
import { CLERK_ENABLED } from './lib/authToken.ts'
import { parseSnapshotParams } from './lib/snapshotBoot.ts'
import { parseShellAuthParams } from './lib/shellAuthBoot.ts'
import { shouldShowSignIn } from './lib/demoBoot.ts'
import { isDemoPreview } from './lib/demoPreview.ts'
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

// The shell browser-auth handoff boot (?shell_auth=1&port=..&state=..): a
// Chrome tab opened by the native shell to mint and forward a sign-in ticket.
const shellAuthParams = parseShellAuthParams(window.location.search)

// The Clerk cards otherwise title themselves after the dashboard's application
// name, which still reads "Auto Trader"; the product is Chartkar.
const CLERK_TEXT = {
  signIn: {
    start: { title: 'Sign in to Chartkar', subtitle: 'Welcome back' },
  },
  signUp: {
    start: { title: 'Create your Chartkar account', subtitle: 'Free to start' },
  },
}

// Decided once so both the Clerk-enabled and no-Clerk fallback branches agree.
const bootMobile = shouldBootMobile()

// ?demo=preview: an admin looking at the published demo from a signed-in tab
// (Settings > Public demo > View). It renders the visitor's DemoApp, but on
// its own workspace key namespace - see lib/demoPreview.ts. Deliberately
// OUTSIDE AccountGate: the preview has no account state to gate, and staying
// out keeps it from hydrating the signed-in workspace it is standing in for.
const bootDemoPreview = isDemoPreview()

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
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/" localization={CLERK_TEXT}>
        <ClerkTokenBridge />
        <SignedIn>
          {shellAuthParams ? (
            <ShellAuthHandoff params={shellAuthParams} />
          ) : bootDemoPreview ? (
            <DemoApp preview mobile={bootMobile} />
          ) : (
            <AccountGate>
              <ImpersonationBanner />
              {bootAdmin ? <AdminApp /> : bootMobile ? <MobileApp /> : <App />}
            </AccountGate>
          )}
        </SignedIn>
        <SignedOut>
          {shellAuthParams || shouldShowSignIn(window.location.search) ? (
            <ShellTicketSignIn />
          ) : (
            <DemoApp mobile={bootMobile} />
          )}
        </SignedOut>
      </ClerkProvider>
    ) : bootDemoPreview ? (
      <DemoApp preview mobile={bootMobile} />
    ) : bootAdmin ? (
      <AdminApp />
    ) : bootMobile ? (
      <MobileApp />
    ) : (
      <App />
    )}
  </StrictMode>,
)
