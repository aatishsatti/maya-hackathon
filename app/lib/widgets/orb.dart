import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show PointMode;

import 'package:flutter/material.dart';

enum OrbState { connecting, listening, thinking, speaking }

/// Maya's presence on the call page: a sphere of fine particles in trust blue and teal, turning slowly.
/// EVERY particle moves, all the time, each at its own rhythm. How far and how fast they move follows the SOUND itself, frame by frame (the loudness of the senior's voice and of Maya's, read
/// live), on top of a resting level set by who is speaking:
///   Maya speaking  - the whole surface swells and ripples
///   you speaking   - the surface answers just as strongly (a touch smaller)
///   thinking       - a steady shimmer
///   listening      - a quiet breathing (the particles still stir, so the page is never dead)
///   connecting     - the faintest stir
/// Nothing is drawn outside the particles (no glow, no rings). Changes between these take 300 ms.
class MayaOrb extends StatefulWidget {
  final OrbState state;
  final double size;

  /// The person is speaking right now (their words are arriving).
  final bool youSpeaking;

  /// The loudness right now, 0 to 1, read on every frame (both voices). Null: the resting levels only.
  final double Function()? level;
  const MayaOrb({super.key, required this.state, this.size = 240, this.youSpeaking = false, this.level});

  @override
  State<MayaOrb> createState() => _MayaOrbState();
}

class _MayaOrbState extends State<MayaOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 120))..repeat();
  late final _Cloud _cloud = _Cloud(3400);
  DateTime _last = DateTime.now();
  double _phase = 0; // runs faster when it is louder, so the ripples keep pace with the voice
  double _eff = 0.2; // the smoothed amount of movement: quick to rise, slower to settle

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  // the resting movement (0 is still, 1 is the full swell) for who is speaking; the live sound adds to it
  double get _rest {
    if (widget.youSpeaking) return 0.34;
    switch (widget.state) {
      case OrbState.speaking:
        return 0.30;
      case OrbState.thinking:
        return 0.30;
      case OrbState.listening:
        return 0.16;
      case OrbState.connecting:
        return 0.10;
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
      child: RepaintBoundary(
        child: SizedBox(
          width: widget.size,
          height: widget.size,
          child: AnimatedBuilder(
            animation: _c,
            builder: (context, _) {
              // one step per frame: the live loudness is read now, smoothed (up quickly, down gently), and moves the whole cloud
              final now = DateTime.now();
              final dt = math.min(0.1, now.difference(_last).inMicroseconds / 1e6);
              _last = now;
              final heard = widget.level == null ? 0.0 : widget.level!().clamp(0.0, 1.0);
              final target = math.min(1.0, _rest + heard * 0.85);
              _eff += (target - _eff) * (target > _eff ? 0.55 : 0.14);
              _phase += dt * (1.0 + 2.4 * _eff);
              return CustomPaint(painter: _OrbPainter(_cloud, _phase, _eff, widget.youSpeaking));
            },
          ),
        ),
      ),
    );
  }
}

class _Cloud {
  final int n;
  late final Float32List x, y, z, ph1, ph2, f1, f2;
  late final Uint8List tint;
  _Cloud(this.n) {
    x = Float32List(n);
    y = Float32List(n);
    z = Float32List(n);
    ph1 = Float32List(n);
    ph2 = Float32List(n);
    f1 = Float32List(n);
    f2 = Float32List(n);
    tint = Uint8List(n);
    final rnd = math.Random(7);
    final golden = math.pi * (3 - math.sqrt(5));
    for (var i = 0; i < n; i++) {
      final yy = 1 - (i / (n - 1)) * 2; // a point per band, from the top to the bottom
      final rr = math.sqrt(1 - yy * yy);
      final th = golden * i;
      x[i] = math.cos(th) * rr;
      y[i] = yy;
      z[i] = math.sin(th) * rr;
      ph1[i] = rnd.nextDouble() * math.pi * 2;
      ph2[i] = rnd.nextDouble() * math.pi * 2;
      f1[i] = 0.9 + rnd.nextDouble() * 1.9; // every particle has its own rhythm
      f2[i] = 1.7 + rnd.nextDouble() * 2.6;
      tint[i] = rnd.nextInt(256);
    }
  }
}

