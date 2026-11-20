package app.chartkar.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlertPushTest {
    private val start = "https://chartkar.app"

    @Test
    fun priceAlertTapOpensItsChart() {
        val d = mapOf("title" to "🔔 US100", "body" to "@ 100 · now 101", "kind" to "price",
            "epic" to "US100", "broker" to "capital", "id" to "a1")
        val n = AlertPush.from(start, d)!!
        assertEquals("🔔 US100", n.title)
        assertEquals("@ 100 · now 101", n.body)
        assertEquals("https://chartkar.app/?alertEpic=US100&alertBroker=capital", n.tapUrl)
        assertNull(n.action)
    }

    @Test
    fun accountAlertTapOpensTheApp() {
        val n = AlertPush.from(start, mapOf("title" to "🚨 Capital live", "body" to "x", "kind" to "account"))!!
        assertEquals("https://chartkar.app/", n.tapUrl)
        assertNull(n.action)
    }

    @Test
    fun positionAlertGetsTheRemoveButton() {
        val d = mapOf("title" to "🔔 US100", "body" to "near SL", "kind" to "position", "epic" to "US100",
            "broker" to "capital:demo", "side" to "sl", "removeToken" to "ab&cd")
        val n = AlertPush.from(start, d)!!
        assertEquals("Remove SL", n.action!!.label)
        assertEquals("https://chartkar.app/?removeLevel=ab%26cd", n.action!!.url)
        val tp = AlertPush.from(start, d + ("side" to "tp"))!!
        assertEquals("Remove TP", tp.action!!.label)
        assertNull(AlertPush.from(start, d - "removeToken")!!.action)
    }

    @Test
    fun aDebugStartUrlKeepsItsPort() {
        val n = AlertPush.from("http://localhost:5173", mapOf("title" to "t", "body" to "b", "epic" to "X"))!!
        assertEquals("http://localhost:5173/?alertEpic=X", n.tapUrl)
    }

    @Test
    fun aMessageWithoutTextIsDropped() {
        assertNull(AlertPush.from(start, mapOf("kind" to "price")))
    }

    @Test
    fun notificationIdsAreStablePerAlert() {
        assertEquals(AlertPush.notificationId("a1"), AlertPush.notificationId("a1"))
    }
}
