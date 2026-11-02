import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../models.dart';
import '../services/api.dart';
import '../services/call_session.dart';
import '../services/events.dart';
import '../services/native_call.dart';
import '../services/store.dart';
import '../services/tz.dart';
import '../theme.dart';
import '../start/start_gate.dart';
import '../widgets/pressable.dart';
import 'call_screen.dart';
import 'chat_view.dart';

/// The senior's whole app: one screen, no login. The chat, a small phone icon to call, and one small menu button (My Reminders, My Profile, Sign out, Help).
/// There is no Family button here. Nothing on this screen scrolls except the chat, inside its own area.
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
  Timer? _ringEnd; // a ring is ONE bounded attempt: the screen clears by itself when the ring time is over, even if the server's end message never arrives
  bool _inCall = false;
  StreamSubscription<String>? _nativeAccept, _nativeEnd, _nativeRing;
  StreamSubscription<({String via, String messageId})>? _nativeOpened;
  String? _playId; // the voice note that opens playing (its notification was tapped)
  Timer? _playClear;
  CallSession? _live; // the call on screen, so the system call screen's hang-up can end it
  bool _callRouteOpen = false; // the call page is on screen (a call set aside to the chat has none)
  String? _liveOutreach;

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
    _ringEnd?.cancel();
    _recTimer?.cancel();
    _ampSub?.cancel();
    _rec?.dispose();
    final call = _live;
    if (call != null) {
      call.removeListener(_liveChanged);
      call.dispose();   // the app is closing: the call ends with it
    }
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
        _ringEnd?.cancel();
        _ringEnd = Timer(Duration(milliseconds: ((e.data['ringMs'] as num?)?.toInt() ?? 30000) + 3000), _dropIncoming);
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
    _ringEnd?.cancel();
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

  // A senior's phone always knows who it is (the family's link or code set it, see start_gate.dart): there is no list of people to pick from and nothing to set up here.
  Future<void> _ensureProfile() async {}

  Future<void> _startCall({String? reason, String? outreachId}) async {
    await _ensureProfile();
    final id = _pid;
    if (id == null || !mounted || _inCall) return;
    _inCall = true;
    final session = _live = CallSession(profileId: id, reason: reason, outreachId: outreachId);
    _liveOutreach = outreachId;
    session.addListener(_liveChanged);
    await _showCall(session, resume: false);
  }

  // The call page. "Go back to chat" closes only the page: the call keeps running, and the chat shows a "Back to call" bar. Any other way out means the call is over.
  Future<void> _showCall(CallSession session, {required bool resume}) async {
    _callRouteOpen = true;
    final result = await Navigator.of(context).push<String>(PageRouteBuilder<String>(
      transitionDuration: const Duration(milliseconds: 240),
      reverseTransitionDuration: const Duration(milliseconds: 200),
      pageBuilder: (_, _, _) => CallScreen(session: session, resume: resume),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));
    _callRouteOpen = false;
    if (result == 'chat' && !session.ended && mounted) return;   // the chat is the page underneath: the call stays live and the "Back to call" bar shows
    _finishCall();
  }

  Future<void> _backToCall() async {
    final call = _live;
    if (call == null || call.ended || _callRouteOpen || !mounted) return;
    await _showCall(call, resume: true);
  }

  // The call ended while the chat was showing (Maya hung up, the line was lost, the phone's own call screen ended it).
  void _liveChanged() {
    final call = _live;
    if (call != null && call.ended && !_callRouteOpen) _finishCall();
  }

  void _finishCall() {
    final call = _live;
    if (call == null) return;
    call.removeListener(_liveChanged);
    _live = null;
    _inCall = false;
    call.dispose();
    final oid = _liveOutreach;
    _liveOutreach = null;
    if (oid != null) NativeCall.instance.callEnded(oid);
    if (mounted) {
      setState(() {});
      _loadThread();
    }
  }

  // ---- attachments: a photo or a PDF, sent in the chat (also while a call is on) ----
  Future<void> _attachSheet() async {
    if (_busy != null) return;
    final choice = await showAttachSheet(context);
    if (choice == null || !mounted) return;
    if (choice == 'pdf') {
      await _sendPdf();
    } else {
      await _sendPhoto(choice == 'camera' ? ImageSource.camera : ImageSource.gallery);
    }
  }

  Future<void> _sendPhoto(ImageSource source) async {
    await _ensureProfile();
    final id = _pid;
    if (id == null) return;
    XFile? f;
    try {
      f = await ImagePicker().pickImage(source: source, maxWidth: 1800, imageQuality: 85);
    } catch (_) {
      if (mounted) setState(() => _error = source == ImageSource.camera ? 'The camera could not open. Please check that Maya may use it in Settings.' : 'Your photos could not open. Please check that Maya may use them in Settings.');
      return;
    }
    if (f == null || !mounted) return;
    final Uint8List bytes = await f.readAsBytes();
    await _sendAttachment(id, kind: 'image', label: '', busy: 'Maya is looking at your photo...', post: () async {
      final tz = await Tz.name();
      return Api.postBytes('/api/chat/$id/image', bytes, 'image/jpeg', query: tz == null ? null : {'tz': tz});
    });
  }

  Future<void> _sendPdf() async {
    await _ensureProfile();
    final id = _pid;
    if (id == null) return;
    PlatformFile? f;
    try {
      final r = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: const ['pdf'], withData: true);
      f = r?.files.single;
    } catch (_) {
      if (mounted) setState(() => _error = 'Your files could not open. Please check that Maya may use them in Settings.');
      return;
    }
    if (f == null || !mounted) return;
    Uint8List? bytes = f.bytes;
    if (bytes == null && f.path != null) bytes = await File(f.path!).readAsBytes();
    if (bytes == null) {
      setState(() => _error = 'Maya could not read that file. Please try another one.');
      return;
    }
    if (bytes.length > 8 * 1024 * 1024) {
      setState(() => _error = 'That PDF is too big for Maya. Please choose a smaller one.');
      return;
    }
    final name = f.name;
    final data = bytes;
    await _sendAttachment(id, kind: 'file', label: 'PDF: $name', busy: 'Maya is reading your PDF...', post: () async {
      final tz = await Tz.name();
      return Api.postBytes('/api/chat/$id/pdf', data, 'application/pdf', query: {'name': name, 'tz': ?tz});
    });
  }

  Future<void> _sendAttachment(String id, {required String kind, required String label, required String busy, required Future<dynamic> Function() post}) async {
    final pending = ChatMessage(id: 'p${DateTime.now().microsecondsSinceEpoch}', role: 'senior', kind: kind, text: label, pending: true);
    setState(() {
      _messages.add(pending);
      _busy = busy;
      _error = null;
    });
    _toBottom();
    try {
      _apply(pending, await post());
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _messages.remove(pending);
          _error = e.message;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = null);
    }
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
        resizeToAvoidBottomInset: true,
        backgroundColor: kChatTop,
        body: DecoratedBox(
          decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [kChatTop, kChatBottom])),
          child: SafeArea(
            child: Stack(children: [
              _chatPage(),
              if (_incoming != null) IncomingCallCard(kind: '${_incoming!['kind'] ?? ''}', onAccept: _acceptIncoming, onDecline: _declineIncoming),
            ]),
          ),
        ),
    );
  }

  // The menu: one sheet over the chat (never a new page, never the family's dashboard).
  Future<void> _openMenu() async {
    final id = _pid;
    if (id == null) return;
    final out = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.white,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      builder: (_) => _SeniorMenu(profileId: id, fallbackName: _name),
    );
    if (out == true) await _signOut();
  }

  // Sign out: this phone forgets the senior link and goes back to the start screen. The server profile and the chat thread are untouched; the link or the code brings it all back.
  Future<void> _signOut() async {
    _live?.hangUp();
    _eventSub?.cancel();
    _eventSub = null;
    _events?.stop();
    _events = null;
    _ringTimer?.cancel();
    await NativeCall.instance.unlink();   // the server stops ringing this phone for this person
    await Store.clearProfile();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute<void>(builder: (_) => const StartScreen()), (r) => false);
  }

  String get _title => _name == null ? 'Maya' : 'Maya and $_name';

  // A call set aside to the chat is still running: one tap returns to it.
  Widget _backBar() {
    final call = _live;
    if (call == null || call.ended || _callRouteOpen) return const SizedBox.shrink();
    return _BackToCallBar(onTap: _backToCall);
  }

  // The chat is the whole app: the person opens Maya and is in the conversation. A small phone icon in the header (top right, one tap to call), the messages, the box, the Family link at the bottom.
  Widget _chatPage() {
    return Column(children: [
      _ChatHeader(title: _title, onCall: _ready ? (_live != null ? _backToCall : () => _startCall()) : null, onMenu: _ready ? _openMenu : null),
      _backBar(),
      Expanded(child: ClipRect(child: ChatView(messages: _messages, controller: _scroll, playId: _playId))),
      if (_notice != null)
        _NoticeBar(text: '${_notice!['text']}', label: _notice!['kind'] == 'reminder' ? (_notice!['by'] == 'senior' ? 'Your reminder' : 'Reminder from your family') : _notice!['kind'] == 'welfare' ? 'Check-in from your family' : 'Message from your family', onClose: () {
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
      _Composer(controller: _text, focus: _focus, recording: _recording, seconds: _recSeconds, levels: _levels, busy: _busy != null, onSend: _sendText, onMic: _toggleRecord, onCancel: _cancelRecord, onAttach: _attachSheet),
    ]);
  }
}

/// The chat's header: the name, and the one small phone icon at the top right (the way to call).
class _ChatHeader extends StatelessWidget {
  final String title;
  final VoidCallback? onCall, onMenu;
  const _ChatHeader({required this.title, required this.onCall, required this.onMenu});
  @override
  Widget build(BuildContext context) => SizedBox(
        height: 64,
        child: Row(children: [
          const SizedBox(width: 16),
          Pressable(
            onTap: onMenu,
            semanticLabel: 'Menu',
            child: Container(width: 48, height: 48, decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white, border: Border.all(color: const Color(0xFFD7DEF7))), child: const Icon(Icons.menu, color: kTrust, size: 26)),
          ),
          const SizedBox(width: 16),   // balances the phone icon so the name is centred
          Expanded(child: Center(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w800, letterSpacing: -0.4, color: kInk)))),
          Pressable(
            onTap: onCall,
            semanticLabel: 'Call Maya',
            child: Container(width: 48, height: 48, decoration: BoxDecoration(shape: BoxShape.circle, color: kTrustSoft, border: Border.all(color: const Color(0xFFD7DEF7))), child: const Icon(Icons.call, color: kTrust, size: 24)),
          ),
          const SizedBox(width: 16),
        ]),
      );
}

