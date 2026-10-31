import 'dart:async';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';

/// Plays Maya's live voice. The server sends raw PCM16 (24 kHz, mono) faster than real time; it is gathered and played as
/// short WAV pieces, back to back. The first piece starts after about a quarter of a second of audio, and everything that
/// arrives while it plays becomes the next piece, so a reply has at most a seam or two. stop() clears everything at once.
/// What a call needs from the speaker (so a test can stand in for the phone's audio).
abstract class VoiceSink {
  Stream<bool> get idle;
  void add(Uint8List pcm);
  void finish();
  Future<void> stop();
  Future<void> prime();
  Future<void> dispose();
}

class VoicePlayer implements VoiceSink {
  static const int rate = 24000;
  static const int _firstBytes = rate * 2 ~/ 4; // 250 ms
  static const Duration _flushAfter = Duration(milliseconds: 160);

  final AudioPlayer _player;
  final void Function(String)? _log;
  int _pieces = 0;
  DateTime? _replyStart, _lastEnd;
  final BytesBuilder _buf = BytesBuilder(copy: false);
  StreamSubscription<void>? _doneSub;
  Timer? _flush;
  bool _playing = false, _closed = false, _priming = false;
  final StreamController<bool> _idle = StreamController<bool>.broadcast();

  // ignore: prefer_initializing_formals
  VoicePlayer({AudioPlayer? player, void Function(String)? log}) : _player = player ?? AudioPlayer(), _log = log {
    _doneSub = _player.onPlayerComplete.listen((_) {
      _lastEnd = DateTime.now();
      _next();
    });
  }

  /// Plays a tenth of a second of silence through the same path. The first real word of a call used to be the very first sound the
  /// phone had to start (and the output route may change), which is where a first word can break up; this takes that start-up away.
  @override
  Future<void> prime() async {
    if (_closed || _playing || _buf.isNotEmpty) return;
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
  bool get isIdle => !_playing && _buf.isEmpty;

  /// Speaker, with the microphone open at the same time (a call).
  static Future<void> configureForCall() async {
    await AudioPlayer.global.setAudioContext(AudioContext(
      iOS: AudioContextIOS(category: AVAudioSessionCategory.playAndRecord, options: const {AVAudioSessionOptions.defaultToSpeaker, AVAudioSessionOptions.allowBluetooth}),
      android: const AudioContextAndroid(isSpeakerphoneOn: true, stayAwake: true, contentType: AndroidContentType.speech, usageType: AndroidUsageType.voiceCommunication, audioFocus: AndroidAudioFocus.gain),
    ));
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
    final was = _playing;
    _playing = false;
    try {
      await _player.stop();
    } catch (_) {}
    if (was) _idle.add(true);
  }

  @override
  Future<void> dispose() async {
    _closed = true;
    _flush?.cancel();
    await _doneSub?.cancel();
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
