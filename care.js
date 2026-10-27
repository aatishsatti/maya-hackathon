// Care layer (Feature 3): call-backs, reminders, smart flags/alerts, resolution, notification status.
// Everything here is IN-APP only: Maya "rings" an open page over a server-sent-events stream. A closed app or
// a locked phone cannot be rung, and nothing here claims otherwise. No push provider exists yet, so the
// "push to family" is a family-side notification record + a live event to any open family page (dashboard).
// No transcripts, audio, diagnosis or location are ever stored here or sent to family; only topics-free facts:
// who, when, how many tries, last seen.
//
// State per senior: data/care/<profileId>.json (git-ignored with the rest of data/).
//   { id, mode, callCount, tz, lastActivity:{maya,app,whatsapp}, reminders[], flags[], notifications[], lines{pool:[{t,text}]} }
// Notification status language everywhere: Sent -> Delivered -> Seen (Played for audio) -> Replied, or
// "Hasn't replied yet" / "Not replied yet". WhatsApp (Feature 6) will use the same fields (channel, waStatus);
// a WhatsApp no-reply NEVER raises a flag or alert, it is status only and the family decides.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const memory = require('./memory');

const DIR = process.env.MAYA_CARE_DIR || path.join(__dirname, 'data', 'care'); // env override is for tests
fs.mkdirSync(DIR, { recursive: true });

// MAYA_CARE_SCALE (test only) shrinks ring / retry / green / long-inactive times so a browser test does not
// take hours. The 5 s call-back delay and the silence timings in call.js are never scaled.
const SCALE = Number(process.env.MAYA_CARE_SCALE) > 0 ? Number(process.env.MAYA_CARE_SCALE) : 1;
if (SCALE !== 1) console.warn(`MAYA_CARE_SCALE=${SCALE}: care timings are shortened (test only)`);
const MIN = 60000;
const cfg = {
  callbackDelayMs: 5000,            // after a silence hang-up, Maya rings back after 5 s
  ringMs: 30000 * SCALE,            // how long one ring stays on screen
  retryMinMs: 1 * MIN * SCALE,      // no answer: ring again after 1-2 minutes
  retryMaxMs: 2 * MIN * SCALE,
  maxAttempts: 3,                   // total rings per sequence (the first plus two retries)
  greenMs: 5 * MIN * SCALE,         // app / WhatsApp activity this recent = senior is fine, just busy
  longInactiveMs: 3 * 60 * MIN * SCALE, // no activity anywhere for this long = "a long time"
  quietStart: 22, quietEnd: 7,      // local hours; asleep is not an alarm
  lineWindowMs: 3 * 24 * 60 * MIN,  // dynamic lines never repeat inside this window
  reminderLateMs: 30 * MIN,         // a reminder missed by more than this (server down) is marked Missed, never called late
  resolveWithinMs: Infinity,        // any return-and-talk resolves; see onSeniorSpoke
};

const MODES = {
  standard: { label: 'Standard', blurb: 'Flag on the dashboard only. A real alert only if the senior goes suddenly silent mid-call.' },
  cautious: { label: 'Cautious', blurb: 'Flag plus a gentle, non-emergency note to family. Alerts if nothing has been seen for a long time or mid-call silence.' },
  ultra: { label: 'Ultra Cautious', blurb: 'An alert every time Maya cannot reach the senior. Opt-in, noisy by choice.' },
};

// ---------------------------------------------------------------- storage
const cache = new Map();
const file = (id) => path.join(DIR, `${id}.json`);
const uid = () => crypto.randomBytes(4).toString('hex');
const blank = (id) => ({ id, mode: 'standard', callCount: 0, tz: null, lastActivity: { maya: null, app: null, whatsapp: null }, reminders: [], flags: [], notifications: [], lines: {}, safetyHistory: [] });
const dirty = new Set();
let flushTimer = null;

function flush() {
  flushTimer = null;
  for (const id of dirty) {
    const s = cache.get(id);
    if (!s) continue;
    try { fs.writeFileSync(`${file(id)}.tmp`, JSON.stringify(s, null, 2)); fs.renameSync(`${file(id)}.tmp`, file(id)); }
    catch (e) { console.error('Care save failed:', e.message); }
  }
  dirty.clear();
}
function save(id) { dirty.add(id); if (!flushTimer) { flushTimer = setTimeout(flush, 300); flushTimer.unref(); } }
process.on('exit', flush);

