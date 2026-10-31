import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../config.dart';
import 'tz.dart';

class SseEvent {
  final String name;
  final Map<String, dynamic> data;
  const SseEvent(this.name, this.data);
}

/// The senior's live stream from the server (/api/care/ID/events): Maya ringing the phone while the app is open
/// ("incoming"), her own messages ("chat"), notes from the family ("notice"). It reconnects by itself.
/// Maya can ring only while the app is open: there is no push service behind it.
class SeniorEvents {
  final String profileId;
  SeniorEvents(this.profileId);

  final _out = StreamController<SseEvent>.broadcast();
  Stream<SseEvent> get stream => _out.stream;
  HttpClient? _client;
  bool _stopped = false;
  bool connected = false;

  Future<void> start() async {
    final tz = await Tz.name();
    while (!_stopped) {
      try {
        final c = _client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
        final req = await c.getUrl(apiUri('/api/care/$profileId/events', tz == null ? null : {'tz': tz}));
        req.headers.set('Accept', 'text/event-stream');
        final resp = await req.close();
        if (resp.statusCode != 200) throw const SocketException('bad status');
        connected = true;
        String name = 'message';
        final data = StringBuffer();
        await for (final line in resp.transform(utf8.decoder).transform(const LineSplitter())) {
          if (_stopped) break;
          if (line.isEmpty) {
            if (data.isNotEmpty) {
              try {
                final m = jsonDecode(data.toString());
                if (m is Map<String, dynamic>) _out.add(SseEvent(name, m));
              } catch (_) {}
            }
            name = 'message';
            data.clear();
          } else if (line.startsWith('event:')) {
            name = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            if (data.isNotEmpty) data.write('\n');
            data.write(line.substring(5).trimLeft());
          }
        }
      } catch (_) {
        // fall through to the pause and a new try
      }
      connected = false;
      _client?.close(force: true);
      if (_stopped) break;
      await Future<void>.delayed(const Duration(seconds: 4));
    }
  }

  void stop() {
    _stopped = true;
    _client?.close(force: true);
    _out.close();
  }
}
