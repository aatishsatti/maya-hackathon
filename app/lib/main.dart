import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'services/api.dart';
import 'services/store.dart';
import 'start/start_gate.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  Api.familyToken = await Store.familyToken();   // a family phone is still logged in after the app is closed
  SystemChrome.setPreferredOrientations(const [DeviceOrientation.portraitUp]);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Colors.transparent, statusBarIconBrightness: Brightness.dark, statusBarBrightness: Brightness.light, systemNavigationBarColor: Colors.white, systemNavigationBarIconBrightness: Brightness.dark));
  runApp(const MayaApp());
}

class MayaApp extends StatelessWidget {
  final Widget? home; // widget tests pass a home
  const MayaApp({super.key, this.home});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Maya',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: home,
      // A senior's link (https://.../s/<id>), tapped while the app is closed or open, opens that senior's chat straight away.
      onGenerateInitialRoutes: home != null ? null : (name) {
        final m = RegExp(r'^/s/([a-f0-9]{8})').firstMatch(name);
        return [MaterialPageRoute<void>(builder: (_) => m != null ? LinkOpener(id: m.group(1)!) : const StartGate())];
      },
      onGenerateRoute: (s) {
        final m = RegExp(r'^/s/([a-f0-9]{8})').firstMatch(s.name ?? '');
        return m == null ? null : MaterialPageRoute<void>(builder: (_) => LinkOpener(id: m.group(1)!), settings: s);
      },
    );
  }
}
