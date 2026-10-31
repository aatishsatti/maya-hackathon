# Maya app (Flutter, iOS + Android)

A new front-end for the same Maya server (`https://maya-singapore.onrender.com`). The brain, memory, reminders, welfare checks,
scam shield, WhatsApp and the family data all stay on the server; the app holds no key and no token.

- Senior side (no login): one screen, a big Call button, the chat, voice notes, a small Family link. Maya can ring the phone only
  while the app is open (there is no push service behind it).
- Family side: a PIN that locks the family area **on this phone** (the server has no family accounts), then Activity, Reminders,
  Welfare, Message and Setup, all from the server's own API.

Build and install (Flutter 3.47):

    flutter pub get
    flutter analyze && flutter test
    flutter build apk --debug          # build/app/outputs/flutter-apk/app-debug.apk, install with: adb install -r <apk>
    flutter build ios --debug --no-codesign   # then open ios/Runner.xcworkspace in Xcode, pick your team, run on your iPhone

A local server instead of the live one: `--dart-define=MAYA_SERVER=http://192.168.x.x:3000`.