/// While a call is set aside to the chat: a small bar at the top, one tap back to the call.
class _BackToCallBar extends StatelessWidget {
  final VoidCallback onTap;
  const _BackToCallBar({required this.onTap});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 2, 14, 8),
        child: Pressable(
          onTap: onTap,
          semanticLabel: 'Back to call',
          child: Container(
            height: 52,
            padding: const EdgeInsets.symmetric(horizontal: 18),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(26), gradient: const LinearGradient(colors: [kTrust, kTrustDeep]), boxShadow: const [BoxShadow(color: Color(0x334D63D8), blurRadius: 16, offset: Offset(0, 6))]),
            child: Row(children: [
              const Icon(Icons.call, color: Colors.white, size: 22),
              const SizedBox(width: 10),
              const Text('Back to call', style: TextStyle(fontSize: 18, color: Colors.white, fontWeight: FontWeight.w700)),
              const Spacer(),
              Flexible(child: Text('Still connected', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: Colors.white.withValues(alpha: 0.85)))),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right, color: Colors.white, size: 24),
            ]),
          ),
        ),
      );
}

/// The box at the bottom. You write in it, or you tap the blue microphone to record a voice note; tap it again to send. While recording the box becomes a blue bar: a bin to throw it away,
/// the waveform of what you are saying, the time, and a white send button. Writing and voice notes live in the same chat.
class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focus;
  final bool recording, busy;
  final int seconds;
  final List<double> levels;
  final VoidCallback onSend, onMic, onCancel, onAttach;
  const _Composer({required this.controller, required this.focus, required this.recording, required this.seconds, required this.levels, required this.busy, required this.onSend, required this.onMic, required this.onCancel, required this.onAttach});

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
                    padding: const EdgeInsets.only(left: 4, right: 18),
                    child: Row(children: [
                      // the attachment button: a photo or a PDF (a sheet with three plain choices)
                      Pressable(onTap: busy ? null : onAttach, semanticLabel: 'Attach a photo or a file', child: const SizedBox(width: 48, height: 48, child: Icon(Icons.attach_file, color: kTrust, size: 26))),
                      Expanded(child: TextField(
                      controller: controller,
                      focusNode: focus,
                      minLines: 1,
                      maxLines: 3,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => onSend(),
                      decoration: const InputDecoration(hintText: 'Write to Maya', filled: false, border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none, contentPadding: EdgeInsets.symmetric(vertical: 15)),
                      style: const TextStyle(fontSize: 18.5, color: kInk),
                    )),
                    ]),
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

