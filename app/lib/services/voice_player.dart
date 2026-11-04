import 'dart:async';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/services.dart';

/// Plays Maya's live voice. On Android, Maya uses the phone's female Google TTS voice (deviceVoice: true, zero server MMS).
/// What a call needs from the speaker (so a test can stand in for the phone's audio).
abstract class VoiceSink {
  Stream<bool> get idle;
  void add(Uint8List pcm);
  void say(String text, {bool flush = false}) {}
  void finish();
  Future<void> stop();
  Future<void> prime();
  Future<void> dispose();
}

class VoicePlayer implements VoiceSink {
  static const int rate = 24000;
  static const int _firstBytes = rate * 2 ~/ 4; // 250 ms
  static const Duration _flushAfter = Duration(milliseconds: 160);

  /// Channel to Android's OS TextToSpeech (MainActivity.kt). Tests can replace it.
  static MethodChannel ttsChannel = const MethodChannel('maya/tts');
  static bool useDeviceTts = Platform.isAndroid;
  static final Set<VoicePlayer> _activeTtsPlayers = <VoicePlayer>{};
  static bool _ttsHandlerBound = false;

  static void _bindTtsHandler() {
    if (_ttsHandlerBound) return;
    _ttsHandlerBound = true;
    ttsChannel.setMethodCallHandler((c) async {
      if (c.method == 'done' && c.arguments is Map) {
        final id = '${(c.arguments as Map)['id'] ?? ''}';
        for (final p in List<VoicePlayer>.from(_activeTtsPlayers)) {
          p._onTtsDone(id);
        }
      }
      return null;
    });
  }

  final AudioPlayer _player;
  final void Function(String)? _log;
  int _pieces = 0, _ttsSeq = 0;
  DateTime? _replyStart, _lastEnd;
  final BytesBuilder _buf = BytesBuilder(copy: false);
  StreamSubscription<void>? _doneSub;
  Timer? _flush;
  bool _playing = false, _closed = false, _priming = false;
  bool _usedTts = false, _ttsFinished = false;
  final Set<String> _ttsPending = <String>{};
  final Map<String, Timer> _ttsGuards = <String, Timer>{};
  final StreamController<bool> _idle = StreamController<bool>.broadcast();

  // ignore: prefer_initializing_formals
  VoicePlayer({AudioPlayer? player, void Function(String)? log}) : _player = player ?? AudioPlayer(), _log = log {
    _doneSub = _player.onPlayerComplete.listen((_) {
      _lastEnd = DateTime.now();
      _next();
    });
    if (useDeviceTts) {
      _bindTtsHandler();
      _activeTtsPlayers.add(this);
    }
  }

  /// Warms the voice path when the call is ready. On Android this warms the OS Google TTS female voice.
  @override
  Future<void> prime() async {
    if (_closed) return;
    if (useDeviceTts) {
      try {
        final res = await ttsChannel.invokeMethod<dynamic>('warm');
        if (res is Map) {
          _log?.call('device TTS warmed: engine=${res['engine']} voice=${res['voice']}');
        } else {
          _log?.call('device TTS warmed');
        }
      } catch (_) {
        _log?.call('device TTS warm skipped');
      }
      return;
    }
    if (_playing || _buf.isNotEmpty) return;
    try {
      _playing = true;
      _priming = true;
      await _player.play(BytesSource(wav(Uint8List(rate * 2 ~/ 8)), mimeType: 'audio/wav'));
      _log?.call('audio path warmed with 125 ms of silence');
    } catch (e) {
      _playing = false;
      _priming = false;
      _log?.call('warm-up failed: ${e.runtimeType}');
    }
  }

  /// true when nothing is playing and nothing is waiting.
  @override
  Stream<bool> get idle => _idle.stream;
  bool get isIdle => !_playing && _buf.isEmpty && _ttsPending.isEmpty;

  /// Call audio context (never forces speakerphone on Android so Earpiece and Bluetooth headset routing in MainActivity are never overridden).
  static Future<void> configureForCall() async {
    await AudioPlayer.global.setAudioContext(AudioContext(
      iOS: AudioContextIOS(category: AVAudioSessionCategory.playAndRecord, options: const {AVAudioSessionOptions.defaultToSpeaker, AVAudioSessionOptions.allowBluetooth}),
      android: const AudioContextAndroid(isSpeakerphoneOn: false, stayAwake: true, contentType: AndroidContentType.speech, usageType: AndroidUsageType.voiceCommunication, audioFocus: AndroidAudioFocus.gain),
    ));
  }

  @override
  void say(String text, {bool flush = false}) {
    if (_closed) return;
    final clean = text.trim();
    if (clean.isEmpty) return;
    _usedTts = true;
    if (flush) {
      for (final t in _ttsGuards.values) {
        t.cancel();
      }
      _ttsGuards.clear();
      _ttsPending.clear();
      _ttsFinished = false;
      _replyStart = DateTime.now();
      _pieces = 0;
    }
    final id = 'tts_${++_ttsSeq}';
    _ttsPending.add(id);
    _playing = true;
    _pieces++;
    final started = DateTime.now();
    _log?.call('device TTS piece $_pieces (${clean.length} chars, flush=$flush, +${started.difference(_replyStart ?? started).inMilliseconds} ms)');
    final guardMs = (clean.length * 95 + 1200).clamp(1800, 18000);
    _ttsGuards[id] = Timer(Duration(milliseconds: guardMs), () => _onTtsDone(id));
    unawaited(() async {
      try {
        await ttsChannel.invokeMethod<void>('speak', {'text': clean, 'flush': flush, 'id': id, 'call': true});
      } catch (_) {
        _onTtsDone(id);
      }
    }());
  }

