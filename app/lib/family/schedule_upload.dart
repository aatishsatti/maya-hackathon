import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../services/api.dart';
import '../theme.dart';
import '../widgets/pressable.dart';
import 'family_data.dart';

/// The family gives Maya the person's schedule: a photo, a PDF, typed words or a voice note. Maya reads it and lists what she found with NOTHING set; the family ticks the
/// ones they want and only those become call reminders in the Maya app (the same flow as the web dashboard).
class ScheduleUpload extends StatefulWidget {
  final FamilyData data;
  const ScheduleUpload({super.key, required this.data});
  @override
  State<ScheduleUpload> createState() => _ScheduleUploadState();
}

class _Found {
  final String id, task, when;
  bool ticked = false;
  _Found(this.id, this.task, this.when);
}

class _ScheduleUploadState extends State<ScheduleUpload> {
  String _source = 'photo';
  final _text = TextEditingController();
  final _rec = AudioRecorder();
  bool _recording = false, _busy = false;
  int _secs = 0;
  Timer? _timer;
  String? _error, _done;
  List<_Found> _found = const [];

  @override
  void dispose() {
    _timer?.cancel();
    _text.dispose();
    _rec.dispose();
    super.dispose();
  }

  String get _base => '/api/care/${widget.data.profileId}/schedule';

  Future<void> _read(Future<dynamic> Function() go) async {
    setState(() {
      _busy = true;
      _error = null;
      _done = null;
      _found = const [];
    });
    try {
      final j = await go();
      final items = (j is Map && j['items'] is List) ? j['items'] as List : const [];
      final out = [for (final i in items) if (i is Map) _Found('${i['id']}', '${i['task']}', '${i['when']}')];
      if (mounted) {
        setState(() {
          _found = out;
          if (out.isEmpty) _error = 'Maya could not find anything with a clear time in that. You can type the schedule instead.';
        });
      }
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _photo() async {
    XFile? f;
    try {
      f = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1800, imageQuality: 85);
    } catch (_) {
      setState(() => _error = 'Your photos could not open. Please check that Maya may use them in Settings.');
      return;
    }
    if (f == null) return;
    final Uint8List bytes = await f.readAsBytes();
    await _read(() => Api.postBytes('$_base/image', bytes, 'image/jpeg'));
  }

  Future<void> _pdf() async {
    FilePickerResult? r;
    try {
      r = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: const ['pdf'], withData: true);
    } catch (_) {
      setState(() => _error = 'Your files could not open. Please check that Maya may use them in Settings.');
      return;
    }
    final bytes = r?.files.single.bytes;
    if (bytes == null) return;
    if (bytes.length > 8 * 1024 * 1024) {
      setState(() => _error = 'That PDF is too big (8 MB at most). Please send a photo of the page instead.');
      return;
    }
    await _read(() => Api.postBytes('$_base/pdf', bytes, 'application/pdf'));
  }

  Future<void> _voice() async {
    if (_recording) {
      _timer?.cancel();
      String? path;
      try {
        path = await _rec.stop();
      } catch (_) {}
      setState(() => _recording = false);
      if (path == null) return;
      final bytes = await File(path).readAsBytes();
      try {
        await File(path).delete();
      } catch (_) {}
      await _read(() => Api.postBytes('$_base/voice', bytes, 'audio/wav'));
      return;
    }
    try {
      if (!await _rec.hasPermission()) {
        setState(() => _error = 'Maya needs the microphone to hear you. Please allow it in Settings.');
        return;
      }
      final dir = await getTemporaryDirectory();
      await _rec.start(const RecordConfig(encoder: AudioEncoder.wav, sampleRate: 24000, numChannels: 1), path: '${dir.path}/schedule_${DateTime.now().millisecondsSinceEpoch}.wav');
      setState(() {
        _recording = true;
        _secs = 0;
        _error = null;
      });
      _timer = Timer.periodic(const Duration(seconds: 1), (_) => mounted ? setState(() => _secs++) : null);
    } catch (_) {
      setState(() => _error = 'The recording could not start. Please try again.');
    }
  }

