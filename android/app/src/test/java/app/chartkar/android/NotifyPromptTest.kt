package app.chartkar.android

import app.chartkar.android.NotifyPrompt.Action
import app.chartkar.android.NotifyPrompt.Fix
import org.junit.Assert.assertEquals
import org.junit.Test

class NotifyPromptTest {
    private val allOn = NotifyPrompt.State(
        sdk = 34, permissionGranted = true, appEnabled = true, channelEnabled = true,
        askedBefore = true, canAskAgain = false, optedOut = false,
    )

    @Test
    fun nothingWhenAllOn() {
        assertEquals(Action.None, NotifyPrompt.decide(allOn))
    }

    @Test
    fun firstLaunchShowsTheSystemPrompt() {
        val s = allOn.copy(permissionGranted = false, appEnabled = false, askedBefore = false)
        assertEquals(Action.SystemPrompt, NotifyPrompt.decide(s))
    }

    @Test
    fun deniedOnceExplainsThenAsksAgain() {
        val s = allOn.copy(permissionGranted = false, appEnabled = false, canAskAgain = true)
        assertEquals(Action.Explain(Fix.SYSTEM_PROMPT), NotifyPrompt.decide(s))
    }

    @Test
    fun deniedForGoodSendsToSettings() {
        val s = allOn.copy(permissionGranted = false, appEnabled = false, canAskAgain = false)
        assertEquals(Action.Explain(Fix.APP_SETTINGS), NotifyPrompt.decide(s))
    }

    @Test
    fun offInSettingsBelow33SendsToSettings() {
        val s = allOn.copy(sdk = 30, appEnabled = false)
        assertEquals(Action.Explain(Fix.APP_SETTINGS), NotifyPrompt.decide(s))
    }

    @Test
    fun blockedChannelSendsToChannelSettings() {
        val s = allOn.copy(channelEnabled = false)
        assertEquals(Action.Explain(Fix.CHANNEL_SETTINGS), NotifyPrompt.decide(s))
    }

    @Test
    fun optedOutStaysQuiet() {
        val s = allOn.copy(permissionGranted = false, appEnabled = false, optedOut = true)
        assertEquals(Action.None, NotifyPrompt.decide(s))
        assertEquals(Action.None, NotifyPrompt.decide(allOn.copy(channelEnabled = false, optedOut = true)))
    }
}
