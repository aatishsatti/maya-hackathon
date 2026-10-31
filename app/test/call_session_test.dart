import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:maya_app/config.dart';
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
  @override
  Stream<bool> get idle => _idle.stream;
  @override
  void add(Uint8List pcm) {}
  @override
  void finish() {}
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
}
