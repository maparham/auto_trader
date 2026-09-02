import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import ClerkTokenBridge from './components/ClerkTokenBridge.tsx'
import AccountGate from './components/AccountGate.tsx'
import { CLERK_ENABLED } from './lib/authToken.ts'

// The publishable key doubles as the feature switch: unset (local dev) renders
// exactly the pre-auth tree — no provider, no sign-in, no behavior change.
const clerkKey = (
  import.meta as unknown as { env?: { VITE_CLERK_PUBLISHABLE_KEY?: string } }
).env?.VITE_CLERK_PUBLISHABLE_KEY

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {CLERK_ENABLED && clerkKey ? (
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
        <ClerkTokenBridge />
        <SignedIn>
          <AccountGate>
            <App />
          </AccountGate>
        </SignedIn>
        <SignedOut>
          <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
            <SignIn />
          </div>
        </SignedOut>
      </ClerkProvider>
    ) : (
      <App />
    )}
  </StrictMode>,
)