// ---------------------------------------------------------------- the senior's menu

/// A reminder the person set themselves (from the server's senior menu route: never the family's).
class _MyReminder {
  final String id, task, repeat;
  final int? dueAt;
  final int every;
  final String? deliver, channel;
  final bool going;
  final int? waitUntil;   // quiet hours: when it will go (7 in the morning); null for an ordinary reminder
  const _MyReminder({required this.id, required this.task, required this.repeat, required this.every, this.dueAt, this.deliver, this.channel, this.going = false, this.waitUntil});

  static _MyReminder? from(dynamic j) {
    if (j is! Map || j['id'] is! String) return null;
    return _MyReminder(
      id: j['id'] as String,
      task: '${j['task']}',
      repeat: '${j['repeat'] ?? 'none'}',
      every: j['every'] is num ? (j['every'] as num).toInt() : 1,
      dueAt: j['dueAt'] is num ? (j['dueAt'] as num).toInt() : null,
      deliver: j['deliver'] is String ? j['deliver'] as String : null,
      channel: j['channel'] is String ? j['channel'] as String : null,
      going: j['going'] == true,
      waitUntil: j['waitUntil'] is num ? (j['waitUntil'] as num).toInt() : null,
    );
  }

  String get whenText => waitUntil != null ? 'Waiting until morning · ${_whenText(waitUntil)}' : _whenText(dueAt);

