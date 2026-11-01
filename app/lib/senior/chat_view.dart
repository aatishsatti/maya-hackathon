import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../models.dart';
import '../theme.dart';
import '../widgets/pressable.dart';

/// The chat. It scrolls inside its own area only; the newest message sits at the bottom. A message arrives with a short fade and slide (220 ms).
/// Light and calm: a message from Maya is a pale blue-white bubble on the left, one from the person a pale green on the right. A voice note shows its words,
/// then a play button, a waveform you can slide along, and how long it is.
class ChatView extends StatelessWidget {
  final List<ChatMessage> messages;
  final ScrollController controller;
  final String? playId; // a voice note to start playing (the person tapped its notification)
  const ChatView({super.key, required this.messages, required this.controller, this.playId});

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28),
          child: Text('Say hello to Maya. You can type, record a voice note, or call her.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: kSoft, fontSize: 17, height: 1.4)),
        ),
      );
    }
    final rev = messages.reversed.toList();
    return ListView.builder(
      controller: controller,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      itemCount: rev.length,
      itemBuilder: (context, i) => _Bubble(key: ValueKey(rev[i].id), m: rev[i], autoPlay: rev[i].id == playId),
    );
  }
}

class _Bubble extends StatelessWidget {
  final ChatMessage m;
  final bool autoPlay;
  const _Bubble({super.key, required this.m, this.autoPlay = false});

  @override
  Widget build(BuildContext context) {
    final maya = m.fromMaya;
    final voice = m.kind == 'voice';
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
      builder: (context, t, child) => Opacity(opacity: t * (m.pending ? 0.65 : 1), child: Transform.translate(offset: Offset(0, 10 * (1 - t)), child: child)),
      child: Align(
        alignment: maya ? Alignment.centerLeft : Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          width: voice ? MediaQuery.of(context).size.width * 0.8 : null,
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          decoration: BoxDecoration(
            color: maya ? kBubbleIn : kBubbleOut,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: maya ? const Color(0xFFE4EAF7) : const Color(0xFFD9EEDD)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (m.kind == 'file') _FileRow(name: m.text) else if (m.text.isNotEmpty) Text(m.text, style: const TextStyle(fontSize: 18, height: 1.35, color: kInk, fontWeight: FontWeight.w400)),
              if (m.kind == 'image')
                Padding(
                  padding: EdgeInsets.only(top: m.text.isNotEmpty ? 8 : 0),
                  child: m.mediaUrl != null
                      ? ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.network(m.mediaUrl!, height: 180, width: double.infinity, fit: BoxFit.cover, errorBuilder: (_, _, _) => const _FileRow(name: 'Photo')))
                      : const _FileRow(name: 'Photo', icon: Icons.photo_outlined),
                ),
              if (voice && m.mediaUrl != null) Padding(padding: EdgeInsets.only(top: m.text.isNotEmpty ? 8 : 0), child: VoiceBubble(url: m.mediaUrl!, autoPlay: autoPlay)),
              if (voice && m.mediaUrl == null) Padding(padding: EdgeInsets.only(top: m.text.isNotEmpty ? 8 : 0), child: _Pending(sending: m.pending)),
              if (m.voiceError != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(m.voiceError!, style: const TextStyle(fontSize: 13, color: kAlert))),
            ],
          ),
        ),
      ),
    );
  }
}

/// A document or a photo the person sent: the name, with its icon.
class _FileRow extends StatelessWidget {
  final String name;
  final IconData icon;
  const _FileRow({required this.name, this.icon = Icons.picture_as_pdf_outlined});
  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 44, height: 44, decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white), child: Icon(icon, color: kTrust, size: 24)),
        const SizedBox(width: 12),
        Flexible(child: Text(name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, height: 1.3, color: kInk, fontWeight: FontWeight.w500))),
      ]);
}

/// The sheet behind the paperclip: three plain choices, in words. It answers 'image', 'pdf' or 'camera' (or nothing when the person closes it).
Future<String?> showAttachSheet(BuildContext context) => showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      builder: (_) => const AttachSheet(),
    );