function get(id) {
  if (cache.has(id)) return cache.get(id);
  if (!memory.load(id)) return null;
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { /* new */ }
  s = Object.assign(blank(id), s || {});
  s.lastActivity = Object.assign({ maya: null, app: null, whatsapp: null }, s.lastActivity);
  if (!MODES[s.mode]) s.mode = 'standard';
  cache.set(id, s);
  return s;
}

function remove(id) {
  const o = activeByProfile.get(id);
  if (o) closeOutreach(o, 'removed');
  cache.delete(id); dirty.delete(id);
  fs.rmSync(file(id), { force: true });
}

const nameOf = (id) => (memory.load(id) || { name: 'your senior' }).name;
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const rand = (a, b) => a + Math.random() * (b - a);

function fmtTime(ts, tz) {
  if (!ts) return null;
  const o = { hour: 'numeric', minute: '2-digit' };
  try { return new Date(ts).toLocaleTimeString('en-US', tz ? { ...o, timeZone: tz } : o); }
  catch { return new Date(ts).toLocaleTimeString('en-US', o); }
}
function localHour(ts, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) }).format(new Date(ts))); }
  catch { return new Date(ts).getHours(); }
}
function inQuietHours(ts, tz) {
  const h = localHour(ts, tz);
  return cfg.quietStart > cfg.quietEnd ? (h >= cfg.quietStart || h < cfg.quietEnd) : (h >= cfg.quietStart && h < cfg.quietEnd);
}

// ---------------------------------------------------------------- dynamic lines (3-day no-repeat)
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  const sa = new Set(x.split(' ')), sb = new Set(y.split(' '));
  const inter = [...sa].filter((w) => sb.has(w)).length;
  return sa.size >= 4 && inter / (sa.size + sb.size - inter) >= 0.8;
}
function recentLines(id, pool, now = Date.now()) {
  const p = get(id);
  if (!p) return [];
  const list = (p.lines[pool] || []).filter((l) => now - l.t < cfg.lineWindowMs);
  if (list.length !== (p.lines[pool] || []).length) { p.lines[pool] = list; save(id); }
  return list.map((l) => l.text);
}
const isRepeatLine = (id, pool, text, now) => recentLines(id, pool, now).some((l) => similar(l, text));
function addLine(id, pool, text, now = Date.now()) {
  const p = get(id);
  if (!p || !text) return;
  recentLines(id, pool, now);
  (p.lines[pool] = p.lines[pool] || []).push({ t: now, text: clip(text, 300) });
  save(id);
}

// ---------------------------------------------------------------- activity / calls
const liveCalls = new Map(); // profileId -> Call (so a due reminder can be spoken in the live call)

// source: 'maya' | 'app' | 'whatsapp'. App pings are ignored while a Maya call is live (the click that started it
// must not make a silent senior look "busy elsewhere").
function touch(id, source, at = Date.now(), tz = null) {
  const p = get(id);
  if (!p || !(source in p.lastActivity)) return false;
  if (source === 'app' && liveCalls.has(id)) return false;
  p.lastActivity[source] = Math.max(p.lastActivity[source] || 0, at);
  if (tz) p.tz = tz;
  save(id);
  return true;
}

function lastSeen(p) {
  let at = null, source = null;
  for (const [s, t] of Object.entries(p.lastActivity)) if (t && (!at || t > at)) { at = t; source = s; }
  return { at, source };
}

function callStarted(id, call, tz) {
  const p = get(id);
  if (!p) return;
  liveCalls.set(id, call);
  p.callCount += 1;
  if (tz) p.tz = tz;
  for (const h of p.safetyHistory || []) h.callsSince += 1;
  touch(id, 'maya');
  const o = activeByProfile.get(id);
  if (o && o.state !== 'answered') { if (o.safety) { const f = safetyFlag(p); if (f) f.callbackState = 'answered'; } closeOutreach(o, 'answered'); } // they called Maya themselves: stop ringing
  save(id);
}
function callEnded(id, call) {
  if (liveCalls.get(id) === call) liveCalls.delete(id);
}
const callCount = (id) => (get(id) || { callCount: 0 }).callCount;

