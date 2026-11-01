import 'package:flutter/material.dart';

import '../family/family_login.dart';
import '../senior/senior_screen.dart';
import '../services/api.dart';
import '../services/store.dart';
import '../theme.dart';
import '../widgets/pressable.dart';

/// Where the app opens. Two doors, never mixed:
///   a phone that already has a senior linked opens STRAIGHT into that senior's chat (no start screen, no login, no password);
///   a phone with a family login opens the family area;
///   a phone with neither shows the start screen: the family logs in or signs up, or the senior types the code from the link they were sent.
class StartGate extends StatefulWidget {
  const StartGate({super.key});
  @override
  State<StartGate> createState() => _StartGateState();
}

class _StartGateState extends State<StartGate> {
  Widget? _next;

  @override
  void initState() {
    super.initState();
    _decide();
  }

  Future<void> _decide() async {
    final id = await Store.profileId();
    if (id != null) {
      if (mounted) setState(() => _next = const SeniorScreen());
      return;
    }
    final token = await Store.familyToken();
    if (token != null) {
      Api.familyToken = token;
      if (mounted) setState(() => _next = const FamilyHome());
      return;
    }
    if (mounted) setState(() => _next = const StartScreen());
  }

  @override
  Widget build(BuildContext context) => _next ?? const Scaffold(body: SizedBox.expand());
}

/// The id out of what a person typed or pasted: "a1b2c3d4", "/s/a1b2c3d4" or the whole link. null when it is not one.
String? codeFrom(String text) {
  final t = text.trim().toLowerCase().replaceAll(RegExp(r'/+$'), '');
  final m = RegExp(r'^(?:https?://[^\s/]+/s/|/s/|s/)?([a-f0-9]{8})$').firstMatch(t);
  return m?.group(1);
}

class StartScreen extends StatefulWidget {
  const StartScreen({super.key});
  @override
  State<StartScreen> createState() => _StartScreenState();
}

class _StartScreenState extends State<StartScreen> {
  bool _code = false, _busy = false;
  String? _error;
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    final id = codeFrom(_text.text);
    if (id == null) {
      setState(() => _error = 'That code does not look right. It is the last part of the link your family sent you.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await openSeniorLink(context, id);
    if (!ok && mounted) {
      setState(() {
        _busy = false;
        _error = 'Maya could not find that code. Please check it with your family.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kChatTop,
      body: DecoratedBox(
        decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [kChatTop, kChatBottom])),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  const Text('Maya', textAlign: TextAlign.center, style: TextStyle(fontSize: 34, fontWeight: FontWeight.w800, letterSpacing: -0.8, color: kInk)),
                  const SizedBox(height: 28),
                  if (!_code) ...[
                    const Text('For the family', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: kSoft)),
                    const SizedBox(height: 8),
                    _Big(label: 'Log in', filled: true, onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const FamilyLogin(signup: false)))),
                    const SizedBox(height: 10),
                    _Big(label: 'Sign up', filled: false, onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const FamilyLogin(signup: true)))),
                    const SizedBox(height: 30),
                    const Text('For the person Maya talks with', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: kSoft)),
                    const SizedBox(height: 8),
                    const Text('Open the link your family sent you and Maya opens by herself. If it does not open, enter the code.', style: TextStyle(fontSize: 16, height: 1.35, color: kSoft)),
                    const SizedBox(height: 10),
                    _Big(label: 'Enter code', filled: false, onTap: () => setState(() => _code = true)),
                  ] else ...[
                    const Text('Enter the code', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: kInk)),
                    const SizedBox(height: 6),
                    const Text('It is the last part of the link your family sent you, after /s/.', style: TextStyle(fontSize: 16, height: 1.35, color: kSoft)),
                    const SizedBox(height: 14),
                    TextField(controller: _text, autofocus: true, autocorrect: false, enableSuggestions: false, textInputAction: TextInputAction.go, onSubmitted: (_) => _open(), decoration: const InputDecoration(hintText: 'For example a1b2c3d4'), style: const TextStyle(fontSize: 20)),
                    if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(fontSize: 15, color: kAlert))),
                    const SizedBox(height: 14),
                    _Big(label: _busy ? 'Opening...' : 'Open Maya', filled: true, onTap: _busy ? null : _open),
                    TextButton(onPressed: () => setState(() {
                          _code = false;
                          _error = null;
                        }), child: const Text('Back', style: TextStyle(fontSize: 16, color: kSoft))),
                  ],
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Big extends StatelessWidget {
  final String label;
  final bool filled;
  final VoidCallback? onTap;
  const _Big({required this.label, required this.filled, required this.onTap});
  @override
  Widget build(BuildContext context) => Pressable(
        onTap: onTap,
        semanticLabel: label,
        child: Container(
          height: 60,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: filled ? kTrust : Colors.white, borderRadius: BorderRadius.circular(30), border: Border.all(color: filled ? kTrust : const Color(0xFFE2E7F6), width: 1.4)),
          child: Text(label, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: filled ? Colors.white : kInk)),
        ),
      );
}

/// A senior's link (or code) was opened: this phone becomes that person's phone and goes straight into the chat. No login, no password. false when the server does not know the code.
Future<bool> openSeniorLink(BuildContext context, String id) async {
  try {
    final j = await Api.get('/api/senior/$id');
    final p = j is Map ? j['profile'] : null;
    if (p is! Map || p['id'] is! String) return false;
    await Store.setProfile('${p['id']}', '${p['name'] ?? ''}');
    if (!context.mounted) return true;
    Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute<void>(builder: (_) => const SeniorScreen()), (r) => false);
    return true;
  } on ApiError {
    return false;
  }
}

/// A link tapped while the app is closed or open (https://.../s/ID): opens that senior's chat.
class LinkOpener extends StatefulWidget {
  final String id;
  const LinkOpener({super.key, required this.id});
  @override
  State<LinkOpener> createState() => _LinkOpenerState();
}

class _LinkOpenerState extends State<LinkOpener> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final ok = await openSeniorLink(context, widget.id);
      if (!ok && mounted) Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute<void>(builder: (_) => const StartScreen()), (r) => false);
    });
  }

  @override
  Widget build(BuildContext context) => const Scaffold(body: SizedBox.expand());
}
