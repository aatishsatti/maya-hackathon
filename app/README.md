# Maya app — Flutter frontend

The app connects to the same Maya server as the web interface. Model-service credentials remain server-side.

- Seniors enter through a provisioned link or code and use chat, voice notes or calls without a password. The senior menu is separate from the family dashboard.
- Family/team dashboard access uses the family-account flow described in the root README, not the earlier device-only PIN design.
- The tested Android app supports native incoming-call delivery through the configured push path. The published demo shows the actual tested behaviour; this is not a guarantee across all devices or proof of iOS delivery.
- Consult the root README for current voice routing, demonstrated capabilities and known limitations.

The following build commands are developer setup instructions, not a claim that every platform has been live-tested.

Build and install (Flutter 3.47):

    flutter pub get
    flutter analyze && flutter test
    flutter build apk --debug          # build/app/outputs/flutter-apk/app-debug.apk, install with: adb install -r <apk>
    flutter build ios --debug --no-codesign   # then open ios/Runner.xcworkspace in Xcode, pick your team, run on your iPhone

A local server instead of the live one: `--dart-define=MAYA_SERVER=http://192.168.x.x:3000`.
