import 'dart:io' show Platform;

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
