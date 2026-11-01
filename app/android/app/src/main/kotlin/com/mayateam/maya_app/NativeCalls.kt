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
    const val EXTRA_KIND = "maya_kind"   // callback | reminder | welfare: the reason the call is joined with
    private const val CHANNEL = "maya_calls"
    private const val MESSAGES = "maya_messages"
    const val EXTRA_VIA = "maya_via"               // text | voice
    const val EXTRA_MESSAGE = "maya_message"       // the chat message id of a voice note
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

    fun show(ctx: Context, oid: String, ringMs: Long, kind: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val c = NotificationChannel(CHANNEL, "Maya calls", NotificationManager.IMPORTANCE_HIGH)
            c.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
            c.enableVibration(true); nm.createNotificationChannel(c)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        fun open(action: String, code: Int): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_ACTION, action).putExtra(EXTRA_OUTREACH, oid).putExtra(EXTRA_KIND, kind)
            return PendingIntent.getActivity(ctx, idOf(oid) + code, i, flags)
        }
        val decline = PendingIntent.getBroadcast(ctx, idOf(oid) + 3, Intent(ctx, DeclineReceiver::class.java).putExtra(EXTRA_OUTREACH, oid), flags)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(android.R.drawable.sym_call_incoming).setContentTitle("Maya").setContentText("Maya is calling").setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true).setAutoCancel(false).setFullScreenIntent(open("ring", 1), true).setContentIntent(open("ring", 1))
            .addAction(Notification.Action.Builder(null, "Decline", decline).build())
            .addAction(Notification.Action.Builder(null, "Accept", open("accept", 2)).build())
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(ringMs)
        val n = b.build()
        n.flags = n.flags or Notification.FLAG_INSISTENT   // the ringtone repeats until the call is answered, declined or times out, like a phone call (a plain notification sound plays once)
        nm.notify(idOf(oid), n)
    }

    // A text or a voice note that found the app closed. The notification says only who it is from and what it is; the words are read in the chat, which is where a tap goes
    // (a voice note starts playing there). Nothing from the message travels in the push. Buttons, like a messenger's, and each does its job from the notification itself:
    //   a reminder      : "Got it" (marks it answered, no app)      + "Open" (the exact chat; a voice note plays)
    //   a welfare check : "I'm okay" (marks it answered, no app)    + "Reply" (typed in the notification, sent to Maya, no app)
    //   any other text / voice note: "Reply" (typed in the notification) + "Open chat" (the exact chat; a voice note plays)
    const val REPLY_KEY = "maya_reply"
    const val EXTRA_NID = "maya_nid"
    const val EXTRA_WHAT = "maya_what"
    private fun immutable() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private fun messageChannel(ctx: Context): NotificationManager {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(MESSAGES, "Maya messages", NotificationManager.IMPORTANCE_HIGH))
        return nm
    }

    // The tap target: the chat, on this very message (a voice note plays).
    private fun openChat(ctx: Context, via: String, messageId: String?, code: Int): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_ACTION, "message").putExtra(EXTRA_VIA, via)
        if (messageId != null) i.putExtra(EXTRA_MESSAGE, messageId)
        return PendingIntent.getActivity(ctx, code, i, immutable())
    }

    fun showMessage(ctx: Context, via: String, what: String, messageId: String?) {
        val nm = messageChannel(ctx)
        val code = (messageId ?: (what + via + System.currentTimeMillis())).hashCode()
        val open = openChat(ctx, via, messageId, code)
        val title = if (what == "welfare") "Check-in from your family" else "Reminder from your family"
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, MESSAGES) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(if (via == "voice") "Maya sent you a voice note. Tap to listen." else "Maya has a message for you. Tap to read it.")
            .setCategory(Notification.CATEGORY_MESSAGE).setAutoCancel(true).setContentIntent(open)
        fun ack(label: String): Notification.Action {
            val pi = PendingIntent.getBroadcast(ctx, code + 11, Intent(ctx, AckReceiver::class.java).putExtra(EXTRA_NID, code).putExtra(EXTRA_WHAT, what).putExtra(EXTRA_VIA, via).putExtra(EXTRA_MESSAGE, messageId), immutable())
            return Notification.Action.Builder(null, label, pi).build()
        }
        fun reply(): Notification.Action {
            // A reply written in the notification comes back as a RemoteInput result, so this intent must be mutable (Android 12+).
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getBroadcast(ctx, code + 12, Intent(ctx, ReplyReceiver::class.java).putExtra(EXTRA_NID, code).putExtra(EXTRA_VIA, via).putExtra(EXTRA_MESSAGE, messageId), flags)
            return Notification.Action.Builder(null, "Reply", pi).addRemoteInput(android.app.RemoteInput.Builder(REPLY_KEY).setLabel("Write to Maya").build()).setAllowGeneratedReplies(true).build()
        }
        fun openAction(label: String) = Notification.Action.Builder(null, label, open).build()
        when (what) {
            "reminder" -> b.addAction(ack("Got it")).addAction(openAction("Open"))
            "welfare" -> b.addAction(ack("I'm okay")).addAction(reply())
            else -> b.addAction(reply()).addAction(openAction("Open chat"))
        }
        nm.notify(code, b.build())
    }

    // The same notification slot, told what happened to a button press ("Sending", "Sent", or that it did not go and a tap opens the chat). Quiet: it replaces, it does not ring again.
    fun status(ctx: Context, nid: Int, text: String, via: String, messageId: String?, done: Boolean) {
        val nm = messageChannel(ctx)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, MESSAGES) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Maya").setContentText(text).setCategory(Notification.CATEGORY_MESSAGE).setOnlyAlertOnce(true).setAutoCancel(true)
            .setContentIntent(openChat(ctx, via, messageId, nid))
        if (done && Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(4000)
        nm.notify(nid, b.build())
    }

    // POST a small JSON body to this phone's Maya server; the HTTP status, or null when the server could not be reached. Nothing here is kept or logged.
    fun postJson(ctx: Context, path: (String) -> String, body: String, readMs: Int): Int? {
        val p = ctx.getSharedPreferences("maya_native", 0); val base = p.getString("base", "") ?: ""; val pid = p.getString("profile", "") ?: ""
        if (base.isEmpty() || pid.isEmpty()) return null
        return try {
            val c = URL(base + path(pid)).openConnection() as HttpURLConnection
            c.requestMethod = "POST"; c.connectTimeout = 8000; c.readTimeout = readMs; c.doOutput = true; c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode; c.disconnect(); code
        } catch (e: Exception) { null }
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

// "Got it" / "I'm okay": the same answer the chat gives, sent from the notification with the app closed.
class AckReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val nid = i.getIntExtra(NativeCalls.EXTRA_NID, 0); val what = i.getStringExtra(NativeCalls.EXTRA_WHAT) ?: return
        val via = i.getStringExtra(NativeCalls.EXTRA_VIA) ?: "text"; val mid = i.getStringExtra(NativeCalls.EXTRA_MESSAGE)
        val pr = goAsync()
        thread {
            val code = NativeCalls.postJson(ctx, { pid -> "/api/care/$pid/ack" }, org.json.JSONObject().put("what", what).toString(), 15000)
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (code == 200 || code == 404) nm.cancel(nid)   // answered (404: nothing was waiting any more, so it was already answered)
            else NativeCalls.status(ctx, nid, "Could not send that. Tap to open the chat.", via, mid, false)
            pr.finish()
        }
    }
}

