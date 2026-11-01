import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/audio_route.dart';
import '../services/call_log.dart';
import '../services/call_session.dart';
import '../widgets/orb.dart';
import '../widgets/pressable.dart';

// The call page: ONE page. A soft blurred, see-through backdrop fills the whole screen; on it, from the top: the status and the words (Maya's line large, yours smaller beneath),
// the particle orb in the middle, and at the bottom the only controls: Mute on the left, Speaker on the right, End call as a red pill centred under them on the orb's axis.
// No cards, no navigation. System font.
const Color _quiet = Color(0xFFFFFFFF);
const Color _end = Color(0xFFC0392B);
const Color _textOnCard = Colors.white;

/// The call. One screen, never scrolls.
class CallScreen extends StatefulWidget {
  final CallSession session;
  const CallScreen({super.key, required this.session});
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  CallSession get s => widget.session;
  bool _popping = false;
  String _maya = '', _you = '', _seenCaption = '';
  DateTime? _youAt;
  Timer? _youTimer;

  @override
  void initState() {
    super.initState();
    s.addListener(_changed);
    _read();
    if (s.autoStart) s.start();
  }

  @override
  void dispose() {
    _youTimer?.cancel();
    s.removeListener(_changed);
    s.dispose();
    super.dispose();
  }

  // The session keeps one caption at a time ("Maya: ..." or "You: ..."); the page keeps both lines so they can sit one above the other.
  void _read() {
    final c = s.caption;
    if (c == _seenCaption) return;
    _seenCaption = c;
    if (c.startsWith('Maya: ')) {
      _maya = c.substring(6);
    } else if (c.startsWith('You: ')) {
      _you = c.substring(5);
      _youAt = DateTime.now();
      _youTimer?.cancel();
      _youTimer = Timer(const Duration(milliseconds: 1400), () {
        if (mounted) setState(() {});   // their words stopped arriving: the orb goes back to its state
      });
    }
  }

  bool get _youSpeaking => _youAt != null && DateTime.now().difference(_youAt!) < const Duration(milliseconds: 1400) && !s.muted && s.orb != OrbState.speaking;

  void _changed() {
    if (!mounted) return;
    _read();
    setState(() {});
    if (s.ended && s.endMessage == null && !_popping) {
      _popping = true;
      Future<void>.delayed(const Duration(milliseconds: 700), () {
        if (mounted) Navigator.of(context).maybePop();
      });
    }
  }

  String get _status {
    if (s.ended) return 'The call has ended.';
    if (s.reconnecting) return 'Reconnecting...';
    if (s.phase == CallPhase.connecting) return 'Calling Maya...';
    if (s.muted) return 'Your microphone is off';
    if (_youSpeaking) return 'Maya is listening';
    switch (s.orb) {
      case OrbState.connecting:
        return 'Calling Maya...';
      case OrbState.listening:
        return 'Maya is listening';
      case OrbState.thinking:
        return 'Maya is thinking';
      case OrbState.speaking:
        return 'Maya is speaking';
    }
  }

  @override
  Widget build(BuildContext context) {
    final failed = s.ended && s.endMessage != null;
    return PopScope(
      canPop: s.ended,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) s.hangUp();
      },
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Stack(fit: StackFit.expand, children: [
          const CallBackdrop(),
          SafeArea(
            child: Column(children: [
              // the words, at the top
              Expanded(flex: 5, child: _Words(status: _status, maya: failed ? s.endMessage! : _maya, you: failed ? '' : _you)),
              // the orb, in the middle of the page
              Expanded(
                flex: 6,
                child: LayoutBuilder(builder: (context, box) {
                  final size = math.min(box.maxWidth * 0.8, box.maxHeight);
                  return Center(child: MayaOrb(state: s.orb, size: size, youSpeaking: _youSpeaking));
                }),
              ),
              // the controls, at the bottom, on the same page
              Padding(padding: const EdgeInsets.fromLTRB(24, 4, 24, 20), child: _Controls(s: s, failed: failed)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Maya's line large where the eye lands, yours smaller beneath it, a small status line above. The size follows the room, so four lines of hers and two of yours always fit.
class _Words extends StatelessWidget {
  final String status, maya, you;
  const _Words({required this.status, required this.maya, required this.you});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 8, 28, 0),
      child: LayoutBuilder(builder: (context, tb) {
        final big = (tb.maxHeight / 7.4).clamp(15.0, 34.0);
        return Align(
          alignment: Alignment.bottomLeft,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              layoutBuilder: _leftStack,
              child: Text(status, key: ValueKey(status), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: (big * 0.5).clamp(12.0, 18.0), color: _textOnCard.withValues(alpha: 0.84), fontWeight: FontWeight.w400)),
            ),
            SizedBox(height: big * 0.28),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              layoutBuilder: _leftStack,
              child: Text(maya, key: ValueKey(maya), maxLines: 4, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: big, height: 1.1, color: _textOnCard, fontWeight: FontWeight.w300, letterSpacing: -0.6)),
            ),
            if (you.isNotEmpty) ...[
              SizedBox(height: big * 0.36),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                layoutBuilder: _leftStack,
                child: Text(you, key: ValueKey(you), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: (big * 0.56).clamp(13.0, 20.0), height: 1.25, color: _textOnCard.withValues(alpha: 0.76), fontWeight: FontWeight.w400)),
              ),
            ],
          ]),
        );
      }),
    );
  }
}

