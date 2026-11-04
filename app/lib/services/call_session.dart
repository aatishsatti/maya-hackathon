import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import '../config.dart';
import 'audio_route.dart';
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
  /// The microphone settings for a call. On Android the recorder holds audio focus and, by default (AudioInterruptionMode.pause), PAUSES itself when anything else takes focus and never resumes:
  /// Maya's own voice player takes focus every time she speaks, so after her greeting the microphone was dead and she heard nothing. A call is both at once, so on Android the recorder is told to keep
  /// recording through interruptions (none). iOS is left exactly as it was.
  static RecordConfig config(int sampleRate, {bool? android}) => RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
        autoGain: true,
        audioInterruption: (android ?? Platform.isAndroid) ? AudioInterruptionMode.none : AudioInterruptionMode.pause,
        iosConfig: const IosRecordConfig(categoryOptions: [IosAudioCategoryOption.defaultToSpeaker, IosAudioCategoryOption.allowBluetooth]),
      );
  @override
  Future<Stream<Uint8List>> start(int sampleRate) => _rec.startStream(config(sampleRate));
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

/// How loud the call is, right now, for the orb (0 is quiet, 1 is loud): the person's own voice from the microphone, and Maya's voice as it plays. Read once per frame.
/// Maya's audio arrives faster than it is played, so what is kept is a loudness for each 20 ms of it, in playing order, and the reading follows the clock.
class CallLevels {
  double _mic = 0;
  DateTime _micAt = DateTime.now();
  final List<double> _env = [];
  DateTime? _playStart;

  static double _rms(Uint8List pcm, int from, int to) {
    final bd = ByteData.sublistView(pcm);
    var sum = 0.0, n = 0;
    for (var i = from; i + 1 < to && i + 1 < pcm.length; i += 2) {
      final v = bd.getInt16(i, Endian.little) / 32768.0;
      sum += v * v;
      n++;
    }
    return n == 0 ? 0 : math.sqrt(sum / n);
  }

  /// A piece of the microphone (16-bit samples).
  void micChunk(Uint8List pcm) {
    final now = DateTime.now();
    _mic = math.max(_decayed(now), (_rms(pcm, 0, pcm.length) * 7).clamp(0.0, 1.0));
    _micAt = now;
  }

  double _decayed(DateTime now) => _mic * math.exp(-now.difference(_micAt).inMilliseconds / 160.0);

  /// A piece of Maya's voice (16-bit samples, 24 kHz): its loudness, 20 ms at a time.
  void voiceChunk(Uint8List pcm) {
    final now = DateTime.now();
    final start = _playStart;
    if (start == null || now.isAfter(start.add(Duration(milliseconds: _env.length * 20 + 300)))) {
      _env.clear();
      _playStart = now.add(const Duration(milliseconds: 280)); // the player starts a moment after the first piece arrives
    }
    const win = 24000 * 2 ~/ 50; // 20 ms of bytes
    for (var i = 0; i < pcm.length; i += win) {
      _env.add((_rms(pcm, i, math.min(i + win, pcm.length)) * 5.5).clamp(0.0, 1.0));
    }
  }

  /// A piece of Maya's device TTS voice: builds a smooth speaking envelope for the orb while the OS TTS speaks.
  void voiceText(String text) {
    final clean = text.trim();
    if (clean.isEmpty) return;
    final now = DateTime.now();
    final start = _playStart;
    if (start == null || now.isAfter(start.add(Duration(milliseconds: _env.length * 20 + 200)))) {
      _env.clear();
      _playStart = now.add(const Duration(milliseconds: 80));
    }
    final frames = ((clean.length * 65) ~/ 20).clamp(12, 600);
    for (var i = 0; i < frames; i++) {
      final w = 0.55 + 0.3 * math.sin(i * 0.45) + 0.15 * math.cos(i * 0.19);
      _env.add(w.clamp(0.15, 0.95));
    }
  }

