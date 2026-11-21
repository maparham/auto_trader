package app.chartkar.android

/**
 * What to do about notifications on a cold start. Pure, so JVM tests cover it.
 * Alerts arrive as notifications, so the app checks every launch: the first
 * time it shows the system prompt; after that, while alerts are still off, it
 * explains why and offers to fix it (the system prompt again while Android
 * still allows it, else the settings page). "Don't ask again" stops it.
 */
object NotifyPrompt {
    data class State(
        val sdk: Int,
        /** POST_NOTIFICATIONS granted (always true below API 33). */
        val permissionGranted: Boolean,
        /** App notifications on in system settings. */
        val appEnabled: Boolean,
        /** The "alerts" channel is not set to "None". */
        val channelEnabled: Boolean,
        /** The system prompt was shown before. */
        val askedBefore: Boolean,
        /** shouldShowRequestPermissionRationale: Android still shows the prompt. */
        val canAskAgain: Boolean,
        /** The user chose "Don't ask again" in our dialog. */
        val optedOut: Boolean,
    )

    enum class Fix { SYSTEM_PROMPT, APP_SETTINGS, CHANNEL_SETTINGS }

    sealed class Action {
        object None : Action()
        /** Show the system prompt now, without our dialog. */
        object SystemPrompt : Action()
        /** Explain first; "Turn on" does [fix]. */
        data class Explain(val fix: Fix) : Action()
    }

    fun decide(s: State): Action {
        val needsPermission = s.sdk >= 33 && !s.permissionGranted
        if (!needsPermission && s.appEnabled && s.channelEnabled) return Action.None
        if (s.optedOut) return Action.None
        if (needsPermission) {
            if (!s.askedBefore) return Action.SystemPrompt
            return Action.Explain(if (s.canAskAgain) Fix.SYSTEM_PROMPT else Fix.APP_SETTINGS)
        }
        return Action.Explain(if (!s.appEnabled || s.sdk < 26) Fix.APP_SETTINGS else Fix.CHANNEL_SETTINGS)
    }
}
