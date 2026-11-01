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
  final List<double> _levels = []; // how loud the voice note is, a moment at a time: it draws the waveform in the recording bar
  StreamSubscription<Amplitude>? _ampSub;
  SeniorEvents? _events;
  StreamSubscription<SseEvent>? _eventSub;
  Map<String, dynamic>? _incoming; // a ring from Maya while the app is open
  Map<String, dynamic>? _notice; // a note from the family
  Timer? _ringTimer;
  bool _inCall = false;
  StreamSubscription<String>? _nativeAccept, _nativeEnd, _nativeRing;
  StreamSubscription<({String via, String messageId})>? _nativeOpened;
  String? _playId; // the voice note that opens playing (its notification was tapped)
  Timer? _playClear;
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
    _nativeRing?.cancel();
    _nativeOpened?.cancel();
    _playClear?.cancel();
    _events?.stop();
    _ringTimer?.cancel();
    _recTimer?.cancel();
    _ampSub?.cancel();
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
    _nativeAccept ??= NativeCall.instance.accepted.listen((oid) async {
      if (!mounted || _inCall) return;
      _dropIncoming();
      final kind = NativeCall.instance.kindOf(oid);   // callback | reminder | welfare: what rang
      await NativeCall.instance.audioReady();         // iOS: the call audio is on before the microphone opens
      if (!mounted || _inCall) return;
      _startCall(reason: kind, outreachId: oid);
    });
    _nativeEnd ??= NativeCall.instance.ended.listen((_) => _live?.hangUp());
    // The call notification of a closed app was tapped: the ring is still going on the server, so connect again; it is announced at once and the Accept / Decline card shows (nothing is answered or lost by looking).
    _nativeRing ??= NativeCall.instance.ring.listen((_) {
      final pid = _pid;
      if (!mounted || pid == null || _inCall || _incoming != null) return;
      _attach(pid);
    });
    // A text or a voice-note notification was tapped: the chat opens on it, and a voice note plays.
    _nativeOpened ??= NativeCall.instance.opened.listen((o) async {
      await _loadThread();
      if (!mounted || o.via != 'voice') return;
      String? id = o.messageId.isEmpty ? null : o.messageId;
      if (id == null) {
        for (final m in _messages.reversed) {
          if (m.fromMaya && m.kind == 'voice' && m.mediaUrl != null) {
            id = m.id;
            break;
          }
        }
      }
      if (id == null) return;
      setState(() => _playId = id);
      _playClear?.cancel();
      _playClear = Timer(const Duration(seconds: 3), () => mounted ? setState(() => _playId = null) : null);
    });
    NativeCall.instance.start(id);
    if (Platform.isIOS) _primeMic();
  }

  // The microphone question can only be asked with the phone in hand: on a lock screen there is no room for it, so an Accept would open a silent call.
  // Asking here, while the app is open, means a closed-app ring that is answered can talk at once. (Android asks natively, in MainActivity.)
  Future<void> _primeMic() async {
    try {
      final r = AudioRecorder();
      await r.hasPermission();
      await r.dispose();
    } catch (_) {
      // no microphone plugin (tests, desktop): nothing to ask
    }
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
        _levels.clear();
      });
      _ampSub?.cancel();
      _ampSub = rec.onAmplitudeChanged(const Duration(milliseconds: 90)).listen((a) {
        if (!mounted) return;
        setState(() {
          _levels.add(((a.current + 50) / 50).clamp(0.0, 1.0));
          if (_levels.length > 60) _levels.removeAt(0);
        });
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

  // The bin in the recording bar: stop, throw the recording away, send nothing.
  Future<void> _cancelRecord() async {
    _recTimer?.cancel();
    _ampSub?.cancel();
    String? path;
    try {
      path = await _rec?.stop();
    } catch (_) {}
    if (path != null) {
      try {
        await File(path).delete();
      } catch (_) {}
    }
    if (mounted) {
      HapticFeedback.selectionClick();
      setState(() {
        _recording = false;
        _levels.clear();
      });
    }
  }

  Future<void> _stopAndSend() async {
    _recTimer?.cancel();
    _ampSub?.cancel();
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
      backgroundColor: kChatTop,
      body: DecoratedBox(
        decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [kChatTop, kChatBottom])),
        child: SafeArea(
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
              Expanded(child: ClipRect(child: ChatView(messages: _messages, controller: _scroll, playId: _playId))),
              if (_notice != null) _NoticeBar(text: '${_notice!['text']}', label: _notice!['kind'] == 'reminder' ? (_notice!['by'] == 'senior' ? 'Your reminder' : 'Reminder from your family') : _notice!['kind'] == 'welfare' ? 'Check-in from your family' : 'Message from your family', onClose: () {
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
              _Composer(controller: _text, focus: _focus, recording: _recording, seconds: _recSeconds, levels: _levels, busy: _busy != null, onSend: _sendText, onMic: _toggleRecord, onCancel: _cancelRecord),
              if (!kb)
                SizedBox(
                  height: 48,
                  child: Center(child: TextButton(onPressed: _openFamily, child: const Text('Family', style: TextStyle(fontSize: 15, color: kSoft)))),
                ),
            ]);
          }),
          if (_incoming != null) IncomingCallCard(kind: '${_incoming!['kind'] ?? ''}', onAccept: _acceptIncoming, onDecline: _declineIncoming),
        ]),
      ),
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

