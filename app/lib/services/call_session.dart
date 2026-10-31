import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import '../config.dart';
import '../widgets/orb.dart';
import 'tz.dart';
import 'voice_player.dart';

enum CallPhase { connecting, live, ended }

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
  CallSession({required this.profileId, this.reason, this.outreachId, this.autoStart = true});

  CallPhase phase = CallPhase.connecting;
  OrbState orb = OrbState.connecting;
  String caption = '';
  String? endMessage; // set when the call ended for a reason the person should read
  bool muted = false;
  bool get ended => phase == CallPhase.ended;

  WebSocket? _ws;
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _micSub;
  StreamSubscription<bool>? _idleSub;
  Timer? _heartbeat, _thinkWatch;
  VoicePlayer? _player;
  bool _ready = false, _speaking = false, _closing = false;
  DateTime _lastRx = DateTime.now();
  final List<int> _carry = [];

  static const int micRate = 16000;
  static const int frameSamples = 1024;

  Future<void> start() async {
    try {
      final rec = _rec = AudioRecorder();
      if (!await rec.hasPermission()) {
        _finish('Maya needs the microphone to hear you. Please allow it in Settings, then call again.');
        return;
      }
      await VoicePlayer.configureForCall();
      final player = _player = VoicePlayer();
      _idleSub = player.idle.listen((_) {
        if (!_speaking || ended) return;
        // her voice has finished playing
        if (orb == OrbState.speaking) _setOrb(OrbState.listening);
      });
      final ws = _ws = await WebSocket.connect(wsUri().toString(), headers: {'Origin': kOrigin}).timeout(const Duration(seconds: 25));
      ws.pingInterval = const Duration(seconds: 15);
      ws.listen(_onData, onDone: _onClosed, onError: (_) => _onClosed(), cancelOnError: true);
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
      final stream = await rec.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: micRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
        autoGain: true,
        iosConfig: IosRecordConfig(categoryOptions: [IosAudioCategoryOption.defaultToSpeaker, IosAudioCategoryOption.allowBluetooth]),
      ));
      _micSub = stream.listen(_onMic, onError: (_) => _finish('The microphone stopped. Please call again.'));
      _heartbeat = Timer.periodic(const Duration(seconds: 5), (_) {
        if (ended) return;
        _send({'type': 'ping'});
        if (DateTime.now().difference(_lastRx) > const Duration(seconds: 25)) _finish('The connection to Maya ended. Please call again.');
      });
    } on TimeoutException {
      _finish('Maya could not be reached. Please check the internet connection and call again.');
    } on SocketException {
      _finish('Maya could not be reached. Please check the internet connection and call again.');
    } on WebSocketException {
      _finish('Maya could not be reached. Please try again in a moment.');
    } catch (_) {
      _finish('The call could not start. Please try again.');
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
    if (on) _thinkWatch = Timer(const Duration(seconds: 45), () => _finish('Maya did not answer in time. Please call again.'));
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
        _ready = true;
        phase = CallPhase.live;
        _setOrb(OrbState.listening);
        notifyListeners();
        break;
      case 'speak':
        if (ev['cont'] != true) {
          _player?.stop();
        }
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
        _finish(null);
        break;
      case 'error':
        _finish('Something went wrong: ${ev['message'] ?? 'unknown'}');
        break;
      default:
        break;
    }
  }

  void _onClosed() {
    if (!ended) _finish('The connection to Maya ended. Please call again.');
  }

  void setMuted(bool on) {
    muted = on;
    _send({'type': 'mute', 'on': on});
    notifyListeners();
  }

  /// The person hangs up.
  Future<void> hangUp() async => _finish(null);

  void _finish(String? message) {
    if (_closing) return;
    _closing = true;
    endMessage = message;
    phase = CallPhase.ended;
    _heartbeat?.cancel();
    _thinkWatch?.cancel();
    _micSub?.cancel();
    _idleSub?.cancel();
    unawaited(_rec?.stop().catchError((_) => null));
    unawaited(_rec?.dispose().catchError((_) {}));
    try {
      _ws?.close(1000);
    } catch (_) {}
    final p = _player;
    if (p != null) unawaited(p.dispose());
    notifyListeners();
  }

  @override
  void dispose() {
    _finish(endMessage);
    super.dispose();
  }
}
