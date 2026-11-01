package com.mayateam.maya_app

import android.Manifest
import android.content.Intent
import android.app.NotificationManager
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
        NativeCalls.attach(null)
        handle(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.getStringExtra(NativeCalls.EXTRA_ACTION) != null && Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }   // opened by the incoming call screen on a locked phone
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (intent.getStringExtra(NativeCalls.EXTRA_ACTION) != null && Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }   // the app is already running and the call screen woke a locked phone
        handle(intent)
    }

    private fun handle(i: Intent?) {
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
