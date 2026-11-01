import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maya_app/services/audio_route.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('chat voice notes are media on the loudspeaker, never the call setting', () {
    final c = AudioRoute.chatContext.android;
    expect(c.isSpeakerphoneOn, isTrue);
    expect(c.usageType, AndroidUsageType.media);
    expect(c.contentType, AndroidContentType.music);
    expect(c.usageType, isNot(AndroidUsageType.voiceCommunication));
    expect(AudioRoute.chatContext.iOS.category, AVAudioSessionCategory.playback);
  });

  test('before a chat voice note the call is let go completely (route, mode, proximity); during a live call nothing is touched', () async {
    final sent = <String>[];
    AudioRoute.channel = const MethodChannel('maya/audio_route_test');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(AudioRoute.channel, (c) async {
      sent.add(c.method);
      return null;
    });
    final wasAndroid = AudioRoute.android;
    AudioRoute.android = true;
    addTearDown(() {
      AudioRoute.android = wasAndroid;
      AudioRoute.channel = const MethodChannel('maya/audio_route');
    });
    // a call ended on the earpiece; a voice note is tapped afterwards
    AudioRoute.callStarted();
    AudioRoute.callEnded();
    expect(AudioRoute.callLive, isFalse);
    await AudioRoute.prepareChatPlayback();
    expect(sent, ['release'], reason: 'the route is released fresh before the note plays');
    // while a call is live a note must not pull the call's route away
    sent.clear();
    AudioRoute.callStarted();
    await AudioRoute.prepareChatPlayback();
    expect(sent, isEmpty);
    AudioRoute.callEnded();
    expect(AudioRoute.callLive, isFalse);
    AudioRoute.callEnded();   // an extra end never goes below zero
    expect(AudioRoute.callLive, isFalse);
  });
}
