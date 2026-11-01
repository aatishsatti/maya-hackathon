import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models.dart';
import '../services/api.dart';
import '../services/native_call.dart';
import '../services/store.dart';
import '../start/start_gate.dart';
import '../theme.dart';
import '../widgets/pressable.dart';
import 'dashboard.dart';
import 'family_ring.dart';

/// The family door: a username and a password (the same account as on the web). There is no PIN. After signing up the family adds a family member (the server makes
/// their profile and gives a link for their phone); after logging in the family sees its dashboards, one per family member.
class FamilyLogin extends StatefulWidget {
  final bool signup;
  const FamilyLogin({super.key, required this.signup});
  @override
  State<FamilyLogin> createState() => _FamilyLoginState();
}

class _FamilyLoginState extends State<FamilyLogin> {
  late bool _signup = widget.signup;
  final _user = TextEditingController(), _pass = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final j = await Api.postJson('/api/family/${_signup ? 'signup' : 'login'}', {'username': _user.text.trim(), 'password': _pass.text});
      final token = j is Map ? '${j['token'] ?? ''}' : '';
      if (token.isEmpty) throw const ApiError('Maya could not log you in. Please try again.');
      await Store.setFamily('${(j as Map)['username']}', token);
      Api.familyToken = token;
      if (!mounted) return;
      Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute<void>(builder: (_) => FamilyHome(addFirst: _signup)), (r) => false);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_signup ? 'Sign up' : 'Log in')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(_signup ? 'Make a family account. Next you add the person Maya talks with.' : 'Welcome back.', style: const TextStyle(fontSize: 17, height: 1.35, color: kSoft)),
            const SizedBox(height: 18),
            TextField(controller: _user, autocorrect: false, enableSuggestions: false, textInputAction: TextInputAction.next, autofillHints: const [AutofillHints.username], decoration: const InputDecoration(labelText: 'Username'), style: const TextStyle(fontSize: 19)),
            const SizedBox(height: 14),
            TextField(controller: _pass, obscureText: true, autocorrect: false, enableSuggestions: false, onSubmitted: (_) => _busy ? null : _go(), autofillHints: [_signup ? AutofillHints.newPassword : AutofillHints.password], decoration: InputDecoration(labelText: 'Password', helperText: _signup ? 'At least 8 characters.' : null), style: const TextStyle(fontSize: 19)),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(fontSize: 15, color: kAlert))),
            const SizedBox(height: 20),
            FilledButton(style: FilledButton.styleFrom(backgroundColor: kTrust, minimumSize: const Size(48, 56)), onPressed: _busy ? null : _go, child: Text(_busy ? 'Please wait...' : (_signup ? 'Sign up' : 'Log in'))),
            TextButton(onPressed: () => setState(() {
                  _signup = !_signup;
                  _error = null;
                }), child: Text(_signup ? 'I already have an account' : 'Make a family account', style: const TextStyle(fontSize: 16, color: kSoft))),
          ]),
        ),
      ),
    );
  }
}

/// The family's own people: one dashboard each. Also where a family member is added and the family logs out.
class FamilyHome extends StatefulWidget {
  final bool addFirst; // right after signing up
  final bool embedded; // inside the dashboard's Family Members page: no header of its own
  const FamilyHome({super.key, this.addFirst = false, this.embedded = false});
  @override
  State<FamilyHome> createState() => _FamilyHomeState();
}

class _FamilyHomeState extends State<FamilyHome> {
  List<Profile>? _seniors;
  String? _error;

  StreamSubscription<({String seniorId, String episodeId, String act})>? _ringSub;

  @override
  void dispose() {
    _ringSub?.cancel();
    super.dispose();
  }

  // The family phone registers for push (so a ring reaches it while the app is closed) and listens for a ring that was tapped or accepted from the notification.
  Future<void> _push() async {
    final token = await Store.familyToken();
    if (token == null) return;
    await NativeCall.instance.startFamily(token);
    _ringSub ??= NativeCall.instance.familyRing.listen(_ringFromPush);
  }

