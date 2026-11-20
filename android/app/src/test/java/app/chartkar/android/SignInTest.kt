package app.chartkar.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Ported from tauri-android/src-tauri/src/auth.rs, so the native app keeps the
// exact sign-in rules the Tauri app had.
class SignInTest {
    @Test
    fun parseCallbackReadsTicketAndState() {
        assertEquals(
            SignIn.Callback("sit_a&b", "s1"),
            SignIn.parseCallback("https://chartkar.app/app-auth/callback?ticket=sit_a%26b&state=s1"),
        )
    }

    @Test
    fun parseCallbackRejectsOtherHostsPathsAndSchemes() {
        assertNull(SignIn.parseCallback("https://evil.example/app-auth/callback?ticket=t&state=s"))
        assertNull(SignIn.parseCallback("https://chartkar.app/other?ticket=t&state=s"))
        assertNull(SignIn.parseCallback("http://chartkar.app/app-auth/callback?ticket=t&state=s"))
        assertNull(SignIn.parseCallback("https://chartkar.app/app-auth/callback?ticket=&state=s"))
        assertNull(SignIn.parseCallback("https://chartkar.app/app-auth/callback?ticket=t"))
        assertNull(SignIn.parseCallback("not a url"))
    }

    @Test
    fun parseCallbackAcceptsTrailingSlash() {
        assertEquals(
            SignIn.Callback("t", "s"),
            SignIn.parseCallback("https://chartkar.app/app-auth/callback/?ticket=t&state=s"),
        )
    }

    @Test
    fun decideAcceptsMatchingStateInTime() {
        assertEquals(SignIn.Outcome.Accept("t"), SignIn.decide(SignIn.Pending("s1", 1000), "s1", "t", 1000))
    }

    @Test
    fun decideExpiredAfterDeadline() {
        assertEquals(SignIn.Outcome.Expired, SignIn.decide(SignIn.Pending("s1", 1000), "s1", "t", 1001))
    }

    @Test
    fun decideNothingPendingIsExpired() {
        assertEquals(SignIn.Outcome.Expired, SignIn.decide(null, "s1", "t", 0))
    }

    @Test
    fun decideMismatchKeepsPending() {
        // A second tap on "Sign in" replaced s1 with s2; s1's callback is dropped.
        assertEquals(SignIn.Outcome.Mismatch, SignIn.decide(SignIn.Pending("s2", 1000), "s1", "t", 10))
    }

    @Test
    fun handoffUrlShape() {
        assertEquals("https://chartkar.app/?shell_auth=1&return=app&state=s1", SignIn.handoffUrl("s1"))
    }

    @Test
    fun appUrlKeepsOriginAndReplacesQuery() {
        assertEquals(
            "http://localhost:5173/?__clerk_ticket=sit_a%26b",
            SignIn.appUrl("http://localhost:5173/some/path?x=1", "__clerk_ticket", "sit_a&b"),
        )
        assertEquals(
            "https://chartkar.app/?auth_error=expired",
            SignIn.appUrl("https://chartkar.app/", "auth_error", "expired"),
        )
    }

    @Test
    fun randomStateIs64HexCharsAndVaries() {
        val a = SignIn.randomState()
        assertEquals(64, a.length)
        assertTrue(a.all { it in "0123456789abcdef" })
        assertNotEquals(a, SignIn.randomState())
    }

    @Test
    fun pendingRoundTripsThroughItsStoredForm() {
        val p = SignIn.Pending("s1", 42)
        assertEquals(p, SignIn.Pending.decode(p.encode()))
        assertNull(SignIn.Pending.decode("garbage"))
        assertNull(SignIn.Pending.decode(null))
    }

    @Test
    fun resolveTurnsCallbacksIntoTheTarget() {
        val p = SignIn.Pending("s1", 1000)
        val ok = SignIn.resolve(p, "https://chartkar.app/app-auth/callback?ticket=t&state=s1", 10)
        assertEquals(SignIn.Target("__clerk_ticket", "t"), ok)
        val late = SignIn.resolve(p, "https://chartkar.app/app-auth/callback?ticket=t&state=s1", 2000)
        assertEquals(SignIn.Target("auth_error", "expired"), late)
        assertNull(SignIn.resolve(p, "https://chartkar.app/app-auth/callback?ticket=t&state=other", 10))
        assertNull(SignIn.resolve(p, "https://chartkar.app/elsewhere", 10))
    }
}
