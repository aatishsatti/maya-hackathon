import 'package:flutter/material.dart';

import '../models.dart';
import '../services/api.dart';
import '../theme.dart';
import '../widgets/delivery_picker.dart';
import '../widgets/whatsapp_rules.dart';
import '../widgets/pill.dart';
import 'common.dart';
import 'family_data.dart';
import 'schedule_upload.dart';

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
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        child: OutlinedButton.icon(
          style: OutlinedButton.styleFrom(minimumSize: const Size(double.infinity, 48)),
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => Scaffold(appBar: AppBar(title: const Text('Upload a schedule')), body: SafeArea(child: ScheduleUpload(data: data))))),
          icon: const Icon(Icons.upload_file),
          label: const Text('Upload a schedule'),
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
                  return InkWell(
                    onTap: r.seniorSet ? null : () => showModalBottomSheet<void>(context: context, isScrollControlled: true, backgroundColor: Colors.white, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))), builder: (_) => Padding(padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom), child: _AddSheet(data: data, edit: r))),
                    child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(r.task, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          Wrap(spacing: 6, runSpacing: 4, children: [
                            if (r.channel != null) Pill(_whereLabel[r.channel] ?? r.channel!),
                            if (r.deliver != null) Pill(_howLabel[r.deliver] ?? r.deliver!),
                            if (r.seniorSet) const Pill('Set by senior') else if (r.by == 'senior') const Pill('Set by talking'),
                            if (r.held || r.waitUntil != null) const Pill('Waiting until morning', tone: kToneWait),
                            if (r.stateLabel != null) Pill(r.stateLabel!, tone: kToneInfo),
                          ]),
                          if (r.socialLine != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(r.socialLine!, style: const TextStyle(fontSize: 13, color: kSoft)))
                          else if (r.waitUntil != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Waiting until morning (quiet hours): goes at ${dayTime(r.waitUntil!)}', style: const TextStyle(fontSize: 13, color: kSoft)))
                          else if (r.dueAt != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Next: ${dayTime(r.dueAt!)}${r.repeat != 'none' ? ' · repeats ${r.every == 2 ? 'every 2 ${r.repeat == 'weekly' ? 'weeks' : 'days'}' : r.repeat}' : ''}', style: const TextStyle(fontSize: 13, color: kSoft))),
                        ]),
                      ),
                      if (!r.seniorSet) const Padding(padding: EdgeInsets.only(left: 8, top: 4), child: Icon(Icons.chevron_right, color: kSoft)),
                    ]),
                  ));
                },
              ),
      ),
    ]);
  }
}

class _AddSheet extends StatefulWidget {
  final FamilyData data;
  final Reminder? edit;   // set: the sheet changes this reminder (or stops it) instead of adding one
  const _AddSheet({required this.data, this.edit});
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
  void initState() {
    super.initState();
    final r = widget.edit;
    if (r == null) return;
    _task.text = r.task;
    if (r.dueAt != null) _at = DateTime.fromMillisecondsSinceEpoch(r.dueAt!);
    _repeat = r.repeat == 'none' ? 'none' : '${r.repeat}${r.every == 2 ? '2' : ''}';
    if (!const ['none', 'daily', 'daily2', 'weekly', 'weekly2'].contains(_repeat)) _repeat = 'none';   // a repeat only talking can set (every few hours) is shown as Once here and the family picks again
    _deliver = r.deliver;
    _channel = r.channel;
  }

  // Stopping is destructive: it asks once more.
  Future<void> _stop() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Stop this reminder?'),
        content: Text('Maya will no longer remind them: ${widget.edit!.task}.'),
        actions: [TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text('Keep it')), TextButton(onPressed: () => Navigator.of(c).pop(true), child: const Text('Yes, stop it', style: TextStyle(color: kAlert)))],
      ),
    );
    if (sure != true || !mounted) return;
    final nav = Navigator.of(context);
    final ok = await act(context, () => Api.delete('/api/care/${widget.data.profileId}/reminders/${widget.edit!.id}'), done: 'Reminder stopped.');
    if (ok) {
      widget.data.refresh(quiet: true);
      nav.pop();
    }
  }

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
          Text(widget.edit == null ? 'New reminder' : 'Edit reminder', style: Theme.of(context).textTheme.titleLarge),
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
            items: const [DropdownMenuItem(value: 'none', child: Text('Once')), DropdownMenuItem(value: 'daily', child: Text('Every day')), DropdownMenuItem(value: 'daily2', child: Text('Every 2 days')), DropdownMenuItem(value: 'weekly', child: Text('Every week')), DropdownMenuItem(value: 'weekly2', child: Text('Every 2 weeks'))],
            onChanged: (v) => setState(() => _repeat = v ?? 'none'),
          ),
          sectionLabel('Where it goes'),
          DeliveryPicker(value: _channel, clearable: true, choices: DeliveryPicker.channels, onChanged: (v) => setState(() => _channel = v)),
          if (_channel == 'whatsapp' || _channel == 'both') WhatsappRules(rules: WhatsappRules.from(widget.data.care['whatsappRules'])),
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
                    final ok = await act(context, () => Api.postJson('/api/care/${widget.data.profileId}/reminders${widget.edit == null ? '' : '/${widget.edit!.id}'}', {'task': _task.text, 'dueAt': _at.millisecondsSinceEpoch, 'repeat': _repeat.replaceAll(RegExp(r'2$'), ''), if (_repeat.endsWith('2')) 'every': 2, if (_deliver != null) 'deliver': _deliver, if (_channel != null) 'channel': _channel}), done: 'Reminder added.');
                    if (!mounted) return;
                    setState(() => _busy = false);
                    if (ok) {
                      widget.data.refresh(quiet: true);
                      nav.pop();
                    }
                  },
            child: Text(_busy ? (widget.edit == null ? 'Adding...' : 'Saving...') : (widget.edit == null ? 'Add reminder' : 'Save changes')),
          ),
          if (widget.edit != null) Padding(padding: const EdgeInsets.only(top: 8), child: TextButton(style: TextButton.styleFrom(minimumSize: const Size(48, 48)), onPressed: _busy ? null : _stop, child: const Text('Stop this reminder', style: TextStyle(color: kAlert, fontSize: 16, fontWeight: FontWeight.w600)))),
        ]),
      ),
    );
  }
}
