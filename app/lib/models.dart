import 'services/api.dart';

class Profile {
  final String id, name;
  const Profile(this.id, this.name);
  static Profile? from(dynamic j) => j is Map && j['id'] is String && j['name'] is String ? Profile(j['id'] as String, j['name'] as String) : null;
}

/// A bubble in the chat: { id, role: 'senior'|'maya', kind: 'text'|'voice'|'image', text, mediaUrl?, voiceError? }.
class ChatMessage {
  final String id, role, kind, text;
  final String? mediaUrl, voiceError;
  final bool pending;
  const ChatMessage({required this.id, required this.role, required this.kind, required this.text, this.mediaUrl, this.voiceError, this.pending = false});

  bool get fromMaya => role == 'maya';

  static ChatMessage? from(dynamic j) {
    if (j is! Map) return null;
    final media = j['mediaUrl'];
    return ChatMessage(
      id: '${j['id'] ?? DateTime.now().microsecondsSinceEpoch}',
      role: j['role'] == 'maya' ? 'maya' : 'senior',
      kind: j['kind'] is String ? j['kind'] as String : 'text',
      text: j['text'] is String ? j['text'] as String : '',
      mediaUrl: media is String && media.isNotEmpty ? Api.media(media) : null,
      voiceError: j['voiceError'] is String ? j['voiceError'] as String : null,
    );
  }
}

/// One row of the Activity list (built by the server: whatsapp.js activityOf). Only the family's own words are ever in `words`.
class ActivityEntry {
  final String id, type, channel, status, label;
  final int at;
  final String? words, note, where;
  const ActivityEntry({required this.id, required this.type, required this.channel, required this.status, required this.label, required this.at, this.words, this.note, this.where});

  static ActivityEntry? from(dynamic j) {
    if (j is! Map) return null;
    return ActivityEntry(
      id: '${j['id']}',
      type: '${j['type']}',
      channel: '${j['channel']}',
      status: '${j['status']}',
      label: '${j['label']}',
      at: (j['at'] is num) ? (j['at'] as num).toInt() : 0,
      words: j['words'] is String ? j['words'] as String : null,
      note: j['note'] is String ? j['note'] as String : null,
      where: j['where'] is String ? j['where'] as String : null,
    );
  }
}

class Reminder {
  final String id, task, repeat;
  final int? dueAt;
  final String? deliver, channel, by;
  final bool held, msg, finished;
  final String? stateLabel;
  final int? lastAt;
  final int every;
  final int? waitUntil;   // quiet hours: when a held (or night-time) reminder will go, null for an ordinary one
  final bool seniorSet;   // the senior set it (or ownership is unknown): view-only here, never editable or stoppable by the family
  final String? socialLine;   // a daily chat the senior set: its time, zone, next call and state, as one line
  const Reminder({required this.id, required this.task, required this.repeat, this.every = 1, this.dueAt, this.deliver, this.channel, this.by, this.held = false, this.msg = false, this.stateLabel, this.finished = false, this.lastAt, this.waitUntil, this.seniorSet = false, this.socialLine});

  static Reminder? from(dynamic j) {
    if (j is! Map || j['id'] is! String) return null;
    final cur = j['active'] ?? j['last'];
    return Reminder(
      id: j['id'] as String,
      task: '${j['task']}',
      repeat: '${j['repeat'] ?? 'none'}',
      every: j['every'] is num ? (j['every'] as num).toInt() : 1,
      dueAt: j['dueAt'] is num ? (j['dueAt'] as num).toInt() : null,
      deliver: j['deliver'] is String ? j['deliver'] as String : null,
      channel: j['channel'] is String ? j['channel'] as String : null,
      by: j['by'] is String ? j['by'] as String : null,   // 'senior': the person set it by talking to Maya
      finished: j['active'] == null && j['dueAt'] == null,
      lastAt: j['last'] is Map && (j['last'] as Map)['at'] is num ? ((j['last'] as Map)['at'] as num).toInt() : null,
      held: j['held'] == true,
      waitUntil: j['waitUntil'] is num ? (j['waitUntil'] as num).toInt() : null,
      seniorSet: j['owner'] != 'family',
      socialLine: j['social'] is Map ? 'Daily chat at ${(j['social'] as Map)['time']} (${(j['social'] as Map)['tz']}) · ${(j['social'] as Map)['next'] is num ? 'next: ${dayTime(((j['social'] as Map)['next'] as num).toInt())}' : 'no next call'} · ${(j['social'] as Map)['status']}. Only the senior can change it, by talking to Maya.' : null,
      msg: j['msg'] == true,
      stateLabel: cur is Map && cur['label'] is String ? cur['label'] as String : null,
    );
  }
}

String clock(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'am' : 'pm'}';
}

const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
String dayTime(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${_days[d.weekday - 1]} ${d.day} ${_months[d.month - 1]}, ${clock(ms)}';
}

String dayGroup(int ms, [DateTime? now]) {
  final n = now ?? DateTime.now();
  final today = DateTime(n.year, n.month, n.day).millisecondsSinceEpoch;
  const day = 86400000;
  if (ms >= today + day) return 'Upcoming';
  if (ms >= today) return 'Today';
  if (ms >= today - day) return 'Yesterday';
  return 'Earlier';
}
