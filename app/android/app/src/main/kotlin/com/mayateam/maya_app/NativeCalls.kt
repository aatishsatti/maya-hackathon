package com.mayateam.maya_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.flutter.plugin.common.MethodChannel
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

// Maya ringing a CLOSED phone on Android: a Firebase data message -> an incoming-call notification (full screen on a locked phone) with Accept and Decline.
// Accept opens the app, which joins the same live call socket as an in-app Accept. Decline tells the server straight from here, so it works with the app not running.
// Nothing about Firebase is configured in this repository: with no google-services.json in app/ no token is issued and the server falls back (WhatsApp under its rules).
object NativeCalls {
    const val EXTRA_ACTION = "maya_action"
    const val EXTRA_OUTREACH = "maya_outreach"
    private const val CHANNEL = "maya_calls"
    private val main = Handler(Looper.getMainLooper())
    private var ch: MethodChannel? = null
    private val queue = ArrayList<Pair<String, Map<String, Any>>>()

    fun attach(c: MethodChannel?) { if (c != null) { ch = c; val q = ArrayList(queue); queue.clear(); for ((n, m) in q) emit(n, m) } }
    fun emit(name: String, data: Map<String, Any>) = main.post { val c = ch; if (c == null) queue.add(name to data) else c.invokeMethod(name, data) }

    fun configure(ctx: Context, base: String, profile: String) { ctx.getSharedPreferences("maya_native", 0).edit().putString("base", base).putString("profile", profile).apply() }

    fun fetchToken() {
        try { FirebaseMessaging.getInstance().token.addOnSuccessListener { t -> emit("token", mapOf("platform" to "android", "token" to t)) } }
        catch (e: Exception) { emit("unavailable", mapOf("platform" to "android", "reason" to "firebase_not_configured")) }   // no google-services.json: a label, nothing else
    }

    private fun idOf(oid: String) = oid.hashCode()

    fun show(ctx: Context, oid: String, ringMs: Long) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val c = NotificationChannel(CHANNEL, "Maya calls", NotificationManager.IMPORTANCE_HIGH)
            c.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
            c.enableVibration(true); nm.createNotificationChannel(c)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        fun open(action: String, code: Int): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_ACTION, action).putExtra(EXTRA_OUTREACH, oid)
            return PendingIntent.getActivity(ctx, idOf(oid) + code, i, flags)
        }
        val decline = PendingIntent.getBroadcast(ctx, idOf(oid) + 3, Intent(ctx, DeclineReceiver::class.java).putExtra(EXTRA_OUTREACH, oid), flags)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(android.R.drawable.sym_call_incoming).setContentTitle("Maya").setContentText("Maya is calling").setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true).setAutoCancel(false).setFullScreenIntent(open("ring", 1), true).setContentIntent(open("ring", 1))
            .addAction(Notification.Action.Builder(null, "Decline", decline).build())
            .addAction(Notification.Action.Builder(null, "Accept", open("accept", 2)).build())
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(ringMs)
        nm.notify(idOf(oid), b.build())
    }

    fun cancel(ctx: Context, oid: String) { (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(idOf(oid)) }
    fun dismiss(ctx: Context, oid: String?) { if (oid != null) cancel(ctx, oid) }

    // Decline, straight to the server: POST /api/care/<profile>/outreach/<id>/decline (the same call the in-app Decline makes).
    fun declineToServer(ctx: Context, oid: String) {
        val p = ctx.getSharedPreferences("maya_native", 0); val base = p.getString("base", "") ?: ""; val pid = p.getString("profile", "") ?: ""
        if (base.isEmpty() || pid.isEmpty()) return
        thread {
            try {
                val c = URL("$base/api/care/$pid/outreach/$oid/decline").openConnection() as HttpURLConnection
                c.requestMethod = "POST"; c.connectTimeout = 8000; c.readTimeout = 8000; c.doOutput = true; c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write("{}".toByteArray()) }; c.responseCode; c.disconnect()
            } catch (e: Exception) { /* the ring ends by itself on the server; nothing to say here */ }
        }
    }
}

class DeclineReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val oid = i.getStringExtra(NativeCalls.EXTRA_OUTREACH) ?: return
        NativeCalls.cancel(ctx, oid); NativeCalls.declineToServer(ctx, oid); NativeCalls.emit("declined", mapOf("outreachId" to oid))
    }
}

class MayaMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { NativeCalls.emit("token", mapOf("platform" to "android", "token" to token)) }
    override fun onMessageReceived(m: RemoteMessage) {
        val d = m.data; val oid = d["outreachId"] ?: return
        when (d["type"]) {
            "incoming" -> NativeCalls.show(this, oid, (d["ringMs"]?.toLongOrNull() ?: 30000L))
            "end" -> NativeCalls.cancel(this, oid)
        }
    }
}
