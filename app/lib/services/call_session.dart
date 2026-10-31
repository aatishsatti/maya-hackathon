import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import '../config.dart';
import 'call_log.dart';
import '../widgets/orb.dart';
import 'tz.dart';
import 'voice_player.dart';

enum CallPhase { connecting, live, ended }

/// What a call needs from the microphone (a test stands in for it).
abstract class MicSource {
  Future<bool> hasPermission();
  Future<Stream<Uint8List>> start(int sampleRate);
  Future<void> stop();
}

class RecordMic implements MicSource {
  final AudioRecorder _rec = AudioRecorder();
  @override
  Future<bool> hasPermission() => _rec.hasPermission();
  @override
  Future<Stream<Uint8List>> start(int sampleRate) => _rec.startStream(RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
        autoGain: true,
        iosConfig: const IosRecordConfig(categoryOptions: [IosAudioCategoryOption.defaultToSpeaker, IosAudioCategoryOption.allowBluetooth]),
      ));
  @override
  Future<void> stop() async {
    try {
      await _rec.stop();
    } catch (_) {}
    try {
      await _rec.dispose();
    } catch (_) {}
  }
}

/// One live call with Maya, over the server's /ws socket (the same one the web page uses).
///   app -> server: text {type:'start', sampleRate, localHour, tz, profileId, reason?, outreachId?} | {type:'mute', on} | {type:'ping'};
///                  binary = Float32 mono microphone frames (16 kHz here).
///   server -> app: text events (ready, speak, caption, partial, speechStart, speechEnd, thinking, idle, audioEnd, stopped, hangup, error ...);
///                  binary = PCM16 24 kHz mono, Maya's voice.
/// Nothing is faked: if the line cannot open, the call says so and ends.
class CallSession extends ChangeNotifier {
  final String profileId;
  final String? reason, outreachId;
  final bool autoStart; // false only in tests that look at the call screen without opening a line
  final MicSource? mic; // tests only
  final VoiceSink? voice; // tests only
  final Duration deadAfter, pingEvery; // how long the line may be silent, and how often it is pinged
  CallSession({required this.profileId, this.reason, this.outreachId, this.autoStart = true, this.mic, this.voice, this.deadAfter = const Duration(seconds: 12), this.pingEvery = const Duration(seconds: 5)});

  CallPhase phase = CallPhase.connecting;
  OrbState orb = OrbState.connecting;
  String caption = '';
  String? endMessage; // set when the call ended for a reason the person should read
  String endDetail = ''; // the plain facts of how it ended (a close code, a time), for the details view
  bool muted = false;
  bool reconnecting = false;
  bool get ended => phase == CallPhase.ended;

  WebSocket? _ws;
  MicSource? _mic;
  StreamSubscription<Uint8List>? _micSub;
  StreamSubscription<bool>? _idleSub;
  Timer? _heartbeat, _thinkWatch, _retryTimer, _attemptTimer;
  VoiceSink? _player;
  bool _ready = false, _speaking = false, _closing = false;
  String? _token; // the server gives it at 'ready': a new socket that shows it gets the SAME call back (the server holds a call 20 s after its line is lost)
  DateTime _lastRx = DateTime.now();
  DateTime? _startedAt, _lostAt;
  int _attempt = 0, _socketNo = 0;
  final List<int> _carry = [];

  static const int micRate = 16000;
  static const int frameSamples = 1024;
  // The same recovery the web page uses: reconnect within a second or two and show the token, for up to 18 s (the server waits 20 s).
  static const Duration lineWindow = Duration(seconds: 18);
  static const List<int> retryMs = [300, 1000];
  static const Duration attemptTimeout = Duration(seconds: 4);

  Future<VoiceSink> _realPlayer() async {
    await VoicePlayer.configureForCall();
    return VoicePlayer(log: CallLog.add);
  }

  int get _elapsedMs => _startedAt == null ? 0 : DateTime.now().difference(_startedAt!).inMilliseconds;

  Future<void> start() async {
    _startedAt = DateTime.now();
    CallLog.add('call start profile=${profileId.substring(0, 4)}.. reason=${reason ?? 'none'}');
    try {
      final rec = _mic = mic ?? RecordMic();
      if (!await rec.hasPermission()) {
        _finish('Maya needs the microphone to hear you. Please allow it in Settings, then call again.', 'no microphone permission');
        return;
      }
      final player = _player = voice ?? await _realPlayer();
      _idleSub = player.idle.listen((_) {
        if (!_speaking || ended) return;
        if (orb == OrbState.speaking) _setOrb(OrbState.listening); // her voice has finished playing
      });
      await _openSocket(resume: false);
      final stream = await rec.start(micRate);
      CallLog.add('microphone open at ${micRate ~/ 1000} kHz');
      _micSub = stream.listen(_onMic, onError: (Object e) => _finish('The microphone stopped. Please call again.', 'microphone error ${e.runtimeType}'));
      _heartbeat = Timer.periodic(pingEvery, (_) {
        if (ended) return;
        _send({'type': 'ping'});
        final quiet = DateTime.now().difference(_lastRx);
        if (!reconnecting && quiet > deadAfter) _lineLost('nothing heard from the server for ${quiet.inMilliseconds} ms');
      });
    } on TimeoutException {
      _finish('Maya could not be reached. Please check the internet connection and call again.', 'connect timed out');
    } on SocketException catch (e) {
      _finish('Maya could not be reached. Please check the internet connection and call again.', 'socket error ${e.osError?.errorCode ?? ''} ${e.message}');
    } on WebSocketException catch (e) {
      _finish('Maya could not be reached. Please try again in a moment.', 'websocket error ${e.message}');
    } catch (e) {
      _finish('The call could not start. Please try again.', 'start failed ${e.runtimeType}');
    }
  }

