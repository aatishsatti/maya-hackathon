import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart';
import 'package:maya_app/config.dart';
import 'package:maya_app/services/audio_route.dart';
import 'package:maya_app/services/call_log.dart';
import 'package:maya_app/services/call_session.dart';
import 'package:maya_app/services/voice_player.dart';

/// The call socket against a local stand-in for the server that speaks the same protocol (start -> ready{resume}, resume -> resumed
/// | resumeFailed, ping -> pong, binary = microphone frames) and that drops the line when told to.
class FakeServer {
  late HttpServer http;
  final List<WebSocket> sockets = [];
  final List<Map<String, dynamic>> firstMessages = [];
  int frames = 0, pings = 0, drops = 0;
  bool resumeOk = true, answerPings = true;

  Future<void> start() async {
    http = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    debugWsUri = Uri.parse('ws://127.0.0.1:${http.port}/ws');
    http.listen((req) async {
      final ws = await WebSocketTransformer.upgrade(req);
      sockets.add(ws);
      var first = true;
      ws.listen((m) {
        if (m is String) {
          final j = jsonDecode(m) as Map<String, dynamic>;
          if (first) {
            first = false;
            firstMessages.add(j);
            if (j['type'] == 'start') ws.add(jsonEncode({'type': 'ready', 'resume': 'tok1'}));
            if (j['type'] == 'resume') ws.add(jsonEncode({'type': resumeOk && j['token'] == 'tok1' ? 'resumed' : 'resumeFailed'}));
          } else if (j['type'] == 'ping') {
            pings++;
            if (answerPings) ws.add(jsonEncode({'type': 'pong'}));
          }
        } else {
          frames++;
        }
      }, onError: (_) {});
    });
  }

  /// The line dies without a goodbye (a close frame with a "going away" code, as a lost link looks to the app).
  Future<void> dropLine() async {
    drops++;
    final ws = sockets.last;
    await ws.close(1001, 'test drop');
  }

  Future<void> stop() async {
    debugWsUri = null;
    for (final s in sockets) {
      try {
        await s.close();
      } catch (_) {}
    }
    await http.close(force: true);
  }
}

class FakeMic implements MicSource {
  final StreamController<Uint8List> c = StreamController<Uint8List>();
  Timer? t;
  @override
  Future<bool> hasPermission() async => true;
  @override
  Future<Stream<Uint8List>> start(int sampleRate) async {
    // 64 ms of a quiet tone every 64 ms, as the real microphone delivers it
    t = Timer.periodic(const Duration(milliseconds: 64), (_) {
      if (!c.isClosed) c.add(Uint8List(2048));
    });
    return c.stream;
  }

  @override
  Future<void> stop() async {
    t?.cancel();
  }
}

class FakeVoice implements VoiceSink {
  final _idle = StreamController<bool>.broadcast();
  int primed = 0;
  int pcmBytes = 0;
  final List<String> spoken = [];
  @override
  Stream<bool> get idle => _idle.stream;
  @override
  void add(Uint8List pcm) {
    pcmBytes += pcm.length;
  }
  @override
  void say(String text, {bool flush = false}) {
    spoken.add('${flush ? 'F' : 'A'}:$text');
  }
  @override
  void finish() {
    if (spoken.isNotEmpty) scheduleMicrotask(() => !_idle.isClosed ? _idle.add(true) : null);
  }
  @override
  Future<void> stop() async {}
  @override
  Future<void> prime() async {
    primed++;
  }

  @override
  Future<void> dispose() async {
    await _idle.close();
  }
}

class FakeRoute implements AudioRouteSink {
  final List<String> calls = [];
  @override
  Future<void> setSpeaker(bool on) async => calls.add('speaker ${on ? 'on' : 'off'}');
  @override
  Future<void> release() async => calls.add('release');
}

CallSession session({Duration dead = const Duration(seconds: 12), Duration ping = const Duration(seconds: 5)}) => CallSession(profileId: 'abcdef12', mic: FakeMic(), voice: FakeVoice(), deadAfter: dead, pingEvery: ping);

