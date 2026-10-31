import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// What this phone remembers about itself: who Maya talks with, and the family PIN.
/// The PIN is a lock on THIS phone only. The server has no family accounts, so it is not a server login.
class Store {
  static SharedPreferences? _p;
  static Future<SharedPreferences> get _prefs async => _p ??= await SharedPreferences.getInstance();

  static Future<String?> profileId() async => (await _prefs).getString('profileId');
  static Future<String?> profileName() async => (await _prefs).getString('profileName');
  static Future<void> setProfile(String id, String name) async {
    final p = await _prefs;
    await p.setString('profileId', id);
    await p.setString('profileName', name);
  }

  static Future<void> clearProfile() async {
    final p = await _prefs;
    await p.remove('profileId');
    await p.remove('profileName');
  }

  static String _hash(String pin, String salt) => sha256.convert(utf8.encode('$salt:$pin')).toString();

  static Future<bool> hasPin() async => (await _prefs).getString('pinHash') != null;

  static Future<void> setPin(String pin) async {
    final p = await _prefs;
    final salt = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    await p.setString('pinSalt', salt);
    await p.setString('pinHash', _hash(pin, salt));
  }

  static Future<bool> checkPin(String pin) async {
    final p = await _prefs;
    final salt = p.getString('pinSalt'), h = p.getString('pinHash');
    return salt != null && h != null && _hash(pin, salt) == h;
  }

  static Future<void> clearPin() async {
    final p = await _prefs;
    await p.remove('pinSalt');
    await p.remove('pinHash');
  }
}
