import 'package:flutter/material.dart';

import '../theme.dart';

/// Meta's WhatsApp rules in plain words, as the server states them (care.js WA_RULES), so the family reads them BEFORE picking WhatsApp for a reminder.
class WhatsappRules extends StatelessWidget {
  final List<String> rules;
  final bool open;
  const WhatsappRules({super.key, required this.rules, this.open = false});

  static List<String> from(dynamic json) => json is List ? [for (final r in json) '$r'] : const [];

  @override
  Widget build(BuildContext context) {
    if (rules.isEmpty) return const SizedBox.shrink();
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 8),
        initiallyExpanded: open,
        title: const Text('WhatsApp rules, in plain words', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        children: [
          for (final r in rules) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('•  ', style: TextStyle(color: kSoft)), Expanded(child: Text(r, style: const TextStyle(fontSize: 14, color: kSoft, height: 1.3)))])),
        ],
      ),
    );
  }
}