Future<void> until(bool Function() ok, {int ms = 8000}) async {
  final t0 = DateTime.now();
  while (!ok()) {
    if (DateTime.now().difference(t0).inMilliseconds > ms) throw TimeoutException('waited ${ms}ms');
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  late FakeServer srv;
  setUp(() async {
    CallLog.clear();
    srv = FakeServer();
    await srv.start();
  });
  tearDown(() async => srv.stop());

  test('a line lost mid-call is taken back with the token and the SAME call carries on (the app used to end the call at the first loss)', () async {
    final s = session();
    await s.start();
    await until(() => s.phase == CallPhase.live);
    expect(srv.firstMessages.first['type'], 'start');
    expect(srv.firstMessages.first['profileId'], 'abcdef12');
    await until(() => srv.frames > 5); // the microphone is flowing
    await srv.dropLine();
    await until(() => srv.firstMessages.length == 2 && !s.reconnecting && s.phase == CallPhase.live);
    expect(srv.firstMessages[1], {'type': 'resume', 'token': 'tok1'});
    expect(s.ended, isFalse, reason: 'a lost line is not the end of the call');
    final before = srv.frames;
    await until(() => srv.frames > before + 5); // and the microphone flows again after the resume
    final log = CallLog.lines.join('\n');
    expect(log, contains('socket #1 CLOSED: code=1001 reason="test drop"'));
    expect(log, contains('line lost: the socket closed (code 1001)'));
    expect(log, contains('RESUMED after'));
    expect(log, contains('ready after'));
    await s.hangUp();
    expect(s.endDetail, 'the person ended the call');
    s.dispose();
  });

  test('it survives repeated line losses (a call that lasts minutes on a weak network) and ends only when the person hangs up', () async {
    final s = session();
    await s.start();
    await until(() => s.phase == CallPhase.live);
    for (var i = 1; i <= 5; i++) {
      await srv.dropLine();
      await until(() => srv.firstMessages.length == i + 1 && !s.reconnecting && s.phase == CallPhase.live);
      expect(s.ended, isFalse, reason: 'after loss $i');
    }
    expect(srv.drops, 5);
    expect(CallLog.lines.where((l) => l.contains('RESUMED after')).length, 5);
    await s.hangUp();
    expect(s.ended, isTrue);
    s.dispose();
  });

  test('a silent line is noticed (nothing heard for a while) and recovered; a server that cannot resume ends the call with a plain message and the cause in the log', () async {
    final s = session(dead: const Duration(milliseconds: 500), ping: const Duration(milliseconds: 100));
    srv.answerPings = false; // the link looks alive but nothing comes back
    await s.start();
    await until(() => s.phase == CallPhase.live);
    await until(() => srv.firstMessages.length >= 2, ms: 6000);
    expect(CallLog.lines.join('\n'), contains('nothing heard from the server for'));
    srv.answerPings = true;
    await until(() => !s.reconnecting && s.phase == CallPhase.live);
    await s.hangUp();
    s.dispose();

    CallLog.clear();
    srv.resumeOk = false;
    final t = session();
    await t.start();
    await until(() => t.phase == CallPhase.live);
    await srv.dropLine();
    await until(() => t.ended);
    expect(t.endMessage, 'The connection to Maya ended. Please call again.');
    expect(t.endDetail, contains('resumeFailed'));
    expect(CallLog.lines.join('\n'), contains('call END after'));
    t.dispose();
  });

  test('the first audio: the audio path is warmed when the call is ready, and her voice WAV pieces are valid', () async {
    final v = FakeVoice();
    final s = CallSession(profileId: 'abcdef12', mic: FakeMic(), voice: v);
    await s.start();
    await until(() => s.phase == CallPhase.live);
    await until(() => v.primed == 1);
    await s.hangUp();
    s.dispose();
  });

  test('Android: the microphone keeps recording while Maya\'s voice plays (it is not paused by the audio focus her player takes); iOS settings are unchanged', () {
    final android = RecordMic.config(16000, android: true);
    expect(android.audioInterruption, AudioInterruptionMode.none, reason: 'the default (pause) left the microphone dead for the rest of the call after her greeting');
    final ios = RecordMic.config(16000, android: false);
    expect(ios.audioInterruption, AudioInterruptionMode.pause, reason: 'iOS is as it was');
    for (final c in [android, ios]) {
      expect(c.encoder, AudioEncoder.pcm16bits);
      expect(c.sampleRate, 16000);
      expect(c.numChannels, 1);
      expect([c.echoCancel, c.noiseSuppress, c.autoGain], [true, true, true]);
    }
    expect(ios.iosConfig.categoryOptions, [IosAudioCategoryOption.defaultToSpeaker, IosAudioCategoryOption.allowBluetooth]);
  });

  test('speaker: a call starts on the loudspeaker (before Maya says anything); toggling off and on mid-call changes only the route, the call and the microphone carry on; hanging up releases the route', () async {
    final r = FakeRoute();
    final s = CallSession(profileId: 'abcdef12', mic: FakeMic(), voice: FakeVoice(), route: r);
    expect(s.speakerOn, isTrue);
    await s.start();
    await until(() => s.phase == CallPhase.live);
    expect(r.calls, ['speaker on'], reason: 'on answer: the loudspeaker, set once, before the line opened');
    await until(() => srv.frames > 3);
    final sockets = srv.sockets.length;
    await s.setSpeaker(false);
    expect(s.speakerOn, isFalse);
    final f0 = srv.frames;
    await until(() => srv.frames > f0 + 3);
    expect(s.phase, CallPhase.live, reason: 'the call was not dropped');
    expect(srv.sockets.length, sockets, reason: 'no new line');
    await s.setSpeaker(true);
    expect(s.speakerOn, isTrue);
    expect(r.calls, ['speaker on', 'speaker off', 'speaker on']);
    await s.hangUp();
    expect(r.calls.last, 'release');
    await s.setSpeaker(false);
    expect(r.calls.where((c) => c == 'speaker off').length, 1, reason: 'nothing is routed after the call ended');
    s.dispose();
  });

  test('the audio route is Android only: elsewhere it does nothing, and an unanswered native side is not an error', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final told = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(AudioRoute.channel, (c) async {
      told.add('${c.method} ${c.arguments}');
      return null;
    });
    try {
      AudioRoute.android = false;
      await AudioRoute().setSpeaker(true);
      await AudioRoute().release();
      expect(told, isEmpty, reason: 'iOS is untouched');
      AudioRoute.android = true;
      await AudioRoute().setSpeaker(false);
      await AudioRoute().release();
      expect(told, ['speaker {on: false}', 'release {}']);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(AudioRoute.channel, null);
      await AudioRoute().setSpeaker(true);   // no native side: no error
    } finally {
      AudioRoute.android = Platform.isAndroid;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(AudioRoute.channel, null);
    }
  });

  test('call levels: the microphone and Maya\'s voice each move the reading, quiet is quiet, and a loud sound fades by itself', () async {
    final l = CallLevels();
    expect(l.read(), 0);
    Uint8List tone(int amp, int samples, int rate) {
      final bd = ByteData(samples * 2);
      for (var i = 0; i < samples; i++) {
        bd.setInt16(i * 2, (amp * (i % 2 == 0 ? 1 : -1)), Endian.little);
      }
      return bd.buffer.asUint8List();
    }
    l.micChunk(tone(20, 1600, 16000));
    expect(l.read(), lessThan(0.05), reason: 'a whisper of noise stays quiet');
    l.micChunk(tone(9000, 1600, 16000));
    final loud = l.read();
    expect(loud, greaterThan(0.6), reason: 'a loud voice at the microphone');
    await Future<void>.delayed(const Duration(milliseconds: 700));
    expect(l.read(), lessThan(loud * 0.2), reason: 'it fades once the sound stops');
    l.voiceChunk(tone(8000, 24000, 24000));   // a second of Maya
    expect(l.read(), lessThan(0.05), reason: 'her voice is not playing yet: the reading follows the clock');
    await Future<void>.delayed(const Duration(milliseconds: 420));
    expect(l.read(), greaterThan(0.5), reason: 'her voice is playing, loud');
    l.voiceReset();
    expect(l.read(), lessThan(0.1), reason: 'interrupted: it stops at once');
  });

  test('Android deviceVoice: sends deviceVoice:true on start, speaks pieces via device TTS, and never plays server MMS binary audio', () async {
    final v = FakeVoice();
    final s = CallSession(profileId: 'abcdef12', useDeviceVoice: true, mic: FakeMic(), voice: v);
    await s.start();
    await until(() => s.phase == CallPhase.live);
    expect(srv.firstMessages.first['deviceVoice'], isTrue);
    final ws = srv.sockets.last;
    ws.add(Uint8List(4800)); // binary server MMS frame: must be ignored when deviceVoice is true
    ws.add(jsonEncode({'type': 'speak', 'text': 'Hello Henry.', 'piece': 'Hello Henry.', 'deviceVoice': true}));
    ws.add(jsonEncode({'type': 'caption', 'text': 'Hello Henry. How are you feeling today?', 'piece': 'How are you feeling today?', 'deviceVoice': true}));
    ws.add(jsonEncode({'type': 'audioEnd'}));
    await until(() => v.spoken.length == 2);
    expect(v.spoken, ['F:Hello Henry.', 'A:How are you feeling today?']);
    expect(v.pcmBytes, 0, reason: 'server MMS binary audio is never used for app voice');
    await s.hangUp();
    expect(s.ended, isTrue);
    s.dispose();
  });

  test('voice hangup and manual End button: both end the call cleanly even if the server only replies Okay', () async {
    for (final phrase in ['hang up', 'please hang up', 'Can you hang up?', 'Could you end the call please?', 'hang up the phone', 'disconnect']) {
      expect(CallSession.voiceEndIntent(phrase), 'stop', reason: phrase);
    }
    for (final phrase in ['goodbye', 'Okay, bye', 'I have to go', 'You can hang up now', 'talk to you later', "that's all for now"]) {
      expect(CallSession.voiceEndIntent(phrase), 'bye', reason: phrase);
    }
    for (final phrase in ["please don't hang up", 'hang up the washing, will you?', 'he said bye']) {
      expect(CallSession.voiceEndIntent(phrase), isNull, reason: phrase);
    }

    // Live call voice hangup when server replies "Okay." without sending hangup:
    final v = FakeVoice();
    final r = FakeRoute();
    final s = CallSession(profileId: 'abcdef12', useDeviceVoice: true, mic: FakeMic(), voice: v, route: r);
    await s.start();
    await until(() => s.phase == CallPhase.live);
    final ws = srv.sockets.last;
    ws.add(jsonEncode({'type': 'partial', 'text': 'Can you hang up please?'}));
    ws.add(jsonEncode({'type': 'speechEnd'}));
    ws.add(jsonEncode({'type': 'speak', 'text': 'Okay.', 'piece': 'Okay.', 'deviceVoice': true}));
    ws.add(jsonEncode({'type': 'audioEnd'}));
    await until(() => s.ended);
    expect(s.endMessage, isNull);
    expect(s.endDetail, contains('the person ended the call by voice'));
    expect(r.calls.last, 'release');
    s.dispose();
  });
}
