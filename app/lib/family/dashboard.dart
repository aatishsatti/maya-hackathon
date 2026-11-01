import 'package:flutter/material.dart';

import '../models.dart';
import '../services/store.dart';
import '../theme.dart';
import '../widgets/pressable.dart';
import 'family_data.dart';
import 'family_login.dart';
import 'tab_activity.dart';
import 'tab_reminders.dart';
import 'tab_setup.dart';
import 'tab_welfare.dart';

/// The family dashboard: a SUMMARY first (status, next check with date and time, reminders today, an alert only when there is one, the latest rows). Each section opens on a tap as its own page with a Close.
class FamilyDashboard extends StatefulWidget {
  final Profile profile;
  const FamilyDashboard({super.key, required this.profile});
  @override
  State<FamilyDashboard> createState() => _FamilyDashboardState();
}

class _FamilyDashboardState extends State<FamilyDashboard> {
  late Profile _profile = widget.profile;
  late FamilyData _data = FamilyData(_profile.id)..start();

  @override
  void dispose() {
    _data.dispose();
    super.dispose();
  }

  Future<void> _switch(Profile p) async {
    await Store.setProfile(p.id, p.name);
    final old = _data;
    setState(() {
      _profile = p;
      _data = FamilyData(p.id)..start();
    });
    old.dispose();
  }

  String _presence(FamilyData d) {
    final c = d.care;
    if (c.isEmpty) return 'Loading...';
    final seen = c['lastSeen'] is Map && (c['lastSeen'] as Map)['at'] is num ? clock(((c['lastSeen'] as Map)['at'] as num).toInt()) : 'not yet';
    return '${c['inCall'] == true ? 'On a call with Maya now' : c['appOpen'] == true ? 'App is open' : 'App is not open'} · Last seen $seen';
  }

  // always a date AND a time: "Tue 3 Nov, 9:00 am"
  static String dateTime(num ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${days[d.weekday - 1]} ${d.day} ${months[d.month - 1]}, ${clock(ms.toInt())}';
  }

