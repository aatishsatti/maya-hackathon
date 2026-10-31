import 'package:flutter/material.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import '../services/api.dart';
import '../theme.dart';

bool _tzReady = false;

/// Is `ms` inside their quiet hours (where THEY are)? The server holds anything due in them until the morning; this only warns.
/// An unknown time zone: false (the server holds nothing then).
bool inQuietAt(Map<String, dynamic>? quiet, int ms) {
  if (quiet == null || quiet['tz'] is! String) return false;
  try {
    if (!_tzReady) {
      tzdata.initializeTimeZones();
      _tzReady = true;
    }
    final h = tz.TZDateTime.fromMillisecondsSinceEpoch(tz.getLocation(quiet['tz'] as String), ms).hour;
    final s = (quiet['start'] as num).toInt(), e = (quiet['end'] as num).toInt();
    return s > e ? (h >= s || h < e) : (h >= s && h < e);
  } catch (_) {
    return false;
  }
}

String hh(num n) => n.toInt().toString().padLeft(2, '0');

/// An error in plain words, with a Try again when there is something to try.
class ErrorBanner extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const ErrorBanner({super.key, required this.message, this.onRetry});
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
        decoration: BoxDecoration(color: kToneMiss.bg, border: Border.all(color: kToneMiss.line), borderRadius: BorderRadius.circular(12)),
        child: Row(children: [
          Expanded(child: Text(message, style: TextStyle(fontSize: 15, color: kToneMiss.ink))),
          if (onRetry != null) TextButton(onPressed: onRetry, child: const Text('Try again')),
        ]),
      );
}

/// Runs a server action and answers in words: the server's own plain message on a failure, never a fake success.
Future<bool> act(BuildContext context, Future<dynamic> Function() go, {String? done, void Function(dynamic result)? onResult}) async {
  final m = ScaffoldMessenger.of(context);
  try {
    final r = await go();
    onResult?.call(r);
    if (done != null) m.showSnackBar(SnackBar(content: Text(done)));
    return true;
  } on ApiError catch (e) {
    m.showSnackBar(SnackBar(content: Text(e.message), duration: const Duration(seconds: 6)));
    return false;
  }
}

Widget sectionLabel(String t) => Padding(padding: const EdgeInsets.only(top: 14, bottom: 6), child: Text(t, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: kSoft)));
