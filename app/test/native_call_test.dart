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

  test('a phone with no native side (tests, desktop) is not an error', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeCall.channel, null);
    await NativeCall.instance.start('abc12345');
    await NativeCall.instance.dismiss('x');
  });
}
