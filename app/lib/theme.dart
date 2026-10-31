import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

// Pure white, dark ink. Colour is used for meaning only (status), never for decoration.
const Color kInk = Color(0xFF111111);
const Color kSoft = Color(0xFF666666);
const Color kLine = Color(0xFFE5E5E5);
const Color kFill = Color(0xFFF5F5F5);
const Color kAccent = Color(0xFF14463C); // the Call button
const Color kAlert = Color(0xFFB3261E); // end a call, errors

class Tone {
  final Color bg, ink, line;
  const Tone(this.bg, this.ink, this.line);
}

const Tone kToneOk = Tone(Color(0xFFE1F1E5), Color(0xFF2C6A43), Color(0xFFB9D9C1));
const Tone kToneInfo = Tone(Color(0xFFE3F0F6), Color(0xFF1F5C73), Color(0xFFC4DCE5));
const Tone kToneWait = Tone(Color(0xFFFFF0BF), Color(0xFF6B4E00), Color(0xFFE8D48A));
const Tone kToneMiss = Tone(Color(0xFFFBDCD7), Color(0xFF8C1D18), Color(0xFFEBB1AA));
const Tone kTonePlain = Tone(Color(0xFFF2F2F2), Color(0xFF444444), kLine);

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: kAccent, brightness: Brightness.light).copyWith(
    primary: kAccent,
    onPrimary: Colors.white,
    surface: Colors.white,
    onSurface: kInk,
    error: kAlert,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Colors.white,
    canvasColor: Colors.white,
    splashFactory: InkRipple.splashFactory,
    appBarTheme: const AppBarTheme(backgroundColor: Colors.white, foregroundColor: kInk, elevation: 0, scrolledUnderElevation: 0),
    textTheme: const TextTheme(
      headlineMedium: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: kInk, height: 1.15),
      titleLarge: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: kInk),
      titleMedium: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: kInk),
      bodyLarge: TextStyle(fontSize: 18, color: kInk, height: 1.3),
      bodyMedium: TextStyle(fontSize: 16, color: kInk, height: 1.3),
      bodySmall: TextStyle(fontSize: 14, color: kSoft, height: 1.3),
      labelLarge: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: kLine, width: 1.5)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: kLine, width: 1.5)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: kInk, width: 2)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 52),
        backgroundColor: kInk,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 52),
        foregroundColor: kInk,
        side: const BorderSide(color: kLine, width: 1.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(minimumSize: const Size(48, 48), foregroundColor: kInk)),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
    }),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: kInk, contentTextStyle: TextStyle(color: Colors.white, fontSize: 16)),
    dividerColor: kLine,
  );
}