  /// One socket for the call. resume=false: a new call ('start'). resume=true: the same call again, identified by the token.
  Future<void> _openSocket({required bool resume}) async {
    final no = ++_socketNo;
    final t0 = DateTime.now();
    final ws = await WebSocket.connect(wsUri().toString(), headers: {'Origin': kOrigin}).timeout(const Duration(seconds: 25));
    ws.pingInterval = const Duration(seconds: 15);
    _ws = ws;
    _lastRx = DateTime.now();
    CallLog.add('socket #$no open in ${DateTime.now().difference(t0).inMilliseconds} ms (${resume ? 'resume' : 'new call'}), at $_elapsedMs ms into the call');
    ws.listen(_onData, onDone: () => _onClosed(ws, no), onError: (Object e) => _onClosed(ws, no, error: e), cancelOnError: true);
    if (resume) {
      ws.add(jsonEncode({'type': 'resume', 'token': _token}));
      _attemptTimer?.cancel();
      _attemptTimer = Timer(attemptTimeout, () {
        if (reconnecting && !ended && _ws == ws) {
          CallLog.add('resume attempt got no answer in ${attemptTimeout.inSeconds} s');
          _lineLost('the reconnect got no answer');
        }
      });
    } else {
      final tz = await Tz.name();
      ws.add(jsonEncode({
        'type': 'start',
        'sampleRate': micRate,
        'localHour': DateTime.now().hour,
        'tz': ?tz,
        'profileId': profileId,
        'reason': ?reason,
        'outreachId': ?outreachId,
      }));
    }
  }

  void _send(Map<String, dynamic> m) {
    final ws = _ws;
    if (ws != null && ws.readyState == WebSocket.open) ws.add(jsonEncode(m));
  }

  void _onMic(Uint8List pcm16) {
    final ws = _ws;
    if (!_ready || muted || ws == null || ws.readyState != WebSocket.open) return;
    _carry.addAll(pcm16);
    final bytesPerFrame = frameSamples * 2;
    while (_carry.length >= bytesPerFrame) {
      final frame = Uint8List.fromList(_carry.sublist(0, bytesPerFrame));
      _carry.removeRange(0, bytesPerFrame);
      final bd = ByteData.sublistView(frame);
      final f32 = Float32List(frameSamples);
      for (var i = 0; i < frameSamples; i++) {
        f32[i] = bd.getInt16(i * 2, Endian.little) / 32768.0;
      }
      ws.add(f32.buffer.asUint8List());
    }
  }

