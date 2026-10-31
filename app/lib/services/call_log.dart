import 'package:flutter/foundation.dart';

/// What happened on a call, with times, so a dropped call can be explained instead of guessed at. Every line goes to the
/// Xcode / Android console (prefix "maya.call") and is kept in memory (the last 300) for the call screen and Setup.
/// A line holds times, counts, close codes and reasons: never a word anyone said.
class CallLog {
  static final List<String> _lines = [];
  static final Stopwatch _clock = Stopwatch()..start();
  static List<String> get lines => List.unmodifiable(_lines);

  static void add(String what) {
    final t = DateTime.now();
    final stamp = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}.${t.millisecond.toString().padLeft(3, '0')}';
    final line = '$stamp $what';
    _lines.add(line);
    if (_lines.length > 300) _lines.removeRange(0, _lines.length - 300);
    debugPrint('maya.call $line');
  }

  static List<String> last(int n) => _lines.length <= n ? List.of(_lines) : _lines.sublist(_lines.length - n);
  static void clear() => _lines.clear();
  @visibleForTesting
  static int get uptimeMs => _clock.elapsedMilliseconds;
}