// "Reply": the words typed in the notification go to Maya as a chat message (the same route the chat box uses), with the app closed. Maya's answer waits in the chat.
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val nid = i.getIntExtra(NativeCalls.EXTRA_NID, 0)
        val via = i.getStringExtra(NativeCalls.EXTRA_VIA) ?: "text"; val mid = i.getStringExtra(NativeCalls.EXTRA_MESSAGE)
        val text = android.app.RemoteInput.getResultsFromIntent(i)?.getCharSequence(NativeCalls.REPLY_KEY)?.toString()?.trim() ?: ""
        if (text.isEmpty()) { (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(nid); return }
        NativeCalls.status(ctx, nid, "Sending...", via, mid, false)   // replaces the notification, which also stops the reply spinner
        val pr = goAsync()
        thread {
            val code = NativeCalls.postJson(ctx, { pid -> "/api/chat/$pid/message" }, org.json.JSONObject().put("text", text).toString(), 60000)
            if (code == 200) NativeCalls.status(ctx, nid, "Sent to Maya.", via, mid, true)
            else NativeCalls.status(ctx, nid, "Could not send that. Tap to open the chat.", via, mid, false)
            pr.finish()
        }
    }
}

class MayaMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { NativeCalls.emit("token", mapOf("platform" to "android", "token" to token)) }
    override fun onMessageReceived(m: RemoteMessage) {
        val d = m.data
        if (d["type"] == "message") { NativeCalls.showMessage(this, d["via"] ?: "text", d["what"] ?: "reminder", d["messageId"]); return }
        val oid = d["outreachId"] ?: return
        when (d["type"]) {
            "incoming" -> NativeCalls.show(this, oid, (d["ringMs"]?.toLongOrNull() ?: 30000L), d["kind"] ?: "reminder")
            "end" -> NativeCalls.cancel(this, oid)
        }
    }
}
