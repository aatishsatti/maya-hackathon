import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models.dart';
import '../theme.dart';
import '../widgets/pressable.dart';

/// The chat. It scrolls inside its own area only; the newest message sits at the bottom. A message arrives with a short
/// fade and slide (220 ms).
class ChatView extends StatelessWidget {
  final List<ChatMessage> messages;
  final ScrollController controller;
  const ChatView({super.key, required this.messages, required this.controller});

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Text('Say hello to Maya. You can type, record a voice note, or call her.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: kSoft)),
        ),
      );
    }
    final rev = messages.reversed.toList();
    return ListView.builder(
      controller: controller,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      itemCount: rev.length,
      itemBuilder: (context, i) => _Bubble(key: ValueKey(rev[i].id), m: rev[i]),
    );
  }
}

class _Bubble extends StatelessWidget {
  final ChatMessage m;
  const _Bubble({super.key, required this.m});

  @override
  Widget build(BuildContext context) {
    final maya = m.fromMaya;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
      builder: (context, t, child) => Opacity(opacity: t * (m.pending ? 0.6 : 1) + (1 - t) * 0, child: Transform.translate(offset: Offset(0, 10 * (1 - t)), child: child)),
      child: Align(
        alignment: maya ? Alignment.centerLeft : Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(color: maya ? kFill : kInk, borderRadius: BorderRadius.only(topLeft: const Radius.circular(18), topRight: const Radius.circular(18), bottomLeft: Radius.circular(maya ? 4 : 18), bottomRight: Radius.circular(maya ? 18 : 4))),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(maya ? 'Maya' : 'You', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: maya ? kSoft : Colors.white70)),
              const SizedBox(height: 2),
              if (m.kind == 'voice' && m.mediaUrl != null) VoiceBubble(url: m.mediaUrl!, dark: !maya),
              if (m.kind == 'voice' && m.mediaUrl == null) Text('Voice note', style: TextStyle(fontSize: 16, color: maya ? kInk : Colors.white)),
              if (m.kind == 'image') Text('Photo', style: TextStyle(fontSize: 16, color: maya ? kInk : Colors.white)),
              if (m.text.isNotEmpty) Text(m.text, style: TextStyle(fontSize: 17, height: 1.3, color: maya ? kInk : Colors.white)),
              if (m.voiceError != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(m.voiceError!, style: const TextStyle(fontSize: 13, color: kAlert))),
            ],
          ),
        ),
      ),
    );
  }
}

/// A voice note: tap to hear it, tap again to pause.
class VoiceBubble extends StatefulWidget {
  final String url;
  final bool dark;
  const VoiceBubble({super.key, required this.url, this.dark = false});
  @override
  State<VoiceBubble> createState() => _VoiceBubbleState();
}

class _VoiceBubbleState extends State<VoiceBubble> {
  AudioPlayer? _p;
  bool _playing = false;
  String? _err;

  @override
  void dispose() {
    _p?.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    HapticFeedback.selectionClick();
    try {
      final p = _p ??= AudioPlayer()..onPlayerComplete.listen((_) => mounted ? setState(() => _playing = false) : null);
      if (_playing) {
        await p.pause();
        setState(() => _playing = false);
      } else {
        setState(() => _err = null);
        await p.play(UrlSource(widget.url));
        setState(() => _playing = true);
      }
    } catch (_) {
      if (mounted) setState(() => _err = 'This voice note could not be played.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final fg = widget.dark ? Colors.white : kInk;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Pressable(
        onTap: _toggle,
        semanticLabel: _playing ? 'Pause the voice note' : 'Play the voice note',
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 48,
          height: 48,
          decoration: BoxDecoration(shape: BoxShape.circle, color: widget.dark ? Colors.white24 : Colors.white, border: Border.all(color: widget.dark ? Colors.white30 : kLine)),
          child: Icon(_playing ? Icons.pause : Icons.play_arrow, color: fg),
        ),
      ),
      const SizedBox(width: 10),
      Flexible(child: Text(_err ?? (_playing ? 'Playing...' : 'Voice note'), style: TextStyle(fontSize: 16, color: _err != null ? kAlert : fg))),
    ]);
  }
}
