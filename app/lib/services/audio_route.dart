import 'dart:io' show Platform;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/services.dart';

import 'call_log.dart';

/// Where a call's sound comes out, and the proximity sensor that goes with it (Android; the native side is MainActivity.kt, channel "maya/audio_route").
///   Speaker ON : the loudspeaker, and the proximity sensor is off (the screen stays on, so a phone held out in front is never blanked).
///   Speaker OFF: the earpiece, and the proximity sensor is on (the screen goes off at the ear and comes back when the phone is moved away, so a cheek cannot press anything).
/// iOS is not touched: its call audio and screen behaviour are as they were.
abstract class AudioRouteSink {
  Future<void> setSpeaker(bool on);

  /// The call is over: sound back to normal, the sensor released.
  Future<void> release();
}

class AudioRoute implements AudioRouteSink {
  // ---- chat voice notes are NOT a call: they play on the loudspeaker, fresh, every time ----
  // A call turns the phone's audio into a call session (in-communication mode, the earpiece or speaker as the call chose, and a GLOBAL player setting of "voice
  // communication"). If any of that is left behind, a voice note in the chat follows it: it came out of the earpiece, then nothing at all. So when a call ends the route is
  // released and the player's setting is put back to plain media on the speaker, and a voice note re-does the same just before it plays.
  static int _liveCalls = 0;
  static bool get callLive => _liveCalls > 0;
  static void callStarted() => _liveCalls++;
  static void callEnded() {
    if (_liveCalls > 0) _liveCalls--;
  }

  /// How chat voice notes sound: media, on the loudspeaker (Android), the playback session (iOS: the loudspeaker unless something is plugged in).
  static AudioContext get chatContext => AudioContext(
        iOS: AudioContextIOS(category: AVAudioSessionCategory.playback),
        android: const AudioContextAndroid(isSpeakerphoneOn: true, stayAwake: false, contentType: AndroidContentType.music, usageType: AndroidUsageType.media, audioFocus: AndroidAudioFocus.gain),
      );

  /// Before a chat voice note plays: nothing of a finished call is left (route, mode, proximity sensor), and the player's setting is the speaker. Does nothing during a live call.
  static Future<void> prepareChatPlayback() async {
    if (callLive) return;
    await AudioRoute().release();
    await useChatContext();
  }

  /// Puts the app-wide player setting back to chat (speaker, media). Never throws.
  static Future<void> useChatContext() async {
    try {
      ServicesBinding.instance;   // throws when there is no Flutter engine yet (a plain Dart test): there is no player to set then
      await AudioPlayer.global.setAudioContext(chatContext);
    } catch (e) {
      CallLog.add('audio route: chat context not set: ${e.runtimeType}');
    }
  }


  /// Tests replace these; nothing else does.
  static MethodChannel channel = const MethodChannel('maya/audio_route');
  static bool android = Platform.isAndroid;

  @override
  Future<void> setSpeaker(bool on) => _tell('speaker', {'on': on});

  @override
  Future<void> release() => _tell('release', const {});

  Future<void> _tell(String method, Map<String, Object> args) async {
    if (!android) return;
    try {
      await channel.invokeMethod(method, args);
    } on MissingPluginException {
      // no native side (tests, desktop)
    } on PlatformException catch (e) {
      CallLog.add('audio route: $method failed: ${e.code}');
    }
  }
}