class _OrbPainter extends CustomPainter {
  final _Cloud cloud;
  final double t, level;
  final bool you;
  _OrbPainter(this.cloud, this.t, this.level, this.you);

  // teal at the top, through cyan-blue, to trust blue below (cool only)
  static const List<Color> ramp = [Color(0xFF2BD1BE), Color(0xFF35B6E8), Color(0xFF4A8BEF), Color(0xFF5A6FE6)];
  // depth: back (dim), middle, front (bright)
  static const List<double> alphas = [0.34, 0.68, 0.96];
  static const List<double> widths = [1.2, 1.7, 2.2];
  static final List<Float32List> _buf = List.generate(12, (_) => Float32List(0));

  @override
  void paint(Canvas canvas, Size size) {
    final n = cloud.n;
    final c = Offset(size.width / 2, size.height / 2);
    final base = size.shortestSide / 2 * 0.80 * (1 + 0.035 * math.sin(t * 0.9) + 0.09 * level); // the whole body breathes, and swells with the sound; room is left for the particles to rise
    if (_buf[0].length != n * 2) {
      for (var i = 0; i < 12; i++) {
        _buf[i] = Float32List(n * 2);
      }
    }
    final counts = List<int>.filled(12, 0);
    final ay = t * 0.16, ax = 0.42; // slow turn, a little tilt
    final cy = math.cos(ay), sy = math.sin(ay), cx = math.cos(ax), sx = math.sin(ax);
    final swell = 0.03 + 0.20 * level; // how far a particle may leave the surface: the louder, the further
    for (var i = 0; i < n; i++) {
      // every particle moves, all the time: slow waves run over the whole surface (so neighbours move together, as one body), and each particle adds a small rhythm of its own
      final x0 = cloud.x[i], y0 = cloud.y[i], z0 = cloud.z[i];
      final wave = 0.5 * math.sin(6.4 * x0 + 4.6 * y0 + t * (1.6 + 1.4 * level)) + 0.35 * math.sin(5.6 * y0 - 6.8 * z0 + t * (2.2 + 1.2 * level) + 1.0) + 0.25 * math.sin(7.0 * z0 + 4.2 * x0 - t * (1.4 + 1.6 * level) + 2.1);
      final own = math.sin(cloud.f1[i] * t * (you ? 1.3 : 1.0) + cloud.ph1[i]);
      final w = 0.72 * wave + 0.28 * own; // -1 .. 1
      final r = 1 + swell * (0.35 + 0.65 * w.abs()) * (w >= 0 ? 1.0 : -0.5);
      final px = x0 * r, py = y0 * r, pz = z0 * r;
      // turn about the vertical axis, then tilt
      final rx = px * cy + pz * sy;
      final rz = -px * sy + pz * cy;
      final ry = py * cx - rz * sx;
      final rz2 = py * sx + rz * cx;
      final depth = rz2 < -0.25 ? 0 : (rz2 < 0.35 ? 1 : 2);
      final k = ((ry * 0.55 + rx * 0.25) * 0.5 + 0.5 + (cloud.tint[i] - 128) / 1400).clamp(0.0, 0.999);
      final bucket = (k * 4).floor() * 3 + depth;
      final at = counts[bucket];
      _buf[bucket][at] = c.dx + rx * base;
      _buf[bucket][at + 1] = c.dy + ry * base;
      counts[bucket] = at + 2;
    }
    for (var b = 0; b < 12; b++) {
      if (counts[b] == 0) continue;
      final depth = b % 3;
      final paint = Paint()
        ..color = ramp[b ~/ 3].withValues(alpha: alphas[depth])
        ..strokeWidth = widths[depth] * (size.shortestSide / 240).clamp(0.6, 1.5)
        ..strokeCap = StrokeCap.round;
      canvas.drawRawPoints(PointMode.points, Float32List.sublistView(_buf[b], 0, counts[b]), paint);
    }
  }

  @override
  bool shouldRepaint(_OrbPainter old) => true;
}
