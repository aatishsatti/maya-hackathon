import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/call_session.dart';
import '../theme.dart';
import '../widgets/orb.dart';
import '../widgets/pressable.dart';

/// The call. One screen, never scrolls: Maya's orb, the words on the line, Mute and End.
class CallScreen extends StatefulWidget {
  final CallSession session;
  const CallScreen({super.key, required this.session});
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  CallSession get s => widget.session;
  bool _popping = false;

  @override
  void initState() {
    super.initState();
    s.addListener(_changed);
    if (s.autoStart) s.start();
  }

  @override
  void dispose() {
    s.removeListener(_changed);
    s.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    if (s.ended && s.endMessage == null && !_popping) {
      _popping = true;
      Future<void>.delayed(const Duration(milliseconds: 700), () {
        if (mounted) Navigator.of(context).maybePop();
      });
    }
  }

  String get _status {
    if (s.ended) return s.endMessage == null ? 'The call has ended.' : 'The call has ended.';
    if (s.phase == CallPhase.connecting) return 'Calling Maya...';
    if (s.muted) return 'Your microphone is off';
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
    return PopScope(
      canPop: s.ended,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) s.hangUp();
      },
      child: Scaffold(
        body: SafeArea(
          child: LayoutBuilder(builder: (context, box) {
            final orbSize = (box.maxHeight * 0.30).clamp(96.0, 220.0);
            return Padding(
              padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
              child: Column(
                children: [
                  Text('Maya', style: Theme.of(context).textTheme.headlineMedium),
                  const SizedBox(height: 6),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 200),
                    child: Text(_status, key: ValueKey(_status), style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: kSoft)),
                  ),
                  Expanded(
                    child: Center(
                      child: s.ended ? Icon(Icons.call_end, size: orbSize * 0.5, color: kSoft) : MayaOrb(state: s.orb, size: orbSize),
                    ),
                  ),
                  SizedBox(
                    height: 96,
                    child: Center(
                      child: s.ended && s.endMessage != null
                          ? Text(s.endMessage!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, color: kAlert, height: 1.3))
                          : AnimatedSwitcher(
                              duration: const Duration(milliseconds: 180),
                              child: Text(s.caption, key: ValueKey(s.caption), textAlign: TextAlign.center, maxLines: 4, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodyLarge),
                            ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (s.ended && s.endMessage != null)
                    FilledButton(onPressed: () => Navigator.of(context).maybePop(), child: const Text('Close'))
                  else
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        _RoundButton(
                          label: s.muted ? 'Unmute' : 'Mute',
                          icon: s.muted ? Icons.mic_off : Icons.mic,
                          background: s.muted ? kInk : Colors.white,
                          foreground: s.muted ? Colors.white : kInk,
                          bordered: true,
                          onTap: s.ended ? null : () => s.setMuted(!s.muted),
                        ),
                        _RoundButton(label: 'End call', icon: Icons.call_end, background: kAlert, foreground: Colors.white, size: 72, onTap: s.ended ? null : () {
                          HapticFeedback.mediumImpact();
                          s.hangUp();
                        }),
                      ],
                    ),
                ],
              ),
            );
          }),
        ),
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color background, foreground;
  final bool bordered;
  final double size;
  final VoidCallback? onTap;
  const _RoundButton({required this.label, required this.icon, required this.background, required this.foreground, required this.onTap, this.bordered = false, this.size = 64});

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Pressable(
        onTap: onTap,
        semanticLabel: label,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          width: size,
          height: size,
          decoration: BoxDecoration(color: background, shape: BoxShape.circle, border: bordered ? Border.all(color: kLine, width: 1.5) : null),
          child: Icon(icon, color: foreground, size: size * 0.45),
        ),
      ),
      const SizedBox(height: 6),
      Text(label, style: const TextStyle(fontSize: 14, color: kSoft)),
    ]);
  }
}