  Future<void> _set() async {
    final ids = [for (final f in _found) if (f.ticked) f.id];
    setState(() => _busy = true);
    try {
      final r = await Api.postJson('$_base/set', {'ids': ids});
      final set = (r is Map && r['set'] is List) ? (r['set'] as List).map((x) => '$x').toList() : <String>[];
      final failed = (r is Map && r['failed'] is List) ? (r['failed'] as List).map((x) => '$x').toList() : <String>[];
      final skipped = (r is Map && r['skipped'] is List) ? (r['skipped'] as List).map((x) => '$x').toList() : <String>[];
      if (mounted) {
        setState(() {
          _found = const [];
          _done = '${set.isNotEmpty ? 'Set ${set.length == 1 ? '1 reminder' : '${set.length} reminders'}: ${set.join('; ')}. ' : 'Nothing was set. '}${failed.isNotEmpty ? 'Could not set: ${failed.join('; ')}. ' : ''}${skipped.isNotEmpty ? 'Not set (not ticked): ${skipped.join('; ')}.' : ''}'.trim();
        });
      }
      widget.data.refresh(quiet: true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final n = _found.where((f) => f.ticked).length;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Text('Give Maya their schedule: medicine, doctor, meals, walks, calls. She reads it and shows what she found. Nothing is set until you tick it.', style: TextStyle(fontSize: 15, height: 1.4, color: kSoft)),
        const SizedBox(height: 16),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'photo', label: Text('Photo')), ButtonSegment(value: 'pdf', label: Text('PDF')), ButtonSegment(value: 'text', label: Text('Type it')), ButtonSegment(value: 'voice', label: Text('Voice'))],
          selected: {_source},
          showSelectedIcon: false,
          onSelectionChanged: _busy || _recording ? null : (s) => setState(() => _source = s.first),
        ),
        const SizedBox(height: 16),
        if (_source == 'photo') OutlinedButton(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 56)), onPressed: _busy ? null : _photo, child: const Text('Choose a photo')),
        if (_source == 'pdf') OutlinedButton(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 56)), onPressed: _busy ? null : _pdf, child: const Text('Choose a PDF')),
        if (_source == 'text') ...[
          TextField(controller: _text, minLines: 4, maxLines: 8, maxLength: 6000, decoration: const InputDecoration(hintText: 'For example: blood pressure tablet at 8 am every day, walk at 5 pm, Dr Rao on Thursday at 10:30')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: kTrust, minimumSize: const Size(48, 52)), onPressed: _busy ? null : () => _text.text.trim().isEmpty ? setState(() => _error = 'Type the schedule first.') : _read(() => Api.postJson('$_base/text', {'text': _text.text.trim()})), child: const Text('Read it')),
        ],
        if (_source == 'voice') ...[
          FilledButton(style: FilledButton.styleFrom(backgroundColor: _recording ? kAlert : kTrust, minimumSize: const Size(48, 56)), onPressed: _busy ? null : _voice, child: Text(_recording ? 'Stop and read it ($_secs s)' : 'Start recording')),
        ],
        if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: Text('Maya is reading it...', style: TextStyle(fontSize: 15, color: kSoft))),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(fontSize: 15, color: kAlert))),
        if (_done != null) Container(margin: const EdgeInsets.only(top: 16), padding: const EdgeInsets.all(16), decoration: BoxDecoration(color: kTrustSoft, borderRadius: BorderRadius.circular(12)), child: Text(_done!, style: const TextStyle(fontSize: 16, height: 1.4))),
        if (_found.isNotEmpty) ...[
          const SizedBox(height: 20),
          const Text('What Maya found', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('Tick the ones you want. Each becomes a call at its time, in the Maya app.', style: TextStyle(fontSize: 14, color: kSoft)),
          const SizedBox(height: 8),
          for (final f in _found)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Pressable(
                onTap: () => setState(() => f.ticked = !f.ticked),
                semanticLabel: '${f.task}, ${f.when}',
                child: Container(
                  constraints: const BoxConstraints(minHeight: 56),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: kFill, borderRadius: BorderRadius.circular(12)),
                  child: Row(children: [
                    Icon(f.ticked ? Icons.check_box : Icons.check_box_outline_blank, color: f.ticked ? kTrust : kSoft),
                    const SizedBox(width: 12),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(f.task, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)), Text(f.when, style: const TextStyle(fontSize: 14, color: kSoft))])),
                  ]),
                ),
              ),
            ),
          const SizedBox(height: 8),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: kTrust, minimumSize: const Size(48, 56)), onPressed: _busy || n == 0 ? null : _set, child: Text(n == 0 ? 'Tick the ones you want' : 'Set $n ${n == 1 ? 'reminder' : 'reminders'}')),
        ],
      ]),
    );
  }
}
