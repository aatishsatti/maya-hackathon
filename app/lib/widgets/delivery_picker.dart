import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// The one delivery picker: Call / Text / Voice note. Used for reminders, welfare checks and messages.
/// clearable: tapping the chosen one again clears it (a reminder with no choice keeps the old default).
class DeliveryPicker extends StatelessWidget {
  final String? value;
  final ValueChanged<String?> onChanged;
  final bool clearable;
  final List<(String, String)> choices;
  const DeliveryPicker({super.key, required this.value, required this.onChanged, this.clearable = false, this.choices = options});

  static const options = [('call', 'Call'), ('text', 'Text'), ('voice', 'Voice note')];
  /// Where a reminder goes: WhatsApp (its own rules), the Maya app (none of them), or both.
  static const channels = [('whatsapp', 'WhatsApp'), ('app', 'Maya app'), ('both', 'Both')];

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(border: Border.all(color: kLine, width: 1.5), borderRadius: BorderRadius.circular(14)),
      clipBehavior: Clip.antiAlias,
      child: Row(
        children: [
          for (var i = 0; i < choices.length; i++) ...[
            if (i > 0) const SizedBox(width: 1.5, height: 48, child: ColoredBox(color: kLine)),
            Expanded(
              child: Semantics(
                button: true,
                selected: value == choices[i].$1,
                label: choices[i].$2,
                child: InkWell(
                  onTap: () {
                    HapticFeedback.selectionClick();
                    onChanged(clearable && value == choices[i].$1 ? null : choices[i].$1);
                  },
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    height: 48,
                    alignment: Alignment.center,
                    color: value == choices[i].$1 ? kInk : Colors.white,
                    child: Text(choices[i].$2, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: value == choices[i].$1 ? Colors.white : kInk)),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
