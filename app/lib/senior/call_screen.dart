import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/audio_route.dart';
import '../services/call_log.dart';
import '../services/call_session.dart';
import '../widgets/orb.dart';
import '../widgets/pressable.dart';

// The call page: a calm native screen in two separate pieces.
//   1. The talking area, a large rounded card on a soft blurred warm backdrop. Maya's line is large, yours is smaller just beneath it. The orb sits low and centred.
//   2. The control deck, a shadowed card of its own, with the only controls on the page: Mute on the left, Speaker on the right, and End call as a red pill centred under them on the orb's axis.
// System font, muted neutrals. No navigation, nothing else.
const Color _page = Color(0xFFEFECE8);
const Color _deck = Color(0xFFFBFAF8);
const Color _ink = Color(0xFF26231F);
const Color _quiet = Color(0xFF6E6860);
const Color _button = Color(0xFFEAE6E0);
const Color _end = Color(0xFFB83A2E);
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
        backgroundColor: _page,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Column(children: [
              Expanded(child: _TalkingArea(status: _status, maya: failed ? s.endMessage! : _maya, you: failed ? '' : _you, orb: s.orb, youSpeaking: _youSpeaking, ended: s.ended)),
              const SizedBox(height: 14),
              _Deck(s: s, failed: failed),
            ]),
          ),
        ),
      ),
    );
  }
}

/// The talking area: a soft blurred warm backdrop, Maya's line large where the eye lands, yours smaller beneath it, the orb low and centred.
class _TalkingArea extends StatelessWidget {
  final String status, maya, you;
  final OrbState orb;
  final bool youSpeaking, ended;
  const _TalkingArea({required this.status, required this.maya, required this.you, required this.orb, required this.youSpeaking, required this.ended});

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(38),
      child: Stack(fit: StackFit.expand, children: [
        const _WarmBackdrop(),
        LayoutBuilder(builder: (context, box) {
          final orbSize = (box.maxHeight * 0.24).clamp(56.0, 124.0);
          return Padding(
            padding: const EdgeInsets.fromLTRB(26, 0, 26, 22),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // The text block takes all the room above the orb. Its size follows that room, so four lines of Maya's and two of yours always fit and are never cut.
              Expanded(
                child: LayoutBuilder(builder: (context, tb) {
                  final big = (tb.maxHeight / 7.4).clamp(15.0, 36.0);
                  return Align(
                    alignment: const Alignment(-1, 0.12),
                    child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                      // the small line, then Maya's line large, then yours smaller: the place a first line is read
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 220),
                        layoutBuilder: _leftStack,
                        child: Text(status, key: ValueKey(status), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: (big * 0.5).clamp(12.0, 18.0), color: _textOnCard.withValues(alpha: 0.82), fontWeight: FontWeight.w400)),
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
                          child: Text(you, key: ValueKey(you), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: (big * 0.56).clamp(13.0, 21.0), height: 1.25, color: _textOnCard.withValues(alpha: 0.74), fontWeight: FontWeight.w400)),
                        ),
                      ],
                    ]),
                  );
                }),
              ),
              const SizedBox(height: 14),
              // the orb: centred on the page's axis, animation only inside it
              Center(child: MayaOrb(state: orb, size: orbSize, youSpeaking: youSpeaking)),
            ]),
          );
        }),
      ]),
    );
  }
}

// Cross-fading lines stay on the left edge (the default stack would centre them).
Widget _leftStack(Widget? current, List<Widget> previous) => Stack(alignment: Alignment.topLeft, children: [...previous, ?current]);

/// A soft, blurred backdrop: slate above, warm tan below. Still (it never moves), so the page stays calm.
class _WarmBackdrop extends StatelessWidget {
  const _WarmBackdrop();
  @override
  Widget build(BuildContext context) {
    return Stack(fit: StackFit.expand, children: [
      const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF66767F), Color(0xFF8B979A), Color(0xFFBFAF9C), Color(0xFFD3C3B0)], stops: [0, 0.45, 0.8, 1]))),
      ImageFiltered(
        imageFilter: ImageFilter.blur(sigmaX: 46, sigmaY: 46, tileMode: TileMode.decal),
        child: Stack(children: const [
          Positioned(right: -70, bottom: 60, width: 260, height: 220, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0xAA9C7352)))),
          Positioned(left: -60, bottom: -40, width: 240, height: 200, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0xAAEADBC8)))),
          Positioned(left: -50, top: -30, width: 240, height: 200, child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, color: Color(0x88566570)))),
        ]),
      ),
    ]);
  }
}

/// The control deck: its own shadowed card. Mute and Speaker in one row at the two outer positions, End call a red pill centred below on the orb's axis.
class _Deck extends StatelessWidget {
  final CallSession s;
  final bool failed;
  const _Deck({required this.s, required this.failed});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
      decoration: BoxDecoration(
        color: _deck,
        borderRadius: BorderRadius.circular(32),
        boxShadow: const [BoxShadow(color: Color(0x24000000), blurRadius: 34, offset: Offset(0, 12)), BoxShadow(color: Color(0x14000000), blurRadius: 5, offset: Offset(0, 1))],
      ),
      child: failed
          ? Column(mainAxisSize: MainAxisSize.min, children: [
              FilledButton(onPressed: () => Navigator.of(context).maybePop(), child: const Text('Close')),
              TextButton(onPressed: () => showCallLog(context, headline: s.endDetail), child: const Text('Details', style: TextStyle(color: _quiet))),
            ])
          : Column(mainAxisSize: MainAxisSize.min, children: [
              // Mute where "type" sat, Speaker where "transcribe" sat; the middle is left open for the orb's axis
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
              const SizedBox(height: 20),
              _EndPill(onTap: s.ended
                  ? null
                  : () {
                      HapticFeedback.mediumImpact();
                      s.hangUp();
                    }),
            ]),
    );
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
          decoration: BoxDecoration(shape: BoxShape.circle, color: on ? _ink : _button),
          child: Icon(icon, size: 28, color: on ? Colors.white : _ink),
        ),
      ),
      const SizedBox(height: 8),
      FittedBox(fit: BoxFit.scaleDown, child: Text(label, style: const TextStyle(fontSize: 14, color: _quiet, fontWeight: FontWeight.w500))),
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