  /// Maya stopped (interrupted or finished).
  void voiceReset() {
    _env.clear();
    _playStart = null;
  }

  /// The loudness now: the louder of the two voices.
  double read() {
    final now = DateTime.now();
    var voice = 0.0;
    final start = _playStart;
    if (start != null && _env.isNotEmpty) {
      final i = now.difference(start).inMilliseconds ~/ 20;
      if (i >= 0 && i < _env.length) {
        final a = _env[i], b = i > 0 ? _env[i - 1] : a, c = i + 1 < _env.length ? _env[i + 1] : a;
        voice = (a * 0.5 + b * 0.25 + c * 0.25);
      }
    }
    return math.max(voice, _decayed(now)).clamp(0.0, 1.0);
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
  final bool? useDeviceVoice; // defaults to VoicePlayer.useDeviceTts (true on Android)
  final MicSource? mic; // tests only
  final VoiceSink? voice; // tests only
  final AudioRouteSink? route; // tests only
  final Duration deadAfter, pingEvery; // how long the line may be silent, and how often it is pinged
  CallSession({
    required this.profileId,
    this.reason,
    this.outreachId,
    this.autoStart = true,
    this.useDeviceVoice,
    this.mic,
    this.voice,
    this.route,
    this.deadAfter = const Duration(seconds: 12),
    this.pingEvery = const Duration(seconds: 5),
  });

  bool get deviceVoice => useDeviceVoice ?? VoicePlayer.useDeviceTts;

  static final RegExp _stopNowRe = RegExp(
    r"^(?:(?:please|just|ok|okay|all right|alright|maya|hey maya|now|can you|could you|will you|would you|can we|let's|let us|i want to|i'd like to|i am going to|i'm going to|time to)\s+)*(?:stop(?: (?:the|this) call)?|hang up|end (?:(?:the|this|our) )?(?:phone )?call|close (?:the|this) call|disconnect)(?:\s+(?:now|please|maya|the call|this call|the phone|for me|it|thanks|thank you))*$",
  );
  static final RegExp _byeWordsRe = RegExp(
    r"\b(?:good ?bye|bye(?: bye)?|good ?night|see you(?: later| soon)?|talk (?:to you )?(?:later|soon)|take care|i have to go|i must go|i need to go|got to go|gotta go|you can (?:hang up|go now|go)|hang up now|let you go|we are done|we're done|that's all(?: for now| maya| thanks| thank you)?|that is all(?: for now| maya| thanks| thank you)?|(?:please )?hang up(?: the (?:call|phone)| maya| now| please)*$)\b",
  );
  static final RegExp _notExitRe = RegExp(
    r"\b(?:don'?t|do not|never|not yet|wait|if|when|whenever|unless|whether|would|could|suppose|imagine|kidding|joking|jk|haha|lol|said|says|saying|told|tell|asked)\b",
  );
  static final RegExp _questionWordsRe = RegExp(
    r"\b(?:who|what|why|how|when|where|which|can you|could you|would you|will you|do you|did you|are you|is it|is there|but|actually|one thing|one more|also|however)\b",
  );
  static final RegExp _mayaFarewellRe = RegExp(
    r"\b(?:good ?bye|bye(?:-bye| bye)?|hang(?:ing)? up|let you go|talk (?:to you )?(?:soon|later)|speak (?:to you )?soon)\b|\b(?:good night|take care)\W*$",
    caseSensitive: false,
  );

  /// Recognizes when the person ends the call by voice ('stop' or 'bye'), matching call.js plus natural polite hangup requests.
  static String? voiceEndIntent(String? text) {
    final raw = (text ?? '').trim();
    if (raw.isEmpty || RegExp(r'["“”]').hasMatch(raw)) return null;
    final w = raw.toLowerCase().replaceAll(RegExp(r'[\u2018\u2019]'), "'").replaceAll(RegExp(r"[^a-z' ]"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
    if (w.isEmpty) return null;
    final n = w.split(' ').length;
    if (n > 14) return null;
    if (!RegExp(r"\b(?:don'?t|do not|never|not yet|wait)\b").hasMatch(w) && _stopNowRe.hasMatch(w)) return 'stop';
    if (!_byeWordsRe.hasMatch(w) || raw.contains('?') || _notExitRe.hasMatch(w) || _questionWordsRe.hasMatch(w)) return null;
    return 'bye';
  }

  static bool isMayaFarewell(String? text) {
    final t = (text ?? '').trim();
    if (t.isEmpty || RegExp(r'\?\W*$').hasMatch(t)) return false;
    return _mayaFarewellRe.hasMatch(t);
  }

  final CallLevels levels = CallLevels(); // how loud each voice is, for the orb
  CallPhase phase = CallPhase.connecting;
  OrbState orb = OrbState.connecting;
  String caption = '';
  String? endMessage; // set when the call ended for a reason the person should read
  String endDetail = ''; // the plain facts of how it ended (a close code, a time), for the details view
  bool muted = false;
  bool speakerOn = true; // a call starts on the loudspeaker; the person can switch to the earpiece and back at any time
  bool reconnecting = false;
  bool get ended => phase == CallPhase.ended;

  WebSocket? _ws;
  MicSource? _mic;
  late final AudioRouteSink _route = route ?? AudioRoute();
  bool _routeCounted = false;
  StreamSubscription<Uint8List>? _micSub;
  StreamSubscription<bool>? _idleSub;
  Timer? _heartbeat, _thinkWatch, _retryTimer, _attemptTimer, _voiceEndTimer;
  VoiceSink? _player;
  bool _ready = false, _speaking = false, _closing = false;
  String _lastHeard = '';
  String? _pendingVoiceEnd;
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
      if (!_routeCounted) {
        _routeCounted = true;
        AudioRoute.callStarted();
      }
      await _route.setSpeaker(true); // on answer: the loudspeaker, before Maya says a word (an app-open call and a call answered from a closed app both start here)
      _idleSub = player.idle.listen((_) {
        if (!_speaking || ended) return;
        if (_pendingVoiceEnd != null) {
          final how = _pendingVoiceEnd!;
          _pendingVoiceEnd = null;
          _finish(null, 'the person ended the call by voice ($how)');
          return;
        }
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
        if (deviceVoice) 'deviceVoice': true,
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
    levels.micChunk(pcm16);
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
      if (_speaking && !deviceVoice) {
        final bytes = data is Uint8List ? data : Uint8List.fromList(data);
        levels.voiceChunk(bytes);
        _player?.add(bytes);
      }
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

  void _armVoiceEndFallback(Duration wait) {
    _voiceEndTimer?.cancel();
    _voiceEndTimer = Timer(wait, () {
      if (!ended && _pendingVoiceEnd != null) {
        final how = _pendingVoiceEnd!;
        _pendingVoiceEnd = null;
        _finish(null, 'the person ended the call by voice ($how)');
      }
    });
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
        CallLog.add('ready after $_elapsedMs ms (token ${_token == null ? 'MISSING: a lost line cannot be resumed' : 'kept'}, deviceVoice=$deviceVoice)');
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
        if (ev['lead'] == true && deviceVoice) break; // never play server MMS lead-in clips on Android
        if (ev['cont'] != true) {
          _player?.stop();
          levels.voiceReset();
        }
        _speaking = true;
        if (ev['lead'] == true) {
          _setOrb(OrbState.thinking);
        } else {
          _setOrb(OrbState.speaking);
          final shown = '${ev['text'] ?? ''}';
          caption = 'Maya: $shown';
          final piece = (ev['piece'] ?? (deviceVoice ? ev['text'] : null))?.toString().trim() ?? '';
          if (piece.isNotEmpty) {
            _player?.say(piece, flush: ev['cont'] != true);
            levels.voiceText(piece);
          }
          if (isMayaFarewell(shown)) {
            _pendingVoiceEnd ??= 'bye';
          }
          if (_pendingVoiceEnd != null) {
            _armVoiceEndFallback(Duration(milliseconds: (shown.length * 110 + 1800).clamp(2200, 9000)));
          }
          notifyListeners();
        }
        break;
      case 'caption':
        if (orb == OrbState.speaking) {
          final shown = '${ev['text'] ?? ''}';
          caption = 'Maya: $shown';
          final piece = (ev['piece'])?.toString().trim() ?? '';
          if (piece.isNotEmpty) {
            _player?.say(piece, flush: false);
            levels.voiceText(piece);
          }
          if (isMayaFarewell(shown)) {
            _pendingVoiceEnd ??= 'bye';
          }
          if (_pendingVoiceEnd != null) {
            _armVoiceEndFallback(Duration(milliseconds: (shown.length * 110 + 1800).clamp(2200, 9000)));
          }
          notifyListeners();
        }
        break;
      case 'audioEnd':
        _player?.finish();
        if (_pendingVoiceEnd != null && !deviceVoice && (_player == null || (_player is VoicePlayer && (_player as VoicePlayer).isIdle))) {
          _armVoiceEndFallback(const Duration(milliseconds: 900));
        }
        break;
      case 'ttsFailed':
        caption = 'Maya: ${ev['text'] ?? ''}'; // her voice failed for this line: the words are shown, nothing is pretended
        CallLog.add('her voice failed for one line (${ev['error'] ?? 'no reason'})');
        _setOrb(OrbState.listening);
        if (_pendingVoiceEnd != null) _armVoiceEndFallback(const Duration(milliseconds: 600));
        notifyListeners();
        break;
      case 'speechStart':
        _lastHeard = '';
        _pendingVoiceEnd = null;
        _voiceEndTimer?.cancel();
        if (orb != OrbState.speaking) _setOrb(OrbState.listening);
        break;
      case 'partial':
        final text = '${ev['text'] ?? ''}';
        _lastHeard = text.trim();
        _pendingVoiceEnd = voiceEndIntent(_lastHeard);
        caption = 'You: $text';
        notifyListeners();
        break;
      case 'speechEnd':
      case 'thinking':
        if (_pendingVoiceEnd == 'stop') {
          _armVoiceEndFallback(const Duration(milliseconds: 1800));
        } else if (_pendingVoiceEnd == 'bye') {
          _armVoiceEndFallback(const Duration(milliseconds: 5500));
        }
        if (orb != OrbState.speaking) _setOrb(OrbState.thinking);
        break;
      case 'idle':
        if (_pendingVoiceEnd != null) {
          final how = _pendingVoiceEnd!;
          _pendingVoiceEnd = null;
          _finish(null, 'the person ended the call by voice ($how)');
          break;
        }
        if (orb != OrbState.speaking) _setOrb(OrbState.listening);
        break;
      case 'stopped':
        _player?.stop();
        levels.voiceReset();
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

  /// Speaker on: the loudspeaker (the proximity sensor off, the screen stays on). Speaker off: the earpiece (the screen goes off at the ear). Works in the middle of a call; the line is not touched.
  Future<void> setSpeaker(bool on) async {
    if (ended) return;
    speakerOn = on;
    notifyListeners();
    await _route.setSpeaker(on);
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
    _voiceEndTimer?.cancel();
    _micSub?.cancel();
    _idleSub?.cancel();
    unawaited(_mic?.stop());
    if (_routeCounted) {
      _routeCounted = false;
      AudioRoute.callEnded();
    }
    // the call's audio is let go completely, THEN the player goes back to the chat setting (speaker, media), so a voice note after the call is never stuck on the call's route
    unawaited(_route.release().whenComplete(AudioRoute.useChatContext));
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