  void _onData(dynamic data) {
    _lastRx = DateTime.now();
    if (data is String) {
      Map<String, dynamic> ev;
      try {
        ev = jsonDecode(data) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      _onEvent(ev);
    } else if (data is List<int>) {
      if (_speaking) _player?.add(data is Uint8List ? data : Uint8List.fromList(data));
    }
  }

  void _watchThinking(bool on) {
    _thinkWatch?.cancel();
    if (on) _thinkWatch = Timer(const Duration(seconds: 45), () => _finish('Maya did not answer in time. Please call again.', 'no answer from the server for 45 s while thinking'));
  }

  void _setOrb(OrbState s) {
    if (orb == s) return;
    orb = s;
    notifyListeners();
  }

  void _onEvent(Map<String, dynamic> ev) {
    final t = ev['type'];
    _watchThinking(t == 'thinking' || t == 'speechEnd');
    switch (t) {
      case 'ready':
        _token = ev['resume'] is String ? ev['resume'] as String : null;
        _ready = true;
        phase = CallPhase.live;
        _setOrb(OrbState.listening);
        CallLog.add('ready after $_elapsedMs ms (token ${_token == null ? 'MISSING: a lost line cannot be resumed' : 'kept'})');
        unawaited(_player?.prime()); // warm the audio path now, so her first word is not the first sound the phone has to start
        notifyListeners();
        break;
      case 'resumed':
        _attemptTimer?.cancel();
        reconnecting = false;
        _attempt = 0;
        _ready = true;
        CallLog.add('RESUMED after ${_lostAt == null ? 0 : DateTime.now().difference(_lostAt!).inMilliseconds} ms without a line: the same call carries on');
        _lostAt = null;
        if (muted) _send({'type': 'mute', 'on': true});
        _setOrb(OrbState.listening);
        notifyListeners();
        break;
      case 'resumeFailed':
        _finish('The connection to Maya ended. Please call again.', 'the server no longer had the call (resumeFailed)');
        break;
      case 'speak':
        if (ev['cont'] != true) _player?.stop();
        _speaking = true;
        if (ev['lead'] == true) {
          _setOrb(OrbState.thinking);
        } else {
          _setOrb(OrbState.speaking);
          caption = 'Maya: ${ev['text'] ?? ''}';
          notifyListeners();
        }
        break;
      case 'caption':
        if (orb == OrbState.speaking) {
          caption = 'Maya: ${ev['text'] ?? ''}';
          notifyListeners();
        }
        break;
      case 'audioEnd':
        _player?.finish();
        break;
      case 'ttsFailed':
        caption = 'Maya: ${ev['text'] ?? ''}'; // her voice failed for this line: the words are shown, nothing is pretended
        CallLog.add('her voice failed for one line (${ev['error'] ?? 'no reason'})');
        _setOrb(OrbState.listening);
        notifyListeners();
        break;
      case 'speechStart':
        if (orb != OrbState.speaking) _setOrb(OrbState.listening);
        break;
      case 'partial':
        caption = 'You: ${ev['text'] ?? ''}';
        notifyListeners();
        break;
      case 'speechEnd':
      case 'thinking':
        if (orb != OrbState.speaking) _setOrb(OrbState.thinking);
        break;
      case 'idle':
        if (orb != OrbState.speaking) _setOrb(OrbState.listening);
        break;
      case 'stopped':
        _player?.stop();
        if (orb == OrbState.speaking) _setOrb(OrbState.listening);
        break;
      case 'hangup':
        _finish(null, 'Maya ended the call (hangup)');
        break;
      case 'error':
        _finish('Something went wrong: ${ev['message'] ?? 'unknown'}', 'the server sent an error: ${ev['message'] ?? 'unknown'}');
        break;
      default:
        break;
    }
  }

  void _onClosed(WebSocket ws, int no, {Object? error}) {
    if (ended || _ws != ws) return; // an old socket we already replaced
    final since = DateTime.now().difference(_lastRx).inMilliseconds;
    CallLog.add('socket #$no CLOSED: code=${ws.closeCode} reason="${ws.closeReason ?? ''}" ${error != null ? 'error=${error.runtimeType} ' : ''}$_elapsedMs ms into the call, last data from the server $since ms ago');
    _lineLost('the socket closed (code ${ws.closeCode}${error != null ? ', ${error.runtimeType}' : ''})');
  }

  /// The line died without a goodbye. Reconnect with the token, as the web page does; give up after the window.
  void _lineLost(String why) {
    if (ended || _closing) return;
    final now = DateTime.now();
    _lostAt ??= now;
    _ready = false;
    _attemptTimer?.cancel();
    _retryTimer?.cancel();
    try {
      _ws?.close();
    } catch (_) {}
    CallLog.add('line lost: $why (attempt $_attempt, ${now.difference(_lostAt!).inMilliseconds} ms since the first loss)');
    if (_token == null || now.difference(_lostAt!) >= lineWindow) {
      _finish('The connection to Maya ended. Please call again.', 'could not get the line back (${_token == null ? 'no token' : 'window of ${lineWindow.inSeconds} s used up'}); first cause: $why');
      return;
    }
    reconnecting = true;
    _setOrb(OrbState.connecting);
    final delay = retryMs[_attempt.clamp(0, retryMs.length - 1)];
    _attempt++;
    notifyListeners();
    _retryTimer = Timer(Duration(milliseconds: delay), () async {
      if (ended) return;
      CallLog.add('reconnect attempt $_attempt');
      try {
        await _openSocket(resume: true);
      } catch (e) {
        _lineLost('the reconnect could not open (${e.runtimeType})');
      }
    });
  }

  void setMuted(bool on) {
    muted = on;
    _send({'type': 'mute', 'on': on});
    notifyListeners();
  }

  /// The person hangs up.
  Future<void> hangUp() async => _finish(null, 'the person ended the call');

  void _finish(String? message, String detail) {
    if (_closing) return;
    _closing = true;
    endMessage = message;
    endDetail = detail;
    phase = CallPhase.ended;
    reconnecting = false;
    CallLog.add('call END after $_elapsedMs ms: $detail');
    _heartbeat?.cancel();
    _thinkWatch?.cancel();
    _retryTimer?.cancel();
    _attemptTimer?.cancel();
    _micSub?.cancel();
    _idleSub?.cancel();
    unawaited(_mic?.stop());
    try {
      _ws?.close(1000);
    } catch (_) {}
    final p = _player;
    if (p != null) unawaited(p.dispose());
    notifyListeners();
  }

  @override
  void dispose() {
    _finish(endMessage, endDetail.isEmpty ? 'the call screen closed' : endDetail);
    super.dispose();
  }
}