// ---------------------------------------------------------------- SSE hubs
const seniorClients = new Map(); // profileId -> Set(res)
const familyClients = new Set();
const send = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); return true; } catch { return false; } };

function attachSenior(id, res, tz) {
  if (!get(id)) return false;
  if (!seniorClients.has(id)) seniorClients.set(id, new Set());
  seniorClients.get(id).add(res);
  const p = get(id);
  if (tz) p.tz = tz;
  // A family message sent while the app was closed arrives when it opens.
  for (const n of p.notifications) if (n.to === 'senior' && n.kind === 'family_message' && n.status === 'sent' && Date.now() - n.times.sent < 24 * 60 * MIN) send(res, 'notice', { notifId: n.id, kind: n.kind, text: n.text });
  return () => { const set = seniorClients.get(id); if (set) { set.delete(res); if (!set.size) seniorClients.delete(id); } };
}
function attachFamily(res) { familyClients.add(res); return () => familyClients.delete(res); }
function pushSenior(id, ev, data) {
  let n = 0;
  for (const res of seniorClients.get(id) || []) if (send(res, ev, data)) n += 1;
  return n;
}
function pushFamily(ev, data) {
  let n = 0;
  for (const res of familyClients) if (send(res, ev, data)) n += 1;
  return n;
}
const appOpen = (id) => (seniorClients.get(id) || new Set()).size > 0;

// ---------------------------------------------------------------- notifications (status language)
const ORDER = ['sent', 'delivered', 'seen', 'replied'];
function makeNotif(p, { to, kind, text, ref = null }) {
  const n = { id: uid(), to, kind, text, ref, channel: 'app', waStatus: null, status: 'sent', noReply: false, played: false, times: { sent: Date.now() } };
  p.notifications.unshift(n);
  p.notifications.length = Math.min(p.notifications.length, 80);
  save(p.id);
  return n;
}
function advance(p, n, status) {
  if (!n || ORDER.indexOf(status) <= ORDER.indexOf(n.status)) return;
  n.status = status; n.times[status] = Date.now();
  if (status === 'replied') n.noReply = false;
  save(p.id);
}
// Exactly one vocabulary, shared with the dashboard (and later WhatsApp).
function statusLabel(n) {
  if (n.status === 'replied') return 'Replied';
  if (n.noReply) return "Hasn't replied yet";
  if (n.status === 'seen' && n.kind === 'family_message') return 'Seen · Not replied yet';
  if (n.status === 'seen') return n.played ? 'Played' : 'Seen';
  return n.status === 'delivered' ? 'Delivered' : 'Sent';
}
// A client reports its own notification: 'delivered' (arrived on screen) or 'seen' (Close / Decline pressed).
function markNotif(id, nid, status) {
  const p = get(id);
  const n = p && p.notifications.find((x) => x.id === nid);
  if (!n || !['delivered', 'seen'].includes(status)) return false;
  advance(p, n, status);
  if (status === 'seen' && n.to === 'family') {
    for (const f of p.flags) if (f.safety && f.status === 'active' && f.notifId === n.id) { f.status = 'resolved'; f.resolvedAt = Date.now(); f.resolvedBy = 'family';
      // Keep only the FACT that it happened (no words, no names, no place) so later calls never deny it. Lives here, not in
      // memory.js: the memory file is rewritten from each call's words, which would drop it.
      (p.safetyHistory = p.safetyHistory || []).push({ date: memory.today(p.tz), resolvedAt: f.resolvedAt, callsSince: 0 });
    }
  }
  pushFamily('refresh', { id });
  return true;
}

// ---------------------------------------------------------------- outreach (call-back / reminder ring)
const outreaches = new Map();        // oid -> outreach
const activeByProfile = new Map();   // profileId -> outreach

const safetyFlag = (p) => p.flags.find((x) => x.status === 'active' && x.safety);

