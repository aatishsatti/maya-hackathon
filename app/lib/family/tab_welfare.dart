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
  String _where = 'whatsapp';        // Where it goes for a check-in now: app | whatsapp | both
  String _schedWhere = 'whatsapp';  // and for the schedule
  bool _whereSet = false;
  String _schedVia = 'call';
  String _every = '1440';
  final _custom = TextEditingController();   // empty: the preset above is used. Typing here is the advanced custom interval.
  bool _busy = false;
  String? _result;

  FamilyData get d => widget.data;

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  String _unit = 'days';
  bool get _customOn => _custom.text.trim().isNotEmpty;
  int get _everyMin => _customOn ? (int.tryParse(_custom.text.trim()) ?? 0) * (_unit == 'hours' ? 60 : _unit == 'days' ? 1440 : 10080) : int.parse(_every);

  Future<void> _checkNow() async {
    setState(() {
      _busy = true;
      _result = null;
    });
    try {
      final r = await Api.postJson('/api/whatsapp/${d.profileId}/welfare-call', {'via': _via, 'channel': _where});
      String text;
      if (r is Map && r['channel'] != null) {
        // the welfare channel: the server says in one line what happened and where
        final result = r['result'];
        if (r['summary'] is String) {
          text = r['summary'] as String;
        } else if (result is Map && result['calledInstead'] == true) {
          text = 'The 24 hour window is closed, so a text or voice note cannot go: Maya is calling instead. Their phone should ring now.';
        } else if (result is Map && result['sent'] == true) {
          text = 'Sent on WhatsApp as a ${result['via'] == 'voice' ? 'voice note' : 'text'}.';
        } else if (result is Map && result['placed'] == false) {
          text = 'Nothing rang. ${callLimitText(result['calls'] is Map ? Map<String, dynamic>.from(result['calls'] as Map) : null)} A WhatsApp message was sent instead.';
        } else {
          text = 'WhatsApp took the call: their phone should ring now.';
        }
      } else if (r is Map && r['calledInstead'] == true) {
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
    final paused = d.schedule != null && d.schedule!['status'] == 'paused';
    setState(() => _busy = true);
    final ok = await act(context, () => Api.postJson('/api/whatsapp/${d.profileId}/welfare-schedule', {'everyMin': _everyMin, 'via': _schedVia, 'channel': _schedWhere}), done: paused ? 'The schedule is running again.' : 'The schedule is running.');
    if (mounted) setState(() => _busy = false);
    if (ok) d.refresh(quiet: true);
  }

  Future<void> _stopSchedule() async {
    final ok = await act(context, () => Api.delete('/api/whatsapp/${d.profileId}/welfare-schedule'), done: 'The schedule is stopped.');
    if (ok) d.refresh(quiet: true);
  }

  String _everyText(int n) => n == 60 ? 'hour' : n == 1440 ? 'day' : n == 10080 ? 'week' : n % 10080 == 0 ? '${n ~/ 10080} weeks' : n % 1440 == 0 ? '${n ~/ 1440} days' : n % 60 == 0 ? '${n ~/ 60} hours' : '$n minutes';

  @override
  Widget build(BuildContext context) {
    if (!_whereSet && d.care['delivery'] is Map) {
      final ch = (d.care['delivery'] as Map)['channel'];
      if (ch is String && const ['app', 'whatsapp', 'both'].contains(ch)) {
        _where = ch;
        _schedWhere = ch;
      }
      _whereSet = true;
    }
    final s = d.schedule;
    final running = s != null && s['status'] == 'running';
    final q = d.quiet;
    final n = _everyMin;
    final via = _schedVia;
    final planned = n >= 5 && n <= 120960 ? ((n >= 1440 ? 90 * 1440 : 24 * 60) ~/ n).clamp(1, 288) : 0;
    final paused = s != null && s['status'] == 'paused';
    final stateWord = running ? 'Running' : paused ? 'Paused' : 'Stopped';
    // always a date AND a time: "Tue 3 Nov, 9:00 am"
    String dt(num ms) {
      final d0 = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return '${days[d0.weekday - 1]} ${d0.day} ${months[d0.month - 1]}, ${clock(ms.toInt())}';
    }
    final nextText = running ? (s['held'] == true ? 'Next check: ${dt(s['next'] as num)} (held for quiet hours)' : 'Next check: ${dt(s['next'] as num)}') : s != null ? 'since ${dt((s['statusAt'] ?? s['startedAt'] ?? DateTime.now().millisecondsSinceEpoch) as num)}${s['note'] != null && '${s['note']}'.isNotEmpty ? '. ${s['note']}' : ''}' : '';
    final line = s == null
        ? 'No schedule is running.'
        : s['status'] == 'running'
            ? '${s['held'] == true ? 'Held for quiet hours: the next check is ${dt(s['next'] as num)}. ' : ''}Running: a check-in by ${s['via'] == 'call' ? 'call' : s['via'] == 'voice' ? 'voice note' : 'text'}${s['channel'] == 'app' ? ' in the Maya app' : s['channel'] == 'both' ? ' on WhatsApp and in the app' : s['channel'] == 'whatsapp' ? ' on WhatsApp' : ''} every ${_everyText((s['everyMin'] as num).toInt())}, ${s['fired']} sent so far of about ${s['planned']}. Next check: ${dt(s['next'] as num)}.'
            : '${s['status'] == 'paused' ? 'Paused' : 'Ended'}: ${s['note'] ?? ''}';
    return LayoutBuilder(builder: (context, box) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight - 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            sectionLabel('Check In With Them: ${d.name}'),
            const Text('Maya says it is a welfare check and asks how they are. As a call she then talks with them; as a text or voice note she sends the same short words.', style: TextStyle(fontSize: 14, color: kSoft)),
            const SizedBox(height: 8),
            DeliveryPicker(value: _via, onChanged: (v) => setState(() => _via = v ?? 'call')),
            const SizedBox(height: 8),
            const Text('Where it goes', style: TextStyle(fontSize: 14, color: kSoft)),
            const SizedBox(height: 4),
            WherePicker(value: _where, onChanged: (v) => setState(() => _where = v)),
            const SizedBox(height: 8),
            FilledButton(onPressed: _busy ? null : _checkNow, child: Text(_busy ? 'Working...' : 'Check in now')),
            if (_result != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_result!, style: const TextStyle(fontSize: 15))),
            const Divider(height: 28),
            sectionLabel('Scheduled check-ins'),
            // the running / paused / stopped space exists only while there is a schedule to show
            if (s != null) ...[
              Text.rich(TextSpan(children: [TextSpan(text: stateWord, style: const TextStyle(fontWeight: FontWeight.w700)), if (nextText.isNotEmpty) TextSpan(text: ' · $nextText')]), key: const Key('schedStatus'), style: const TextStyle(fontSize: 16)),
              const SizedBox(height: 4),
              Text(line, style: const TextStyle(fontSize: 14, color: kSoft)),
            ],
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _every,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Check in'),
              items: const [
                DropdownMenuItem(value: '1440', child: Text('Every day')),
                DropdownMenuItem(value: '2880', child: Text('Every 2 days')),
                DropdownMenuItem(value: '10080', child: Text('Every week')),
                DropdownMenuItem(value: '20160', child: Text('Every 2 weeks')),
              ],
              onChanged: (v) => setState(() {
                _every = v ?? '1440';
                _custom.clear();
              }),
            ),
            ExpansionTile(
              key: const Key('schedAdvanced'),
              tilePadding: EdgeInsets.zero,
              title: const Text('Advanced: a custom interval', style: TextStyle(fontSize: 14, color: kSoft)),
              children: [
                Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('Too frequent will pause for flooding. Maya stops a phone from getting too many messages in a day.', key: const Key('customWarn'), style: TextStyle(fontSize: 13, color: n < 1440 && _customOn ? Colors.red.shade700 : kSoft, fontWeight: n < 1440 && _customOn ? FontWeight.w600 : FontWeight.normal))),
                Row(children: [
                  Expanded(child: TextField(controller: _custom, keyboardType: TextInputType.number, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'How many?'))),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: _unit,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Unit'),
                      items: const [DropdownMenuItem(value: 'hours', child: Text('hours')), DropdownMenuItem(value: 'days', child: Text('days')), DropdownMenuItem(value: 'weeks', child: Text('weeks'))],
                      onChanged: (v) => setState(() => _unit = v ?? 'days'),
                    ),
                  ),
                ]),
              ],
            ),
            const SizedBox(height: 8),
            DeliveryPicker(value: _schedVia, onChanged: (v) => setState(() => _schedVia = v ?? 'call')),
            const SizedBox(height: 8),
            const Text('Where it goes', style: TextStyle(fontSize: 14, color: kSoft)),
            const SizedBox(height: 4),
            WherePicker(value: _schedWhere, onChanged: (v) => setState(() => _schedWhere = v)),
            const SizedBox(height: 4),
            const Text('The Maya app has no WhatsApp limits. If WhatsApp cannot deliver, the app covers it and Activity says why. Both sends texts and voice notes to both; a call rings one place at a time.', style: TextStyle(fontSize: 13, color: kSoft)),
            const SizedBox(height: 6),
            Text(
              planned == 0
                  ? 'Choose a number of hours, days or weeks (up to 12 weeks).'
                  : 'Up to $planned ${via == 'call' ? 'calls' : via == 'voice' ? 'voice notes' : 'texts'} in the next ${n >= 1440 ? '90 days (it keeps going until you stop it)' : '24 hours'}. ${q != null && q['tz'] != null ? 'A check that falls between ${hh(q['start'] as num)}:00 and ${hh(q['end'] as num)}:00 (their night) is held until ${hh(q['end'] as num)}:00. ' : ''}${via == 'call' ? 'WhatsApp decides how many calls a business may start in a day and refuses the rest: Maya then pauses the schedule. ' : 'WhatsApp only allows a text or a voice note inside 24 hours after they last wrote: when that window is closed at a check, Maya calls instead for that round. '}It pauses by itself after 2 unanswered calls in a row, and says why. Every check shows in Activity.',
              style: const TextStyle(fontSize: 13, color: kSoft),
            ),
            const SizedBox(height: 10),
            // Running shows Stop only; Paused shows Restart only; otherwise Start only. Never both.
            if (running)
              SizedBox(width: double.infinity, child: OutlinedButton(key: const Key('schedStop'), onPressed: _busy ? null : _stopSchedule, child: const Text('Stop')))
            else
              SizedBox(width: double.infinity, child: FilledButton(key: Key(paused ? 'schedRestart' : 'schedStart'), onPressed: _busy ? null : _startSchedule, child: Text(paused ? 'Restart' : n >= 1440 ? 'Start' : 'Start (24 hours)'))),
            if (d.calls != null && callLimitText(d.calls).isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(callLimitText(d.calls), style: const TextStyle(fontSize: 13, color: kSoft))),
          ]),
        ),
      );
    });
  }
}
