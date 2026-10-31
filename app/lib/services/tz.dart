import 'package:flutter_timezone/flutter_timezone.dart';

/// The phone's IANA time zone name ("Asia/Kolkata"), or null when it cannot be read: the server then simply does not know it.
class Tz {
  static String? _name;
  static bool _done = false;
  static Future<String?> name() async {
    if (_done) return _name;
    _done = true;
    try {
      final t = await FlutterTimezone.getLocalTimezone();
      final n = t.identifier;
      _name = RegExp(r'^[\w/+\-]{1,60}$').hasMatch(n) ? n : null;
    } catch (_) {
      _name = null;
    }
    return _name;
  }
}
