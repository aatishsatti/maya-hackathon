import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models.dart';
import '../senior/profile_picker.dart';
import '../services/store.dart';
import '../theme.dart';
import '../widgets/pressable.dart';
import 'dashboard.dart';

/// The family area opens with a PIN. This is a lock on THIS phone, set here by the family: the Maya server has no family
/// accounts, so it is not a server login. (First time: choose a 4-digit PIN, then repeat it.)
class FamilyGate extends StatefulWidget {
  const FamilyGate({super.key});
  @override
  State<FamilyGate> createState() => _FamilyGateState();
}

class _FamilyGateState extends State<FamilyGate> with SingleTickerProviderStateMixin {
  bool? _hasPin;
  String _entry = '';
  String? _first; // while setting a new PIN: the first entry
  String? _message;
  int _wrong = 0;
  DateTime? _lockedUntil;
  Timer? _lockTick;
  late final AnimationController _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 240));

  @override
  void initState() {
    super.initState();
    Store.hasPin().then((v) {
      if (mounted) setState(() => _hasPin = v);
    });
  }

  @override
  void dispose() {
    _lockTick?.cancel();
    _shake.dispose();
    super.dispose();
  }

  bool get _locked => _lockedUntil != null && DateTime.now().isBefore(_lockedUntil!);

  String get _title => _hasPin == false ? (_first == null ? 'Choose a family PIN' : 'Repeat the PIN') : 'Family PIN';
  String get _hint => _hasPin == false ? 'Four digits. It locks the family area on this phone.' : 'Enter the PIN to open the family area.';

  Future<void> _digit(String d) async {
    if (_locked || _hasPin == null || _entry.length >= 4) return;
    HapticFeedback.selectionClick();
    setState(() {
      _entry += d;
      _message = null;
    });
    if (_entry.length == 4) await _submit();
  }

  Future<void> _submit() async {
    if (_hasPin == false) {
      if (_first == null) {
        setState(() {
          _first = _entry;
          _entry = '';
        });
        return;
      }
      if (_first == _entry) {
        await Store.setPin(_entry);
        await _enter();
      } else {
        _fail('The two PINs did not match. Please start again.');
        setState(() => _first = null);
      }
      return;
    }
    if (await Store.checkPin(_entry)) {
      await _enter();
    } else {
      _wrong++;
      if (_wrong >= 5) {
        _lockedUntil = DateTime.now().add(const Duration(seconds: 30));
        _lockTick = Timer.periodic(const Duration(seconds: 1), (_) {
          if (!mounted) return;
          if (!_locked) _lockTick?.cancel();
          setState(() {});
        });
        _wrong = 0;
        _fail('Too many tries. Please wait 30 seconds.');
      } else {
        _fail('That is not the PIN. Please try again.');
      }
    }
  }

  void _fail(String m) {
    HapticFeedback.heavyImpact();
    _shake.forward(from: 0);
    setState(() {
      _entry = '';
      _message = m;
    });
  }

  Future<void> _enter() async {
    var id = await Store.profileId();
    var name = await Store.profileName();
    if (id == null && mounted) {
      final p = await showProfilePicker(context);
      id = p?.id;
      name = p?.name;
    }
    if (!mounted) return;
    if (id == null) {
      Navigator.of(context).pop();
      return;
    }
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => FamilyDashboard(profile: Profile(id!, name ?? 'them'))));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Family')),
      body: SafeArea(
        child: Column(children: [
          const SizedBox(height: 8),
          Text(_title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: Text(_locked ? 'Locked for ${_lockedUntil!.difference(DateTime.now()).inSeconds + 1} seconds.' : (_message ?? _hint), textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, color: _message != null || _locked ? kAlert : kSoft))),
          const SizedBox(height: 8),
          AnimatedBuilder(
            animation: _shake,
            builder: (context, child) => Transform.translate(offset: Offset(12 * (1 - _shake.value) * ((_shake.value * 8).floor().isEven ? 1 : -1), 0), child: child),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 0; i < 4; i++)
                AnimatedContainer(duration: const Duration(milliseconds: 120), margin: const EdgeInsets.all(8), width: 16, height: 16, decoration: BoxDecoration(shape: BoxShape.circle, color: i < _entry.length ? kInk : Colors.white, border: Border.all(color: kInk, width: 1.5))),
            ]),
          ),
          // The keypad is drawn at its natural size and shrinks to fit a short screen, so it never needs to scroll.
          Expanded(
            child: Center(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['', '0', '<']])
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      for (final k in row)
                        Padding(
                          padding: const EdgeInsets.all(6),
                          child: k.isEmpty
                              ? const SizedBox(width: 68, height: 68)
                              : Pressable(
                                  onTap: () => k == '<' ? setState(() => _entry = _entry.isEmpty ? '' : _entry.substring(0, _entry.length - 1)) : _digit(k),
                                  semanticLabel: k == '<' ? 'Delete' : k,
                                  child: Container(width: 68, height: 68, decoration: const BoxDecoration(shape: BoxShape.circle, color: kFill), child: Center(child: k == '<' ? const Icon(Icons.backspace_outlined) : Text(k, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w600)))),
                                ),
                        ),
                    ]),
                ]),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}