function startOutreach(id, { kind, reminderId = null, talked = false, delayMs = null, safety = false }) {
  const p = get(id);
  if (!p || liveCalls.has(id)) return null;
  const cur = activeByProfile.get(id);
  if (cur) {
    // One sequence at a time, no spam: a second call-back is ignored; a reminder takes over a call-back in progress.
    if (kind === 'reminder' && cur.kind === 'callback') { cur.kind = 'reminder'; cur.reminderId = reminderId; cur.notif.kind = 'reminder'; cur.notif.text = 'Maya is calling with a reminder from your family.'; return cur; }
    return null;
  }
  const o = { id: uid(), profileId: id, kind, reminderId, talked, safety, attempts: 0, state: 'pending', timer: null, notif: null, startedAt: Date.now() };
  o.notif = makeNotif(p, { to: 'senior', kind, text: kind === 'reminder' ? 'Maya is calling with a reminder from your family.' : 'Maya is calling to check on you.', ref: o.id });
  outreaches.set(o.id, o);
  activeByProfile.set(id, o);
  if (safety) { const f = safetyFlag(p); if (f) Object.assign(f, { callbackState: 'pending', callbackAttempts: 0, callbackOf: cfg.maxAttempts, callbackReached: false }); }
  o.timer = setTimeout(() => ring(o), delayMs != null ? delayMs : kind === 'callback' ? cfg.callbackDelayMs : 0);
  return o;
}

function ring(o) {
  if (outreaches.get(o.id) !== o) return;
  const p = get(o.profileId);
  o.attempts += 1; o.state = 'ringing';
  const reached = pushSenior(o.profileId, 'incoming', { outreachId: o.id, notifId: o.notif.id, kind: o.kind, text: o.notif.text, attempt: o.attempts, of: cfg.maxAttempts });
  if (o.reminderId) { const r = p.reminders.find((x) => x.id === o.reminderId); if (r && r.active) r.active.attempts = o.attempts; }
  if (o.safety) { const f = safetyFlag(p); if (f) { f.callbackState = 'ringing'; f.callbackAttempts = o.attempts; if (reached > 0) f.callbackReached = true; } }
  console.log('care ring', JSON.stringify({ profile: o.profileId, kind: o.kind, attempt: o.attempts, appOpen: reached > 0 }));
  save(p.id);
  o.timer = setTimeout(() => ringTimeout(o), cfg.ringMs);
}

function ringTimeout(o) {
  if (outreaches.get(o.id) !== o) return;
  pushSenior(o.profileId, 'incomingEnd', { outreachId: o.id });
  if (o.attempts < cfg.maxAttempts) {
    o.state = 'waiting';
    o.timer = setTimeout(() => ring(o), rand(cfg.retryMinMs, cfg.retryMaxMs));
    return;
  }
  exhausted(o);
}

function closeOutreach(o, state) {
  clearTimeout(o.timer);
  o.state = state;
  outreaches.delete(o.id);
  if (activeByProfile.get(o.profileId) === o) activeByProfile.delete(o.profileId);
  pushSenior(o.profileId, 'incomingEnd', { outreachId: o.id });
}

// Senior pressed Accept (the call socket 'start' carries the outreach id).
function claim(id, oid) {
  const o = outreaches.get(oid);
  const p = get(id);
  if (!o || !p || o.profileId !== id || o.state !== 'ringing') return null;
  const info = { kind: o.kind, reminderId: o.reminderId, talked: o.talked, safety: o.safety };
  if (o.safety) { const f = safetyFlag(p); if (f) f.callbackState = 'answered'; } // the alert itself is NOT resolved by this
  advance(p, o.notif, o.kind === 'reminder' ? 'seen' : 'replied');
  if (o.reminderId) { const r = p.reminders.find((x) => x.id === o.reminderId); if (r && r.active) r.active.state = 'answered'; } // picked up; waiting for the acknowledgement
  closeOutreach(o, 'answered');
  pushFamily('refresh', { id });
  return info;
}

// Decline is respected: this sequence stops, nothing more rings, no flag. A button press is also a sign of life.
function decline(id, oid) {
  const o = outreaches.get(oid);
  const p = get(id);
  if (!o || !p || o.profileId !== id) return false;
  advance(p, o.notif, 'seen');
  touch(id, 'app');
  if (o.reminderId) finishOccurrence(p, o.reminderId, 'declined');
  if (o.safety) { const f = safetyFlag(p); if (f) f.callbackState = 'declined'; }
  closeOutreach(o, 'declined');
  pushFamily('refresh', { id });
  return true;
}

