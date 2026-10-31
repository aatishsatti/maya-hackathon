// Where Maya lives. The app is only a new front-end for this server: the brain, the memory, the reminders, the
// welfare checks, the scam shield, WhatsApp and the family data all stay there. No key or token is ever in the app.
// For a local server, build with: --dart-define=MAYA_SERVER=http://192.168.x.x:3000
const String kServer = String.fromEnvironment('MAYA_SERVER', defaultValue: 'https://maya-singapore.onrender.com');

Uri apiUri(String path, [Map<String, String>? query]) {
  final base = Uri.parse(kServer);
  return base.replace(path: path, queryParameters: (query == null || query.isEmpty) ? null : query);
}

/// The call socket. The server only opens it for a request whose Origin is its own host (a browser rule); the app
/// is not a browser, so it sends that same Origin itself.
Uri wsUri() {
  final base = Uri.parse(kServer);
  return base.replace(scheme: base.scheme == 'https' ? 'wss' : 'ws', path: '/ws');
}

String get kOrigin => Uri.parse(kServer).replace(path: '').toString().replaceAll(RegExp(r'/$'), '');