/// The box at the bottom. You write in it, or you tap the blue microphone to record a voice note; tap it again to send. While recording the box becomes a blue bar: a bin to throw it away,
/// the waveform of what you are saying, the time, and a white send button. Writing and voice notes live in the same chat.
class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focus;
  final bool recording, busy;
  final int seconds;
  final List<double> levels;
  final VoidCallback onSend, onMic, onCancel;
  const _Composer({required this.controller, required this.focus, required this.recording, required this.seconds, required this.levels, required this.busy, required this.onSend, required this.onMic, required this.onCancel});

  @override
  Widget build(BuildContext context) {
    final mm = '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 8),
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 220),
        child: recording
            ? Container(
                key: const ValueKey('recording'),
                height: 64,
                padding: const EdgeInsets.fromLTRB(8, 7, 8, 7),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(32), gradient: const LinearGradient(colors: [kTrust, kTrustDeep]), boxShadow: const [BoxShadow(color: Color(0x334D63D8), blurRadius: 22, offset: Offset(0, 8))]),
                child: Row(children: [
                  Pressable(
                    onTap: onCancel,
                    semanticLabel: 'Throw this voice note away',
                    child: const SizedBox(width: 48, height: 48, child: Icon(Icons.delete_outline, color: Colors.white70, size: 28)),
                  ),
                  const SizedBox(width: 4),
                  Expanded(child: SizedBox(height: 36, child: CustomPaint(painter: _LiveWave(levels)))),
                  const SizedBox(width: 10),
                  Text(mm, style: const TextStyle(fontSize: 17, color: Colors.white, fontWeight: FontWeight.w600, fontFeatures: [FontFeature.tabularFigures()])),
                  const SizedBox(width: 10),
                  Pressable(
                    onTap: onMic,
                    semanticLabel: 'Stop and send the voice note',
                    child: Container(width: 50, height: 50, decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white), child: const Icon(Icons.send_rounded, color: kTrust, size: 24)),
                  ),
                ]),
              )
            : Row(key: const ValueKey('writing'), children: [
                Expanded(
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 56),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(28), border: Border.all(color: const Color(0xFFE2E7F6), width: 1.2)),
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                    child: TextField(
                      controller: controller,
                      focusNode: focus,
                      minLines: 1,
                      maxLines: 3,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => onSend(),
                      decoration: const InputDecoration(hintText: 'Write to Maya', filled: false, border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none, contentPadding: EdgeInsets.symmetric(vertical: 15)),
                      style: const TextStyle(fontSize: 18.5, color: kInk),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                // one blue button: a microphone while the box is empty, an arrow once there is something to send
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: controller,
                  builder: (context, v, _) {
                    final hasText = v.text.trim().isNotEmpty;
                    return Pressable(
                      onTap: busy ? null : (hasText ? onSend : onMic),
                      semanticLabel: hasText ? 'Send' : 'Record a voice note',
                      child: Container(
                        width: 58,
                        height: 58,
                        decoration: const BoxDecoration(shape: BoxShape.circle, color: kTrust, boxShadow: [BoxShadow(color: Color(0x334D63D8), blurRadius: 18, offset: Offset(0, 6))]),
                        child: Icon(hasText ? Icons.arrow_upward : Icons.mic, color: Colors.white, size: 28),
                      ),
                    );
                  },
                ),
              ]),
      ),
    );
  }
}

