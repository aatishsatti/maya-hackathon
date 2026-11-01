import 'package:flutter/material.dart';

import '../senior/call_screen.dart' show CallBackdrop;
import '../services/api.dart';
import '../widgets/pressable.dart';

/// Maya is ringing the FAMILY: "Maya is calling" large, one fixed topic-only line (who has not responded, never what they said), Decline (red) on the LEFT and Accept (green) on the RIGHT,
/// on the same see-through page as the senior's incoming call. The answer is sent to the server; "Seen" is on the dashboard afterwards.
class FamilyRingScreen extends StatelessWidget {
  final String text;
  final VoidCallback onAccept, onDecline;
  const FamilyRingScreen({super.key, required this.text, required this.onAccept, required this.onDecline});

  Widget _action(String label, Color color, IconData icon, VoidCallback onTap) => Column(mainAxisSize: MainAxisSize.min, children: [
        Pressable(onTap: onTap, semanticLabel: label, child: Container(width: 92, height: 92, decoration: BoxDecoration(shape: BoxShape.circle, color: color), child: Icon(icon, color: Colors.white, size: 40))),
        const SizedBox(height: 12),
        Text(label, style: const TextStyle(fontSize: 18, color: Colors.white, fontWeight: FontWeight.w600)),
      ]);

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Stack(fit: StackFit.expand, children: [
          const CallBackdrop(),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(28, 24, 28, 40),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Spacer(flex: 3),
                const Text('Maya is calling', style: TextStyle(fontSize: 40, height: 1.05, color: Colors.white, fontWeight: FontWeight.w300, letterSpacing: -1)),
                const SizedBox(height: 14),
                Text(text, style: TextStyle(fontSize: 20, height: 1.35, color: Colors.white.withValues(alpha: 0.9))),
                const Spacer(flex: 5),
                Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _action('Decline', const Color(0xFFC0392B), Icons.call_end, onDecline),
                  _action('Accept', const Color(0xFF2E9C86), Icons.call, onAccept),
                ]),
              ]),
            ),
          ),
        ]),
      );
}

/// Shows the ring for one episode of one person and sends the family's answer. Returns once it is answered.
Future<void> showFamilyRing(BuildContext context, {required String seniorId, required String episodeId, required String text}) async {
  Future<void> answer(String act) async {
    try {
      await Api.postJson('/api/care/$seniorId/escalation/$episodeId/$act');
    } on ApiError {
      // the ring ends by itself on the server
    }
    if (context.mounted) Navigator.of(context).pop();
  }

  await Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => FamilyRingScreen(text: text, onAccept: () => answer('accepted'), onDecline: () => answer('declined'))));
}
