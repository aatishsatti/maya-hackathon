import 'package:flutter/material.dart';

import '../theme.dart';

/// A small status label. The colour change when a status moves on takes 250 ms.
class Pill extends StatelessWidget {
  final String text;
  final Tone tone;
  const Pill(this.text, {super.key, this.tone = kTonePlain});

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: tone.bg, borderRadius: BorderRadius.circular(999), border: Border.all(color: tone.line)),
      child: Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: tone.ink)),
    );
  }
}

Tone toneForStatus(String status) {
  switch (status) {
    case 'answered':
      return kToneOk;
    case 'sent':
    case 'delivered':
    case 'read':
      return kToneInfo;
    case 'noreply':
    case 'paused':
      return kToneWait;
    case 'unreached':
    case 'missed':
    case 'failed':
      return kToneMiss;
    default:
      return kTonePlain;
  }
}
