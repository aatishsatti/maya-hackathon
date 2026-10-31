import 'package:flutter/material.dart';

import '../models.dart';
import '../senior/profile_picker.dart';
import '../services/api.dart';
import '../services/store.dart';
import '../theme.dart';
import '../widgets/pill.dart';
import 'common.dart';
import 'family_data.dart';

/// Setup: the WhatsApp number, how reminders reach them, the mode, the people, the PIN.
class SetupTab extends StatefulWidget {
  final FamilyData data;
  final Profile profile;
  final ValueChanged<Profile> onSwitch;
  const SetupTab({super.key, required this.data, required this.profile, required this.onSwitch});
  @override
  State<SetupTab> createState() => _SetupTabState();
}

class _SetupTabState extends State<SetupTab> {
  final _phone = TextEditingController();
  bool _agreed = false, _busy = false;

  FamilyData get d => widget.data;

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final delivery = (d.care['delivery'] is Map ? (d.care['delivery'] as Map)['reminders'] : null) as String? ?? 'voice';
    return ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 24), children: [
      sectionLabel('WhatsApp'),
      if (!d.configured) const Text('WhatsApp is not set up on this server yet.', style: TextStyle(fontSize: 15, color: kSoft)),
      if (d.configured && d.linked && d.optIn) ...[
        Row(children: [
          Expanded(child: Text('Number ending ${d.phoneEnd ?? ''}.', style: const TextStyle(fontSize: 16))),
          Pill(d.windowOpen ? 'Can message' : 'Waiting for them to write', tone: d.windowOpen ? kToneOk : kTonePlain),
        ]),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: () async {
            final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: const Text('Unlink this number?'), content: const Text('Maya will stop messaging and calling this WhatsApp number.'), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep')), TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Unlink'))]));
            if (ok != true || !context.mounted) return;
            if (await act(context, () => Api.delete('/api/whatsapp/${d.profileId}'), done: 'Unlinked.')) d.refresh(quiet: true);
          },
          child: const Text('Unlink this number'),
        ),
      ],
      if (d.configured && !(d.linked && d.optIn)) ...[
        Text(d.linked ? 'They stopped messages from Maya (number ending ${d.phoneEnd ?? ''}). Link again once they agree.' : 'Link their number once they have agreed to hear from Maya on WhatsApp.', style: const TextStyle(fontSize: 15, color: kSoft)),
        const SizedBox(height: 8),
        TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'WhatsApp number with country code, e.g. 447700900123')),
        CheckboxListTile(contentPadding: EdgeInsets.zero, value: _agreed, onChanged: (v) => setState(() => _agreed = v ?? false), title: const Text('They have agreed to hear from Maya on WhatsApp', style: TextStyle(fontSize: 15)), controlAffinity: ListTileControlAffinity.leading),
        FilledButton(
          onPressed: _busy
              ? null
              : () async {
                  setState(() => _busy = true);
                  final ok = await act(context, () => Api.postJson('/api/whatsapp/${d.profileId}/link', {'phone': _phone.text, 'optIn': _agreed}), done: 'Linked.');
                  if (mounted) setState(() => _busy = false);
                  if (ok) {
                    _phone.clear();
                    d.refresh(quiet: true);
                  }
                },
          child: const Text('Link this number'),
        ),
      ],
      sectionLabel('When no pick is made, send reminders on WhatsApp as'),
      SegmentedButton<String>(
        segments: const [ButtonSegment(value: 'voice', label: Text('Voice note')), ButtonSegment(value: 'text', label: Text('Text'))],
        selected: {delivery},
        onSelectionChanged: (s) async {
          if (await act(context, () => Api.postJson('/api/care/${d.profileId}/delivery', {'reminders': s.first}))) d.refresh(quiet: true);
        },
      ),
      sectionLabel('Mode'),
      RadioGroup<String>(
        groupValue: d.mode,
        onChanged: (v) async {
          if (v != null && await act(context, () => Api.postJson('/api/care/${d.profileId}/mode', {'mode': v}))) d.refresh(quiet: true);
        },
        child: Column(children: [
          for (final e in d.modes.entries)
            RadioListTile<String>(
              contentPadding: EdgeInsets.zero,
              value: e.key,
              title: Text('${(e.value is Map ? e.value['label'] : e.key)}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              subtitle: e.value is Map && e.value['blurb'] != null ? Text('${e.value['blurb']}', style: const TextStyle(fontSize: 13)) : null,
            ),
        ]),
      ),
      sectionLabel('People'),
      OutlinedButton(
        onPressed: () async {
          final p = await showProfilePicker(context);
          if (p != null) widget.onSwitch(p);
        },
        child: Text('Change person (now ${widget.profile.name})'),
      ),
      const SizedBox(height: 8),
      OutlinedButton(
        onPressed: () async {
          final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: Text('Delete ${widget.profile.name}?'), content: const Text('This deletes the person and everything Maya remembers about them. It cannot be undone.'), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep')), TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete', style: TextStyle(color: kAlert)))]));
          if (ok != true || !context.mounted) return;
          if (await act(context, () => Api.delete('/api/profiles/${d.profileId}'), done: 'Deleted.')) {
            await Store.clearProfile();
            if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
          }
        },
        child: Text('Delete ${widget.profile.name}', style: const TextStyle(color: kAlert)),
      ),
      sectionLabel('This phone'),
      OutlinedButton(
        onPressed: () async {
          final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: const Text('Change the family PIN?'), content: const Text('You will choose a new PIN the next time you open the family area. The PIN only locks this phone.'), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Change'))]));
          if (ok != true) return;
          await Store.clearPin();
          if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
        },
        child: const Text('Change the family PIN'),
      ),
    ]);
  }
}
