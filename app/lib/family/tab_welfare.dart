import 'package:flutter/material.dart';

import '../models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/delivery_picker.dart';
import 'common.dart';
import 'family_data.dart';

/// Welfare checks: check in now, or schedule them (every hour / 2 hours / 3 hours / custom, for 24 hours).
class WelfareTab extends StatefulWidget {
  final FamilyData data;
  const WelfareTab({super.key, required this.data});
  @override
  State<WelfareTab> createState() => _WelfareTabState();
}

class _WelfareTabState extends State<WelfareTab> {
  String _via = 'call';
  String _schedVia = 'call';
  String _every = '60';
  final _custom = TextEditingController(text: '30');
  bool _busy = false;
  String? _result;

  FamilyData get d => widget.data;

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  int get _everyMin => _every == 'custom' ? (int.tryParse(_custom.text) ?? 0) : int.parse(_every);

  Future<void> _checkNow() async {
    setState(() {
      _busy = true;
      _result = null;
    });
    try {
      final r = await Api.postJson('/api/whatsapp/${d.profileId}/welfare-call', {'via': _via});
      String text;
      if (r is Map && r['calledInstead'] == true) {
        text = 'The 24 hour window is closed, so a text or voice note cannot go: Maya is calling instead. Their phone should ring now.';
      } else if (r is Map && r['sent'] == true) {
        text = 'Sent as a ${r['via'] == 'voice' ? 'voice note' : 'text'}. No call was placed.';
      } else if (r is Map && r['placed'] == false) {
        text = 'Nothing rang. ${callLimitText(r['calls'] is Map ? Map<String, dynamic>.from(r['calls'] as Map) : null)} A WhatsApp message was sent instead.';
      } else {
        text = 'WhatsApp took the call: their phone should ring now.';
      }
      if (mounted) setState(() => _result = text);
      d.refresh(quiet: true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _result = '${e.message} Nothing rang.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _startSchedule() async {
    setState(() => _busy = true);
    final ok = await act(context, () => Api.postJson('/api/whatsapp/${d.profileId}/welfare-schedule', {'everyMin': _everyMin, 'via': _schedVia}), done: 'The schedule is running.');
    if (mounted) setState(() => _busy = false);
    if (ok) d.refresh(quiet: true);
  }

  Future<void> _stopSchedule() async {
    final ok = await act(context, () => Api.delete('/api/whatsapp/${d.profileId}/welfare-schedule'), done: 'The schedule is stopped.');
    if (ok) d.refresh(quiet: true);
  }

  String _everyText(int n) => n == 60 ? 'hour' : n % 60 == 0 ? '${n ~/ 60} hours' : '$n minutes';

  @override
  Widget build(BuildContext context) {
    final s = d.schedule;
    final running = s != null && s['status'] == 'running';
    final q = d.quiet;
    final n = _everyMin;
    final via = _schedVia;
    final planned = n >= 5 && n <= 720 ? (24 * 60 ~/ n).clamp(1, 288) : 0;
    final line = s == null
        ? 'No schedule is running.'
        : s['status'] == 'running'
            ? '${s['held'] == true ? 'Held for quiet hours: the next check goes at ${q != null ? hh(q['end'] as num) : '07'}:00. ' : ''}Running: a check-in by ${s['via'] == 'call' ? 'call' : s['via'] == 'voice' ? 'voice note' : 'text'} every ${_everyText((s['everyMin'] as num).toInt())}, ${s['fired']} sent so far of about ${s['planned']}. Next about ${clock((s['next'] as num).toInt())}.'
            : '${s['status'] == 'paused' ? 'Paused' : 'Ended'}: ${s['note'] ?? ''}';
    return LayoutBuilder(builder: (context, box) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight - 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            sectionLabel('Check in with ${d.name} now'),
            const Text('Maya says it is a welfare check and asks how they are. As a call she then talks with them; as a text or voice note she sends the same short words.', style: TextStyle(fontSize: 14, color: kSoft)),
            const SizedBox(height: 8),
            DeliveryPicker(value: _via, onChanged: (v) => setState(() => _via = v ?? 'call')),
            const SizedBox(height: 8),
            FilledButton(onPressed: _busy ? null : _checkNow, child: Text(_busy ? 'Working...' : 'Check in now')),
            if (_result != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_result!, style: const TextStyle(fontSize: 15))),
            const Divider(height: 28),
            sectionLabel('Scheduled check-ins'),
            Text(line, style: const TextStyle(fontSize: 15)),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _every,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Check in'),
              items: const [
                DropdownMenuItem(value: '60', child: Text('Every hour')),
                DropdownMenuItem(value: '120', child: Text('Every 2 hours')),
                DropdownMenuItem(value: '180', child: Text('Every 3 hours')),
                DropdownMenuItem(value: 'custom', child: Text('Custom (minutes)')),
                DropdownMenuItem(value: 'daily', enabled: false, child: Text('Every day (needs WhatsApp\'s template: not available yet)', overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (v) => setState(() => _every = v ?? '60'),
            ),
            if (_every == 'custom') Padding(padding: const EdgeInsets.only(top: 8), child: TextField(controller: _custom, keyboardType: TextInputType.number, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Minutes between check-ins (5 to 720)'))),
            const SizedBox(height: 8),
            DeliveryPicker(value: _schedVia, onChanged: (v) => setState(() => _schedVia = v ?? 'call')),
            const SizedBox(height: 6),
            Text(
              planned == 0
                  ? 'Choose between 5 and 720 minutes.'
                  : 'Up to $planned ${via == 'call' ? 'calls' : via == 'voice' ? 'voice notes' : 'texts'} in the next 24 hours. ${q != null && q['tz'] != null ? 'A check that falls between ${hh(q['start'] as num)}:00 and ${hh(q['end'] as num)}:00 (their night) is held until ${hh(q['end'] as num)}:00. ' : ''}${via == 'call' ? 'WhatsApp decides how many calls a business may start in a day and refuses the rest: Maya then pauses the schedule. ' : 'WhatsApp only allows a text or a voice note inside 24 hours after they last wrote: when that window is closed at a check, Maya calls instead for that round. '}It pauses by itself after 2 unanswered calls in a row, and says why. Every check shows in Activity.',
              style: const TextStyle(fontSize: 13, color: kSoft),
            ),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: FilledButton(onPressed: _busy || running ? null : _startSchedule, child: const Text('Start (24 hours)'))),
              const SizedBox(width: 10),
              Expanded(child: OutlinedButton(onPressed: running ? _stopSchedule : null, child: const Text('Stop'))),
            ]),
            if (d.calls != null && callLimitText(d.calls).isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(callLimitText(d.calls), style: const TextStyle(fontSize: 13, color: kSoft))),
          ]),
        ),
      );
    });
  }
}
