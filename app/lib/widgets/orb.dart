import 'package:flutter/material.dart';

import '../theme.dart';

enum OrbState { connecting, listening, thinking, speaking }

/// Maya's presence on the call screen: it breathes while she listens, shimmers while she thinks and swells while she speaks.
/// The colour change between states takes 250 ms; the slow breathing is ambient and never blocks anything.
class MayaOrb extends StatefulWidget {
  final OrbState state;
  final double size;
  const MayaOrb({super.key, required this.state, this.size = 200});

  @override
  State<MayaOrb> createState() => _MayaOrbState();
}

class _MayaOrbState extends State<MayaOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Color get _color {
    switch (widget.state) {
      case OrbState.connecting:
        return const Color(0xFF9AA5A1);
      case OrbState.listening:
        return kAccent;
      case OrbState.thinking:
        return const Color(0xFF7A6A2E);
      case OrbState.speaking:
        return const Color(0xFF1F6F5F);
    }
  }

  double get _depth => widget.state == OrbState.speaking ? 0.09 : widget.state == OrbState.thinking ? 0.05 : 0.04;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: switch (widget.state) {
        OrbState.connecting => 'Connecting to Maya',
        OrbState.listening => 'Maya is listening',
        OrbState.thinking => 'Maya is thinking',
        OrbState.speaking => 'Maya is speaking',
      },
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final s = 1 + _depth * Curves.easeInOut.transform(_c.value);
          return TweenAnimationBuilder<Color?>(
            tween: ColorTween(end: _color),
            duration: const Duration(milliseconds: 250),
            builder: (context, color, _) {
              final base = color ?? _color;
              return Transform.scale(
                scale: s,
                child: Container(
                  width: widget.size,
                  height: widget.size,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(colors: [base.withValues(alpha: 0.95), base.withValues(alpha: 0.72)], stops: const [0.2, 1]),
                    boxShadow: [BoxShadow(color: base.withValues(alpha: 0.22 + 0.12 * _c.value), blurRadius: 40, spreadRadius: 6)],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
