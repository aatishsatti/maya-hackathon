import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'senior/senior_screen.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
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
      home: home ?? const SeniorScreen(),
    );
  }
}
