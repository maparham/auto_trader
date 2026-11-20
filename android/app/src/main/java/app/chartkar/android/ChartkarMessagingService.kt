package app.chartkar.android

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Receives the backend's data-only alert messages and shows them. A new
 *  token needs no work here: the page sends the current token to the
 *  backend on every boot (frontend/src/lib/appPush.ts). */
class ChartkarMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val note = AlertPush.from(BuildConfig.START_URL, message.data) ?: return
        Notifications.postAlert(this, note, message.data["id"].orEmpty())
    }
}
