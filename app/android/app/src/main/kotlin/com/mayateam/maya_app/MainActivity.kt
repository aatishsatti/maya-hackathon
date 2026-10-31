package com.mayateam.maya_app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
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
                    askNotifications()
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

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handle(intent) }

    private fun handle(i: Intent?) {
        if (i?.getStringExtra(NativeCalls.EXTRA_ACTION) == "accept") {
            val oid = i.getStringExtra(NativeCalls.EXTRA_OUTREACH) ?: return
            NativeCalls.cancel(this, oid)
            NativeCalls.emit("accepted", mapOf("outreachId" to oid))
            i.removeExtra(NativeCalls.EXTRA_ACTION)
        }
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
    }
}
