import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maya_app/senior/chat_view.dart';

// In its own file: the audio player keeps app-wide state, which the other voice-note test must not see.
void main() {
  group('chat voice notes', () {
    testWidgets(
      'a voice note that cannot play says so in words and can be tried again (never silent)',
      (t) async {
        t.view.physicalSize = const Size(390 * 3, 844 * 3);
        t.view.devicePixelRatio = 3;
        addTearDown(t.view.reset);
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        for (final n in const [
          'xyz.luan/audioplayers.global',
          'xyz.luan/audioplayers.global/events',
        ]) {
          messenger.setMockMethodCallHandler(
            MethodChannel(n),
            (c) async => null,
          );
        }
        messenger.setMockMethodCallHandler(
          const MethodChannel('xyz.luan/audioplayers'),
          (c) async =>
              throw PlatformException(code: 'fail', message: 'no audio'),
        ); // the phone's player refuses
        addTearDown(() {
          for (final n in const [
            'xyz.luan/audioplayers.global',
            'xyz.luan/audioplayers.global/events',
            'xyz.luan/audioplayers',
          ]) {
            messenger.setMockMethodCallHandler(MethodChannel(n), null);
          }
        });
        await t.pumpWidget(
          const MaterialApp(
            home: Scaffold(
              body: Padding(
                padding: EdgeInsets.all(16),
                child: VoiceBubble(url: 'http://127.0.0.1:1/a.wav'),
              ),
            ),
          ),
        );
        await t.pump(const Duration(milliseconds: 300));
        await t.runAsync(() async {
          await t.tap(find.byIcon(Icons.play_arrow));
          for (var i = 0; i < 40; i++) {
            // up to four seconds for the two tries to fail
            await Future<void>.delayed(const Duration(milliseconds: 100));
            await t.pump();
            if (find.textContaining('did not play').evaluate().isNotEmpty) {
              break;
            }
          }
        });
        expect(
          find.textContaining('did not play'),
          findsOneWidget,
          reason: 'a visible message, not a silent failure',
        );
        expect(
          find.byIcon(Icons.play_arrow),
          findsOneWidget,
          reason: 'the play button is there to try again',
        );
        await t.pumpWidget(const SizedBox());
      },
    );
  });
}