function exhausted(o) {
  const p = get(o.profileId);
  o.notif.noReply = true;
  closeOutreach(o, 'failed');
  if (o.safety) { // the safety Alert is already up and stays; the card shows the tries. No extra flag.
    const f = safetyFlag(p);
    if (f) f.callbackState = 'no_answer';
    save(p.id); pushFamily('refresh', { id: p.id });
    return;
  }
  let task = null;
  if (o.reminderId) { const r = p.reminders.find((x) => x.id === o.reminderId); task = r && r.task; finishOccurrence(p, o.reminderId, 'unanswered'); }
  const a = assess(p, { sudden: o.kind === 'callback' && o.talked });
  console.log('care assess', JSON.stringify({ profile: o.profileId, level: a.level, notify: a.notify, long: a.long, quiet: a.quiet, sudden: a.sudden }));
  if (a.level !== 'green') raise(p, a, { trigger: o.kind, attempts: o.attempts, task });
  pushFamily('refresh', { id: p.id });
}

// ---------------------------------------------------------------- the decision: Green / Flag / Alert
// Context first, mode second. App/WhatsApp activity within greenMs = Green (no flag, no alert): the senior is
// busy, not unreachable. Maya's own call does not count for Green (it is the thing that failed).
// Flag = soft, dashboard only. Alert = push to family. Modes decide how far to go:
//   standard: Flag; Alert only for sudden silence after talking (not in quiet hours unless something worrying was said)
//   cautious: Flag + gentle note; Alert for sudden silence, or nothing seen for a long time outside quiet hours
//   ultra:    Alert for every failed sequence that is not Green
function assess(p, { sudden = false, worry = false, now = Date.now() }) {
  const busy = Math.max(p.lastActivity.app || 0, p.lastActivity.whatsapp || 0);
  if (busy && now - busy <= cfg.greenMs) return { level: 'green', notify: null, sudden, long: false, quiet: false };
  const seen = lastSeen(p);
  const long = !seen.at || now - seen.at >= cfg.longInactiveMs;
  const quiet = inQuietHours(now, p.tz);
  let level = 'flag';
  if (p.mode === 'ultra') level = 'alert';
  else if (sudden && (!quiet || worry)) level = 'alert';
  else if (p.mode === 'cautious' && long && !quiet) level = 'alert';
  const notify = level === 'alert' ? 'alert' : p.mode === 'cautious' ? 'gentle' : null;
  return { level, notify, sudden, long, quiet };
}

// Creates or updates the one active flag for this senior; sends the family note only when it grows in severity.
function raise(p, a, { trigger, attempts, task = null }) {
  const now = Date.now();
  const seen = lastSeen(p);
  let f = p.flags.find((x) => x.status === 'active' && !x.safety);
  if (!f) {
    f = { id: uid(), level: 'flag', mode: p.mode, createdAt: now, trigger, task, attempts, lastCallAt: p.lastActivity.maya, lastSeenAt: seen.at, lastSeenSource: seen.source, status: 'active', resolvedAt: null, returnAt: null, notified: 'none', quietHours: a.quiet };
    p.flags.unshift(f);
    p.flags.length = Math.min(p.flags.length, 50);
  } else {
    f.attempts = Math.max(f.attempts, attempts); f.mode = p.mode;
    f.lastSeenAt = seen.at; f.lastSeenSource = seen.source;
  }
  if (a.level === 'alert') f.level = 'alert';
  const rank = { none: 0, gentle: 1, alert: 2 };
  if (a.notify && rank[a.notify] > rank[f.notified]) {
    f.notified = a.notify;
    const name = nameOf(p.id);
    const when = fmtTime(seen.at, p.tz);
    const how = trigger === 'silence' ? `during a call with ${name}` : `after ${attempts} tries`;
    const text = a.notify === 'alert'
      ? `Maya couldn't reach ${name} ${how}${when ? `, last active at ${when}` : ', no recent activity seen'}.`
      : `Maya couldn't reach ${name}. This is not an emergency.${when ? ` Last seen at ${when}.` : ''} Maya will check in as soon as ${name} is back.`;
    const n = makeNotif(p, { to: 'family', kind: a.notify, text, ref: f.id });
    if (pushFamily('notify', { id: p.id, notifId: n.id, kind: a.notify, text })) advance(p, n, 'delivered'); // 'Sent' until a family page is open to receive it
  }
  console.log('care raise', JSON.stringify({ profile: p.id, level: f.level, mode: p.mode, notified: f.notified, trigger }));
  save(p.id);
  return f;
}