  Future<void> _ringFromPush(({String seniorId, String episodeId, String act}) r) async {
    try {
      final v = await Api.get('/api/care/${r.seniorId}');
      final eps = v is Map && v['escalations'] is List ? v['escalations'] as List : const [];
      final e = eps.cast<dynamic>().firstWhere((x) => x is Map && x['id'] == r.episodeId, orElse: () => null);
      final name = v is Map ? '${v['name'] ?? 'them'}' : 'them';
      if (!mounted) return;
      if (r.act == 'accepted') {
        try {
          await Api.postJson('/api/care/${r.seniorId}/escalation/${r.episodeId}/accepted');
        } on ApiError {
          // the dashboard still opens
        }
        if (mounted) await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FamilyDashboard(profile: Profile(r.seniorId, name))));
      } else if (e is Map && e['status'] == 'ringing') {
        await showFamilyRing(context, seniorId: r.seniorId, episodeId: r.episodeId, text: '${e['text']}');
      } else if (mounted) {
        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FamilyDashboard(profile: Profile(r.seniorId, name))));
      }
    } on ApiError {
      // the ring ended or the login is gone: the family list is shown as it is
    }
  }

  @override
  void initState() {
    super.initState();
    unawaited(_push());
    _load().then((_) {
      if (widget.addFirst && mounted && (_seniors?.isEmpty ?? false)) _add();
    });
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final j = await Api.get('/api/family/me');
      final list = (j is Map && j['seniors'] is List) ? (j['seniors'] as List).map(Profile.from).whereType<Profile>().toList() : <Profile>[];
      if (mounted) setState(() => _seniors = list);
    } on ApiError catch (e) {
      if (e.status == 401) {
        await _logout();
        return;
      }
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _logout() async {
    try {
      await Api.postJson('/api/family/logout');
    } on ApiError {
      // the phone forgets the login either way
    }
    await Store.clearFamily();
    Api.familyToken = null;
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute<void>(builder: (_) => const StartScreen()), (r) => false);
  }

  Future<void> _add() async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AddSenior()));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: widget.embedded ? null : AppBar(title: const Text('Your family'), actions: [TextButton(onPressed: _logout, child: const Text('Log out'))]),
      body: SafeArea(
        child: _seniors == null
            ? Center(child: _error == null ? const CircularProgressIndicator() : Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: const TextStyle(fontSize: 16, color: kAlert))))
            : ListView(padding: const EdgeInsets.all(20), children: [
                if (_seniors!.isEmpty) const Padding(padding: EdgeInsets.only(bottom: 16), child: Text('Add the person Maya talks with. It takes two minutes.', style: TextStyle(fontSize: 17, height: 1.35, color: kSoft))),
                for (final p in _seniors!)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Pressable(
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FamilyDashboard(profile: p))),
                      semanticLabel: p.name,
                      child: Container(
                        height: 68,
                        padding: const EdgeInsets.symmetric(horizontal: 20),
                        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(22), border: Border.all(color: const Color(0xFFE2E7F6), width: 1.4)),
                        child: Row(children: [
                          Expanded(child: Text(p.name, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w700, color: kInk))),
                          const Icon(Icons.chevron_right, color: kSoft),
                        ]),
                      ),
                    ),
                  ),
                OutlinedButton(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 56)), onPressed: _add, child: const Text('Add a family member')),
                if (widget.embedded) Padding(padding: const EdgeInsets.only(top: 12), child: TextButton(onPressed: _logout, child: const Text('Log out', style: TextStyle(fontSize: 16, color: kSoft)))),
              ]),
      ),
    );
  }
}

