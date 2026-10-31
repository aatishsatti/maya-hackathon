import 'package:flutter/material.dart';

import '../models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/delivery_picker.dart';
import '../widgets/pill.dart';
import 'common.dart';
import 'family_data.dart';

const _whereLabel = {'whatsapp': 'WhatsApp', 'app': 'Maya app', 'both': 'WhatsApp + app'};
const _howLabel = {'call': 'Call', 'text': 'Text', 'voice': 'Voice note'};

/// Reminders: what is coming first (soonest at the top), finished ones below, newest first, the latest five until "Show earlier".
/// A reminder just added shows at once. The list stays in view and scrolls inside itself; adding one opens a sheet.
class RemindersTab extends StatefulWidget {
  final FamilyData data;
  const RemindersTab({super.key, required this.data});
  @override
  State<RemindersTab> createState() => _RemindersTabState();
}

class _RemindersTabState extends State<RemindersTab> {
  bool _showAll = false;

  @override
  Widget build(BuildContext context) {
    final data = widget.data;
    final all = data.reminders.where((r) => !r.msg).toList();
    final upcoming = all.where((r) => !r.finished).toList()..sort((a, b) => (a.dueAt ?? 0).compareTo(b.dueAt ?? 0));
    final finished = all.where((r) => r.finished).toList()..sort((a, b) => (b.lastAt ?? 0).compareTo(a.lastAt ?? 0));
    final shownFinished = _showAll ? finished : finished.take(5).toList();
    final rows = [...upcoming, ...shownFinished];
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: FilledButton.icon(
          onPressed: () => showModalBottomSheet<void>(context: context, isScrollControlled: true, backgroundColor: Colors.white, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))), builder: (_) => Padding(padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom), child: _AddSheet(data: data))),
          icon: const Icon(Icons.add),
          label: const Text('Add a reminder'),
        ),
      ),
      if (data.error != null) ErrorBanner(message: data.error!, onRetry: () => data.refresh()),
      Expanded(
        child: rows.isEmpty
            ? const Center(child: Text('No reminders yet.', style: TextStyle(color: kSoft, fontSize: 16)))
            : ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                itemCount: rows.length + (finished.length > 5 ? 1 : 0),
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, i) {
                  if (i == rows.length) {
                    return TextButton(onPressed: () => setState(() => _showAll = !_showAll), child: Text(_showAll ? 'Show fewer finished reminders' : 'Show ${finished.length - 5} earlier finished reminders'));
                  }
                  final r = rows[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(r.task, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          Wrap(spacing: 6, runSpacing: 4, children: [
                            if (r.channel != null) Pill(_whereLabel[r.channel] ?? r.channel!),
                            if (r.deliver != null) Pill(_howLabel[r.deliver] ?? r.deliver!),
                            if (r.held) const Pill('Held for quiet hours', tone: kToneWait),
                            if (r.stateLabel != null) Pill(r.stateLabel!, tone: kToneInfo),
                          ]),
                          if (r.dueAt != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Next: ${dayTime(r.dueAt!)}${r.repeat != 'none' ? ' · repeats ${r.repeat}' : ''}', style: const TextStyle(fontSize: 13, color: kSoft))),
                        ]),
                      ),
                      IconButton(
                        tooltip: 'Delete ${r.task}',
                        constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () async {
                          final ok = await act(context, () => Api.delete('/api/care/${data.profileId}/reminders/${r.id}'), done: 'Reminder deleted.');
                          if (ok) data.refresh(quiet: true);
                        },
                      ),
                    ]),
                  );
                },
              ),
      ),
    ]);
  }
}

class _AddSheet extends StatefulWidget {
  final FamilyData data;
  const _AddSheet({required this.data});
  @override
  State<_AddSheet> createState() => _AddSheetState();
}

class _AddSheetState extends State<_AddSheet> {
  final _task = TextEditingController();
  DateTime _at = DateTime.now().add(const Duration(minutes: 30));
  String _repeat = 'none';
  String? _deliver, _channel;
  bool _busy = false;

