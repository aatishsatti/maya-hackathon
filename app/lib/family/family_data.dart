import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models.dart';
import '../services/api.dart';

/// What the family dashboard shows, all of it fetched from the server (care.view + whatsapp.view). Nothing is invented here:
/// a failed fetch keeps the last good data on screen and shows the plain-word error with a retry.
class FamilyData extends ChangeNotifier {
  final String profileId;
  FamilyData(this.profileId);

  Map<String, dynamic> care = {}; // /api/care/<id>
  Map<String, dynamic> wa = {}; // /api/whatsapp/<id>
  String? error;
  bool loading = true;
  DateTime? updatedAt;
  Timer? _timer;
  bool _disposed = false;

  void start() {
    refresh();
    _timer = Timer.periodic(const Duration(seconds: 8), (_) => refresh(quiet: true));
  }

  Future<void> refresh({bool quiet = false}) async {
    if (!quiet) {
      loading = true;
      notifyListeners();
    }
    try {
      final r = await Future.wait([Api.get('/api/care/$profileId'), Api.get('/api/whatsapp/$profileId')]);
      if (_disposed) return;
      care = r[0] is Map<String, dynamic> ? r[0] as Map<String, dynamic> : {};
      wa = r[1] is Map<String, dynamic> ? r[1] as Map<String, dynamic> : {};
      error = null;
      updatedAt = DateTime.now();
    } on ApiError catch (e) {
      if (_disposed) return;
      error = e.message;
    } finally {
      loading = false;
      if (!_disposed) notifyListeners();
    }
  }

  // ---- reading ----
  String get name => '${care['name'] ?? 'them'}';
  List<ActivityEntry> get activity => ((wa['activity'] is Map ? (wa['activity'] as Map)['entries'] : null) as List? ?? const []).map(ActivityEntry.from).whereType<ActivityEntry>().toList();
  Map<String, dynamic> get summary => (wa['activity'] is Map && (wa['activity'] as Map)['summary'] is Map) ? Map<String, dynamic>.from((wa['activity'] as Map)['summary'] as Map) : {};
  List<Reminder> get reminders => ((care['reminders'] as List?) ?? const []).map(Reminder.from).whereType<Reminder>().toList();
  bool get linked => wa['linked'] == true;
  bool get optIn => wa['optIn'] == true;
  bool get windowOpen => wa['windowOpen'] == true;
  String? get phoneEnd => wa['phoneEnd'] as String?;
  bool get configured => wa['configured'] == true;
  Map<String, dynamic>? get calls => wa['calls'] is Map ? Map<String, dynamic>.from(wa['calls'] as Map) : null;
  Map<String, dynamic>? get schedule => wa['welfareSchedule'] is Map ? Map<String, dynamic>.from(wa['welfareSchedule'] as Map) : null;
  Map<String, dynamic>? get quiet => care['quiet'] is Map ? Map<String, dynamic>.from(care['quiet'] as Map) : null;
  String get mode => '${care['mode'] ?? 'standard'}';
  Map<String, dynamic> get modes => care['modes'] is Map ? Map<String, dynamic>.from(care['modes'] as Map) : {};
  List<Map<String, dynamic>> get activeAlerts {
    final out = <Map<String, dynamic>>[];
    for (final k in const ['alerts', 'flags', 'scams']) {
      for (final a in (care[k] as List? ?? const [])) {
        if (a is Map && a['status'] == 'active') out.add({...Map<String, dynamic>.from(a), '_kind': k});
      }
    }
    return out;
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// The paused / limit line, in words (from the server's own numbers; the same wording as the web page).
String callLimitText(Map<String, dynamic>? c) {
  if (c == null) return '';
  final meta = c['meta'] is Map ? Map<String, dynamic>.from(c['meta'] as Map) : null;
  final max = c['maxMisses'] ?? 2;
  final m = meta == null
      ? ''
      : 'WhatsApp refused the last call at ${dayTime((meta['at'] as num).toInt())} (error ${meta['code']}): its limit on calls a business can start.${meta['note'] != null && '${meta['note']}'.isNotEmpty ? ' WhatsApp says: ${meta['note']}.' : ''} Maya does not count that limit herself: she tries each call and WhatsApp decides when one is allowed again. ';
  if (c['blocked'] == 'meta') return '${m}Until then a reminder sent with this button goes as a WhatsApp message.';
  if (c['blocked'] == 'misses') return 'Calls are paused: the last $max calls to them were not answered. They start again when they write to Maya or call her. Until then a reminder sent with this button goes as a WhatsApp message.';
  return '$m$max calls in a row that nobody answers pause calls (now ${c['misses'] ?? 0} of $max).';
}