  void _onTtsDone(String id) {
    if (_closed) return;
    _ttsGuards.remove(id)?.cancel();
    if (!_ttsPending.remove(id)) return;
    if (_ttsPending.isEmpty) {
      _playing = false;
      if (_ttsFinished && !_closed) {
        _ttsFinished = false;
        _idle.add(true);
      }
    }
  }

  @override
  void add(Uint8List pcm) {
    if (_closed || pcm.isEmpty) return;
    if (_priming) {   // her voice arrived while the warm-up silence was playing: the silence is cut off, so it can never delay a word
      _priming = false;
      _playing = false;
      unawaited(_player.stop());
    }
    if (_playing == false && _buf.isEmpty) { _replyStart = DateTime.now(); _pieces = 0; }
    _buf.add(pcm);
    if (!_playing && _buf.length >= _firstBytes) {
      _next();
    } else if (!_playing) {
      _flush?.cancel();
      _flush = Timer(_flushAfter, () {
        if (!_playing && _buf.isNotEmpty) _next();
      });
    }
  }

  /// The reply is complete: whatever is left plays now, even if it is short.
  @override
  void finish() {
    if (_usedTts) {
      _ttsFinished = true;
      if (_ttsPending.isEmpty && !_closed) {
        _playing = false;
        _ttsFinished = false;
        _idle.add(true);
      }
      return;
    }
    if (!_playing && _buf.isNotEmpty) _next();
  }

  Future<void> _next() async {
    if (_closed) return;
    if (_buf.isEmpty) {
      if (_playing) {
        _playing = false;
        _idle.add(true);
      }
      return;
    }
    _flush?.cancel();
    _priming = false;
    final pcm = _buf.takeBytes();
    _playing = true;
    final started = DateTime.now();
    try {
      await _player.play(BytesSource(wav(pcm), mimeType: 'audio/wav'));
      _pieces++;
      _log?.call('voice piece $_pieces: ${pcm.length * 1000 ~/ (rate * 2)} ms of audio, ${_pieces == 1 ? 'started ${started.difference(_replyStart ?? started).inMilliseconds} ms after her first audio arrived' : 'started ${_lastEnd == null ? '?' : started.difference(_lastEnd!).inMilliseconds} ms after the previous piece ended'}, play() took ${DateTime.now().difference(started).inMilliseconds} ms');
    } catch (_) {
      _playing = false;
      _idle.add(true);
    }
  }

  @override
  Future<void> stop() async {
    _flush?.cancel();
    _buf.clear();
    for (final t in _ttsGuards.values) {
      t.cancel();
    }
    _ttsGuards.clear();
    final hadTts = _ttsPending.isNotEmpty;
    _ttsPending.clear();
    _ttsFinished = false;
    final was = _playing || hadTts;
    _playing = false;
    if (useDeviceTts || _usedTts) {
      try {
        await ttsChannel.invokeMethod<void>('stop');
      } catch (_) {}
    }
    try {
      await _player.stop();
    } catch (_) {}
    if (was && !_closed) _idle.add(true);
  }

  @override
  Future<void> dispose() async {
    _closed = true;
    _activeTtsPlayers.remove(this);
    _flush?.cancel();
    for (final t in _ttsGuards.values) {
      t.cancel();
    }
    _ttsGuards.clear();
    _ttsPending.clear();
    await _doneSub?.cancel();
    if (useDeviceTts || _usedTts) {
      try {
        await ttsChannel.invokeMethod<void>('stop');
      } catch (_) {}
    }
    try {
      await _player.stop();
      await _player.dispose();
    } catch (_) {}
    await _idle.close();
  }

  /// A 44-byte WAV header around mono 16-bit PCM.
  static Uint8List wav(Uint8List pcm, {int sampleRate = rate}) {
    final out = BytesBuilder(copy: false);
    final h = ByteData(44);
    void s(int o, String t) {
      for (var i = 0; i < t.length; i++) {
        h.setUint8(o + i, t.codeUnitAt(i));
      }
    }

    s(0, 'RIFF');
    h.setUint32(4, 36 + pcm.length, Endian.little);
    s(8, 'WAVEfmt ');
    h.setUint32(16, 16, Endian.little);
    h.setUint16(20, 1, Endian.little);
    h.setUint16(22, 1, Endian.little);
    h.setUint32(24, sampleRate, Endian.little);
    h.setUint32(28, sampleRate * 2, Endian.little);
    h.setUint16(32, 2, Endian.little);
    h.setUint16(34, 16, Endian.little);
    s(36, 'data');
    h.setUint32(40, pcm.length, Endian.little);
    out.add(h.buffer.asUint8List());
    out.add(pcm);
    return out.takeBytes();
  }
}
