import 'package:flutter/material.dart';

import '../services/api.dart';
import 'common.dart' show act;
import '../theme.dart';
import '../widgets/delivery_picker.dart';
import 'family_data.dart';

/// Send a message: to the Maya app on their phone, or on WhatsApp as a call, a text or a voice note.
class MessageTab extends StatefulWidget {
  final FamilyData data;
  const MessageTab({super.key, required this.data});
  @override
  State<MessageTab> createState() => _MessageTabState();
}

class _MessageTabState extends State<MessageTab> {
  final _text = TextEditingController();
  bool _inApp = true;
  String _via = 'text';
  bool _busy = false;
  String? _result;

  FamilyData get d => widget.data;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final t = _text.text.trim();
    if (t.isEmpty) {
      setState(() => _result = 'Please type a message first. Nothing was sent.');
      return;
    }
    setState(() {
      _busy = true;
      _result = null;
    });
    try {
      String out;
      if (_inApp) {
        await Api.postJson('/api/care/${d.profileId}/messages', {'text': t});
        out = 'Sent to the Maya app on their phone. It shows there while the app is open.';
      } else {
        final r = await Api.postJson('/api/whatsapp/${d.profileId}/send', {'kind': _via, 'text': t, 'useTemplate': false});
        if (_via == 'call') {
          out = r is Map && r['placed'] == false ? 'Nothing rang. ${callLimitText(r['calls'] is Map ? Map<String, dynamic>.from(r['calls'] as Map) : null)} It was sent as a text instead.' : 'WhatsApp took the call: their phone should ring now.';
        } else {
          out = 'Sent as a ${_via == 'voice' ? 'voice note' : 'text'} on WhatsApp.';
        }
      }
      if (mounted) {
        setState(() {
          _result = out;
          _text.clear();
        });
      }
      d.refresh(quiet: true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _result = '${e.message} Nothing was sent.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Send a message to ${d.name}', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 10),
        SegmentedButton<bool>(
          segments: const [ButtonSegment(value: true, label: Text('In the Maya app')), ButtonSegment(value: false, label: Text('On WhatsApp'))],
          selected: {_inApp},
          onSelectionChanged: (s) => setState(() => _inApp = s.first),
          style: const ButtonStyle(minimumSize: WidgetStatePropertyAll(Size(48, 48))),
        ),
        const SizedBox(height: 12),
        TextField(controller: _text, maxLines: 3, maxLength: 300, decoration: const InputDecoration(hintText: 'A short note for them (Maya says it is from you)')),
        if (!_inApp) ...[
          const SizedBox(height: 4),
          DeliveryPicker(value: _via, onChanged: (v) => setState(() => _via = v ?? 'text')),
          const SizedBox(height: 6),
          Text(_via == 'call' ? 'Maya rings them and says it as your message. Up to 80 characters. The same call limits apply.' : d.windowOpen ? 'They wrote in the last 24 hours, so this can go now.' : 'WhatsApp only allows free text or a voice note while they have written in the last 24 hours.', style: const TextStyle(fontSize: 13, color: kSoft)),
        ],
        const SizedBox(height: 12),
        FilledButton(onPressed: _busy ? null : _send, child: Text(_busy ? 'Sending...' : 'Send')),
        if (!_inApp && _via != 'call' && d.linked && d.optIn && !d.windowOpen)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: OutlinedButton(
              onPressed: _busy ? null : () async {
                final ok = await act(context, () => Api.postJson('/api/whatsapp/${d.profileId}/send', {'kind': 'text', 'text': '', 'useTemplate': true}), done: 'The standard invitation was sent. Your own words were not: WhatsApp only allows that until they write back.');
                if (ok) d.refresh(quiet: true);
              },
              child: const Text('Send a standard invitation to reply'),
            ),
          ),
        if (_result != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_result!, style: const TextStyle(fontSize: 15))),
      ]),
    );
  }
}
