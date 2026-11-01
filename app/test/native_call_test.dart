// The native incoming-call bridge: the push token goes to the server, Accept on the system call screen reaches Dart with the outreach id,
// a hang-up on the system screen reaches Dart, and Decline is only reported (the native side tells the server). A fake native side stands in.
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:maya_app/services/api.dart';
import 'package:maya_app/services/call_log.dart';
import 'package:maya_app/services/native_call.dart';

Future<void> fromNative(String method, Map<String, dynamic> args) async {
  final data = const StandardMethodCodec().encodeMethodCall(MethodCall(method, args));
  await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(NativeCall.channel.name, data, (_) {});
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('start configures the native side, sends the push token to the server, and Accept / hang-up reach Dart; Decline does not start a call', () async {
    final told = <String>[];
    final posts = <http.Request>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, (c) async {
      told.add('${c.method} ${jsonEncode(c.arguments ?? {})}');
      return null;
    });
    Api.testClient = MockClient((req) async {
      posts.add(req);
      return http.Response('{"ok":true}', 200);
    });
    CallLog.clear();

    final accepted = <String>[];
    final ended = <String>[];
    final a = NativeCall.instance.accepted.listen(accepted.add);
    final e = NativeCall.instance.ended.listen(ended.add);

    await NativeCall.instance.start('abc12345');
    expect(told.first, startsWith('configure'));
    expect(told.first, contains('"profile":"abc12345"'));
    expect(told.last, 'ready {}');

    await fromNative('token', {'platform': 'ios', 'token': 'TOKEN0123456789abcdef'});
    expect(posts.single.url.path, '/api/care/abc12345/device');
    expect(jsonDecode(posts.single.body), {'platform': 'ios', 'token': 'TOKEN0123456789abcdef'});
    expect(CallLog.lines.join('\n'), isNot(contains('TOKEN0123')), reason: 'a token is never logged');

    await fromNative('accepted', {'outreachId': 'o1'});
    await fromNative('declined', {'outreachId': 'o2'});
    await fromNative('ended', {'outreachId': 'o1'});
    await Future<void>.delayed(Duration.zero);
    expect(accepted, ['o1'], reason: 'only Accept starts a call');
    expect(ended, ['o1']);

    await NativeCall.instance.dismiss('o3');
    await NativeCall.instance.callEnded('o1');
    expect(told, containsAll(['dismiss {"outreachId":"o3"}', 'callEnded {"outreachId":"o1"}']));

    await a.cancel();
    await e.cancel();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
    Api.testClient = null;
  });

  test('sign out: the server is told to forget this phone\'s token, the native side unlinks, and a later token goes nowhere', () async {
    final told = <String>[];
    final reqs = <http.Request>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, (c) async {
      told.add(c.method);
      return null;
    });
    Api.testClient = MockClient((req) async {
      reqs.add(req);
      return http.Response('{"ok":true}', 200);
    });
    await NativeCall.instance.start('abc12345');
    await fromNative('token', {'platform': 'android', 'token': 'TOKEN0123456789abcdef:APA-x'});
    reqs.clear();
    await NativeCall.instance.unlink();
    expect(reqs.single.method, 'DELETE');
    expect(reqs.single.url.path, '/api/care/abc12345/device/${Uri.encodeComponent('TOKEN0123456789abcdef:APA-x')}');
    expect(told.last, 'unlink');
    reqs.clear();
    await fromNative('token', {'platform': 'android', 'token': 'ANOTHER0123456789abcdef'});
    expect(reqs, isEmpty, reason: 'signed out: no token is registered for anyone');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
    Api.testClient = null;
  });

  test('a phone with no native side (tests, desktop) is not an error', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
    await NativeCall.instance.start('abc12345');
    await NativeCall.instance.dismiss('x');
  });

  test('Accept carries what rang (welfare / reminder / callback) so the live call is joined with the right reason; unknown is a reminder, and it is read once', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, (c) async => null);
    await NativeCall.instance.start('abc12345');
    await fromNative('accepted', {'outreachId': 'w1', 'kind': 'welfare'});
    await fromNative('accepted', {'outreachId': 'c1', 'kind': 'callback'});
    await fromNative('accepted', {'outreachId': 'r1'});
    expect(NativeCall.instance.kindOf('w1'), 'welfare');
    expect(NativeCall.instance.kindOf('w1'), 'reminder', reason: 'read once');
    expect(NativeCall.instance.kindOf('c1'), 'callback');
    expect(NativeCall.instance.kindOf('r1'), 'reminder');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
  });

  test('iOS: after Accept the microphone waits for the call audio (CallKit activated it); if it never says, it goes on after the timeout; Android and in-app rings do not wait', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, (c) async => null);
    await NativeCall.instance.start('abc12345');
    NativeCall.isIOS = true;
    try {
      await fromNative('accepted', {'outreachId': 'o9', 'kind': 'reminder'});
      var done = false;
      final w = NativeCall.instance.audioReady().then((_) => done = true);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(done, isFalse, reason: 'still waiting for the call audio');
      await fromNative('audioActive', {});
      await w;
      expect(done, isTrue);
      await NativeCall.instance.audioReady();   // already on: no wait
      await fromNative('accepted', {'outreachId': 'o10'});
      final t0 = DateTime.now();
      await NativeCall.instance.audioReady(timeout: const Duration(milliseconds: 120));
      expect(DateTime.now().difference(t0).inMilliseconds, greaterThanOrEqualTo(100), reason: 'no audio event: it waited, then went on');
      NativeCall.isIOS = false;
      final t1 = DateTime.now();
      await fromNative('accepted', {'outreachId': 'o11'});
      await NativeCall.instance.audioReady(timeout: const Duration(seconds: 5));
      expect(DateTime.now().difference(t1).inMilliseconds, lessThan(500), reason: 'Android: no wait');
    } finally {
      NativeCall.isIOS = false;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
    }
  });

  test('closed-app notifications: a tap on the call notification reaches Dart as "ring" (nothing is declined or accepted by it); a tap on a text or voice-note notification reaches Dart as "opened" with what it was and the voice note\'s id', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, (c) async => null);
    await NativeCall.instance.start('abc12345');
    final rings = <String>[];
    final opened = <({String via, String messageId})>[];
    final accepted = <String>[];
    final a = NativeCall.instance.ring.listen(rings.add);
    final b = NativeCall.instance.opened.listen(opened.add);
    final c = NativeCall.instance.accepted.listen(accepted.add);
    await fromNative('ring', {'outreachId': 'o7'});
    await fromNative('opened', {'via': 'voice', 'messageId': 'm9'});
    await fromNative('opened', {'via': 'text', 'messageId': ''});
    await Future<void>.delayed(Duration.zero);
    expect(rings, ['o7']);
    expect(accepted, isEmpty, reason: 'a tap on the notification is not an Accept');
    expect(opened.map((e) => '${e.via}:${e.messageId}'), ['voice:m9', 'text:']);
    await a.cancel();
    await b.cancel();
    await c.cancel();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
  });
}