  String get repeatText {
    String n(String one, String many) => every <= 1 ? 'Every $one' : 'Every $every $many';
    switch (repeat) {
      case 'hourly':
        return n('hour', 'hours');
      case 'daily':
        return n('day', 'days');
      case 'weekly':
        return n('week', 'weeks');
      default:
        return 'Just once';
    }
  }

  String get channelText => channel == 'whatsapp' ? 'On WhatsApp' : channel == 'app' ? 'In the Maya app' : 'In the Maya app or WhatsApp';
  String get howText => deliver == 'call' ? 'A phone call' : deliver == 'text' ? 'A message' : deliver == 'voice' ? 'A voice note' : 'Maya decides';
}

String _whenText(int? ms) {
  if (ms == null) return 'No time set';
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final days = DateTime(t.year, t.month, t.day).difference(today).inDays;
  const wd = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const mo = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final time = '$h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
  final day = days == 0 ? 'Today' : days == 1 ? 'Tomorrow' : days > 1 && days < 7 ? wd[t.weekday - 1] : '${wd[t.weekday - 1]} ${t.day} ${mo[t.month - 1]}';
  return '$day at $time';
}

enum _MenuPage { home, reminders, reminder, profile, help }

/// The menu sheet. Four plain choices; each one opens inside the same sheet with a Back. Pops `true` when the person signs out.
class _SeniorMenu extends StatefulWidget {
  final String profileId;
  final String? fallbackName;
  const _SeniorMenu({required this.profileId, required this.fallbackName});
  @override
  State<_SeniorMenu> createState() => _SeniorMenuState();
}