  @override
  void dispose() {
    _task.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final d = await showDatePicker(context: context, initialDate: _at, firstDate: DateTime.now().subtract(const Duration(days: 0)), lastDate: DateTime.now().add(const Duration(days: 365)));
    if (d == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_at));
    if (t == null) return;
    setState(() => _at = DateTime(d.year, d.month, d.day, t.hour, t.minute));
  }

  @override
  Widget build(BuildContext context) {
    final q = widget.data.quiet;
    final inQuiet = inQuietAt(q, _at.millisecondsSinceEpoch);
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('New reminder', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          TextField(controller: _task, maxLength: 80, decoration: const InputDecoration(labelText: 'What should Maya remind them about?', counterText: ''), textCapitalization: TextCapitalization.sentences),
          const SizedBox(height: 12),
          OutlinedButton.icon(onPressed: _pick, icon: const Icon(Icons.schedule), label: Text(dayTime(_at.millisecondsSinceEpoch))),
          if (inQuiet && q != null)
            Padding(padding: const EdgeInsets.only(top: 8), child: Text('That time is in their quiet hours (${hh(q['start'] as num)}:00 to ${hh(q['end'] as num)}:00). The reminder is kept and will be held until ${hh(q['end'] as num)}:00: nothing is sent, texted or rung at night.', style: TextStyle(fontSize: 14, color: kToneWait.ink))),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _repeat,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Repeat'),
            items: const [DropdownMenuItem(value: 'none', child: Text('Once')), DropdownMenuItem(value: 'daily', child: Text('Every day')), DropdownMenuItem(value: 'weekly', child: Text('Every week'))],
            onChanged: (v) => setState(() => _repeat = v ?? 'none'),
          ),
          sectionLabel('Where it goes'),
          DeliveryPicker(value: _channel, clearable: true, choices: DeliveryPicker.channels, onChanged: (v) => setState(() => _channel = v)),
          Padding(padding: const EdgeInsets.only(top: 6), child: Text(_channel == null ? 'Not chosen: Maya uses the setting in Setup. Tap a choice again to clear it.' : _channel == 'app' ? 'In the Maya app: no 24 hour window, no template. A closed app cannot be rung yet, so a call falls back to WhatsApp.' : _channel == 'both' ? 'On WhatsApp (its rules) and in the app. A call rings the app if it is open, otherwise WhatsApp.' : 'On WhatsApp, under its rules: the 24 hour window and the call limits.', style: const TextStyle(fontSize: 13, color: kSoft))),
          sectionLabel('Deliver this reminder as'),
          DeliveryPicker(value: _deliver, clearable: true, onChanged: (v) => setState(() => _deliver = v)),
          Padding(padding: const EdgeInsets.only(top: 6), child: Text(_deliver == null ? 'Not chosen: Maya uses the person-wide setting. Tap a choice again to clear it.' : _deliver == 'call' ? 'Maya will ring them on WhatsApp.' : 'If the 24 hour window is closed, Maya calls instead for that round.', style: const TextStyle(fontSize: 13, color: kSoft))),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy
                ? null
                : () async {
                    setState(() => _busy = true);
                    final nav = Navigator.of(context);
                    final ok = await act(context, () => Api.postJson('/api/care/${widget.data.profileId}/reminders', {'task': _task.text, 'dueAt': _at.millisecondsSinceEpoch, 'repeat': _repeat, if (_deliver != null) 'deliver': _deliver, if (_channel != null) 'channel': _channel}), done: 'Reminder added.');
                    if (!mounted) return;
                    setState(() => _busy = false);
                    if (ok) {
                      widget.data.refresh(quiet: true);
                      nav.pop();
                    }
                  },
            child: Text(_busy ? 'Adding...' : 'Add reminder'),
          ),
        ]),
      ),
    );
  }
}