// Something worrying was said and then the line went silent: the call stays open (never hung up), and this is
// the sudden-silence case. There is no call-back to wait for, so it is assessed now.
function suddenSilence(id, { worry = true } = {}) {
  const p = get(id);
  if (!p) return null;
  const a = assess(p, { sudden: true, worry });
  if (a.level === 'green') return a;
  raise(p, a, { trigger: 'silence', attempts: 0 });
  return a;
}

// Clear intent to hurt themselves (Tier A, decided in call.js). Safety overrides everything: any mode, any hour, even
// recent activity. Topic-only: no words, no audio, no diagnosis, no location, no emergency number. Maya never calls
// emergency services; the family decides. Stays active until the family sees it (not cleared by the senior talking).
function selfHarmAlert(id) {
  const p = get(id);
  if (!p) return { isNew: false };
  let f = p.flags.find((x) => x.status === 'active' && x.safety);
  if (f) return { isNew: false, flag: f };
  const now = Date.now();
  f = { id: uid(), level: 'alert', mode: p.mode, createdAt: now, trigger: 'safety', safety: true, task: null, attempts: 0, lastCallAt: now, lastSeenAt: now, lastSeenSource: 'maya', status: 'active', resolvedAt: null, returnAt: null, notified: 'alert', quietHours: false, notifId: null };
  p.flags.unshift(f);
  p.flags.length = Math.min(p.flags.length, 50);
  const name = nameOf(id);
  const text = `Urgent: something ${name} said worried Maya about their safety. Maya is staying on the call with them. Please contact ${name} now.`;
  const n = makeNotif(p, { to: 'family', kind: 'alert', text, ref: f.id });
  f.notifId = n.id;
  if (pushFamily('notify', { id, notifId: n.id, kind: 'alert', text })) advance(p, n, 'delivered');
  console.log('care safety alert', JSON.stringify({ profile: id, mode: p.mode }));
  save(id);
  return { isNew: true, flag: f };
}
// The senior asked Maya to let the family know (no distress needed). A gentle, honest note; never an emergency.
function familyAsk(id) {
  const p = get(id);
  if (!p) return false;
  const name = nameOf(id);
  const text = `${name} asked Maya to let you know and would like to hear from you.`;
  const n = makeNotif(p, { to: 'family', kind: 'gentle', text });
  if (pushFamily('notify', { id, notifId: n.id, kind: 'gentle', text })) advance(p, n, 'delivered');
  return true;
}

// The senior ended a call (closed the page, dropped, pressed End) after Tier A. Ring them back like the silence call-back
// (5 s, in-app only, Accept/Decline, 3 tries 1-2 min apart) while the safety Alert is still active. Nothing here resolves it.
// If their page is closed the ring cannot reach them: that is expected and the family Alert is the safety net.
function safetyCut(id) {
  const p = get(id);
  // CORRECT BY DESIGN, do not "fix": once the family pressed "I've seen this" the alert is resolved, so there is no
  // call-back (the family is handling it). Active alert + no Seen + cut -> ring in 5 s.
  if (!p || !safetyFlag(p)) return null;
  return startOutreach(id, { kind: 'callback', talked: true, safety: true });
}

// Silence hang-up: Maya rings back in 5 s, in-app. `talked` = the senior said something during the call.
function silenceHangup(id, { talked }) { return startOutreach(id, { kind: 'callback', talked: Boolean(talked) }); }