class _SeniorMenuState extends State<_SeniorMenu> {
  _MenuPage _page = _MenuPage.home;
  bool _loading = false, _stopping = false;
  String? _error;
  List<_MyReminder> _reminders = const [];
  _MyReminder? _open;
  String? _name, _tz, _mode;

  @override
  void initState() {
    super.initState();
    _name = widget.fallbackName;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final j = await Api.get('/api/senior/${widget.profileId}/menu');
      if (!mounted) return;
      final list = (j is Map && j['reminders'] is List) ? (j['reminders'] as List).map(_MyReminder.from).whereType<_MyReminder>().toList() : <_MyReminder>[];
      setState(() {
        _reminders = list;
        if (j is Map) {
          if (j['name'] is String) _name = j['name'] as String;
          _tz = j['tz'] is String ? j['tz'] as String : null;
          _mode = j['mode'] is String ? j['mode'] as String : null;
        }
        _loading = false;
      });
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _loading = false;
        });
      }
    }
  }

  Future<void> _stop(_MyReminder r) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Stop this reminder?'),
        content: Text('Maya will no longer remind you: ${r.task}', style: const TextStyle(fontSize: 18, height: 1.35)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep it', style: TextStyle(fontSize: 18))),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Stop it', style: TextStyle(fontSize: 18, color: kAlert))),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    setState(() {
      _stopping = true;
      _error = null;
    });
    try {
      await Api.delete('/api/senior/${widget.profileId}/reminders/${r.id}');
      if (!mounted) return;
      setState(() {
        _reminders = _reminders.where((x) => x.id != r.id).toList();
        _page = _MenuPage.reminders;
        _stopping = false;
      });
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _stopping = false;
        });
      }
    }
  }

  Future<void> _signOutAsk() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('This phone will forget you. Your reminders and your chat with Maya are kept. To come back, tap Enter code, or open the link your family sent you.', style: TextStyle(fontSize: 18, height: 1.35)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Stay', style: TextStyle(fontSize: 18))),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Sign out', style: TextStyle(fontSize: 18, color: kAlert))),
        ],
      ),
    );
    if (yes == true && mounted) Navigator.of(context).pop(true);
  }

  String get _modeText {
    switch (_mode) {
      case 'cautious':
        return 'Cautious: Maya keeps a closer eye and tells your family gently if something seems wrong.';
      case 'ultra':
        return 'Extra careful: Maya tells your family every time she cannot reach you.';
      case 'standard':
        return 'Standard: Maya tells your family only when something really needs them.';
      default:
        return 'Not available right now';
    }
  }

  Widget _title(String t, {bool back = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(children: [
          if (back)
            Pressable(onTap: () => setState(() => _page = _page == _MenuPage.reminder ? _MenuPage.reminders : _MenuPage.home), semanticLabel: 'Back', child: const SizedBox(width: 48, height: 48, child: Icon(Icons.arrow_back, color: kTrust, size: 26))),
          Expanded(child: Text(t, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.5, color: kInk))),
        ]),
      );

  Widget _row(IconData icon, String title, String sub, VoidCallback onTap, {Color color = kTrust}) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Pressable(
          onTap: onTap,
          semanticLabel: title,
          child: Container(
            constraints: const BoxConstraints(minHeight: 64),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(color: kChatTop, borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFE2E7F6))),
            child: Row(children: [
              Icon(icon, color: color, size: 28),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: color == kAlert ? kAlert : kInk)),
                Text(sub, style: const TextStyle(fontSize: 15, color: kSoft, height: 1.3)),
              ])),
              const Icon(Icons.chevron_right, color: kSoft, size: 24),
            ]),
          ),
        ),
      );

  Widget _fact(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(fontSize: 15, color: kSoft, fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text(value, style: const TextStyle(fontSize: 20, color: kInk, height: 1.3)),
        ]),
      );

  Widget _errorLine() => _error == null ? const SizedBox.shrink() : Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(fontSize: 16, color: kAlert)));

  Widget _body() {
    switch (_page) {
      case _MenuPage.home:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _title('Menu'),
          _row(Icons.alarm, 'My Reminders', 'What Maya reminds you about', () => setState(() => _page = _MenuPage.reminders)),
          _row(Icons.person_outline, 'My Profile', 'Your name and details', () => setState(() => _page = _MenuPage.profile)),
          _row(Icons.help_outline, 'Help / About Maya', 'Who Maya is, and how to call', () => setState(() => _page = _MenuPage.help)),
          _row(Icons.logout, 'Sign out', 'This phone forgets you', _signOutAsk, color: kAlert),
        ]);
      case _MenuPage.reminders:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _title('My Reminders', back: true),
          _errorLine(),
          if (_loading) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator()))
          else if (_error != null) TextButton(onPressed: _load, child: const Text('Try again', style: TextStyle(fontSize: 18)))
          else if (_reminders.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('You have no reminders yet. Tell Maya, for example: "Remind me to take my tablets at 8 tonight."', style: TextStyle(fontSize: 18, color: kSoft, height: 1.4)))
          else
            for (final r in _reminders)
              _row(Icons.alarm, r.task, '${r.whenText} · ${r.repeatText}', () => setState(() {
                    _open = r;
                    _page = _MenuPage.reminder;
                  })),
        ]);
      case _MenuPage.reminder:
        final r = _open!;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _title('Reminder', back: true),
          _errorLine(),
          _fact('What', r.task),
          _fact('When', r.going ? 'Going out now' : r.waitUntil != null ? 'Waiting until morning. It is quiet hours, so Maya will remind you at ${_whenText(r.waitUntil)}.' : _whenText(r.dueAt)),
          _fact('How often', r.repeatText),
          _fact('How it reaches you', '${r.howText}. ${r.channelText}.'),
          const SizedBox(height: 4),
          SizedBox(
            width: double.infinity,
            height: 56,
            child: OutlinedButton.icon(
              onPressed: _stopping || r.going ? null : () => _stop(r),
              style: OutlinedButton.styleFrom(foregroundColor: kAlert, side: const BorderSide(color: kAlert, width: 1.5), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
              icon: const Icon(Icons.stop_circle_outlined, size: 24),
              label: Text(r.going ? 'Going out now' : 'Stop this reminder', style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
            ),
          ),
        ]);
      case _MenuPage.profile:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _title('My Profile', back: true),
          _errorLine(),
          _fact('Name', _name ?? 'Not available'),
          _fact('Your time zone', _tz ?? 'Not set yet'),
          _fact('How Maya looks after you', _loading ? 'Loading...' : _modeText),
          const Text('To change any of these, ask your family.', style: TextStyle(fontSize: 16, color: kSoft, height: 1.35)),
        ]);
      case _MenuPage.help:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _title('Help / About Maya', back: true),
          const Text('Maya is your friendly companion, made by the Maya team.', style: TextStyle(fontSize: 20, color: kInk, height: 1.4)),
          const SizedBox(height: 16),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(width: 48, height: 48, decoration: const BoxDecoration(shape: BoxShape.circle, color: kTrustSoft), child: const Icon(Icons.call, color: kTrust, size: 24)),
            const SizedBox(width: 14),
            const Expanded(child: Text('To talk to Maya, tap the blue phone button at the top right of the chat. To write to her, use the box at the bottom.', style: TextStyle(fontSize: 18, color: kInk, height: 1.4))),
          ]),
        ]);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
        child: SingleChildScrollView(   // with very large text the sheet scrolls instead of being cut off
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: _body(),
        ),
      );
}
