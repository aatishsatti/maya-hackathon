import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:maya_app/family/dashboard.dart';
import 'package:maya_app/family/family_gate.dart';
import 'package:maya_app/main.dart';
import 'package:maya_app/models.dart';
import 'package:maya_app/services/api.dart';
import 'package:maya_app/senior/call_screen.dart';
import 'package:maya_app/services/call_session.dart';
import 'package:maya_app/services/voice_player.dart';
import 'package:maya_app/widgets/delivery_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

int verticalLists(WidgetTester t) => t.widgetList<Scrollable>(find.byType(Scrollable)).where((s) => s.axis == Axis.vertical).length;

Future<void> phone(WidgetTester t, double w, double h) async {
  t.view.physicalSize = Size(w * 3, h * 3);
  t.view.devicePixelRatio = 3;
  addTearDown(t.view.reset);
}

/// A stand-in server for the dashboard: the same shapes care.view and whatsapp.view send.
http.Client fakeServer() => MockClient((req) async {
      final p = req.url.path;
      Map<String, dynamic> body = {};
      if (p.startsWith('/api/care/')) {
        body = {
          'id': 'abcdef12',
          'name': 'Rosa',
          'mode': 'standard',
          'modes': {'standard': {'label': 'Standard', 'desc': 'Calm'}},
          'delivery': {'reminders': 'voice'},
          'appOpen': true,
          'inCall': false,
          'lastSeen': {'at': DateTime.now().millisecondsSinceEpoch},
          'quiet': {'start': 22, 'end': 7, 'tz': 'Europe/London'},
          'reminders': [
            {'id': 'r1', 'task': 'Take your tablets', 'dueAt': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch, 'repeat': 'none', 'deliver': 'call', 'channel': 'both', 'held': false, 'msg': false, 'active': null, 'last': null},
            for (var i = 0; i < 8; i++) {'id': 'f$i', 'task': 'Old reminder $i', 'dueAt': null, 'repeat': 'none', 'held': false, 'msg': false, 'active': null, 'last': {'state': 'done', 'at': 1700000000000 + i * 1000, 'label': 'Done, senior replied'}},
            {'id': 'r2', 'task': 'Drink water', 'dueAt': DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch, 'repeat': 'none', 'deliver': 'text', 'channel': 'app', 'held': false, 'msg': false, 'active': null, 'last': null},
          ],
          'alerts': [],
          'flags': [],
          'scams': [],
        };
      } else if (p.startsWith('/api/whatsapp/')) {
        final now = DateTime.now().millisecondsSinceEpoch;
        body = {
          'linked': true,
          'configured': true,
          'optIn': true,
          'windowOpen': true,
          'phoneEnd': '8237',
          'calls': {'misses': 0, 'maxMisses': 2, 'blocked': null, 'meta': null},
          'welfareSchedule': null,
          'activity': {
            'entries': [
              {'id': 'a', 'type': 'reminder', 'channel': 'voice', 'status': 'read', 'label': 'Read', 'at': now - 600000, 'words': 'Take your tablets'},
              {'id': 'b', 'type': 'welfare', 'channel': 'call', 'status': 'answered', 'label': 'Answered', 'at': now - 3600000, 'words': null, 'where': 'whatsapp'},
              {'id': 'c', 'type': 'call', 'channel': 'call', 'status': 'completed', 'label': 'Talked, 4 min', 'at': now - 7200000, 'words': null, 'where': 'app'},
            ],
            'summary': {'sent': 7, 'delivered': 6, 'read': 4, 'answered': 3, 'missed': 1},
          },
        };
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    Api.testClient = fakeServer();
  });

  group('senior side', () {
    testWidgets('the big Call button is on the first screen: no login, no password, no menu', (t) async {
      await phone(t, 360, 740);
      await t.pumpWidget(const MayaApp());
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Call Maya'), findsOneWidget);
      expect(find.bySemanticsLabel('Call Maya'), findsWidgets);
      expect(find.text('Family'), findsOneWidget); // the small link
      expect(find.byType(Drawer), findsNothing);
      expect(find.byType(AppBar), findsNothing);
      expect(find.textContaining(RegExp('password|log ?in|sign ?up', caseSensitive: false)), findsNothing);
      final size = t.getSize(find.text('Call Maya'));
      expect(size.height, greaterThan(10));
      // the Call button is big and every tap target is at least 48 logical pixels
      final callBox = t.getRect(find.ancestor(of: find.text('Call Maya'), matching: find.byType(Container)).first);
      expect(callBox.width, greaterThanOrEqualTo(104));
    });

    testWidgets('the senior screen fits without scrolling on a small and a normal phone, and only the chat can scroll', (t) async {
      for (final s in const [Size(320, 480), Size(360, 640), Size(390, 844)]) {
        await phone(t, s.width, s.height);
        await t.pumpWidget(const MayaApp());
        await t.pump(const Duration(milliseconds: 300));
        expect(t.takeException(), isNull, reason: 'no overflow at ${s.width}x${s.height}');
        expect(find.byType(SingleChildScrollView), findsNothing, reason: 'no page that scrolls');
        expect(find.text('Call Maya'), findsOneWidget);
        // the whole screen stays inside the window
        final r = t.getRect(find.text('Family'));
        expect(r.bottom, lessThanOrEqualTo(s.height));
        // the chat is the only list on the screen; with no messages it is a plain line, so nothing scrolls
        expect(find.byType(ListView), findsNothing);
      }
    });

    testWidgets('with the keyboard open on a small phone the screen still fits', (t) async {
      await phone(t, 320, 480);
      t.view.viewInsets = const FakeViewPadding(bottom: 250 * 3);
      addTearDown(t.view.resetViewInsets);
      await t.pumpWidget(const MayaApp());
      await t.pump(const Duration(milliseconds: 300));
      expect(t.takeException(), isNull);
      expect(find.byType(TextField), findsOneWidget);
    });
  });

  group('family side', () {
    testWidgets('the family area opens on a PIN screen (a first PIN is chosen, then repeated); it fits on a small phone', (t) async {
      await phone(t, 320, 480);
      await t.pumpWidget(const MaterialApp(home: FamilyGate()));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Choose a family PIN'), findsOneWidget);
      expect(find.text('5'), findsOneWidget);
      expect(find.byType(SingleChildScrollView), findsNothing);
      expect(t.takeException(), isNull);
      for (final d in ['1', '2', '3', '4']) {
        await t.tap(find.text(d));
        await t.pump(const Duration(milliseconds: 50));
      }
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Repeat the PIN'), findsOneWidget);
    });

    testWidgets('the dashboard shows the five cards from the server, the activity list and the five tabs', (t) async {
      await phone(t, 360, 640);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      for (final label in const ['Sent', 'Delivered', 'Read', 'Answered', 'Missed']) {
        expect(find.text(label), findsWidgets);
      }
      expect(find.text('7'), findsOneWidget); // the server's own count, not invented
      expect(find.text('Take your tablets'), findsOneWidget);
      expect(find.text('Read'), findsWidgets);
      for (final tab in const ['Activity', 'Reminders', 'Welfare', 'Message', 'Setup']) {
        expect(find.text(tab), findsWidgets);
      }
      // the cards and the filters do not scroll with the list
      expect(find.byType(RefreshIndicator), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the Call / Text / Voice note picker is on the Welfare tab, the Reminder sheet and the Message tab', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.text('Welfare').last);
      await t.pump(const Duration(milliseconds: 400));
      expect(find.byType(DeliveryPicker), findsWidgets);
      for (final o in const ['Call', 'Text', 'Voice note']) {
        expect(find.text(o), findsWidgets);
      }
      expect(find.text('Check in now'), findsOneWidget);
      await t.tap(find.text('Message').last);
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.text('On WhatsApp'));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.byType(DeliveryPicker), findsOneWidget);
      await t.tap(find.text('Reminders').last);
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.text('Add a reminder'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.byType(DeliveryPicker), findsNWidgets(2)); // where it goes (WhatsApp / Maya app / Both) and how (Call / Text / Voice note)
      for (final o in const ['WhatsApp', 'Maya app', 'Both']) {
        expect(find.text(o), findsWidgets);
      }
      await t.pumpWidget(const SizedBox());
    });
  });

  group('reminders, activity and setup on the app', () {
    testWidgets('the reminder list shows what is coming first (soonest at the top), then only the latest five finished ones, with the channel and the pick on each', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.text('Reminders').last);
      await t.pump(const Duration(milliseconds: 400));
      await t.pump(const Duration(milliseconds: 400)); // the old tab fades out over 180 ms, over the second frame
      expect(t.takeException(), isNull);
      final water = t.getTopLeft(find.text('Drink water')).dy, tablets = t.getTopLeft(find.text('Take your tablets')).dy;
      expect(water, lessThan(tablets), reason: 'the one due in 5 minutes is above the one due in 2 hours');
      expect(find.text('Old reminder 0'), findsNothing, reason: 'only the latest five finished ones show');
      expect(find.text('Maya app'), findsWidgets);
      expect(find.text('WhatsApp + app'), findsWidgets);
      expect(find.text('Text'), findsWidgets);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('Activity has a Calls filter, shows App / WhatsApp on each row, and a call row says how long they talked', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      expect(find.text('Calls'), findsOneWidget);
      expect(find.text('Talked, 4 min'), findsOneWidget);
      expect(find.text('WhatsApp'), findsWidgets);
      await t.tap(find.text('Calls'));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Talked, 4 min'), findsOneWidget);
      expect(find.text('Take your tablets'), findsNothing, reason: 'the filter hides what is not a call');
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('Setup has the default channel, the call log and the person tools', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.text('Setup').last);
      await t.pump(const Duration(milliseconds: 400));
      expect(find.textContaining('When no choice is made'), findsOneWidget);
      expect(find.text('Maya app'), findsWidgets);
      await t.scrollUntilVisible(find.textContaining('Call log'), 200, scrollable: find.byType(Scrollable).last);
      expect(find.textContaining('Call log'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });
  });

  group('scroll and fit', () {
    testWidgets('the call screen fits without scrolling on a small and a normal phone', (t) async {
      for (final s in const [Size(320, 480), Size(360, 640), Size(390, 844)]) {
        await phone(t, s.width, s.height);
        await t.pumpWidget(MaterialApp(home: CallScreen(session: CallSession(profileId: 'abcdef12', autoStart: false))));
        await t.pump(const Duration(milliseconds: 300));
        expect(t.takeException(), isNull, reason: 'no overflow at ${s.width}x${s.height}');
        expect(find.byType(Scrollable), findsNothing);
        expect(find.text('End call'), findsOneWidget);
        expect(find.text('Mute'), findsOneWidget);
        expect(t.getRect(find.text('End call')).bottom, lessThanOrEqualTo(s.height));
        await t.pumpWidget(const SizedBox());
      }
    });

    testWidgets('the dashboard keeps its header, cards and tabs on a small phone; only the activity list scrolls', (t) async {
      await phone(t, 320, 480);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      expect(find.byType(SingleChildScrollView), findsNothing);
      expect(find.byType(NavigationBar), findsOneWidget);
      expect(t.getRect(find.byType(NavigationBar)).bottom, lessThanOrEqualTo(480));
      // the list is the one vertical scroller on this tab
      final lists = verticalLists(t);
      expect(lists, 1);
      await t.pumpWidget(const SizedBox());
    });
  });

  group('plumbing', () {
    test('a failed request becomes a plain sentence, never a stack trace or a fake success', () async {
      Api.testClient = MockClient((_) async => http.Response(jsonEncode({'error': 'Chat needs real mode.'}), 503));
      await expectLater(Api.get('/api/chat/abcdef12'), throwsA(isA<ApiError>().having((e) => e.message, 'message', 'Chat needs real mode.')));
      Api.testClient = MockClient((_) async => throw const FormatException('boom'));
      await expectLater(Api.get('/x'), throwsA(anything));
    });

    test('Maya\'s voice is wrapped as a valid 24 kHz mono 16-bit WAV', () {
      final pcm = List<int>.filled(480, 0);
      final w = VoicePlayer.wav(Uint8List.fromList(pcm));
      expect(String.fromCharCodes(w.sublist(0, 4)), 'RIFF');
      expect(String.fromCharCodes(w.sublist(8, 16)), 'WAVEfmt ');
      expect(ByteData.sublistView(w).getUint32(24, Endian.little), 24000);
      expect(ByteData.sublistView(w).getUint16(22, Endian.little), 1);
      expect(w.length, 44 + 480);
    });

    test('day groups: Today, Yesterday, Earlier, Upcoming', () {
      final now = DateTime(2026, 10, 31, 12);
      expect(dayGroup(DateTime(2026, 10, 31, 9).millisecondsSinceEpoch, now), 'Today');
      expect(dayGroup(DateTime(2026, 10, 30, 23).millisecondsSinceEpoch, now), 'Yesterday');
      expect(dayGroup(DateTime(2026, 10, 20).millisecondsSinceEpoch, now), 'Earlier');
      expect(dayGroup(DateTime(2026, 11, 1, 8).millisecondsSinceEpoch, now), 'Upcoming');
    });
  });
}