class AttachSheet extends StatelessWidget {
  const AttachSheet({super.key});
  @override
  Widget build(BuildContext context) => SafeArea(
        child: SingleChildScrollView(   // with very large text the sheet scrolls instead of being cut off
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Send Maya something', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -0.5, color: kInk)),
            const SizedBox(height: 4),
            const Text('A photo or a letter. She will tell you what it says.', style: TextStyle(fontSize: 16, color: kSoft, height: 1.35)),
            const SizedBox(height: 16),
            const _AttachTile(icon: Icons.photo_library_outlined, title: 'Attach image', sub: 'A photo from your phone', result: 'image'),
            const SizedBox(height: 10),
            const _AttachTile(icon: Icons.picture_as_pdf_outlined, title: 'Attach file (PDF)', sub: 'A letter, a bill or a message', result: 'pdf'),
            const SizedBox(height: 10),
            const _AttachTile(icon: Icons.photo_camera_outlined, title: 'Take photo', sub: 'Use the camera now', result: 'camera'),
            const SizedBox(height: 6),
            Center(child: TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel', style: TextStyle(fontSize: 17, color: kSoft, fontWeight: FontWeight.w600)))),
          ]),
        ),
      );
}

class _AttachTile extends StatelessWidget {
  final IconData icon;
  final String title, sub, result;
  const _AttachTile({required this.icon, required this.title, required this.sub, required this.result});
  @override
  Widget build(BuildContext context) => Pressable(
        onTap: () => Navigator.of(context).pop(result),
        semanticLabel: title,
        child: Container(
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(color: kTrustSoft.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFDDE3F8))),
          child: Row(children: [
            Container(width: 52, height: 52, decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white), child: Icon(icon, color: kTrust, size: 28)),
            const SizedBox(width: 14),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: kInk)),
              Text(sub, style: const TextStyle(fontSize: 15, color: kSoft)),
            ])),
            const Icon(Icons.chevron_right, color: kSoft),
          ]),
        ),
      );
}

/// A voice note on its way (no sound file yet): the play button waits, the waveform rests.
class _Pending extends StatelessWidget {
  final bool sending;
  const _Pending({required this.sending});
  @override
  Widget build(BuildContext context) => Row(children: [
        _PlayDot(icon: Icons.play_arrow, onTap: null, label: 'Voice note'),
        const SizedBox(width: 12),
        Expanded(child: SizedBox(height: 34, child: CustomPaint(painter: _WavePainter(seed: 7, progress: 0, active: false)))),
        const SizedBox(width: 10),
        Text(sending ? 'Sending' : 'Voice note', style: const TextStyle(fontSize: 14, color: kSoft, fontWeight: FontWeight.w500)),
      ]);
}

class _PlayDot extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final String label;
  const _PlayDot({required this.icon, required this.onTap, required this.label});
  @override
  Widget build(BuildContext context) => Pressable(
        onTap: onTap,
        semanticLabel: label,
        child: Container(width: 48, height: 48, decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white), child: Icon(icon, color: onTap == null ? kTrust.withValues(alpha: 0.4) : kTrust, size: 28)),
      );
}

/// A voice note: a play button, a waveform you can touch to move along the sound, and how long it is. Tap play to hear it, tap again to pause.
class VoiceBubble extends StatefulWidget {
  final String url;
  final bool autoPlay; // start playing when it appears (or when this turns true): a voice note opened from its notification
  const VoiceBubble({super.key, required this.url, this.autoPlay = false});
  @override
  State<VoiceBubble> createState() => _VoiceBubbleState();
}

class _VoiceBubbleState extends State<VoiceBubble> {
  AudioPlayer? _p;
  bool _playing = false;
  String? _err;
  Duration _pos = Duration.zero, _dur = Duration.zero;
  final List<StreamSubscription<dynamic>> _subs = [];

  @override
  void initState() {
    super.initState();
    unawaited(_readLength());
    if (widget.autoPlay) WidgetsBinding.instance.addPostFrameCallback((_) => mounted && !_playing ? _toggle() : null);
  }

  @override
  void didUpdateWidget(VoiceBubble old) {
    super.didUpdateWidget(old);
    if (widget.autoPlay && !old.autoPlay && !_playing) _toggle();
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _p?.dispose();
    super.dispose();
  }

  // The length of a WAV note is in its first bytes and its file size: read them without downloading the whole note, so the length shows before it is played.
  Future<void> _readLength() async {
    final client = http.Client();
    try {
      final res = await client.send(http.Request('GET', Uri.parse(widget.url))).timeout(const Duration(seconds: 6));
      final total = res.contentLength ?? 0;
      final head = <int>[];
      await for (final chunk in res.stream) {
        head.addAll(chunk);
        if (head.length >= 44) break;
      }
      if (head.length >= 44 && total > 44) {
        final bd = ByteData.sublistView(Uint8List.fromList(head.sublist(0, 44)));
        final byteRate = bd.getUint32(28, Endian.little);
        if (byteRate > 0 && mounted) setState(() => _dur = Duration(milliseconds: ((total - 44) * 1000 / byteRate).round()));
      }
    } catch (_) {
      // the length shows once the note is played
    } finally {
      client.close();
    }
  }

