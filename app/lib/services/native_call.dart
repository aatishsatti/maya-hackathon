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

  /// Tests replace the channel and the platform; nothing else does.
  static MethodChannel channel = const MethodChannel('maya/native_call');
  static bool isIOS = Platform.isIOS;

  final _accepted = StreamController<String>.broadcast();
  final _ended = StreamController<String>.broadcast();
  final _ring = StreamController<String>.broadcast();
  final _opened = StreamController<({String via, String messageId})>.broadcast();
  final _familyRing = StreamController<({String seniorId, String episodeId, String act})>.broadcast();
  String? _familyToken;   // set on a family phone: its push token is then registered with the family account, not with a senior

  /// The outreach id of a ring the person accepted on the system call screen.
  Stream<String> get accepted => _accepted.stream;

  /// The person tapped the notification of a ring that is still going (the outreach id). The app reconnects so the ring is announced again and the Accept / Decline card shows.
  Stream<String> get ring => _ring.stream;

  /// The person tapped the notification of a text or a voice note that came while the app was closed: via is 'text' or 'voice'; messageId is the voice note's chat id ('' for a text).
  Stream<({String via, String messageId})> get opened => _opened.stream;

  /// The family was rung while the app was closed (a push), and tapped or accepted it: who (the senior's id), which ring, and act = 'accepted' when Accept was pressed.
  Stream<({String seniorId, String episodeId, String act})> get familyRing => _familyRing.stream;

  /// The system call screen's hang-up on a live call.
  Stream<String> get ended => _ended.stream;

  String? _profile;
  String? _lastToken;   // this phone's push token, as the native side last told us (so a sign-out can take it off the server)
  bool _started = false;
  final _kinds = <String, String>{};   // outreach id -> callback | reminder | welfare, from the push that rang
  Completer<void>? _audio;             // completes when iOS has turned the call audio on (CallKit's didActivate)
  bool _audioOn = false;

  /// What kind of call rang (the reason the live call is joined with). Reminder when the native side did not say.
  String kindOf(String outreachId) => _kinds.remove(outreachId) ?? 'reminder';

  /// After Accept on the iOS call screen, the microphone must be opened only once iOS has switched the call audio on,
  /// or it is silent when the phone was locked. Android has no such step. Waits at most [timeout], then goes on anyway.
  Future<void> audioReady({Duration timeout = const Duration(seconds: 3)}) async {
    if (!isIOS || _audioOn) return;
    final c = _audio ??= Completer<void>();
    await c.future.timeout(timeout, onTimeout: () {});
  }

  /// A FAMILY phone: register it with the family account so a ring reaches it while the app is closed (Android: Firebase; the token goes to /api/family/device).
  Future<void> startFamily(String familyToken) async {
    _familyToken = familyToken;
    _profile = null;
    try {
      if (!_started) {
        _started = true;
        channel.setMethodCallHandler(_onNative);
      }
      await channel.invokeMethod('configure', {'base': kServer.replaceAll(RegExp(r'/$'), ''), 'profile': '', 'familyToken': familyToken});
      await channel.invokeMethod('ready');
    } on MissingPluginException {
      // a platform without the native side (tests, desktop): nothing to do
    } on PlatformException catch (e) {
      CallLog.add('native: family start failed: ${e.code}');
    }
  }

  /// SIGN OUT of a senior: this phone must not be rung for that person any more. The server forgets this phone's push token, the native side forgets the profile
  /// and the push registration (Android: the token is deleted at Google, so an old push cannot arrive; iOS: the VoIP registration is dropped), and any ring on screen is taken down.
  /// Nothing here deletes the person's profile or chat on the server. Safe to call when nothing was started.
  Future<void> unlink() async {
    final id = _profile, token = _lastToken;
    _profile = null;
    _lastToken = null;
    _familyToken = null;
    if (id != null && token != null) {
      try {
        await Api.delete('/api/care/$id/device/${Uri.encodeComponent(token)}');
        CallLog.add('native: push token removed from the server');
      } catch (_) {
        CallLog.add('native: push token not removed from the server');   // the native side still kills the token below, so the server finds it dead on its next try
      }
    }
    try {
      await channel.invokeMethod('unlink');
    } on MissingPluginException {
      // a platform without the native side (tests, desktop): nothing to do
    } on PlatformException catch (e) {
      CallLog.add('native: unlink failed: ${e.code}');
    }
  }

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
        if (token.isNotEmpty) _lastToken = token;
        if (id == null && _familyToken != null && token.isNotEmpty) {   // a family phone
          try {
            await Api.postJson('/api/family/device', {'platform': a['platform'] ?? (Platform.isIOS ? 'ios' : 'android'), 'token': token});
            CallLog.add('native: family push token sent');
          } catch (_) {
            CallLog.add('native: family push token not sent');
          }
          return;
        }
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
        _audioOn = false;
        _audio = null;
        if (a['kind'] is String) _kinds['${a['outreachId']}'] = a['kind'] as String;
        _accepted.add('${a['outreachId']}');
        break;
      case 'audioActive':
        _audioOn = true;
        final w = _audio;
        if (w != null && !w.isCompleted) w.complete();
        break;
      case 'ring':
        CallLog.add('native: the call notification was tapped');
        if (a['kind'] is String) _kinds['${a['outreachId']}'] = a['kind'] as String;
        _ring.add('${a['outreachId'] ?? ''}');
        break;
      case 'opened':
        CallLog.add('native: a message notification was tapped (${a['via']})');
        _opened.add((via: '${a['via'] ?? 'text'}', messageId: '${a['messageId'] ?? ''}'));
        break;
      case 'familyRing':
        _familyRing.add((seniorId: '${a['seniorId'] ?? ''}', episodeId: '${a['episodeId'] ?? ''}', act: '${a['act'] ?? ''}'));
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

  /// Ring the phone's audible bell while an incoming-call card is on screen.
  Future<void> startBell({int ringMs = 30000}) => _invoke('startBell', {'ringMs': ringMs});

  /// Stop the phone's audible bell.
  Future<void> stopBell() => _invoke('stopBell', const {});

  /// Post the system incoming-call notification if a ring reached the app while not in the foreground.
  Future<void> showIncoming({required String outreachId, required String kind, int ringMs = 30000}) =>
      _invoke('showIncoming', {'outreachId': outreachId, 'kind': kind, 'ringMs': ringMs});

  /// Post the system message notification if a text or voice note reached the app while not in the foreground.
  Future<void> showMessage({required String via, required String what, String? messageId}) =>
      _invoke('showMessage', {'via': via, 'what': what, 'messageId': ?messageId});

  Future<void> _tell(String m, String oid) => _invoke(m, {'outreachId': oid});

  Future<void> _invoke(String m, Map<String, Object?> args) async {
    try {
      await channel.invokeMethod(m, args);
    } on MissingPluginException {
      // no native side
    } on PlatformException {
      // nothing to take down
    }
  }
}
