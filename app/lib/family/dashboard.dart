import 'package:flutter/material.dart';

import '../models.dart';
import '../services/store.dart';
import '../theme.dart';
import 'family_data.dart';
import 'tab_activity.dart';
import 'tab_message.dart';
import 'tab_reminders.dart';
import 'tab_setup.dart';
import 'tab_welfare.dart';

/// The family dashboard: five tabs. The header and the bottom bar stay fixed; Activity keeps its count cards fixed and scrolls only its list.
class FamilyDashboard extends StatefulWidget {
  final Profile profile;
  const FamilyDashboard({super.key, required this.profile});
  @override
  State<FamilyDashboard> createState() => _FamilyDashboardState();
}

class _FamilyDashboardState extends State<FamilyDashboard> {
  late Profile _profile = widget.profile;
  late FamilyData _data = FamilyData(_profile.id)..start();
  int _tab = 0;

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
      _tab = 0;
    });
    old.dispose();
  }

  String _presence(FamilyData d) {
    final c = d.care;
    if (c.isEmpty) return 'Loading...';
    final seen = c['lastSeen'] is Map && (c['lastSeen'] as Map)['at'] is num ? clock(((c['lastSeen'] as Map)['at'] as num).toInt()) : 'not yet';
    return '${c['inCall'] == true ? 'On a call with Maya now' : c['appOpen'] == true ? 'App is open' : 'App is not open'} · Last seen $seen';
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _data,
      builder: (context, _) {
        final d = _data;
        final pages = <Widget>[
          ActivityTab(data: d),
          RemindersTab(data: d),
          WelfareTab(data: d),
          MessageTab(data: d),
          SetupTab(data: d, profile: _profile, onSwitch: _switch),
        ];
        return Scaffold(
          appBar: AppBar(
            toolbarHeight: 60,
            titleSpacing: 0,
            title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_profile.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              Text(_presence(d), style: const TextStyle(fontSize: 13, color: kSoft, fontWeight: FontWeight.w400)),
            ]),
            actions: [
              if (d.loading) const Padding(padding: EdgeInsets.only(right: 16), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
            ],
          ),
          body: AnimatedSwitcher(
            duration: const Duration(milliseconds: 180),
            child: KeyedSubtree(key: ValueKey('$_tab-${_profile.id}'), child: pages[_tab]),
          ),
          bottomNavigationBar: NavigationBar(
            height: 68,
            backgroundColor: Colors.white,
            indicatorColor: kFill,
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            destinations: const [
              NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Activity'),
              NavigationDestination(icon: Icon(Icons.notifications_none), selectedIcon: Icon(Icons.notifications), label: 'Reminders'),
              NavigationDestination(icon: Icon(Icons.favorite_border), selectedIcon: Icon(Icons.favorite), label: 'Welfare'),
              NavigationDestination(icon: Icon(Icons.mail_outline), selectedIcon: Icon(Icons.mail), label: 'Message'),
              NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: 'Setup'),
            ],
          ),
        );
      },
    );
  }
}
