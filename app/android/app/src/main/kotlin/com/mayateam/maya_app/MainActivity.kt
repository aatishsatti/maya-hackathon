package com.mayateam.maya_app

import android.Manifest
import android.content.Intent
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.PowerManager
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.Locale

// The Dart side talks to the native incoming-call code through one channel, "maya/native_call" (lib/services/native_call.dart).
class MainActivity : FlutterActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var ttsChannel: MethodChannel? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsInitStarted = false
    private var ttsEngineUsed = "com.google.android.tts"
    private var ttsVoiceUsed = ""
    private val ttsQueue = ArrayList<() -> Unit>()

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "maya/native_call")
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "configure" -> {   // the server address and the profile, kept so a Decline can reach the server even when the app is not running
                    NativeCalls.configure(this, call.argument<String>("base") ?: "", call.argument<String>("profile") ?: "", call.argument<String>("familyToken") ?: "")
                    askPermissions()
                    NativeCalls.fetchToken()
                    ensureTts()
                    result.success(null)
                }
                "unlink" -> { NativeCalls.unlink(this); result.success(null) }   // sign out of a senior: forget the profile, take down rings, delete the push token
                "ready" -> { NativeCalls.attach(ch); result.success(null) }
                "dismiss", "callEnded", "stopBell" -> { NativeCalls.dismiss(this, call.argument<String>("outreachId")); result.success(null) }
                "startBell" -> { NativeCalls.startRinging(this, call.argument<Number>("ringMs")?.toLong() ?: 30000L); result.success(null) }
                "showIncoming" -> {
                    val oid = call.argument<String>("outreachId") ?: ""
                    if (oid.isNotEmpty()) NativeCalls.show(this, oid, call.argument<Number>("ringMs")?.toLong() ?: 30000L, call.argument<String>("kind") ?: "reminder")
                    result.success(null)
                }
                "showMessage" -> {
                    NativeCalls.showMessage(this, call.argument<String>("via") ?: "text", call.argument<String>("what") ?: "reminder", call.argument<String>("messageId"))
                    result.success(null)
                }
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
        val tc = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "maya/tts")
        ttsChannel = tc
        tc.setMethodCallHandler { call, result ->
            when (call.method) {
                "warm" -> {
                    ensureTts {
                        result.success(mapOf("engine" to ttsEngineUsed, "voice" to ttsVoiceUsed))
                    }
                }
                "speak" -> {
                    val text = call.argument<String>("text") ?: ""
                    val flush = call.argument<Boolean>("flush") ?: false
                    val id = call.argument<String>("id") ?: "u_${System.nanoTime()}"
                    val inCall = call.argument<Boolean>("call") ?: true
                    speakTts(text, flush, id, inCall)
                    result.success(null)
                }
                "stop" -> {
                    stopTts()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        ensureTts()
        NativeCalls.attach(null)
        handle(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.getStringExtra(NativeCalls.EXTRA_ACTION) != null && Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }   // opened by the incoming call screen on a locked phone
    }

    // ---- Android Google TTS (female device voice, OS feature, no model call) ----
    private fun ensureTts(onReady: (() -> Unit)? = null) {
        if (ttsReady && tts != null) {
            onReady?.invoke()
            return
        }
        if (onReady != null) ttsQueue.add(onReady)
        if (ttsInitStarted) return
        ttsInitStarted = true
        initTtsWithEngine("com.google.android.tts", allowFallback = true)
    }

    private fun initTtsWithEngine(engine: String?, allowFallback: Boolean) {
        val listener = TextToSpeech.OnInitListener { status ->
            mainHandler.post {
                val inst = tts
                if (status == TextToSpeech.SUCCESS && inst != null) {
                    ttsEngineUsed = engine ?: (inst.defaultEngine ?: "default")
                    configureTtsVoice(inst)
                    ttsReady = true
                    val q = ArrayList(ttsQueue)
                    ttsQueue.clear()
                    for (fn in q) fn.invoke()
                } else if (allowFallback && engine != null) {
                    try { inst?.shutdown() } catch (e: Exception) {}
                    tts = null
                    initTtsWithEngine(null, allowFallback = false)
                } else {
                    ttsInitStarted = false
                    val q = ArrayList(ttsQueue)
                    ttsQueue.clear()
                    for (fn in q) fn.invoke()
                }
            }
        }
        tts = try {
            if (engine != null) TextToSpeech(applicationContext, listener, engine)
            else TextToSpeech(applicationContext, listener)
        } catch (e: Exception) {
            if (allowFallback && engine != null) TextToSpeech(applicationContext, listener)
            else null
        }
    }

    private fun configureTtsVoice(inst: TextToSpeech) {
        try {
            inst.language = Locale.US
            val voices = try { inst.voices } catch (e: Exception) { null }
            val picked = pickFemaleEnglishVoice(voices)
            if (picked != null) {
                inst.voice = picked
                ttsVoiceUsed = picked.name
            } else {
                ttsVoiceUsed = inst.voice?.name ?: "en-US-default"
            }
            inst.setSpeechRate(1.0f)
            inst.setPitch(1.0f)
            inst.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            inst.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) {
                    if (utteranceId != null) mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to utteranceId)) }
                }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    if (utteranceId != null) mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to utteranceId)) }
                }
                override fun onError(utteranceId: String?, errorCode: Int) {
                    if (utteranceId != null) mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to utteranceId)) }
                }
                override fun onStop(utteranceId: String?, interrupted: Boolean) {
                    if (utteranceId != null) mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to utteranceId)) }
                }
            })
        } catch (e: Exception) { /* keep default TTS configuration */ }
    }

    private fun pickFemaleEnglishVoice(voices: Set<Voice>?): Voice? {
        if (voices.isNullOrEmpty()) return null
        val en = voices.filter { it.locale.language.equals("en", ignoreCase = true) }
        if (en.isEmpty()) return null
        val femaleTags = listOf("sfg", "tpf", "iob", "tpc", "gba", "gbg", "rjs", "aua", "auc", "end", "ene", "female")
        val maleTags = listOf("iom", "iol", "tpd", "sfb", "gbd", "gbb", "aub", "aud", "enc", "ena", "#male")
        fun isMale(v: Voice): Boolean {
            val s = (v.name + " " + (v.features?.joinToString(" ") ?: "")).lowercase(Locale.ROOT)
            if (maleTags.any { s.contains(it) }) return true
            return Regex("(^|[^a-z])male([^a-z]|$)").containsMatchIn(s)
        }
        fun isFemale(v: Voice): Boolean {
            val s = (v.name + " " + (v.features?.joinToString(" ") ?: "")).lowercase(Locale.ROOT)
            return femaleTags.any { s.contains(it) }
        }
        fun score(v: Voice): Int {
            if (isMale(v)) return -1000
            var sc = 0
            val n = v.name.lowercase(Locale.ROOT)
            if (isFemale(v)) sc += 100
            if (!v.isNetworkConnectionRequired) sc += 40
            val c = v.locale.country.uppercase(Locale.ROOT)
            if (c == "US") sc += 25 else if (c == "GB" || c == "AU" || c == "SG") sc += 15
            if (n.contains("en-us-x-sfg")) sc += 20
            else if (n.contains("en-us-x-tpf") || n.contains("en-us-x-iob")) sc += 12
            if (v.quality >= Voice.QUALITY_HIGH) sc += 5
            return sc
        }
        return en.filter { !isMale(it) }.maxByOrNull { score(it) } ?: en.firstOrNull()
    }

    private fun speakTts(text: String, flush: Boolean, id: String, inCall: Boolean) {
        val clean = text.trim()
        if (clean.isEmpty()) {
            mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to id)) }
            return
        }
        if (flush) {
            // Drop any queued utterances waiting for init if flushing
            if (!ttsReady) ttsQueue.clear()
        }
        ensureTts {
            val inst = tts
            if (inst == null) {
                mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to id)) }
                return@ensureTts
            }
            try {
                inst.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(if (inCall) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                val params = Bundle().apply {
                    putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, if (inCall) AudioManager.STREAM_VOICE_CALL else AudioManager.STREAM_MUSIC)
                }
                val mode = if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                val res = inst.speak(clean, mode, params, id)
                if (res == TextToSpeech.ERROR) {
                    mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to id)) }
                }
            } catch (e: Exception) {
                mainHandler.post { ttsChannel?.invokeMethod("done", mapOf("id" to id)) }
            }
        }
    }

    private fun stopTts() {
        try { tts?.stop() } catch (e: Exception) {}
    }

    // ---- where a call's sound comes out, and the proximity sensor that goes with it ----
    // Speaker ON : loudspeaker, proximity sensor OFF (the screen stays on).
    // Speaker OFF: earpiece, proximity sensor ON (a PROXIMITY_SCREEN_OFF wake lock: the screen goes off at the ear and back on when the phone moves away).
    // Choosing Earpiece or Speaker NEVER overrides a connected Bluetooth (or wired/USB) headset for the rest of the call.
    private var proximity: PowerManager.WakeLock? = null
    private var inCallRoute = false
    private var lastSpeakerOn = true
    private var deviceCallbackRegistered = false

    private val externalTypes: Set<Int> by lazy {
        val s = mutableSetOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_ACCESSORY
        )
        if (Build.VERSION.SDK_INT >= 26) s.add(AudioDeviceInfo.TYPE_USB_HEADSET)
        if (Build.VERSION.SDK_INT >= 28) s.add(AudioDeviceInfo.TYPE_HEARING_AID)
        if (Build.VERSION.SDK_INT >= 31) {
            s.add(AudioDeviceInfo.TYPE_BLE_HEADSET)
            s.add(AudioDeviceInfo.TYPE_BLE_SPEAKER)
        }
        if (Build.VERSION.SDK_INT >= 33) s.add(AudioDeviceInfo.TYPE_BLE_BROADCAST)
        s
    }

    private val commDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            if (!inCallRoute) return
            if (addedDevices?.any { it.type in externalTypes } == true) {
                applyCallAudioRoute(lastSpeakerOn)
            }
        }
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
            if (!inCallRoute) return
            if (removedDevices?.any { it.type in externalTypes } == true) {
                applyCallAudioRoute(lastSpeakerOn)
            }
        }
    }

    private fun setSpeaker(on: Boolean) {
        inCallRoute = true
        lastSpeakerOn = on
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        if (!deviceCallbackRegistered) {
            deviceCallbackRegistered = true
            am.registerAudioDeviceCallback(commDeviceCallback, mainHandler)
        }
        applyCallAudioRoute(on)
    }

    private fun applyCallAudioRoute(on: Boolean) {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        val hasExternalOut = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in externalTypes }
        if (Build.VERSION.SDK_INT >= 31) {
            val commDevs = am.availableCommunicationDevices
            val extComm = commDevs.firstOrNull { it.type in externalTypes }
            if (extComm != null || hasExternalOut) {
                // Keep the connected Bluetooth / external headset; never pin to built-in speaker or earpiece over it.
                if (extComm != null) {
                    if (am.communicationDevice?.id != extComm.id) am.setCommunicationDevice(extComm)
                } else if (am.communicationDevice?.type in setOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)) {
                    am.clearCommunicationDevice()
                }
                setProximity(false)
                return
            }
            val want = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            val dev = commDevs.firstOrNull { it.type == want }
            if (dev != null) am.setCommunicationDevice(dev) else if (on) @Suppress("DEPRECATION") { am.isSpeakerphoneOn = true } else am.clearCommunicationDevice()
            @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = on }
        } else {
            if (!hasExternalOut) {
                @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = on }
            }
        }
        setProximity(!on && !hasExternalOut)
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
        inCallRoute = false
        setProximity(false)
        proximity = null
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        if (deviceCallbackRegistered) {
            deviceCallbackRegistered = false
            try { am.unregisterAudioDeviceCallback(commDeviceCallback) } catch (e: Exception) {}
        }
        if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice() else @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = false }
        am.mode = AudioManager.MODE_NORMAL
    }

    override fun onDestroy() {
        releaseRoute()
        try { tts?.stop(); tts?.shutdown() } catch (e: Exception) {}
        tts = null
        ttsReady = false
        ttsInitStarted = false
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (intent.getStringExtra(NativeCalls.EXTRA_ACTION) != null && Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }   // the app is already running and the call screen woke a locked phone
        handle(intent)
    }

    private fun handle(i: Intent?) {
        when (i?.getStringExtra(NativeCalls.EXTRA_ACTION)) {
            // The person TAPPED the call notification (or the full-screen call opened): open the call itself and mark reachable so a lost tap never counts as a miss.
            "ring" -> {
                val oid = i.getStringExtra(NativeCalls.EXTRA_OUTREACH) ?: ""
                val kind = i.getStringExtra(NativeCalls.EXTRA_KIND) ?: "reminder"
                NativeCalls.touchServer(this)
                NativeCalls.cancel(this, oid)
                NativeCalls.emit("ring", mapOf("outreachId" to oid, "kind" to kind))
                i.removeExtra(NativeCalls.EXTRA_ACTION)
            }
            // The person tapped a text or voice-note notification: the chat opens on it (a voice note plays).
            // The family tapped (or accepted) the ring that reached the closed family app: the app opens on the ring screen.
            "family_ring" -> {
                val eid = i.getStringExtra(NativeCalls.EXTRA_EPISODE) ?: ""
                NativeCalls.cancelFamily(this, eid)
                NativeCalls.emit("familyRing", mapOf("seniorId" to (i.getStringExtra(NativeCalls.EXTRA_SENIOR) ?: ""), "episodeId" to eid, "act" to (i.getStringExtra(NativeCalls.EXTRA_ACT) ?: "")))
                i.removeExtra(NativeCalls.EXTRA_ACTION)
            }
            "message" -> {
                NativeCalls.touchServer(this)
                NativeCalls.emit("opened", mapOf("via" to (i.getStringExtra(NativeCalls.EXTRA_VIA) ?: "text"), "messageId" to (i.getStringExtra(NativeCalls.EXTRA_MESSAGE) ?: "")))
                i.removeExtra(NativeCalls.EXTRA_ACTION)
            }
        }
        if (i?.getStringExtra(NativeCalls.EXTRA_ACTION) == "accept") {
            val oid = i.getStringExtra(NativeCalls.EXTRA_OUTREACH) ?: return
            NativeCalls.touchServer(this)
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
