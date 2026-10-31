import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/services.dart';

import '../config.dart';
import 'api.dart';
import 'call_log.dart';

/// Maya ringing a CLOSED phone. The native side (iOS: PushKit + CallKit in AppDelegate.swift; Android: Firebase
/// message + an incoming-call notification in NativeCalls.kt) shows the system incoming call screen. This class
/// carries three things between it and Dart: the push token (sent to the server so it can ring this phone), and the
/// person's Accept or Decline. Accept joins the same live call as an in-app Accept. Decline is sent to the server
/// by the native side itself (it works with the app not running); Dart only hears about it.
/// No key lives here: tokens come from Apple or Google when the project is set up for push.
class NativeCall {
  NativeCall._();
  static final NativeCall instance = NativeCall._();

  /// Tests replace the channel; nothing else does.
  static MethodChannel channel = const MethodChannel('maya/native_call');

  final _accepted = StreamController<String>.broadcast();
  final _ended = StreamController<String>.broadcast();

  /// The outreach id of a ring the person accepted on the system call screen.
  Stream<String> get accepted => _accepted.stream;

  /// The system call screen's hang-up on a live call.
  Stream<String> get ended => _ended.stream;

  String? _profile;
  bool _started = false;

  /// Call once the profile is known. Safe to call again for another profile.
  Future<void> start(String profileId) async {
    _profile = profileId;
    try {
      if (!_started) {
        _started = true;
        channel.setMethodCallHandler(_onNative);
      }
      await channel.invokeMethod('configure', {'base': kServer.replaceAll(RegExp(r'/$'), ''), 'profile': profileId});
      await channel.invokeMethod('ready');
    } on MissingPluginException {
      // a platform without the native side (tests, desktop): nothing to do
    } on PlatformException catch (e) {
      CallLog.add('native: start failed: ${e.code}');
    }
  }

  Future<dynamic> _onNative(MethodCall c) async {
    final a = (c.arguments is Map) ? Map<String, dynamic>.from(c.arguments as Map) : <String, dynamic>{};
    switch (c.method) {
      case 'token':
        final id = _profile;
        final token = '${a['token'] ?? ''}';
        if (id == null || token.isEmpty) return;
        try {
          await Api.postJson('/api/care/$id/device', {'platform': a['platform'] ?? (Platform.isIOS ? 'ios' : 'android'), 'token': token});
          CallLog.add('native: push token sent (${a['platform']})');
        } catch (_) {
          CallLog.add('native: push token not sent');
        }
        break;
      case 'unavailable':
        CallLog.add('native: push not available: ${a['reason']}');
        break;
      case 'accepted':
        CallLog.add('native: accepted on the system call screen');
        _accepted.add('${a['outreachId']}');
        break;
      case 'declined':
        CallLog.add('native: declined on the system call screen');
        break;
      case 'ended':
        _ended.add('${a['outreachId']}');
        break;
    }
  }

  /// The app is open and rings in its own screen: take the system call screen down.
  Future<void> dismiss(String outreachId) => _tell('dismiss', outreachId);

  /// The live call finished: end the system call too.
  Future<void> callEnded(String outreachId) => _tell('callEnded', outreachId);

  Future<void> _tell(String m, String oid) async {
    try {
      await channel.invokeMethod(m, {'outreachId': oid});
    } on MissingPluginException {
      // no native side
    } on PlatformException {
      // nothing to take down
    }
  }
}
