import 'package:shared_preferences/shared_preferences.dart';

/// What this phone remembers about itself: who Maya talks with (a senior's phone), or the family's login (a family phone). There is no PIN.
class Store {
  static SharedPreferences? _p;
  static Future<SharedPreferences> get _prefs async => _p ??= await SharedPreferences.getInstance();

  /// Tests only: forget the opened preferences so a test can start from its own saved values.
  static void forgetForTest() => _p = null;

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

  /// The family's login on this phone (a username and the signed session the server gave). The password is never kept here. A senior's phone has none.
  static Future<String?> familyToken() async => (await _prefs).getString('familyToken');
  static Future<String?> familyName() async => (await _prefs).getString('familyName');
  static Future<void> setFamily(String username, String token) async {
    final p = await _prefs;
    await p.setString('familyName', username);
    await p.setString('familyToken', token);
  }

  static Future<void> clearFamily() async {
    final p = await _prefs;
    await p.remove('familyName');
    await p.remove('familyToken');
  }
}