// The senior spoke in a Maya call. Any active flag/alert resolves ("back, okay now") and the family sees Resolved.
function onSeniorSpoke(id) {
  const p = get(id);
  if (!p) return { resolved: 0 };
  touch(id, 'maya');
  let resolved = 0;
  for (const f of p.flags) {
    if (f.status !== 'active' || f.safety) continue; // a safety alert is cleared by the family seeing it, never by the senior talking
    f.status = 'resolved'; f.resolvedAt = f.returnAt = Date.now(); resolved += 1;
    if (f.notified !== 'none') {
      const text = `${nameOf(id)} is back and okay now (${fmtTime(f.returnAt, p.tz)}).`;
      const n = makeNotif(p, { to: 'family', kind: 'resolved', text, ref: f.id });
      if (pushFamily('notify', { id, notifId: n.id, kind: 'resolved', text })) advance(p, n, 'delivered');
    }
  }
  if (resolved) { save(id); pushFamily('refresh', { id }); console.log('care resolved', JSON.stringify({ profile: id, count: resolved })); }
  return { resolved };
}
// The most recent resolved safety concern, while it is still relevant (the next 5 calls, within 14 days).
function safetyHistoryNote(id) {
  const p = get(id);
  const h = p && (p.safetyHistory || []).filter((x) => x.callsSince <= 5 && Date.now() - x.resolvedAt < 14 * 24 * 60 * MIN).pop();
  return h || null;
}
const hasActiveSafety = (id) => Boolean(get(id) && safetyFlag(get(id)));
const hasActiveFlag = (id) => Boolean(get(id) && get(id).flags.some((f) => f.status === 'active' && !f.safety));

// ---------------------------------------------------------------- reminders (information only, as the family wrote them)
const PERIOD = { daily: 24 * 60 * MIN, weekly: 7 * 24 * 60 * MIN };
function addReminder(id, { task, dueAt, repeat }) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  task = clip(task, 80);
  if (!task) throw Object.assign(new Error('Please enter what Maya should remind them about.'), { status: 400 });
  dueAt = Number(dueAt);
  if (!Number.isFinite(dueAt) || dueAt < Date.now() - 60000) throw Object.assign(new Error('Please choose a time that has not passed.'), { status: 400 });
  repeat = repeat || 'none';
  if (repeat !== 'none' && !PERIOD[repeat]) throw Object.assign(new Error('Repeat must be none, daily or weekly.'), { status: 400 });
  const r = { id: uid(), task, dueAt, repeat, active: null, last: null, created: Date.now() };
  p.reminders.push(r);
  save(id);
  return r;
}
function deleteReminder(id, rid) {
  const p = get(id);
  if (!p) return false;
  const n = p.reminders.length;
  p.reminders = p.reminders.filter((r) => r.id !== rid);
  save(id);
  return p.reminders.length < n;
}
function findReminder(id, rid) { const p = get(id); return p && p.reminders.find((r) => r.id === rid); }

function finishOccurrence(p, rid, state) {
  const r = p.reminders.find((x) => x.id === rid);
  if (!r) return;
  const act = r.active || { dueAt: r.dueAt, attempts: 0 };
  r.last = { dueAt: act.dueAt, state, at: Date.now(), attempts: act.attempts || 0 };
  r.active = null;
  save(p.id);
}
function advanceDue(r, now) {
  if (r.repeat === 'none') { r.dueAt = null; return; }
  while (r.dueAt <= now) r.dueAt += PERIOD[r.repeat];
}
// The senior acknowledged the reminder (words judged in call.js): mark it done.
function reminderAck(id, rid) {
  const p = get(id);
  const r = p && p.reminders.find((x) => x.id === rid);
  if (!r || !r.active) return false;
  const n = p.notifications.find((x) => x.id === r.active.notifId);
  if (n) advance(p, n, 'replied');
  finishOccurrence(p, rid, 'done');
  pushFamily('refresh', { id });
  return true;
}
// The call with the reminder ended without an acknowledgement.
function reminderNoAck(id, rid) {
  const p = get(id);
  const r = p && p.reminders.find((x) => x.id === rid);
  if (!r || !r.active) return false;
  const n = p.notifications.find((x) => x.id === r.active.notifId);
  if (n) n.noReply = true;
  finishOccurrence(p, rid, 'no_reply');
  pushFamily('refresh', { id });
  return true;
}

function fireReminder(p, r, now) {
  const live = liveCalls.get(p.id);
  const occ = { dueAt: r.dueAt, state: 'calling', attempts: 0, outreachId: null, notifId: null };
  if (live) {
    // Already talking: say it in the call instead of ringing.
    const n = makeNotif(p, { to: 'senior', kind: 'reminder', text: 'Maya reminded you in your call.', ref: null });
    occ.notifId = n.id; advance(p, n, 'delivered');
    r.active = occ;
    if (!live.deliverReminder(r)) { r.active = null; return false; }
  } else {
    r.active = occ;
    const o = startOutreach(p.id, { kind: 'reminder', reminderId: r.id });
    if (!o) { r.active = null; return false; }
    occ.outreachId = o.id; occ.notifId = o.notif.id;
  }
  advanceDue(r, now);
  save(p.id);
  return true;
}