  AudioPlayer _player() {
    final existing = _p;
    if (existing != null) return existing;
    final p = _p = AudioPlayer();
    _subs.add(p.onPlayerComplete.listen((_) => mounted ? setState(() {
          _playing = false;
          _pos = Duration.zero;
        }) : null));
    _subs.add(p.onPositionChanged.listen((d) => mounted ? setState(() => _pos = d) : null));
    _subs.add(p.onDurationChanged.listen((d) => mounted ? setState(() => _dur = d) : null));
    return p;
  }

  Future<void> _toggle() async {
    HapticFeedback.selectionClick();
    try {
      final p = _player();
      if (_playing) {
        await p.pause();
        setState(() => _playing = false);
      } else {
        setState(() => _err = null);
        if (_pos > Duration.zero && _pos < _dur) {
          await p.resume();
        } else {
          await p.play(UrlSource(widget.url));
        }
        setState(() => _playing = true);
      }
    } catch (_) {
      if (mounted) setState(() => _err = 'This voice note could not be played.');
    }
  }

  Future<void> _seek(double f) async {
    if (_dur == Duration.zero) return;
    final to = Duration(milliseconds: (_dur.inMilliseconds * f.clamp(0.0, 1.0)).round());
    setState(() => _pos = to);
    try {
      final p = _player();
      if (_p != null && (_playing || _pos > Duration.zero)) await p.seek(to);
    } catch (_) {}
  }

  static String _mmss(Duration d) => '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final progress = _dur.inMilliseconds == 0 ? 0.0 : (_pos.inMilliseconds / _dur.inMilliseconds).clamp(0.0, 1.0);
    final shown = _playing || _pos > Duration.zero ? _pos : _dur;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Row(children: [
        _PlayDot(icon: _playing ? Icons.pause : Icons.play_arrow, onTap: _toggle, label: _playing ? 'Pause the voice note' : 'Play the voice note'),
        const SizedBox(width: 12),
        Expanded(
          child: LayoutBuilder(builder: (context, box) {
            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapDown: (d) => _seek(d.localPosition.dx / box.maxWidth),
              onHorizontalDragUpdate: (d) => _seek(d.localPosition.dx / box.maxWidth),
              child: Semantics(
                label: 'Voice note position',
                value: _mmss(_pos),
                child: SizedBox(height: 40, child: CustomPaint(painter: _WavePainter(seed: widget.url.hashCode, progress: progress, active: _playing || _pos > Duration.zero))),
              ),
            );
          }),
        ),
        const SizedBox(width: 10),
        Text(_dur == Duration.zero && !_playing ? '' : _mmss(shown), style: const TextStyle(fontSize: 14, color: kSoft, fontWeight: FontWeight.w500, fontFeatures: [FontFeature.tabularFigures()])),
      ]),
      if (_err != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_err!, style: const TextStyle(fontSize: 14, color: kAlert))),
    ]);
  }
}

/// A waveform you slide along: thin rounded bars, the part already heard in trust blue, the rest pale. The bar heights are a fixed pattern for each note.
class _WavePainter extends CustomPainter {
  final int seed;
  final double progress;
  final bool active;
  _WavePainter({required this.seed, required this.progress, required this.active});

  @override
  void paint(Canvas canvas, Size size) {
    const bw = 3.0, gap = 3.0;
    final n = math.max(8, (size.width / (bw + gap)).floor());
    final rnd = math.Random(seed);
    final mid = size.height / 2;
    for (var i = 0; i < n; i++) {
      final env = 0.35 + 0.65 * math.sin(math.pi * (i + 0.5) / n);
      final h = (size.height * (0.18 + 0.72 * rnd.nextDouble()) * env).clamp(4.0, size.height);
      final x = i * (bw + gap) + bw / 2;
      final heard = active && (i + 0.5) / n <= progress;
      final paint = Paint()
        ..color = heard ? kTrust : kTrust.withValues(alpha: active ? 0.26 : 0.34)
        ..strokeWidth = bw
        ..strokeCap = StrokeCap.round;
      canvas.drawLine(Offset(x, mid - h / 2), Offset(x, mid + h / 2), paint);
    }
    if (active) {
      final x = (progress * size.width).clamp(0.0, size.width);
      canvas.drawCircle(Offset(x, mid), 5.5, Paint()..color = kTrust);
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) => old.progress != progress || old.active != active || old.seed != seed;
}
