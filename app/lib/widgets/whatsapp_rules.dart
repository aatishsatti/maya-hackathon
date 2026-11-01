import 'package:flutter/material.dart';

import '../theme.dart';

/// Meta's WhatsApp rules in plain words, as the server states them (care.js WA_RULES). They are NOT on the page: a clear button opens them in a sheet, and the screens show
/// the button only while the family is doing something with WhatsApp.
class WhatsappRules extends StatelessWidget {
  final List<String> rules;
  const WhatsappRules({super.key, required this.rules});

  static List<String> from(dynamic json) => json is List ? [for (final r in json) '$r'] : const [];

  @override
  Widget build(BuildContext context) {
    if (rules.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          style: TextButton.styleFrom(minimumSize: const Size(48, 48), backgroundColor: kTrustSoft, foregroundColor: kTrust, padding: const EdgeInsets.symmetric(horizontal: 16), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
          onPressed: () => showModalBottomSheet<void>(
            context: context,
            isScrollControlled: true,
            showDragHandle: true,
            backgroundColor: Colors.white,
            shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
            builder: (c) => SafeArea(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('How WhatsApp reminders work', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.4, color: kInk)),
                  const SizedBox(height: 16),
                  for (final r in rules) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(r, style: const TextStyle(fontSize: 16, height: 1.4, color: kInk))),
                  const SizedBox(height: 8),
                  FilledButton(style: FilledButton.styleFrom(backgroundColor: kTrust, minimumSize: const Size(double.infinity, 48)), onPressed: () => Navigator.of(c).pop(), child: const Text('Close')),
                ]),
              ),
            ),
          ),
          icon: const Icon(Icons.info_outline, size: 20),
          label: const Text('How WhatsApp reminders work', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }
}
