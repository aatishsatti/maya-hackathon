package com.mayateam.maya_app

import android.Manifest
import android.content.Intent
import android.app.NotificationManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.PowerManager
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// The Dart side talks to the native incoming-call code through one channel, "maya/native_call" (lib/services/native_call.dart).
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "maya/native_call")
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "configure" -> {   // the server address and the profile, kept so a Decline can reach the server even when the app is not running
                    NativeCalls.configure(this, call.argument<String>("base") ?: "", call.argument<String>("profile") ?: "")
                    askPermissions()
                    NativeCalls.fetchToken()
                    result.success(null)
                }
                "ready" -> { NativeCalls.attach(ch); result.success(null) }
                "dismiss", "callEnded" -> { NativeCalls.dismiss(this, call.argument<String>("outreachId")); result.success(null) }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "maya/audio_route").setMethodCallHandler { call, result ->
            when (call.method) {
                "speaker" -> { setSpeaker(call.argument<Boolean>("on") ?: true); result.success(null) }
                "release" -> { releaseRoute(); result.success(null) }
                else -> result.notImplemented()
            }
        }
        NativeCalls.attach(null)
        handle(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.getStringExtra(NativeCalls.EXTRA_ACTION) != null && Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }   // opened by the incoming call screen on a locked phone
    }

    // ---- where a call's sound comes out, and the proximity sensor that goes with it ----
    // Speaker ON : loudspeaker, proximity sensor OFF (the screen stays on).
    // Speaker OFF: earpiece, proximity sensor ON (a PROXIMITY_SCREEN_OFF wake lock: the screen goes off at the ear and back on when the phone moves away).
    // The call is an in-communication audio session while it lasts; releaseRoute() puts everything back.
    private var proximity: PowerManager.WakeLock? = null

    private fun setSpeaker(on: Boolean) {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 31) {
            val want = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            val dev = am.availableCommunicationDevices.firstOrNull { it.type == want }
            if (dev != null) am.setCommunicationDevice(dev) else if (on) @Suppress("DEPRECATION") { am.isSpeakerphoneOn = true } else am.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = on }
        }
        setProximity(!on)
    }

    private fun setProximity(on: Boolean) {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (on) {
            if (proximity == null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "maya:proximity").also { it.setReferenceCounted(false) }
            }
            proximity?.let { if (!it.isHeld) it.acquire() }
        } else {
            proximity?.let { if (it.isHeld) it.release() }
        }
    }

    private fun releaseRoute() {
        setProximity(false)
        proximity = null
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice() else @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = false }
        am.mode = AudioManager.MODE_NORMAL
    }

    override fun onDestroy() { releaseRoute(); super.onDestroy() }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (intent.getStringExtra(NativeCalls.EXTRA_ACTION) != null && Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }   // the app is already running and the call screen woke a locked phone
        handle(intent)
    }

    private fun handle(i: Intent?) {
        when (i?.getStringExtra(NativeCalls.EXTRA_ACTION)) {
            // The person TAPPED the call notification (or the full-screen call opened): the ring is still going on the server. Dart reconnects, the server announces it again, and the Accept / Decline card appears.
            // Nothing is cancelled here: the ring is not answered, declined or lost by looking at it.
            "ring" -> { NativeCalls.emit("ring", mapOf("outreachId" to (i.getStringExtra(NativeCalls.EXTRA_OUTREACH) ?: ""))); i.removeExtra(NativeCalls.EXTRA_ACTION) }
            // The person tapped a text or voice-note notification: the chat opens on it (a voice note plays).
            "message" -> {
                NativeCalls.emit("opened", mapOf("via" to (i.getStringExtra(NativeCalls.EXTRA_VIA) ?: "text"), "messageId" to (i.getStringExtra(NativeCalls.EXTRA_MESSAGE) ?: "")))
                i.removeExtra(NativeCalls.EXTRA_ACTION)
            }
        }
        if (i?.getStringExtra(NativeCalls.EXTRA_ACTION) == "accept") {
            val oid = i.getStringExtra(NativeCalls.EXTRA_OUTREACH) ?: return
            NativeCalls.cancel(this, oid)
            NativeCalls.emit("accepted", mapOf("outreachId" to oid, "kind" to (i.getStringExtra(NativeCalls.EXTRA_KIND) ?: "reminder")))
            i.removeExtra(NativeCalls.EXTRA_ACTION)
        }
    }

    // Asked while the phone is in hand (the app is open), because it cannot be asked on a lock screen: notifications (Android 13+), the microphone (so an Accept from the lock screen can talk at once),
    // and, on Android 14+, the right to show the call over the lock screen (a settings page; nothing is granted without the person).
    private fun askPermissions() {
        val need = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO)
        if (need.isNotEmpty()) requestPermissions(need.toTypedArray(), 7)
        if (Build.VERSION.SDK_INT >= 34) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            val asked = getSharedPreferences("maya_native", 0)
            if (!nm.canUseFullScreenIntent() && !asked.getBoolean("asked_fullscreen", false)) {
                asked.edit().putBoolean("asked_fullscreen", true).apply()   // once: it is a settings page, not a prompt, so it is not repeated at every launch
                try { startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName"))) } catch (e: Exception) { /* no such settings page: the call still shows as a top notification */ }
            }
        }
    }
}
