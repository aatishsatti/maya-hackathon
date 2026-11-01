import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:maya_app/family/dashboard.dart';
import 'package:maya_app/family/family_login.dart';
import 'package:maya_app/family/family_data.dart';
import 'package:maya_app/family/family_ring.dart';
import 'package:maya_app/family/schedule_upload.dart';
import 'package:maya_app/start/start_gate.dart';
import 'package:maya_app/main.dart';
import 'package:maya_app/models.dart';
import 'package:maya_app/services/api.dart';
import 'package:maya_app/services/store.dart';
import 'package:maya_app/senior/call_screen.dart';
import 'package:maya_app/senior/senior_screen.dart';
import 'package:maya_app/senior/chat_view.dart';
import 'package:maya_app/services/audio_route.dart';
import 'package:maya_app/services/call_session.dart';
import 'package:maya_app/services/voice_player.dart';
import 'package:maya_app/widgets/delivery_picker.dart';
import 'package:maya_app/widgets/orb.dart';
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
          'whatsappRules': ['Text and voice notes: WhatsApp only lets Maya send these within 24 hours after the person last wrote to Maya on WhatsApp.', 'If WhatsApp cannot deliver, the same reminder goes to the Maya app instead, and the Activity list tells you what happened and why.'],
          'reminders': [
            {'id': 'r1', 'task': 'Take your tablets', 'dueAt': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch, 'repeat': 'none', 'deliver': 'call', 'channel': 'both', 'held': false, 'msg': false, 'active': null, 'last': null},
            for (var i = 0; i < 8; i++) {'id': 'f$i', 'task': 'Old reminder $i', 'dueAt': null, 'repeat': 'none', 'held': false, 'msg': false, 'active': null, 'last': {'state': 'done', 'at': 1700000000000 + i * 1000, 'label': 'Done, senior replied'}},
            {'id': 'r9', 'task': 'Stretch my legs', 'dueAt': DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch, 'repeat': 'hourly', 'deliver': 'voice', 'channel': 'whatsapp', 'by': 'senior', 'held': false, 'msg': false, 'active': null, 'last': null},
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

/// Opens a dashboard section by its name (the summary can scroll on a small phone).
Future<void> openSection(WidgetTester t, String name) async {
  await t.scrollUntilVisible(find.text(name).last, 200, scrollable: find.byType(Scrollable).first);
  await t.ensureVisible(find.text(name).last);
  await t.pump();
  await t.tap(find.text(name).last);
  await t.pump(const Duration(milliseconds: 500));
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    Api.testClient = fakeServer();
  });

  group('senior side', () {
    testWidgets('the senior chat: no home page, no big Call button, a small phone icon top right, no Family button, no login, no menu', (t) async {
      await phone(t, 360, 740);
      await t.pumpWidget(const MayaApp(home: SeniorScreen()));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Call Maya'), findsNothing, reason: 'no big Call button');
      expect(find.text('Chat with Maya'), findsNothing, reason: 'no Call-or-Chat gate: she is already in the chat');
      expect(find.byType(TextField), findsOneWidget, reason: 'the writing box is there at once');
      expect(find.bySemanticsLabel('Call Maya'), findsOneWidget, reason: 'the small phone icon in the header');
      expect(find.byIcon(Icons.call), findsOneWidget);
      expect(t.getSize(find.byIcon(Icons.call)).width, lessThan(60));
      final icon = t.getRect(find.byIcon(Icons.call));
      expect(icon.top, lessThan(80));
      expect(icon.right, greaterThan(360 - 80), reason: 'top right');
      expect(find.text('Family'), findsNothing, reason: 'no Family button in the senior chat: the family has its own login');
      expect(find.byType(Drawer), findsNothing);
      expect(find.byType(AppBar), findsNothing);
      expect(find.byIcon(Icons.arrow_back_ios_new), findsNothing, reason: 'nothing to go back to');
      expect(find.textContaining(RegExp('password|log ?in|sign ?up', caseSensitive: false)), findsNothing);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the senior menu: a 44px+ button opens a sheet with four plain choices; My Reminders shows only their own; Sign out forgets the link and keeps nothing of the family', (t) async {
      SharedPreferences.setMockInitialValues({'profileId': 'abcdef12', 'profileName': 'Rosa'});
      Store.forgetForTest();
      addTearDown(Store.forgetForTest);   // the next test starts from its own saved values
      Api.testClient = MockClient((req) async {
        if (req.url.path == '/api/senior/abcdef12/menu') {
          return http.Response(jsonEncode({'name': 'Rosa', 'tz': 'Europe/London', 'mode': 'standard', 'reminders': [{'id': 'm1', 'task': 'Call my sister', 'dueAt': DateTime.now().add(const Duration(hours: 3)).millisecondsSinceEpoch, 'repeat': 'daily', 'every': 1, 'deliver': 'voice', 'channel': 'app', 'going': false}]}), 200, headers: {'content-type': 'application/json'});
        }
        return http.Response(jsonEncode({'messages': []}), 200, headers: {'content-type': 'application/json'});
      });
      await phone(t, 360, 740);
      await t.pumpWidget(const MayaApp(home: SeniorScreen()));
      await t.pump(const Duration(milliseconds: 300));
      expect(t.getSize(find.bySemanticsLabel('Menu')).width, greaterThanOrEqualTo(44));
      expect(find.text('Family'), findsNothing);
      await t.tap(find.bySemanticsLabel('Menu'));
      await t.pumpAndSettle();
      for (final x in const ['My Reminders', 'My Profile', 'Help / About Maya', 'Sign out']) {
        expect(find.text(x), findsOneWidget);
      }
      await t.tap(find.text('My Reminders'));
      await t.pumpAndSettle();
      expect(find.text('Call my sister'), findsOneWidget);
      expect(find.textContaining('Every day'), findsOneWidget);
      await t.tap(find.text('Call my sister'));
      await t.pumpAndSettle();
      expect(find.text('Stop this reminder'), findsOneWidget);
      await t.tap(find.byIcon(Icons.arrow_back));
      await t.pumpAndSettle();
      await t.tap(find.byIcon(Icons.arrow_back));
      await t.pumpAndSettle();
      await t.tap(find.text('Sign out'));
      await t.pumpAndSettle();
      await t.tap(find.text('Sign out').last);
      await t.pumpAndSettle();
      expect(await Store.profileId(), isNull, reason: 'the phone forgot the senior link');
      expect(find.text('Enter code'), findsWidgets, reason: 'back at the start screen');
      await t.pump(const Duration(seconds: 5));   // the stopped live stream's last pause ends
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the senior screen fits without scrolling on a small and a normal phone, and only the chat can scroll', (t) async {
      for (final s in const [Size(320, 480), Size(360, 640), Size(390, 844)]) {
        await phone(t, s.width, s.height);
        await t.pumpWidget(const MayaApp(home: SeniorScreen()));
        await t.pump(const Duration(milliseconds: 300));
        expect(t.takeException(), isNull, reason: 'no overflow at ${s.width}x${s.height}');
        expect(find.byType(SingleChildScrollView), findsNothing, reason: 'no page that scrolls');
        expect(find.bySemanticsLabel('Call Maya'), findsOneWidget);
        // the whole screen stays inside the window
        expect(t.getRect(find.byType(TextField)).bottom, lessThanOrEqualTo(s.height));
        // the chat is the only list on the screen; with no messages it is a plain line, so nothing scrolls
        expect(find.byType(ListView), findsNothing);
      }
    });

    testWidgets('with the keyboard open on a small phone the chat page still fits (the keyboard can only open in the chat)', (t) async {
      await phone(t, 320, 480);
      await t.pumpWidget(const MayaApp(home: SeniorScreen()));
      await t.pump(const Duration(milliseconds: 300));
      t.view.viewInsets = const FakeViewPadding(bottom: 250 * 3);
      addTearDown(t.view.resetViewInsets);
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      expect(find.byType(TextField), findsOneWidget);
    });
  });

  group('family side', () {
    testWidgets('there is no PIN: the start screen offers Log in and Sign up for the family and Enter code for the senior; a code is read from the last 8 letters of the link', (t) async {
      await phone(t, 320, 480);
      SharedPreferences.setMockInitialValues({});
      Store.forgetForTest();
      await t.pumpWidget(const MaterialApp(home: StartGate()));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Log in'), findsOneWidget);
      expect(find.text('Sign up'), findsOneWidget);
      expect(find.text('Enter code'), findsOneWidget);
      expect(find.textContaining('PIN'), findsNothing);
      expect(t.takeException(), isNull);
      expect(codeFrom('a1b2c3d4'), 'a1b2c3d4');
      expect(codeFrom('/s/a1b2c3d4'), 'a1b2c3d4');
      expect(codeFrom('https://maya-singapore.onrender.com/s/A1B2C3D4/'), 'a1b2c3d4');
      expect(codeFrom('hello'), isNull);
      expect(codeFrom('https://evil.example/x/a1b2c3d4'), isNull, reason: 'only a Maya senior link shape is a code');
      await t.ensureVisible(find.text('Enter code'));
      await t.tap(find.text('Enter code'));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Open Maya'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('a phone that already has a senior opens straight into the chat (no start screen, no login); the chat has no Family button', (t) async {
      await phone(t, 390, 844);
      SharedPreferences.setMockInitialValues({'profileId': 'a1b2c3d4', 'profileName': 'Kali'});
      Store.forgetForTest();
      await t.pumpWidget(const MayaApp());
      await t.pump(const Duration(milliseconds: 600));
      await t.pump(const Duration(milliseconds: 600));
      expect(find.byType(TextField), findsOneWidget, reason: 'the chat box is there at once');
      expect(find.text('Log in'), findsNothing);
      expect(find.text('Family'), findsNothing, reason: 'the family has its own login, not a button in the senior chat');
      expect(find.textContaining('Kali'), findsWidgets);
      await t.pumpWidget(const SizedBox());
      await t.pump(const Duration(seconds: 5));   // the closed screen's live stream finishes its last pause (no timer left over)
    });

    testWidgets('family login and signup: a username and a password, the same account as on the web', (t) async {
      await phone(t, 360, 640);
      SharedPreferences.setMockInitialValues({});
      Store.forgetForTest();
      await t.pumpWidget(const MaterialApp(home: FamilyLogin(signup: true)));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Username'), findsOneWidget);
      expect(find.text('Password'), findsOneWidget);
      expect(find.textContaining('PIN'), findsNothing);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the dashboard is a SUMMARY first (status, next check, reminders today, latest rows) and five sections that open on a tap with a Close; the activity cards are inside Activity', (t) async {
      await phone(t, 360, 640);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      expect(find.text('OK'), findsOneWidget, reason: 'the status at a glance');
      expect(find.text('Next check'), findsOneWidget);
      expect(find.text('Reminders today'), findsOneWidget);
      await t.scrollUntilVisible(find.text('Latest'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Latest'), findsOneWidget);
      for (final sec in const ['Check In With Them', 'Reminders', 'Activity', 'Family Members', 'Settings']) {
        expect(find.text(sec), findsWidgets);
      }
      expect(find.text('Sent'), findsNothing, reason: 'the activity cards are not on the summary');
      expect(find.byType(RefreshIndicator), findsNothing);
      await openSection(t, 'Activity');
      await t.pump(const Duration(milliseconds: 500));
      for (final label in const ['Sent', 'Delivered', 'Read', 'Answered', 'Missed']) {
        expect(find.text(label), findsWidgets);
      }
      expect(find.text('7'), findsOneWidget); // the server's own count, not invented
      expect(find.text('Take your tablets'), findsWidgets);
      expect(find.text('Close'), findsOneWidget);
      await t.tap(find.text('Close'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 900));
      expect(find.text('Close'), findsNothing, reason: 'Close goes back to the summary');
      expect(find.text('Latest'), findsWidgets);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the Call / Text / Voice note picker and the Where it goes picker (Maya app / WhatsApp / Both) are on the Welfare tab; the Reminder sheet has both pickers too', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await openSection(t, 'Check In With Them');
      await t.pump(const Duration(milliseconds: 400));
      expect(find.byType(DeliveryPicker), findsWidgets);
      for (final o in const ['Call', 'Text', 'Voice note']) {
        expect(find.text(o), findsWidgets);
      }
      expect(find.text('Check in now'), findsOneWidget);
      expect(find.byType(WherePicker), findsWidgets, reason: 'welfare: where it goes, now and for the schedule');
      for (final o in const ['Maya app', 'WhatsApp', 'Both']) {
        expect(find.text(o), findsWidgets);
      }
      await t.tap(find.text('Close'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 900));
      await openSection(t, 'Reminders');
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
      await openSection(t, 'Reminders');
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

    testWidgets('WhatsApp\'s rules are NOT on the page: the "How WhatsApp reminders work" button appears only once WhatsApp (or Both) is chosen, and opens them in a sheet with a Close', (t) async {
      await phone(t, 360, 800);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await openSection(t, 'Reminders');
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.text('Add a reminder'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.text('How WhatsApp reminders work'), findsNothing, reason: 'nothing chosen: no WhatsApp information');
      expect(find.textContaining('within 24 hours after the person last wrote'), findsNothing);
      await t.tap(find.text('WhatsApp').last);
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.text('How WhatsApp reminders work'), findsOneWidget);
      await t.tap(find.text('How WhatsApp reminders work'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.textContaining('within 24 hours after the person last wrote'), findsOneWidget);
      expect(find.textContaining('Maya app instead'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('tap a reminder: an edit sheet with Save changes, and Stop this reminder asks once more before it stops', (t) async {
      await phone(t, 360, 800);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await openSection(t, 'Reminders');
      await t.pump(const Duration(milliseconds: 400));
      expect(find.byTooltip('Delete Take your tablets'), findsNothing, reason: 'no loose delete button in the list');
      await t.tap(find.text('Take your tablets').last);
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.text('Edit reminder'), findsOneWidget);
      expect(find.text('Save changes'), findsOneWidget);
      await t.scrollUntilVisible(find.text('Stop this reminder'), 100, scrollable: find.byType(Scrollable).last);
      await t.tap(find.text('Stop this reminder'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.text('Stop this reminder?'), findsOneWidget, reason: 'destructive: asked once more');
      await t.tap(find.text('Keep it'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.text('Stop this reminder?'), findsNothing);
      expect(find.text('Edit reminder'), findsOneWidget, reason: 'Keep it leaves the sheet as it was');
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the ring screen: "Maya is calling", the fixed topic-only line, Decline (red) on the LEFT and Accept (green) on the RIGHT', (t) async {
      await phone(t, 390, 844);
      var answer = '';
      await t.pumpWidget(MaterialApp(home: FamilyRingScreen(text: 'This is Maya. Rosa has not responded to reminders. Please check in.', onAccept: () => answer = 'accept', onDecline: () => answer = 'decline')));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Maya is calling'), findsOneWidget);
      expect(find.textContaining('has not responded to reminders'), findsOneWidget);
      expect(t.getCenter(find.text('Decline')).dx, lessThan(t.getCenter(find.text('Accept')).dx), reason: 'Decline left, Accept right');
      await t.tap(find.byIcon(Icons.call_end));
      await t.pump(const Duration(milliseconds: 300));
      expect(answer, 'decline');
      await t.tap(find.byIcon(Icons.call));
      await t.pump(const Duration(milliseconds: 300));
      expect(answer, 'accept');
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('upload a schedule: type it, Maya lists what she found with nothing ticked, and only the ticked ones are set', (t) async {
      await phone(t, 390, 844);
      final posts = <String>[];
      Api.testClient = MockClient((req) async {
        posts.add('${req.method} ${req.url.path} ${req.body}');
        final body = req.url.path.endsWith('/schedule/text') ? {'items': [{'id': '1', 'task': 'take your tablet', 'when': '8:00 AM every day'}, {'id': '2', 'task': 'go for a walk', 'when': '5:00 PM every day'}]} : {'set': ['take your tablet at 8:00 AM every day'], 'failed': [], 'skipped': ['go for a walk']};
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
      });
      addTearDown(() => Api.testClient = null);
      await t.pumpWidget(MaterialApp(home: Scaffold(body: ScheduleUpload(data: FamilyData('abcdef12')))));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('Photo'), findsOneWidget);
      expect(find.text('PDF'), findsOneWidget);
      expect(find.text('Voice'), findsOneWidget);
      await t.tap(find.text('Type it'));
      await t.pump(const Duration(milliseconds: 300));
      await t.enterText(find.byType(TextField), 'tablet at 8 am daily, walk at 5 pm daily');
      await t.tap(find.text('Read it'));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.text('What Maya found'), findsOneWidget);
      expect(find.text('Tick the ones you want'), findsOneWidget, reason: 'nothing is ticked, nothing can be set');
      expect(posts.where((p) => p.contains('/schedule/set')), isEmpty, reason: 'reading sets nothing');
      await t.tap(find.text('take your tablet'));
      await t.pump(const Duration(milliseconds: 200));
      expect(find.text('Set 1 reminder'), findsOneWidget);
      await t.tap(find.text('Set 1 reminder'));
      await t.pump(const Duration(milliseconds: 300));
      expect(posts.where((p) => p.contains('/schedule/set')).last, contains('"ids":["1"]'));
      expect(find.textContaining('Set 1 reminder: take your tablet at 8:00 AM every day'), findsOneWidget);
      expect(find.textContaining('Not set (not ticked): go for a walk'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('welfare check options: Every day, Every 2 days, Every week, Every 2 weeks; no minute or hour preset; the custom interval is under Advanced and warns; only Start shows with no schedule', (t) async {
      await phone(t, 360, 800);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await openSection(t, 'Check In With Them');
      await t.pump(const Duration(milliseconds: 400));
      await t.pump(const Duration(milliseconds: 400));
      await t.scrollUntilVisible(find.text('Every day'), 200, scrollable: find.byType(Scrollable).last);
      await t.tap(find.text('Every day'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      for (final o in const ['Every 2 days', 'Every week', 'Every 2 weeks']) {
        expect(find.text(o), findsWidgets);
      }
      expect(find.text('Every hour'), findsNothing);
      expect(find.textContaining('minutes'), findsNothing);
      expect(find.textContaining('not available yet'), findsNothing);
      expect(find.byKey(const Key('schedStart')), findsOneWidget);
      expect(find.byKey(const Key('schedStop')), findsNothing);
      await t.tap(find.text('Every day').last);
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      await t.scrollUntilVisible(find.text('Advanced: a custom interval'), 200, scrollable: find.byType(Scrollable).last);
      await t.tap(find.text('Advanced: a custom interval'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.textContaining('Too frequent will pause for flooding'), findsOneWidget);
      expect(find.text('How many?'), findsOneWidget);
      expect(find.text('Unit'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('a reminder the person set by talking to Maya says so, with its channel, delivery type and repeat', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await openSection(t, 'Reminders');
      await t.pump(const Duration(milliseconds: 400));
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      expect(find.text('Stretch my legs'), findsOneWidget);
      expect(find.text('Set by talking'), findsOneWidget, reason: 'only the one they set themselves');
      expect(find.textContaining('repeats hourly'), findsOneWidget);
      expect(find.text('Voice note'), findsWidgets);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('Activity has a Calls filter, shows App / WhatsApp on each row, and a call row says how long they talked', (t) async {
      await phone(t, 360, 700);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump(const Duration(milliseconds: 400));
      await openSection(t, 'Activity');
      await t.pump(const Duration(milliseconds: 600));
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
      await openSection(t, 'Settings');
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

    testWidgets('the call screen has a Speaker button beside Mute and End call (Android): on at the start, Earpiece when switched, always visible and fitting on a small phone; iOS shows none', (t) async {
      final keep = AudioRoute.android;
      try {
        AudioRoute.android = true;
        for (final size in const [Size(320, 480), Size(390, 844)]) {
          await phone(t, size.width, size.height);
          await t.pumpWidget(MaterialApp(home: CallScreen(session: CallSession(profileId: 'abcdef12', autoStart: false, route: _NoRoute()))));
          await t.pump(const Duration(milliseconds: 300));
          expect(t.takeException(), isNull, reason: 'no overflow at ${size.width}x${size.height}');
          expect(find.text('Speaker'), findsOneWidget);
          expect(find.text('Mute'), findsOneWidget);
          expect(find.text('End call'), findsOneWidget);
          expect(t.getRect(find.text('Speaker')).bottom, lessThanOrEqualTo(size.height));
          await t.tap(find.byIcon(Icons.volume_up));
          await t.pump(const Duration(milliseconds: 300));
          expect(find.text('Earpiece'), findsOneWidget);
          expect(find.text('Speaker'), findsNothing);
          await t.tap(find.byIcon(Icons.hearing));
          await t.pump(const Duration(milliseconds: 300));
          expect(find.text('Speaker'), findsOneWidget);
          await t.pumpWidget(const SizedBox());
        }
        AudioRoute.android = false;
        await phone(t, 390, 844);
        await t.pumpWidget(MaterialApp(home: CallScreen(session: CallSession(profileId: 'abcdef12', autoStart: false))));
        await t.pump(const Duration(milliseconds: 300));
        expect(find.text('Speaker'), findsNothing);
        expect(find.text('Earpiece'), findsNothing);
        await t.pumpWidget(const SizedBox());
      } finally {
        AudioRoute.android = keep;
      }
    });

    testWidgets('a voice note opened from its notification starts playing by itself (autoPlay), and only that one; the others wait to be tapped', (t) async {
      await phone(t, 360, 700);
      final urls = <String>[];
      for (final name in const ['xyz.luan/audioplayers', 'xyz.luan/audioplayers.global']) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(name), (c) async {
          if (c.method == 'setSourceUrl' && c.arguments is Map) urls.add('${(c.arguments as Map)['url']}');
          return null;
        });
      }
      await t.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: const [VoiceBubble(url: 'http://127.0.0.1:1/a.wav'), VoiceBubble(url: 'http://127.0.0.1:1/b.wav', autoPlay: true)]))));
      await t.pump(const Duration(milliseconds: 300));
      await t.pump(const Duration(milliseconds: 300));
      expect(urls, ['http://127.0.0.1:1/b.wav'], reason: 'only the voice note whose notification was tapped started by itself');
      await t.pumpWidget(const SizedBox());
      for (final name in const ['xyz.luan/audioplayers', 'xyz.luan/audioplayers.global']) {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(name), null);
      }
    });

    testWidgets('the incoming-call page: "Maya is calling" in large type, one line for why from the kind of call only, Accept and Decline on the same see-through page (no card)', (t) async {
      await phone(t, 390, 844);
      for (final c in const [('welfare', 'A welfare check'), ('reminder', 'A reminder from your family'), ('callback', 'A quick check-in'), ('', 'A check-in')]) {
        var accepted = 0, declined = 0;
        await t.pumpWidget(MaterialApp(home: Scaffold(body: Stack(children: [IncomingCallCard(kind: c.$1, onAccept: () => accepted++, onDecline: () => declined++)]))));
        await t.pump(const Duration(milliseconds: 300));
        expect(find.text('Maya is calling'), findsOneWidget);
        expect(find.textContaining(c.$2), findsOneWidget, reason: 'the line for "${c.$1}"');
        expect(find.byType(Card), findsNothing);
        expect(find.byType(CallBackdrop), findsOneWidget);
        expect(t.getSize(find.byIcon(Icons.call)).width, greaterThanOrEqualTo(40));
        await t.tap(find.byIcon(Icons.call));
        await t.tap(find.byIcon(Icons.call_end));
        expect([accepted, declined], [1, 1]);
        await t.pumpWidget(const SizedBox());
      }
    });

    testWidgets('the chat box: write or record in one chat; a microphone while the box is empty, an arrow once there is text', (t) async {
      await phone(t, 390, 844);
      await t.pumpWidget(const MayaApp(home: SeniorScreen()));
      await t.pump(const Duration(milliseconds: 400));
      expect(find.bySemanticsLabel('Record a voice note'), findsOneWidget);
      expect(find.byIcon(Icons.mic), findsOneWidget);
      await t.enterText(find.byType(TextField), 'Hello Maya');
      await t.pump(const Duration(milliseconds: 300));
      expect(find.bySemanticsLabel('Send'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_upward), findsOneWidget);
      expect(find.bySemanticsLabel('Record a voice note'), findsNothing);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('a voice note in the chat: a play button, a waveform you can slide along, and the room for its length', (t) async {
      await phone(t, 390, 844);
      await t.pumpWidget(const MaterialApp(home: Scaffold(body: Padding(padding: EdgeInsets.all(16), child: VoiceBubble(url: 'http://127.0.0.1:1/a.wav')))));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.byIcon(Icons.play_arrow), findsOneWidget);
      expect(find.bySemanticsLabel('Play the voice note'), findsOneWidget);
      expect(find.bySemanticsLabel('Voice note position'), findsOneWidget);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the paperclip opens a sheet with three plain choices, in words, and Cancel closes it', (t) async {
      await phone(t, 390, 844);
      await t.pumpWidget(const MayaApp(home: SeniorScreen()));
      await t.pump(const Duration(milliseconds: 400));
      await t.tap(find.byIcon(Icons.attach_file));
      await t.pump(const Duration(milliseconds: 100));
      await t.pump(const Duration(milliseconds: 600));
      for (final label in const ['Attach image', 'Attach file (PDF)', 'Take photo']) {
        expect(find.text(label), findsOneWidget);
        expect(t.getRect(find.text(label)).height, greaterThan(10));
      }
      await t.tap(find.text('Cancel'));
      await t.pump(const Duration(milliseconds: 100));
      await t.pump(const Duration(milliseconds: 600));
      expect(find.text('Send Maya something'), findsNothing);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the attachment sheet answers image / pdf / camera', (t) async {
      await phone(t, 390, 844);
      String? got;
      await t.pumpWidget(MaterialApp(home: Builder(builder: (c) => Scaffold(body: Center(child: TextButton(onPressed: () async => got = await showAttachSheet(c), child: const Text('open')))))));
      for (final want in const [('Attach file (PDF)', 'pdf'), ('Take photo', 'camera'), ('Attach image', 'image')]) {
        await t.tap(find.text('open'));
        await t.pumpAndSettle(const Duration(milliseconds: 100));
        await t.tap(find.text(want.$1));
        await t.pumpAndSettle(const Duration(milliseconds: 100));
        expect(got, want.$2);
      }
      await t.tap(find.text('open'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      expect(got, isNull, reason: 'closing it answers nothing');
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('on the call page "Go back to chat" is in words, apart from the controls; it leaves the page with the answer "chat" and does NOT end the call; End call still ends it', (t) async {
      await phone(t, 390, 844);
      final s = CallSession(profileId: 'abcdef12', autoStart: false, route: _NoRoute());
      s.phase = CallPhase.live;
      String? result;
      var popped = false;
      await t.pumpWidget(MaterialApp(home: Builder(builder: (c) => Scaffold(body: Center(child: TextButton(onPressed: () async { result = await Navigator.of(c).push<String>(MaterialPageRoute(builder: (_) => CallScreen(session: s, resume: true))); popped = true; }, child: const Text('go')))))));
      await t.tap(find.text('go'));
      await t.pump(const Duration(milliseconds: 100));
      await t.pump(const Duration(milliseconds: 600));
      expect(find.text('Go back to chat'), findsOneWidget);
      final back = t.getRect(find.text('Go back to chat')), end = t.getRect(find.text('End call')), mute = t.getRect(find.text('Mute'));
      expect(back.bottom, lessThan(mute.top - 16), reason: 'above the controls, with room: it cannot be tapped for End call');
      expect(end.top - back.bottom, greaterThan(100));
      await t.tap(find.text('Go back to chat'));
      await t.pump(const Duration(milliseconds: 100));
      await t.pump(const Duration(milliseconds: 600));
      expect(popped, isTrue);
      expect(result, 'chat');
      expect(s.ended, isFalse, reason: 'the call keeps running');
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('the orb reads the sound on every frame and moves with it: louder, further; every frame is drawn from the live level', (t) async {
      await phone(t, 390, 844);
      var reads = 0;
      double loud = 0;
      await t.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: MayaOrb(state: OrbState.listening, size: 240, level: () {
        reads++;
        return loud;
      })))));
      for (var i = 0; i < 20; i++) {
        await t.pump(const Duration(milliseconds: 16));
      }
      expect(reads, greaterThanOrEqualTo(20), reason: 'the level is read on every frame, not once');
      loud = 1;
      final before = reads;
      for (var i = 0; i < 10; i++) {
        await t.pump(const Duration(milliseconds: 16));
      }
      expect(reads - before, greaterThanOrEqualTo(10));
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('on a small phone the summary shows the status and the first card without any menu, there is no tab bar and no long page of cards', (t) async {
      await phone(t, 320, 480);
      await t.pumpWidget(const MaterialApp(home: FamilyDashboard(profile: Profile('abcdef12', 'Rosa'))));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      expect(find.byType(NavigationBar), findsNothing, reason: 'sections are popups, not tabs');
      expect(find.text('OK'), findsOneWidget);
      expect(t.getRect(find.text('Next check')).bottom, lessThanOrEqualTo(480));
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

class _NoRoute implements AudioRouteSink {
  @override
  Future<void> setSpeaker(bool on) async {}
  @override
  Future<void> release() async {}
}