  // Opens one section as its own full page with a Close that goes back to the summary. Never all sections at once.
  void _open(String title, Widget Function() page) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => Scaffold(
        appBar: AppBar(automaticallyImplyLeading: false, title: Text(title, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w800)), actions: [
          Padding(padding: const EdgeInsets.only(right: 12), child: TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)))),
        ]),
        body: SafeArea(child: page()),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _data,
      builder: (context, _) {
        final d = _data;
        return Scaffold(
          appBar: AppBar(
            toolbarHeight: 60,
            titleSpacing: 16,
            title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_profile.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              Text(_presence(d), style: const TextStyle(fontSize: 13, color: kSoft, fontWeight: FontWeight.w400)),
            ]),
            actions: [
              if (d.loading) const Padding(padding: EdgeInsets.only(right: 16), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
            ],
          ),
          body: SafeArea(child: _summary(d)),
        );
      },
    );
  }

  Widget _summary(FamilyData d) {
    final alerts = d.activeAlerts, hasAlert = alerts.any((a) => a['_kind'] == 'alerts' || a['level'] == 'alert'), need = alerts.isNotEmpty;
    final s = d.schedule;
    String nextBig, nextSub;
    if (s != null && s['status'] == 'running' && s['next'] is num) {
      nextBig = dateTime(s['next'] as num);
      nextSub = s['held'] == true ? 'Running, held for quiet hours' : 'Running';
    } else if (s != null && s['status'] == 'paused') {
      nextBig = 'Paused';
      nextSub = 'Paused since ${dateTime((s['statusAt'] ?? s['startedAt'] ?? DateTime.now().millisecondsSinceEpoch) as num)}. Tap to restart';
    } else if (s != null) {
      nextBig = 'Stopped';
      nextSub = 'Stopped since ${dateTime((s['statusAt'] ?? s['startedAt'] ?? DateTime.now().millisecondsSinceEpoch) as num)}. Tap to start';
    } else {
      nextBig = 'Not set';
      nextSub = 'Tap to set check-ins';
    }
    final now = DateTime.now();
    bool today(int ms) {
      final t = DateTime.fromMillisecondsSinceEpoch(ms);
      return t.year == now.year && t.month == now.month && t.day == now.day;
    }

    final todays = d.reminders.where((r) => r.dueAt != null && today(r.dueAt!)).toList()..sort((a, b) => a.dueAt!.compareTo(b.dueAt!));
    final nextR = todays.where((r) => r.dueAt! > now.millisecondsSinceEpoch).toList();
    final recent = d.activity.take(4).toList();
    final tone = hasAlert ? kToneMiss : need ? kToneWait : kToneOk;
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
        decoration: BoxDecoration(color: tone.bg, borderRadius: BorderRadius.circular(40), border: Border.all(color: tone.line, width: 1.5)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: tone.ink)),
          const SizedBox(width: 10),
          Text(need ? 'Needs attention' : 'OK', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: tone.ink)),
        ]),
      ),
      if (need)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Pressable(
            onTap: () => _open('Alerts and flags', () => ActivityTab(data: d)),
            semanticLabel: 'Alerts',
            child: Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(color: tone.bg, borderRadius: BorderRadius.circular(18), border: Border.all(color: tone.line, width: 1.5)),
              child: Text('${alerts.length} ${alerts.length == 1 ? 'alert or flag' : 'alerts and flags'}: tap to read', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: tone.ink)),
            ),
          ),
        ),
      const SizedBox(height: 14),
      _SumCard(label: 'Next check', big: nextBig, sub: nextSub, onTap: () => _open('Check In With Them', () => WelfareTab(data: d))),
      const SizedBox(height: 12),
      _SumCard(label: 'Reminders today', big: '${todays.length}', sub: todays.isEmpty ? 'None today. Tap to add' : (nextR.isNotEmpty ? 'Next ${clock(nextR.first.dueAt!)}: ${nextR.first.task}' : 'Tap to see them'), onTap: () => _open('Reminders', () => RemindersTab(data: d))),
      const SizedBox(height: 16),
      Wrap(spacing: 10, runSpacing: 10, children: [
        _Chip('Check In With Them', () => _open('Check In With Them', () => WelfareTab(data: d))),
        _Chip('Reminders', () => _open('Reminders', () => RemindersTab(data: d))),
        _Chip('Activity', () => _open('Activity', () => ActivityTab(data: d))),
        _Chip('Family Members', () => _open('Family Members', () => const FamilyHome(embedded: true))),
        _Chip('Settings', () => _open('Settings', () => SetupTab(data: d, profile: _profile, onSwitch: _switch))),
      ]),
      const SizedBox(height: 18),
      Row(children: [
        const Expanded(child: Text('Latest', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
        TextButton(onPressed: () => _open('Activity', () => ActivityTab(data: d)), child: const Text('See all activity', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: kTrust))),
      ]),
      if (recent.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('Nothing yet. Reminders, check-ins and messages show here.', style: TextStyle(fontSize: 15, color: kSoft))),
      for (final e in recent)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(e.words ?? e.type, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              Text(e.label, style: const TextStyle(fontSize: 14, color: kSoft)),
            ])),
            Text(dateTime(e.at), style: const TextStyle(fontSize: 13, color: kSoft)),
          ]),
        ),
    ]);
  }
}

class _SumCard extends StatelessWidget {
  final String label, big, sub;
  final VoidCallback onTap;
  const _SumCard({required this.label, required this.big, required this.sub, required this.onTap});
  @override
  Widget build(BuildContext context) => Pressable(
        onTap: onTap,
        semanticLabel: label,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(22), border: Border.all(color: const Color(0xFFE2E7F6), width: 1.4)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label.toUpperCase(), style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 1, color: kSoft)),
            const SizedBox(height: 4),
            Text(big, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.4, color: kInk)),
            const SizedBox(height: 2),
            Text(sub, style: const TextStyle(fontSize: 15, color: kSoft)),
          ]),
        ),
      );
}

class _Chip extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _Chip(this.label, this.onTap);
  @override
  Widget build(BuildContext context) => Pressable(
        onTap: onTap,
        semanticLabel: label,
        child: Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          alignment: Alignment.center,
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(26), border: Border.all(color: const Color(0xFFD3DAF3), width: 1.5)),
          child: Text(label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: kInk)),
        ),
      );
}