/// The waveform in the recording bar: thin white bars, one for each moment, the newest on the right.
class _LiveWave extends CustomPainter {
  final List<double> levels;
  _LiveWave(this.levels);
  @override
  void paint(Canvas canvas, Size size) {
    const bw = 3.0, gap = 3.0;
    final n = (size.width / (bw + gap)).floor();
    final mid = size.height / 2;
    for (var i = 0; i < n; i++) {
      final k = levels.length - n + i; // the newest sound is at the right edge
      final has = k >= 0 && k < levels.length;
      final h = 4 + (has ? levels[k] : 0.0) * (size.height - 4);
      final x = i * (bw + gap) + bw / 2;
      canvas.drawLine(Offset(x, mid - h / 2), Offset(x, mid + h / 2), Paint()..color = Colors.white.withValues(alpha: has ? 0.95 : 0.35)..strokeWidth = bw..strokeCap = StrokeCap.round);
    }
  }

  @override
  bool shouldRepaint(_LiveWave old) => true;
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

/// The page the senior sees when Maya rings (a tap on the call notification, or a ring while the app is open). The same see-through backdrop as the call page, over the whole screen:
/// "Maya is calling" in large type, one line under it for why (from the kind of call only, never any private words), then Accept and Decline, big, on the same page.
class IncomingCallCard extends StatelessWidget {
  final String kind;
  final VoidCallback onAccept, onDecline;
  const IncomingCallCard({super.key, required this.kind, required this.onAccept, required this.onDecline});

  // why she is calling, from the kind only
  String get _why {
    switch (kind) {
      case 'welfare':
        return 'A welfare check: she would like to hear how you are.';
      case 'reminder':
        return 'A reminder from your family.';
      case 'callback':
        return 'A quick check-in: she is calling you back.';
      default:
        return 'A check-in: she would like to hear how you are.';
    }
  }

  Widget _action(String label, Color color, IconData icon, VoidCallback onTap) => Column(mainAxisSize: MainAxisSize.min, children: [
        Pressable(
          onTap: onTap,
          semanticLabel: label,
          child: Container(width: 92, height: 92, decoration: BoxDecoration(shape: BoxShape.circle, color: color), child: Icon(icon, color: Colors.white, size: 40)),
        ),
        const SizedBox(height: 12),
        Text(label, style: const TextStyle(fontSize: 18, color: Colors.white, fontWeight: FontWeight.w600)),
      ]);

  @override
  Widget build(BuildContext context) => Positioned.fill(
        child: Stack(fit: StackFit.expand, children: [
          const CallBackdrop(),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(28, 24, 28, 40),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Spacer(flex: 3),
                const Text('Maya is calling', style: TextStyle(fontSize: 40, height: 1.05, color: Colors.white, fontWeight: FontWeight.w300, letterSpacing: -1)),
                const SizedBox(height: 14),
                Text(_why, style: TextStyle(fontSize: 20, height: 1.35, color: Colors.white.withValues(alpha: 0.86), fontWeight: FontWeight.w400)),
                const Spacer(flex: 5),
                Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _action('Decline', const Color(0xFFC0392B), Icons.call_end, onDecline),
                  _action('Accept', const Color(0xFF2E9C86), Icons.call, onAccept),
                ]),
              ]),
            ),
          ),
        ]),
      );
}