let ticker = null;
function tick(now = Date.now()) {
  for (const p of cache.values()) {
    for (const r of p.reminders) {
      if (r.dueAt == null || r.dueAt > now || r.active) continue;
      if (now - r.dueAt > cfg.reminderLateMs) {
        r.last = { dueAt: r.dueAt, state: 'missed', at: now, attempts: 0 };
        advanceDue(r, now); save(p.id);
        continue;
      }
      fireReminder(p, r, now);
    }
  }
}
function start() {
  for (const f of fs.readdirSync(DIR)) { const m = /^([a-f0-9]{8})\.json$/.exec(f); if (m) get(m[1]); }
  if (!ticker) { ticker = setInterval(() => tick(), 1000); ticker.unref(); }
}
function stop() { clearInterval(ticker); ticker = null; }

// ---------------------------------------------------------------- family-facing views and actions
const OCC_LABEL = { calling: 'Calling now', answered: 'Picked up, waiting for a reply', done: 'Done, senior replied', no_reply: "Hasn't replied yet", unanswered: "Couldn't reach senior", declined: 'Senior declined the call', missed: 'Missed: Maya could not call at that time' };
function setMode(id, mode) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  if (!MODES[mode]) throw Object.assign(new Error('Mode must be standard, cautious or ultra.'), { status: 400 });
  p.mode = mode; save(id);
  return mode;
}
function sendMessage(id, text) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  text = clip(text, 300);
  if (!text) throw Object.assign(new Error('Please type a message.'), { status: 400 });
  const n = makeNotif(p, { to: 'senior', kind: 'family_message', text });
  if (pushSenior(id, 'notice', { notifId: n.id, kind: n.kind, text })) { /* delivered when the page acknowledges it */ }
  return n;
}

function view(id) {
  const p = get(id);
  if (!p) return null;
  const seen = lastSeen(p);
  const fl = (f) => ({ ...f, name: nameOf(id) });
  const rem = (r) => ({ id: r.id, task: r.task, dueAt: r.dueAt, repeat: r.repeat,
    active: r.active && { ...r.active, label: OCC_LABEL[r.active.state] },
    last: r.last && { ...r.last, label: OCC_LABEL[r.last.state] } });
  return {
    id, name: nameOf(id), mode: p.mode, modes: MODES, appOpen: appOpen(id), inCall: liveCalls.has(id),
    lastActivity: p.lastActivity, lastSeen: seen, lastCallAt: p.lastActivity.maya,
    activeOutreach: activeByProfile.has(id) ? { kind: activeByProfile.get(id).kind, attempts: activeByProfile.get(id).attempts, of: cfg.maxAttempts, state: activeByProfile.get(id).state } : null,
    flags: p.flags.filter((f) => f.level === 'flag').map(fl),
    alerts: p.flags.filter((f) => f.level === 'alert').map(fl),
    reminders: p.reminders.map(rem),
    notifications: p.notifications.slice(0, 30).map((n) => ({ id: n.id, to: n.to, kind: n.kind, text: n.text, channel: n.channel, status: n.status, label: statusLabel(n), times: n.times })),
  };
}
function overview() { return memory.listProfiles().map((x) => { const v = view(x.id); return { id: x.id, name: x.name, mode: v.mode, flags: v.flags.filter((f) => f.status === 'active').length, alerts: v.alerts.filter((f) => f.status === 'active').length }; }); }

module.exports = {
  cfg, MODES, get, remove, start, stop, tick,
  touch, lastSeen, callStarted, callEnded, callCount, liveCalls,
  recentLines, isRepeatLine, addLine,
  attachSenior, attachFamily, pushFamily, appOpen,
  statusLabel, markNotif, makeNotif, advance,
  startOutreach, claim, decline, silenceHangup, suddenSilence, selfHarmAlert, familyAsk, safetyCut, onSeniorSpoke, hasActiveFlag, hasActiveSafety, safetyHistoryNote, assess, raise, ring,
  addReminder, deleteReminder, findReminder, reminderAck, reminderNoAck,
  setMode, sendMessage, view, overview, fmtTime, inQuietHours, outreaches, activeByProfile,
};