// Cross-fading lines stay on the left edge (the default stack would centre them).
Widget _leftStack(Widget? current, List<Widget> previous) => Stack(alignment: Alignment.topLeft, children: [...previous, ?current]);

/// The see-through backdrop of the call page and of the incoming-call page: slate above, warm tan below, softly blurred. Still, so the page stays calm. It fills the whole screen.
class CallBackdrop extends StatelessWidget {
  const CallBackdrop({super.key});
  @override
  Widget build(BuildContext context) {
    return Stack(fit: StackFit.expand, children: [
      const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF5E6F7A), Color(0xFF7D8D93), Color(0xFFB4A794), Color(0xFFCDBBA6)], stops: [0, 0.45, 0.82, 1]))),
      ImageFiltered(
        imageFilter: ImageFilter.blur(sigmaX: 54, sigmaY: 54, tileMode: TileMode.decal),
        child: Stack(children: const [
          Positioned(right: -90, bottom: 120, width: 300, height: 260, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0x889C7352)))),
          Positioned(left: -80, bottom: -60, width: 300, height: 260, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0x88EADBC8)))),
          Positioned(left: -60, top: -40, width: 280, height: 240, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0x80465A68)))),
          Positioned(right: -60, top: 80, width: 220, height: 200, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0x4D3E7A8C)))),
        ]),
      ),
    ]);
  }
}

/// The controls, floating on the page itself (no card): Mute on the left, Speaker on the right, End call a red pill centred beneath on the orb's axis.
class _Controls extends StatelessWidget {
  final CallSession s;
  final bool failed;
  const _Controls({required this.s, required this.failed});

  @override
  Widget build(BuildContext context) {
    if (failed) {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        FilledButton(style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: const Color(0xFF26231F), minimumSize: const Size(220, 56)), onPressed: () => Navigator.of(context).maybePop(), child: const Text('Close')),
        TextButton(onPressed: () => showCallLog(context, headline: s.endDetail), child: const Text('Details', style: TextStyle(color: Colors.white70))),
      ]);
    }
    return Column(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(
        height: 96,
        child: Stack(children: [
          Align(
            alignment: const Alignment(-0.54, 0),
            child: _DeckButton(label: s.muted ? 'Unmute' : 'Mute', icon: s.muted ? Icons.mic_off : Icons.mic, on: s.muted, onTap: s.ended ? null : () => s.setMuted(!s.muted)),
          ),
          if (AudioRoute.android)
            Align(
              alignment: const Alignment(0.54, 0),
              child: _DeckButton(label: s.speakerOn ? 'Speaker' : 'Earpiece', icon: s.speakerOn ? Icons.volume_up : Icons.hearing, on: s.speakerOn, onTap: s.ended ? null : () => s.setSpeaker(!s.speakerOn)),
            ),
        ]),
      ),
      const SizedBox(height: 18),
      _EndPill(onTap: s.ended
          ? null
          : () {
              HapticFeedback.mediumImpact();
              s.hangUp();
            }),
    ]);
  }
}

class _DeckButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool on;
  final VoidCallback? onTap;
  const _DeckButton({required this.label, required this.icon, required this.on, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Pressable(
        onTap: onTap,
        semanticLabel: label,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          width: 68,
          height: 68,
          decoration: BoxDecoration(shape: BoxShape.circle, color: on ? Colors.white : Colors.white.withValues(alpha: 0.22), border: Border.all(color: Colors.white.withValues(alpha: on ? 0 : 0.35))),
          child: Icon(icon, size: 28, color: on ? const Color(0xFF26231F) : Colors.white),
        ),
      ),
      const SizedBox(height: 8),
      FittedBox(fit: BoxFit.scaleDown, child: Text(label, style: TextStyle(fontSize: 14, color: _quiet.withValues(alpha: 0.9), fontWeight: FontWeight.w500))),
    ]);
  }
}

/// End call: a wide red pill with the words and the phone, centred under the other two controls. Big, plain and well apart from everything else.
class _EndPill extends StatelessWidget {
  final VoidCallback? onTap;
  const _EndPill({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      semanticLabel: 'End call',
      pressedScale: 0.97,
      child: Container(
        constraints: const BoxConstraints(minWidth: 232, minHeight: 64),
        padding: const EdgeInsets.symmetric(horizontal: 30),
        decoration: BoxDecoration(color: onTap == null ? _end.withValues(alpha: 0.5) : _end, borderRadius: BorderRadius.circular(40)),
        child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: const [
          Icon(Icons.call_end, color: Colors.white, size: 26),
          SizedBox(width: 12),
          Flexible(child: FittedBox(fit: BoxFit.scaleDown, child: Text('End call', style: TextStyle(fontSize: 20, color: Colors.white, fontWeight: FontWeight.w600, letterSpacing: -0.1)))),
        ]),
      ),
    );
  }
}

/// The facts of a call, with times: how it ended and every step before it. For finding out why a call dropped.
void showCallLog(BuildContext context, {String headline = '', int lines = 60}) {
  showDialog<void>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('Call details'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: SelectableText(
            '${headline.isEmpty ? '' : 'How it ended: $headline\n\n'}${CallLog.last(lines).isEmpty ? 'No call has been made on this phone yet.' : CallLog.last(lines).join('\n')}',
            style: const TextStyle(fontSize: 12, fontFamily: 'monospace', height: 1.35),
          ),
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Close'))],
    ),
  );
}
