import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';
import '../widgets/pill.dart';
import 'common.dart';
import 'family_data.dart';

const _typeLabel = {'reminder': 'Reminder', 'welfare': 'Welfare check', 'message': 'Message'};
const _chanLabel = {'call': 'Call', 'text': 'Text', 'voice': 'Voice note'};
const _typeIcon = {'reminder': Icons.notifications_none, 'welfare': Icons.favorite_border, 'message': Icons.mail_outline};

/// Activity: the five count cards and the filters stay put; only the list scrolls, inside its own area.
class ActivityTab extends StatefulWidget {
  final FamilyData data;
  const ActivityTab({super.key, required this.data});
  @override
  State<ActivityTab> createState() => _ActivityTabState();
}

class _ActivityTabState extends State<ActivityTab> {
  String _filter = 'all';

  @override
  Widget build(BuildContext context) {
    final d = widget.data;
    final sum = d.summary;
    final rows = d.activity.where((e) => _filter == 'all' || e.type == _filter).toList();
    final alerts = d.activeAlerts;
    return Column(children: [
      if (alerts.isNotEmpty) _AlertsBanner(alerts: alerts),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        child: Row(children: [
          for (final c in const [('sent', 'Sent'), ('delivered', 'Delivered'), ('read', 'Read'), ('answered', 'Answered'), ('missed', 'Missed')])
            Expanded(
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 3),
                padding: const EdgeInsets.symmetric(vertical: 8),
                decoration: BoxDecoration(color: kFill, borderRadius: BorderRadius.circular(12), border: Border.all(color: kLine)),
                child: Column(children: [
                  TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: ((sum[c.$1] ?? 0) as num).toDouble()),
                    duration: const Duration(milliseconds: 250),
                    builder: (context, v, _) => Text('${v.round()}', key: ValueKey('card-${c.$1}'), style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, height: 1.1)),
                  ),
                  FittedBox(fit: BoxFit.scaleDown, child: Text(c.$2, style: const TextStyle(fontSize: 11, color: kSoft))),
                ]),
              ),
            ),
        ]),
      ),
      SizedBox(
        height: 52,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
          for (final f in const [('all', 'All'), ('reminder', 'Reminders'), ('welfare', 'Welfare'), ('message', 'Messages')])
            Padding(
              padding: const EdgeInsets.only(right: 8, top: 4, bottom: 4),
              child: ChoiceChip(
                label: Text(f.$2),
                selected: _filter == f.$1,
                onSelected: (_) => setState(() => _filter = f.$1),
                materialTapTargetSize: MaterialTapTargetSize.padded,
                selectedColor: kInk,
                labelStyle: TextStyle(color: _filter == f.$1 ? Colors.white : kInk, fontWeight: FontWeight.w600),
                showCheckmark: false,
              ),
            ),
        ]),
      ),
      if (d.error != null) ErrorBanner(message: d.error!, onRetry: () => d.refresh()),
      Expanded(
        child: RefreshIndicator(
          onRefresh: () => d.refresh(quiet: true),
          child: rows.isEmpty
              ? ListView(children: [Padding(padding: const EdgeInsets.all(32), child: Text(d.loading ? 'Loading...' : 'Nothing yet. Reminders, check-ins and messages show here.', textAlign: TextAlign.center, style: const TextStyle(color: kSoft, fontSize: 16)))])
              : ListView.builder(padding: const EdgeInsets.fromLTRB(16, 0, 16, 12), itemCount: rows.length, itemBuilder: (context, i) {
                  final e = rows[i];
                  final g = dayGroup(e.at);
                  final head = i == 0 || dayGroup(rows[i - 1].at) != g;
                  return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if (head) Padding(padding: const EdgeInsets.only(top: 14, bottom: 4), child: Text(g.toUpperCase(), style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 0.8, color: kSoft))),
                    _Row(e: e, group: g),
                  ]);
                }),
        ),
      ),
    ]);
  }
}

class _Row extends StatelessWidget {
  final ActivityEntry e;
  final String group;
  const _Row({required this.e, required this.group});
  @override
  Widget build(BuildContext context) {
    final when = (group == 'Earlier' || group == 'Upcoming') ? dayTime(e.at) : clock(e.at);
    return Container(
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: kLine))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(width: 40, height: 40, decoration: const BoxDecoration(shape: BoxShape.circle, color: kFill), child: Icon(_typeIcon[e.type] ?? Icons.circle_outlined, size: 20)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(e.words ?? _typeLabel[e.type] ?? 'Activity', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Wrap(spacing: 6, runSpacing: 4, children: [Pill(_chanLabel[e.channel] ?? e.channel), Pill(e.label, tone: toneForStatus(e.status))]),
            if (e.note != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(e.note!, style: const TextStyle(fontSize: 13, color: kSoft))),
          ]),
        ),
        const SizedBox(width: 8),
        Text(when, style: const TextStyle(fontSize: 13, color: kSoft)),
      ]),
    );
  }
}

class _AlertsBanner extends StatelessWidget {
  final List<Map<String, dynamic>> alerts;
  const _AlertsBanner({required this.alerts});
  @override
  Widget build(BuildContext context) {
    final red = alerts.any((a) => a['_kind'] == 'alerts' || (a['level'] == 'alert'));
    final tone = red ? kToneMiss : kToneWait;
    return InkWell(
      onTap: () => showModalBottomSheet<void>(context: context, isScrollControlled: true, backgroundColor: Colors.white, builder: (_) => _AlertsSheet(alerts: alerts)),
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 6, 12, 2),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        constraints: const BoxConstraints(minHeight: 48),
        decoration: BoxDecoration(color: tone.bg, border: Border.all(color: tone.line), borderRadius: BorderRadius.circular(12)),
        child: Row(children: [
          Icon(red ? Icons.warning_amber_rounded : Icons.flag_outlined, color: tone.ink),
          const SizedBox(width: 10),
          Expanded(child: Text('${alerts.length} active ${alerts.length == 1 ? 'alert or flag' : 'alerts and flags'}. Tap to read.', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: tone.ink))),
          Icon(Icons.chevron_right, color: tone.ink),
        ]),
      ),
    );
  }
}

class _AlertsSheet extends StatelessWidget {
  final List<Map<String, dynamic>> alerts;
  const _AlertsSheet({required this.alerts});
  @override
  Widget build(BuildContext context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
          child: ListView(padding: const EdgeInsets.all(20), shrinkWrap: true, children: [
            Text('Alerts and flags', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            const Text('Topic only. Maya never passes on the words, audio or photos.', style: TextStyle(color: kSoft)),
            for (final a in alerts) ...[
              const SizedBox(height: 14),
              Text('${a['_kind'] == 'scams' ? 'Possible ${a['type'] ?? 'scam'}' : (a['trigger'] ?? a['level'] ?? 'Alert')}'.replaceAll('_', ' '), style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              Text('${a['level'] ?? ''} · ${a['status'] ?? ''}', style: const TextStyle(color: kSoft)),
              for (final s in (a['timeline'] as List? ?? const [])) if (s is Map) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${s['at'] is num ? '${clock((s['at'] as num).toInt())}  ' : ''}${s['label'] ?? ''}', style: const TextStyle(fontSize: 15))),
            ],
          ]),
        ),
      );
}
