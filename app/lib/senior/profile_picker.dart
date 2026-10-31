import 'package:flutter/material.dart';

import '../models.dart';
import '../services/api.dart';
import '../services/store.dart';
import '../theme.dart';

/// Who is this phone for? Done once by the family. Name and gender only; Maya keeps her memory of each person on the server.
Future<Profile?> showProfilePicker(BuildContext context, {bool allowAdd = true}) {
  return showModalBottomSheet<Profile>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => Padding(padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom), child: _Picker(allowAdd: allowAdd)),
  );
}

class _Picker extends StatefulWidget {
  final bool allowAdd;
  const _Picker({required this.allowAdd});
  @override
  State<_Picker> createState() => _PickerState();
}

class _PickerState extends State<_Picker> {
  List<Profile>? _profiles;
  String? _error;
  bool _adding = false, _busy = false;
  final _name = TextEditingController();
  String _gender = 'prefer-not';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final j = await Api.get('/api/profiles');
      final list = (j is Map && j['profiles'] is List) ? (j['profiles'] as List).map(Profile.from).whereType<Profile>().toList() : <Profile>[];
      if (!mounted) return;
      setState(() {
        _profiles = list;
        _adding = list.isEmpty && widget.allowAdd;
      });
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final j = await Api.postJson('/api/profiles', {'name': _name.text, 'gender': _gender});
      final p = Profile.from(j is Map ? j['profile'] : null);
      if (p == null) throw const ApiError('Maya could not add that person. Please try again.');
      await Store.setProfile(p.id, p.name);
      if (mounted) Navigator.of(context).pop(p);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Who is Maya talking with?', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('Choose once. Maya remembers each person separately.', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 14),
            if (_error != null) _ErrorRow(message: _error!, onRetry: _profiles == null ? _load : null),
            if (_profiles == null && _error == null) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
            if (_profiles != null && !_adding)
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.4),
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final p in _profiles!)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: OutlinedButton(
                          onPressed: () async {
                            await Store.setProfile(p.id, p.name);
                            if (context.mounted) Navigator.of(context).pop(p);
                          },
                          style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft, minimumSize: const Size.fromHeight(56)),
                          child: Text(p.name, style: const TextStyle(fontSize: 18)),
                        ),
                      ),
                  ],
                ),
              ),
            if (_adding) ...[
              TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Name'), autofocus: true),
              const SizedBox(height: 12),
              Wrap(spacing: 8, children: [
                for (final g in const [('female', 'Female'), ('male', 'Male'), ('prefer-not', 'Prefer not to say')])
                  ChoiceChip(label: Text(g.$2), selected: _gender == g.$1, onSelected: (_) => setState(() => _gender = g.$1), materialTapTargetSize: MaterialTapTargetSize.padded),
              ]),
              const SizedBox(height: 14),
              FilledButton(onPressed: _busy ? null : _create, child: Text(_busy ? 'Adding...' : 'Add')),
            ],
            if (_profiles != null && !_adding && widget.allowAdd) TextButton(onPressed: () => setState(() => _adding = true), child: const Text('Add another person')),
          ],
        ),
      ),
    );
  }
}

class _ErrorRow extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorRow({required this.message, this.onRetry});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(children: [
          Expanded(child: Text(message, style: const TextStyle(color: kAlert, fontSize: 15))),
          if (onRetry != null) TextButton(onPressed: onRetry, child: const Text('Try again')),
        ]),
      );
}