/// Adding a family member: their name, their phone or WhatsApp number (optional), their time zone, how careful Maya should be, and the family's consent that Maya may call
/// the family if they go quiet. The server makes the profile and answers with the link for their phone.
class AddSenior extends StatefulWidget {
  const AddSenior({super.key});
  @override
  State<AddSenior> createState() => _AddSeniorState();
}

class _AddSeniorState extends State<AddSenior> {
  final _name = TextEditingController(), _phone = TextEditingController(), _tz = TextEditingController(text: DateTime.now().timeZoneName);
  String _mode = 'standard';
  bool _consent = false, _busy = false;
  String? _error, _link;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _tz.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final j = await Api.postJson('/api/family/seniors', {'name': _name.text.trim(), if (_phone.text.trim().isNotEmpty) 'phone': _phone.text.trim(), if (_tz.text.trim().isNotEmpty) 'tz': _tz.text.trim(), 'mode': _mode, 'consent': _consent});
      if (mounted) setState(() => _link = j is Map ? '${j['link']}' : null);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_link != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Added')),
        body: SafeArea(
          child: ListView(padding: const EdgeInsets.all(24), children: [
            Text('${_name.text.trim()} is added.', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: kInk)),
            const SizedBox(height: 10),
            const Text('Send this link to their phone, by WhatsApp or text. When they tap it, Maya opens straight into the chat: no sign up and no password.', style: TextStyle(fontSize: 17, height: 1.35, color: kSoft)),
            const SizedBox(height: 16),
            SelectableText(_link!, style: const TextStyle(fontSize: 17, color: kInk)),
            const SizedBox(height: 14),
            OutlinedButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: _link!));
                if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Link copied')));
              },
              child: const Text('Copy the link'),
            ),
            const SizedBox(height: 10),
            const Text('If the link does not open the app, they can open Maya and tap "Enter code", then type the last 8 letters and numbers of the link.', style: TextStyle(fontSize: 15, height: 1.35, color: kSoft)),
            const SizedBox(height: 18),
            FilledButton(style: FilledButton.styleFrom(backgroundColor: kTrust, minimumSize: const Size(48, 56)), onPressed: () => Navigator.of(context).pop(), child: const Text('Done')),
          ]),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Add a family member')),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(24, 8, 24, 24), children: [
          TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Their name'), style: const TextStyle(fontSize: 19)),
          const SizedBox(height: 14),
          TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone or WhatsApp number (optional)', hintText: '+44 7700 900123'), style: const TextStyle(fontSize: 19)),
          const SizedBox(height: 14),
          TextField(controller: _tz, autocorrect: false, decoration: const InputDecoration(labelText: 'Their time zone', helperText: 'For example Europe/London or Asia/Kolkata'), style: const TextStyle(fontSize: 19)),
          const SizedBox(height: 14),
          DropdownButtonFormField<String>(
            initialValue: _mode,
            decoration: const InputDecoration(labelText: 'How careful should Maya be?'),
            items: const [
              DropdownMenuItem(value: 'standard', child: Text('Standard: the dashboard first')),
              DropdownMenuItem(value: 'cautious', child: Text('Cautious: tell the family sooner')),
              DropdownMenuItem(value: 'ultra', child: Text('Ultra Cautious: every time')),
            ],
            onChanged: (v) => setState(() => _mode = v ?? 'standard'),
          ),
          const SizedBox(height: 10),
          CheckboxListTile(contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, value: _consent, onChanged: (v) => setState(() => _consent = v ?? false), title: const Text('Maya may call the family in the Maya app if they go quiet. Calls only say who has not responded, never what they said.', style: TextStyle(fontSize: 16, height: 1.3))),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: const TextStyle(fontSize: 15, color: kAlert))),
          const SizedBox(height: 14),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: kTrust, minimumSize: const Size(48, 56)), onPressed: _busy || _name.text.trim().isEmpty && false ? null : _save, child: Text(_busy ? 'Adding...' : 'Add them')),
        ]),
      ),
    );
  }
}
