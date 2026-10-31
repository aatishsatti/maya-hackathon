import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../family/family_gate.dart';
import '../models.dart';
import '../services/api.dart';
import '../services/call_session.dart';
import '../services/events.dart';
import '../services/native_call.dart';
import '../services/store.dart';
import '../services/tz.dart';
import '../theme.dart';
import '../widgets/pressable.dart';
import 'call_screen.dart';
import 'chat_view.dart';
import 'profile_picker.dart';

/// The senior's whole app: one screen, no login, no menu. A big Call button in the middle, the chat below it, and a small
/// Family link at the bottom. Nothing on this screen scrolls except the chat, inside its own area.
class SeniorScreen extends StatefulWidget {
  const SeniorScreen({super.key});
  @override
  State<SeniorScreen> createState() => _SeniorScreenState();
}

class _SeniorScreenState extends State<SeniorScreen> with WidgetsBindingObserver {
  String? _pid, _name;
  bool _ready = false;
  final List<ChatMessage> _messages = [];
  final _scroll = ScrollController();
  final _text = TextEditingController();
  final _focus = FocusNode();
  String? _busy, _error; // _busy: "Maya is thinking..."
  bool _recording = false;
  AudioRecorder? _rec;
  Timer? _recTimer;
  int _recSeconds = 0;
  SeniorEvents? _events;
  StreamSubscription<SseEvent>? _eventSub;
  Map<String, dynamic>? _incoming; // a ring from Maya while the app is open
  Map<String, dynamic>? _notice; // a note from the family
  Timer? _ringTimer;
  bool _inCall = false;
  StreamSubscription<String>? _nativeAccept, _nativeEnd;
  CallSession? _live; // the call on screen, so the system call screen's hang-up can end it

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _boot();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _eventSub?.cancel();
    _nativeAccept?.cancel();
    _nativeEnd?.cancel();
    _events?.stop();
    _ringTimer?.cancel();
    _recTimer?.cancel();
    _rec?.dispose();
    _scroll.dispose();
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _pid != null && !_inCall) _loadThread();
  }

  Future<void> _boot() async {
    final id = await Store.profileId();
    final name = await Store.profileName();
    if (!mounted) return;
    setState(() {
      _pid = id;
      _name = name;
      _ready = true;
    });
    if (id != null) _attach(id);
  }

  // A ring that reached a CLOSED phone (a push -> the system call screen): Accept joins the same live call as an in-app Accept.
  void _listenNative(String id) {
    _nativeAccept ??= NativeCall.instance.accepted.listen((oid) {
      if (!mounted || _inCall) return;
      _dropIncoming();
      _startCall(reason: 'reminder', outreachId: oid);
    });
    _nativeEnd ??= NativeCall.instance.ended.listen((_) => _live?.hangUp());
    NativeCall.instance.start(id);
  }

  void _attach(String id) {
    _eventSub?.cancel();
    _events?.stop();
    final ev = _events = SeniorEvents(id);
    _eventSub = ev.stream.listen(_onEvent);
    ev.start();
    _listenNative(id);
    _loadThread();
  }

  Future<void> _loadThread() async {
    final id = _pid;
    if (id == null) return;
    try {
      final tz = await Tz.name();
      final j = await Api.get('/api/chat/$id', query: tz == null ? null : {'tz': tz});
      final list = (j is Map && j['messages'] is List) ? (j['messages'] as List).map(ChatMessage.from).whereType<ChatMessage>().toList() : <ChatMessage>[];
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(list);
        _error = null;
      });
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _onEvent(SseEvent e) {
    final id = _pid;
    if (id == null || !mounted) return;
    switch (e.name) {
      case 'incoming':
        Api.postJson('/api/care/$id/notifications/${e.data['notifId']}/delivered').catchError((_) => null);
        if (_inCall) return; // never ring over a live call
        NativeCall.instance.dismiss('${e.data['outreachId']}'); // the app is open: it rings here, not on the system call screen too
        setState(() => _incoming = e.data);
        _ringTimer?.cancel();
        _ringTimer = Timer.periodic(const Duration(milliseconds: 1400), (_) {
          HapticFeedback.heavyImpact();
          SystemSound.play(SystemSoundType.alert);
        });
        HapticFeedback.heavyImpact();
        break;
      case 'incomingEnd':
        if (_incoming != null && '${_incoming!['outreachId']}' == '${e.data['outreachId']}') _dropIncoming();
        break;
      case 'chat':
        final m = ChatMessage.from(e.data['message']);
        if (m != null && !_messages.any((x) => x.id == m.id)) {
          setState(() => _messages.add(m));
          HapticFeedback.selectionClick();
        }
        break;
      case 'notice':
        Api.postJson('/api/care/$id/notifications/${e.data['notifId']}/delivered').catchError((_) => null);
        setState(() => _notice = e.data);
        HapticFeedback.mediumImpact();
        break;
    }
  }

  void _dropIncoming() {
    _ringTimer?.cancel();
    if (mounted) setState(() => _incoming = null);
  }

  Future<void> _acceptIncoming() async {
    final d = _incoming;
    if (d == null) return;
    _dropIncoming();
    Api.postJson('/api/care/$_pid/notifications/${d['notifId']}/seen').catchError((_) => null);
    await _startCall(reason: '${d['kind']}', outreachId: '${d['outreachId']}');
  }

  void _declineIncoming() {
    final d = _incoming;
    if (d == null) return;
    _dropIncoming();
    Api.postJson('/api/care/$_pid/outreach/${d['outreachId']}/decline').catchError((_) => null);
  }

  Future<void> _ensureProfile() async {
    if (_pid != null) return;
    final p = await showProfilePicker(context);
    if (p != null && mounted) {
      setState(() {
        _pid = p.id;
        _name = p.name;
      });
      _attach(p.id);
    }
  }

  Future<void> _startCall({String? reason, String? outreachId}) async {
    await _ensureProfile();
    final id = _pid;
    if (id == null || !mounted || _inCall) return;
    _inCall = true;
    final session = _live = CallSession(profileId: id, reason: reason, outreachId: outreachId);
    await Navigator.of(context).push(PageRouteBuilder<void>(
      transitionDuration: const Duration(milliseconds: 240),
      reverseTransitionDuration: const Duration(milliseconds: 200),
      pageBuilder: (_, _, _) => CallScreen(session: session),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));
    _inCall = false;
    _live = null;
    if (outreachId != null) NativeCall.instance.callEnded(outreachId);
    if (mounted) _loadThread();
  }

  void _toBottom() {
    if (_scroll.hasClients) _scroll.animateTo(0, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
  }

  Future<void> _sendText() async {
    final t = _text.text.trim();
    if (t.isEmpty || _busy != null) return;
    await _ensureProfile();
    final id = _pid;
    if (id == null) return;
    HapticFeedback.lightImpact();
    final pending = ChatMessage(id: 'p${DateTime.now().microsecondsSinceEpoch}', role: 'senior', kind: 'text', text: t, pending: true);
    setState(() {
      _messages.add(pending);
      _busy = 'Maya is thinking...';
      _error = null;
      _text.clear();
    });
    _toBottom();
    try {
      final tz = await Tz.name();
      final j = await Api.postJson('/api/chat/$id/message', {'text': t}, tz == null ? null : {'tz': tz});
      _apply(pending, j);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _messages.remove(pending);
        _error = e.message;
        _text.text = t; // nothing is lost: the words are back in the box
      });
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  void _apply(ChatMessage pending, dynamic j) {
    final list = (j is Map && j['messages'] is List) ? (j['messages'] as List).map(ChatMessage.from).whereType<ChatMessage>().toList() : <ChatMessage>[];
    if (!mounted) return;
    setState(() {
      final at = _messages.indexOf(pending);
      if (at >= 0) _messages.removeAt(at);
      _messages.addAll(list.where((m) => !_messages.any((x) => x.id == m.id)));
    });
    _toBottom();
  }

  Future<void> _toggleRecord() async {
    if (_busy != null && !_recording) return;
    if (_recording) {
      await _stopAndSend();
      return;
    }
    await _ensureProfile();
    if (_pid == null) return;
    final rec = _rec ??= AudioRecorder();
    try {
      if (!await rec.hasPermission()) {
        setState(() => _error = 'Maya needs the microphone to hear your voice note. Please allow it in Settings.');
        return;
      }
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/note_${DateTime.now().millisecondsSinceEpoch}.wav';
      await rec.start(const RecordConfig(encoder: AudioEncoder.wav, sampleRate: 24000, numChannels: 1, echoCancel: true, noiseSuppress: true), path: path);
      HapticFeedback.mediumImpact();
      setState(() {
        _recording = true;
        _recSeconds = 0;
        _error = null;
      });
      _recTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        setState(() => _recSeconds++);
        if (_recSeconds >= 120) _stopAndSend();
      });
    } catch (_) {
      setState(() => _error = 'The voice note could not start. Please try again.');
    }
  }

  Future<void> _stopAndSend() async {
    _recTimer?.cancel();
    final id = _pid;
    String? path;
    try {
      path = await _rec?.stop();
    } catch (_) {}
    if (!mounted) return;
    setState(() => _recording = false);
    if (path == null || id == null) {
      setState(() => _error = 'The voice note could not be saved. Please try again.');
      return;
    }
    if (_recSeconds < 1) {
      setState(() => _error = 'That was too short. Hold on a little longer, then tap again.');
      return;
    }
    final pending = ChatMessage(id: 'p${DateTime.now().microsecondsSinceEpoch}', role: 'senior', kind: 'voice', text: '', pending: true);
    setState(() {
      _messages.add(pending);
      _busy = 'Maya is listening to your voice note...';
    });
    _toBottom();
    try {
      final bytes = await File(path).readAsBytes();
      final tz = await Tz.name();
      final j = await Api.postBytes('/api/chat/$id/voicenote', bytes, 'audio/wav', query: tz == null ? null : {'tz': tz});
      _apply(pending, j);
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _messages.remove(pending);
          _error = '${e.message} Your voice note was not sent.';
        });
      }
    } finally {
      try {
        await File(path).delete();
      } catch (_) {}
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _openFamily() async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const FamilyGate()));
    if (!mounted) return;
    final id = await Store.profileId();
    final name = await Store.profileName();
    if (id != _pid) {
      setState(() {
        _pid = id;
        _name = name;
        _messages.clear();
      });
      if (id != null) {
        _attach(id);
      } else {
        _events?.stop();
      }
    } else {
      _loadThread();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: Stack(children: [
          LayoutBuilder(builder: (context, box) {
            final kb = MediaQuery.of(context).viewInsets.bottom > 0;
            final compact = kb || box.maxHeight < 440;
            final callSize = compact ? 0.0 : (box.maxHeight * 0.26).clamp(104.0, 190.0);
            return Column(children: [
              if (!compact)
                SizedBox(
                  height: 52,
                  child: Center(child: Text(_name == null ? 'Maya' : 'Maya and $_name', style: Theme.of(context).textTheme.titleMedium)),
                ),
              if (!compact)
                SizedBox(
                  height: callSize + 44,
                  child: Center(child: _CallButton(size: callSize, onTap: _ready ? () => _startCall() : null)),
                ),
              Expanded(child: ClipRect(child: ChatView(messages: _messages, controller: _scroll))),
              if (_notice != null) _NoticeBar(text: '${_notice!['text']}', label: _notice!['kind'] == 'reminder' ? 'Reminder from your family' : 'Message from your family', onClose: () {
                Api.postJson('/api/care/$_pid/notifications/${_notice!['notifId']}/seen').catchError((_) => null);
                setState(() => _notice = null);
              }),
              if (_busy != null) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text(_busy!, style: const TextStyle(fontSize: 15, color: kSoft))),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 2, 16, 4),
                  child: Row(children: [
                    Expanded(child: Text(_error!, style: const TextStyle(fontSize: 15, color: kAlert))),
                    TextButton(onPressed: () => setState(() => _error = null), child: const Text('OK')),
                  ]),
                ),
              _Composer(controller: _text, focus: _focus, recording: _recording, seconds: _recSeconds, busy: _busy != null, onSend: _sendText, onMic: _toggleRecord),
              if (!kb)
                SizedBox(
                  height: 48,
                  child: Center(child: TextButton(onPressed: _openFamily, child: const Text('Family', style: TextStyle(fontSize: 15, color: kSoft)))),
                ),
            ]);
          }),
          if (_incoming != null) _IncomingCard(text: '${_incoming!['text'] ?? 'Maya is calling'}', onAccept: _acceptIncoming, onDecline: _declineIncoming),
        ]),
      ),
    );
  }
}

