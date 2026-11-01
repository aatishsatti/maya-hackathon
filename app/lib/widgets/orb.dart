import 'dart:math' as math;

import 'package:flutter/material.dart';

enum OrbState { connecting, listening, thinking, speaking }

/// Maya's presence on the call page: a quiet translucent disc with a waveform that lives INSIDE it.
/// Nothing is drawn outside the disc (no glow, no rings). The waveform moves for both voices:
///   Maya speaking  - white bars, full and lively
///   you speaking   - warm bars, a different rhythm (they pulse from the middle outward), so the two voices are told apart at a glance
///   listening      - the bars rest, breathing very slowly
///   thinking       - a soft light travels across the bars
///   connecting     - a row of still dots
/// Changes between these take 300 ms. The motion is ambient and never blocks a tap.
class MayaOrb extends StatefulWidget {
  final OrbState state;
  final double size;

  /// The person is speaking right now (their words are arriving). Shown inside the disc, on top of the state.
  final bool youSpeaking;
  const MayaOrb({super.key, required this.state, this.size = 120, this.youSpeaking = false});

  @override
  State<MayaOrb> createState() => _MayaOrbState();
}

class _MayaOrbState extends State<MayaOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  // how tall the bars grow (0 rests, 1 is the full height) and which voice they show
  double get _amp {
    if (widget.youSpeaking) return 0.72;
    switch (widget.state) {
      case OrbState.speaking:
        return 1.0;
      case OrbState.thinking:
        return 0.26;
      case OrbState.listening:
        return 0.1;
      case OrbState.connecting:
        return 0.0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.youSpeaking
        ? 'You are speaking'
        : switch (widget.state) {
            OrbState.connecting => 'Connecting to Maya',
            OrbState.listening => 'Maya is listening',
            OrbState.thinking => 'Maya is thinking',
            OrbState.speaking => 'Maya is speaking',
          };
    return Semantics(
      label: label,
      child: TweenAnimationBuilder<double>(
        tween: Tween(end: _amp),
        duration: const Duration(milliseconds: 300),
        builder: (context, amp, _) => TweenAnimationBuilder<double>(
          tween: Tween(end: widget.youSpeaking ? 1.0 : 0.0),
          duration: const Duration(milliseconds: 300),
          builder: (context, you, _) => AnimatedBuilder(
            animation: _c,
            builder: (context, _) => SizedBox(
              width: widget.size,
              height: widget.size,
              child: CustomPaint(painter: _OrbPainter(t: _c.value, amp: amp, you: you, thinking: widget.state == OrbState.thinking && !widget.youSpeaking, connecting: widget.state == OrbState.connecting && !widget.youSpeaking)),
            ),
          ),
        ),
      ),
    );
  }
}

class _OrbPainter extends CustomPainter {
  final double t, amp, you;
  final bool thinking, connecting;
  _OrbPainter({required this.t, required this.amp, required this.you, required this.thinking, required this.connecting});

  static const int bars = 9;
  static const Color maya = Color(0xFFFFFFFF);
  static const Color warm = Color(0xFFF6DDBE);

  @override
  void paint(Canvas canvas, Size size) {
    final r = size.shortestSide / 2;
    final c = Offset(size.width / 2, size.height / 2);
    // the disc: translucent and a little darker than the page behind it, so white reads on any part of the backdrop; its edge is a hairline, nothing glows
    canvas.drawCircle(c, r, Paint()..color = const Color(0x3D2A2420));
    canvas.drawCircle(c, r - 0.5, Paint()..style = PaintingStyle.stroke..strokeWidth = 1..color = const Color(0x33FFFFFF));
    canvas.save();
    canvas.clipPath(Path()..addOval(Rect.fromCircle(center: c, radius: r - 1)));
    final span = r * 1.12; // the bars sit well inside the disc
    final bw = r * 0.15;
    final step = span / (bars - 1);
    final x0 = c.dx - span / 2;
    for (var i = 0; i < bars; i++) {
      final u = (i - (bars - 1) / 2) / ((bars - 1) / 2); // -1 .. 1 across the bars
      final env = 0.35 + 0.65 * math.cos(u * math.pi / 2).abs(); // taller in the middle
      // Maya: bars bob independently. You: a wave that leaves the middle and runs outward.
      final mayaWave = 0.5 + 0.5 * math.sin(2 * math.pi * (t * 3 + i * 0.37)) * math.sin(2 * math.pi * (t * 2 - i * 0.21) + 1.3);
      final youWave = 0.5 + 0.5 * math.sin(2 * math.pi * (t * 2 - u.abs() * 0.9));
      final live = (1 - you) * mayaWave + you * youWave;
      final breathe = 0.5 + 0.5 * math.sin(2 * math.pi * (t * 1 + i * 0.05));
      double h;
      var alpha = 0.95;
      if (connecting) {
        h = bw; // still dots
        alpha = 0.45 + 0.25 * math.sin(2 * math.pi * (t * 2 - i * 0.12));
      } else if (thinking) {
        final pos = ((t * 1.0) % 1.0) * (bars + 4) - 2; // a soft light travels across
        final d = (i - pos).abs();
        h = bw + r * 0.5 * env * (0.25 + 0.75 * breathe) * amp * 3;
        alpha = 0.5 + 0.45 * math.exp(-d * d / 2.2);
      } else {
        h = bw + r * 1.15 * env * (0.12 + 0.88 * live) * amp + (amp < 0.2 ? r * 0.12 * env * breathe : 0);
      }
      final color = Color.lerp(maya, warm, you)!.withValues(alpha: alpha.clamp(0.0, 1.0));
      final rect = RRect.fromRectAndRadius(Rect.fromCenter(center: Offset(x0 + i * step, c.dy), width: bw, height: math.min(h, r * 1.5)), Radius.circular(bw / 2));
      canvas.drawRRect(rect, Paint()..color = color);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_OrbPainter old) => old.t != t || old.amp != amp || old.you != you || old.thinking != thinking || old.connecting != connecting;
}
