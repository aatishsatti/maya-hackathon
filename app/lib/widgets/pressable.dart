import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Real tap feedback: the control shrinks a touch under the finger (90 ms), gives a light haptic where the phone has one,
/// and never blocks the tap. Minimum 48 x 48.
class Pressable extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap;
  final bool haptic;
  final String? semanticLabel;
  final double pressedScale;
  const Pressable({super.key, required this.child, this.onTap, this.haptic = true, this.semanticLabel, this.pressedScale = 0.95});

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.semanticLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapCancel: enabled ? () => setState(() => _down = false) : null,
        onTapUp: enabled ? (_) => setState(() => _down = false) : null,
        onTap: enabled
            ? () {
                if (widget.haptic) HapticFeedback.lightImpact();
                widget.onTap!();
              }
            : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          child: AnimatedScale(
            scale: _down ? widget.pressedScale : 1,
            duration: const Duration(milliseconds: 90),
            curve: Curves.easeOut,
            child: widget.child,
          ),
        ),
      ),
    );
  }
}