class _CallButton extends StatefulWidget {
  final double size;
  final VoidCallback? onTap;
  const _CallButton({required this.size, this.onTap});
  @override
  State<_CallButton> createState() => _CallButtonState();
}

class _CallButtonState extends State<_CallButton> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200))..repeat();
  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.size;
    return Semantics(
      label: 'Call Maya',
      button: true,
      child: Pressable(
        onTap: widget.onTap,
        pressedScale: 0.94,
        child: SizedBox(
          width: s + 40,
          height: s + 40,
          child: Stack(alignment: Alignment.center, children: [
            AnimatedBuilder(
              animation: _pulse,
              builder: (context, _) => Container(
                width: s + 40 * _pulse.value,
                height: s + 40 * _pulse.value,
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: kAccent.withValues(alpha: 0.28 * (1 - _pulse.value)), width: 3)),
              ),
            ),
            Container(
              width: s,
              height: s,
              decoration: const BoxDecoration(shape: BoxShape.circle, color: kAccent),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(Icons.call, color: Colors.white, size: s * 0.34),
                SizedBox(height: s * 0.04),
                Text('Call Maya', style: TextStyle(color: Colors.white, fontSize: (s * 0.12).clamp(15, 22), fontWeight: FontWeight.w700)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focus;
  final bool recording, busy;
  final int seconds;
  final VoidCallback onSend, onMic;
  const _Composer({required this.controller, required this.focus, required this.recording, required this.seconds, required this.busy, required this.onSend, required this.onMic});

  @override
  Widget build(BuildContext context) {
    final mm = '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: Row(children: [
        Pressable(
          onTap: busy && !recording ? null : onMic,
          semanticLabel: recording ? 'Stop and send the voice note' : 'Record a voice note',
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            width: 52,
            height: 52,
            decoration: BoxDecoration(shape: BoxShape.circle, color: recording ? kAlert : Colors.white, border: Border.all(color: recording ? kAlert : kLine, width: 1.5)),
            child: Icon(recording ? Icons.stop : Icons.mic, color: recording ? Colors.white : kInk),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: recording
              ? Container(height: 52, alignment: Alignment.centerLeft, padding: const EdgeInsets.symmetric(horizontal: 16), decoration: BoxDecoration(border: Border.all(color: kAlert, width: 1.5), borderRadius: BorderRadius.circular(14)), child: Text('Recording $mm. Tap the square to send.', style: const TextStyle(fontSize: 16, color: kAlert)))
              : TextField(controller: controller, focusNode: focus, minLines: 1, maxLines: 2, textInputAction: TextInputAction.send, onSubmitted: (_) => onSend(), decoration: const InputDecoration(hintText: 'Write to Maya', isDense: false), style: const TextStyle(fontSize: 18)),
        ),
        const SizedBox(width: 8),
        Pressable(
          onTap: recording || busy ? null : onSend,
          semanticLabel: 'Send',
          child: Container(width: 52, height: 52, decoration: const BoxDecoration(shape: BoxShape.circle, color: kInk), child: const Icon(Icons.arrow_upward, color: Colors.white)),
        ),
      ]),
    );
  }
}

class _NoticeBar extends StatelessWidget {
  final String text, label;
  final VoidCallback onClose;
  const _NoticeBar({required this.text, required this.onClose, this.label = 'Message from your family'});
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: const Duration(milliseconds: 220),
        builder: (context, t, child) => Opacity(opacity: t, child: child),
        child: Container(
          margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
          padding: const EdgeInsets.fromLTRB(14, 10, 4, 10),
          decoration: BoxDecoration(color: kToneInfo.bg, border: Border.all(color: kToneInfo.line), borderRadius: BorderRadius.circular(14)),
          child: Row(children: [
            Expanded(child: Text('$label: $text', style: const TextStyle(fontSize: 16, color: kInk))),
            TextButton(onPressed: onClose, child: const Text('Close')),
          ]),
        ),
      );
}

class _IncomingCard extends StatelessWidget {
  final String text;
  final VoidCallback onAccept, onDecline;
  const _IncomingCard({required this.text, required this.onAccept, required this.onDecline});
  @override
  Widget build(BuildContext context) => Positioned.fill(
        child: ColoredBox(
          color: Colors.white,
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text('Maya is calling', style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 12),
              Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: 40),
              Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                Column(children: [
                  Pressable(onTap: onDecline, semanticLabel: 'Decline', child: Container(width: 76, height: 76, decoration: const BoxDecoration(shape: BoxShape.circle, color: kAlert), child: const Icon(Icons.call_end, color: Colors.white, size: 34))),
                  const SizedBox(height: 8),
                  const Text('Decline', style: TextStyle(fontSize: 16, color: kSoft)),
                ]),
                Column(children: [
                  Pressable(onTap: onAccept, semanticLabel: 'Accept', child: Container(width: 76, height: 76, decoration: const BoxDecoration(shape: BoxShape.circle, color: kAccent), child: const Icon(Icons.call, color: Colors.white, size: 34))),
                  const SizedBox(height: 8),
                  const Text('Accept', style: TextStyle(fontSize: 16, color: kSoft)),
                ]),
              ]),
            ]),
          ),
        ),
      );
}
