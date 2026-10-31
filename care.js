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
const trends = require('./trends');

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
  waNudgeMs: 10 * MIN * SCALE,      // a reminder sent on WhatsApp and not answered: ONE nudge after this
  waMissMs: 60 * MIN * SCALE,       // ...and it is marked Missed (visible, never hidden) after this
  waSendStuckMs: 2 * MIN * SCALE,   // a send that never answered in this long is shown as not sent
  waAnsweredCtxMs: 30 * MIN * SCALE, // after a reminder was answered, Maya keeps it in mind this long ("done, carry on")
  waThisMessageMs: 15 * 1000,       // a reply that answered a reminder less than this long ago IS the reply that answered it
  waMissedCtxMs: 2 * 60 * MIN * SCALE, // a Missed reminder is still known to Maya (silently) this long
  doneKeepMs: 30 * 24 * 60 * MIN,   // a finished one-time reminder is deleted after 30 days (the privacy page says so)
  expireCriticalMs: 3 * 24 * 60 * MIN * SCALE, // a safety / medical ticket the family never sees closes after this (NOT confirmed safe)
  expireLightMs: 2 * 24 * 60 * MIN * SCALE,    // a Flag / gentle-note ticket the family never sees closes after this
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
const blank = (id) => ({ id, mode: 'standard', callCount: 0, tz: null, lastActivity: { maya: null, app: null, whatsapp: null }, reminders: [], flags: [], notifications: [], lines: {}, safetyHistory: [], scams: [], days: [], trend: null, delivery: { reminders: 'voice' } });   // days: 30 days of daily NUMBERS (trends.js), trend: the last judgement
const DELIVERY = ['voice', 'text'];
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
// Saved to disk RIGHT NOW (not in 300 ms): used before a network call, so a restart in the middle can never send the same reminder twice.
function flushOne(id) {
  const st = cache.get(id); if (!st) return;
  try { fs.writeFileSync(`${file(id)}.tmp`, JSON.stringify(st, null, 2)); fs.renameSync(`${file(id)}.tmp`, file(id)); dirty.delete(id); }
  catch (e) { console.error('Care save failed:', e.message); }
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
  if (!Array.isArray(s.days)) s.days = [];           // an older care file has no daily numbers yet
  if (!s.trend || typeof s.trend !== 'object') s.trend = null;
  if (!MODES[s.mode]) s.mode = 'standard';
  if (!s.delivery || typeof s.delivery !== 'object' || !DELIVERY.includes(s.delivery.reminders)) s.delivery = { reminders: 'voice' }; // how a reminder reaches the person on WhatsApp: a voice note in Maya's voice (default) or text
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
// How many lines of this pool were said within the last `withinMs` (a count only, never the words).
const linesWithin = (id, pool, withinMs, now = Date.now()) => { const p = get(id); return p ? (p.lines[pool] || []).filter((l) => now - l.t < withinMs).length : 0; };
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
const liveChats = new Map(); // profileId -> text chat session (chat.js), so the family's Seen reaches a senior who is chatting, not calling

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

// ---- Wellbeing trends: daily NUMBERS only (trends.js). No words, no topics, no transcripts: counts per local day, kept 30 days. ----
// Local date and minutes after midnight for a moment, in the person's own time zone when known.
function localParts(ts, tz) {
  const at = new Date(ts);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) }).formatToParts(at);
    const get = (t) => Number((parts.find((x) => x.type === t) || { value: 0 }).value);
    return { date: at.toLocaleDateString('en-CA', tz ? { timeZone: tz } : undefined), min: get('hour') * 60 + get('minute') };
  } catch { return { date: at.toLocaleDateString('en-CA'), min: at.getHours() * 60 + at.getMinutes() }; }
}
// One event into that day's record: {kind:'call'} | {kind:'turn', emotion, intensity, pain, concern} | {kind:'reminder', acked} | {kind:'callback'}.
function trendEvent(id, ev, now = Date.now()) {
  const p = get(id);
  if (!p) return false;
  const { date, min } = localParts(now, p.tz);
  const rec = p.days.find((d) => d.date === date) || trends.blank(date);
  const next = trends.addEvent(rec, { ...ev, atMin: min });
  p.days = trends.prune([...p.days.filter((d) => d.date !== date), next], date).sort((a, b) => a.date.localeCompare(b.date));   // older than 30 days expires here
  save(id);
  return true;
}
// The person's turn just answered: only the private read of it (feeling, strength, pain, concern) is counted, never the words.
const trendTurn = (id, d) => (d ? trendEvent(id, { kind: 'turn', emotion: d.emotion, intensity: d.intensity, pain: d.tagPain === true, concern: d.tagConcern }) : false);
// For the family page. Judged once per local day, on COMPLETED days only (a half-finished day would look like a quiet one), and
// remembered so the no-flapping rule can see yesterday's judgement. Returns plain facts: a status, since when, and lines built from numbers.
function trendView(id, now = Date.now()) {
  const p = get(id);
  if (!p) return null;
  const { date } = localParts(now, p.tz);
  const end = trends.addDays(date, -1);
  if (!p.trend || p.trend.evaluatedOn !== date) {
    p.days = trends.prune(p.days, date);
    const result = trends.evaluate(p.days.filter((d) => d.date <= end), end, p.trend && p.trend.result);
    p.trend = { evaluatedOn: date, result };
    save(id);
  }
  const r = p.trend.result;
  return { status: r.status, since: r.since, learning: r.status === 'learning', daysSoFar: r.span, daysNeeded: trends.MIN_SPAN, lines: trends.describe(r), evaluatedOn: date };
}

function callStarted(id, call, tz) {
  const p = get(id);
  if (!p) return;
  liveCalls.set(id, call);
  p.callCount += 1;
  if (tz) p.tz = tz;
  for (const h of p.safetyHistory || []) h.callsSince += 1;
  touch(id, 'maya');
  trendEvent(id, { kind: 'call' });
  const o = activeByProfile.get(id);
  if (o && o.state !== 'answered') { if (o.safety) { const f = safetyFlag(p); if (f) f.callbackState = 'answered'; } closeOutreach(o, 'answered'); } // they called Maya themselves: stop ringing
  save(id);
}
// how: 'quiet' (Maya hung up after silence), 'safety' (a safety concern was raised in it), 'left' (the senior ended it), 'normal'.
// Kept so the next call's greeting and Maya's notes know how the last one ended (a fact, never a script).
function callEnded(id, call, how = 'normal') {
  if (liveCalls.get(id) === call) liveCalls.delete(id);
  const p = get(id);
  if (p) { p.lastCall = { at: Date.now(), how, talked: Boolean(call && call.userTurns > 0) }; save(id); }
}
const lastCall = (id) => (get(id) || {}).lastCall || null;
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
function makeNotif(p, { to, kind, text, ref = null, incident = null }) {
  const n = { id: uid(), to, kind, text, ref, incident, channel: 'app', waStatus: null, status: 'sent', noReply: false, played: false, times: { sent: Date.now() } };
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
  if (n.paused) return 'Paused';   // a welfare check that was asked for while calls were paused and could not be sent another way
  if (n.calling) return 'Calling now';   // a welfare check call (existing labels only)
  if (n.unreached) return "Couldn't reach senior";
  if (n.status === 'replied') return 'Replied';
  if (n.noReply) return "Hasn't replied yet";
  if (n.pickedUp) return 'Picked up, waiting for a reply';
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
    for (const f of p.flags) if (f.safety && f.status === 'active' && f.notifId === n.id) resolveSafety(p, f, 'family');
    for (const sc of p.scams || []) if (sc.status === 'active' && sc.notifId === n.id) { sc.status = 'resolved'; sc.resolvedAt = Date.now(); sc.resolvedBy = 'family'; } // a scam warning clears when the family sees it, like any alert
  }
  pushFamily('refresh', { id });
  return true;
}

// The ticket closes only when the family sees it (dashboard Seen, WhatsApp Read or Reply) or it expires unseen (closeUnseen). Calm
// talk never closes it; it only means no ring while the call is live. Keeps only the FACT that it happened (no words, names or place) so later calls never deny it. Lives
// here, not in memory.js: the memory file is rewritten from each call's words, which would drop it.
function resolveSafety(p, f, by) {
  f.status = 'resolved'; f.resolvedAt = Date.now(); f.resolvedBy = by;
  if (by === 'family' || /^whatsapp/.test(String(by))) p.seenToTell = Date.now();   // the person has not been told yet that their family knows: the next thing they say is answered with it
  (p.safetyHistory = p.safetyHistory || []).push({ date: memory.today(p.tz), resolvedAt: f.resolvedAt, callsSince: 0 });
  // Handled: a safety call-back still ringing or waiting for its next try stops.
  const o = activeByProfile.get(p.id);
  if (o && o.safety && o.state !== 'answered') closeOutreach(o, by === 'family' ? 'family_seen' : 'safe');
  save(p.id);
  // A live call learns it at once (call.js tells the person in fresh words).
  const live = liveCalls.get(p.id);
  if (live && live.onTicketClosed) live.onTicketClosed(by);
  else { const chat = liveChats.get(p.id); if (chat && chat.onTicketClosed) chat.onTicketClosed(by); }
}

// An unseen ticket does not stay open for ever. After cfg.expireCriticalMs (safety / medical) or cfg.expireLightMs (Flag / gentle
// note) it closes UNSEEN: rings stop, the family gets one final note, and it is never shown or remembered as safe or resolved. A new
// mention afterwards opens a new ticket.
function closeUnseen(p, f, now = Date.now()) {
  f.status = 'expired'; f.expiredAt = now; f.resolvedBy = null;
  const days = Math.max(1, Math.round((now - f.createdAt) / (24 * 60 * MIN * SCALE)));
  f.expiredDays = days;
  if (f.safety) (p.safetyHistory = p.safetyHistory || []).push({ date: memory.today(p.tz), resolvedAt: now, callsSince: 0, unseen: true });
  const o = activeByProfile.get(p.id);
  if (o && Boolean(o.safety) === Boolean(f.safety) && o.state !== 'answered') closeOutreach(o, 'expired');
  if (f.safety || f.notified !== 'none') {
    const text = `The ${f.safety ? 'alert' : 'note'} about ${nameOf(p.id)} from ${fmtTime(f.createdAt, p.tz)} was never marked seen. It has closed after ${days} ${days === 1 ? 'day' : 'days'}, closed unseen. Maya could not confirm ${nameOf(p.id)} is safe.`;
    const n = makeNotif(p, { to: 'family', kind: 'expired', text, ref: f.id, incident: f.id });
    if (pushFamily('notify', { id: p.id, notifId: n.id, kind: 'expired', text })) advance(p, n, 'delivered');
  }
  console.log('care expired', JSON.stringify({ profile: p.id, safety: Boolean(f.safety), days }));
  save(p.id); pushFamily('refresh', { id: p.id });
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
  o.notif = makeNotif(p, { to: 'senior', kind, text: kind === 'reminder' ? 'Maya is calling with a reminder from your family.' : 'Maya is calling to check on you.', ref: o.id, incident: safety && safetyFlag(p) ? safetyFlag(p).id : null });
  outreaches.set(o.id, o);
  activeByProfile.set(id, o);
  if (kind === 'callback') trendEvent(id, { kind: 'callback' });   // a call-back was needed (Maya hung up after silence)
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
  if (o.safety) { const f = safetyFlag(p); if (f) { f.callbackState = 'answered'; f.answers = (f.answers || 0) + 1; } } // answering does NOT close the ticket
  advance(p, o.notif, o.kind === 'reminder' || o.kind === 'welfare' ? 'seen' : 'replied');
  if (o.kind === 'welfare') { o.notif.calling = false; o.notif.pickedUp = true; }   // picked up: whether they spoke is settled when the call ends
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
  if (a.level !== 'green') { const f = raise(p, a, { trigger: o.kind, attempts: o.attempts, task }); o.notif.incident = f.id; }
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
    const n = makeNotif(p, { to: 'family', kind: a.notify, text, ref: f.id, incident: f.id });
    f.notifId = n.id;
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
function selfHarmAlert(id, { kind = 'self_harm', channel = 'call' } = {}) {
  const p = get(id);
  if (!p) return { isNew: false };
  let f = p.flags.find((x) => x.status === 'active' && x.safety);
  if (f) { f.repeats = (f.repeats || 0) + 1; save(id); return { isNew: false, flag: f }; } // same incident: no second alert, no second note to family
  const now = Date.now();
  f = { id: uid(), level: 'alert', mode: p.mode, createdAt: now, trigger: 'safety', safety: true, task: null, attempts: 0, lastCallAt: now, lastSeenAt: now, lastSeenSource: 'maya', status: 'active', resolvedAt: null, returnAt: null, notified: 'alert', quietHours: false, notifId: null, kind };
  p.flags.unshift(f);
  p.flags.length = Math.min(p.flags.length, 50);
  p.seenToTell = 0;   // a new ticket is open: the old "your family has seen it" no longer describes things
  const name = nameOf(id);
  const stay = channel === 'chat' ? 'Maya is staying in the chat with them' : 'Maya is staying on the call with them';
  const text = kind === 'health'
    ? `Urgent: something ${name} described worried Maya about their wellbeing. ${stay}. Please contact ${name} now.`
    : `Urgent: something ${name} said worried Maya about their safety. ${stay}. Please contact ${name} now.`;
  const n = makeNotif(p, { to: 'family', kind: 'alert', text, ref: f.id, incident: f.id });
  f.notifId = n.id;
  if (pushFamily('notify', { id, notifId: n.id, kind: 'alert', text })) advance(p, n, 'delivered');
  console.log('care safety alert', JSON.stringify({ profile: id, mode: p.mode }));
  save(id);
  return { isNew: true, flag: f };
}
// An emergency Maya judged from context (fall with injury, chest pain...): the same persistent ticket as a safety concern (rings
// again whenever a call ends, closes on Seen / WhatsApp Read or Reply), topic-only, no diagnosis.
const healthAlert = (id, opts = {}) => selfHarmAlert(id, { ...opts, kind: 'health' });

// Plain ask ("tell my family I'd like to hear from them"): a gentle, honest note. Not an alert, not an emergency.
function familyAsk(id) {
  const p = get(id);
  if (!p) return false;
  const name = nameOf(id);
  const text = `${name} asked Maya to let you know and would like to hear from you.`;
  const n = makeNotif(p, { to: 'family', kind: 'gentle', text, ref: 'family_ask' });
  if (pushFamily('notify', { id, notifId: n.id, kind: 'gentle', text })) advance(p, n, 'delivered');
  return true;
}
// Maya was unsure whether something was serious, asked, and the senior said yes: a topic-only alert for the dashboard and WhatsApp.
// Not a ticket and not an emergency (an urgent emergency is healthAlert). Not sent twice within 10 minutes.
function concernAlert(id) {
  const p = get(id);
  if (!p) return false;
  const now = Date.now();
  if (p.notifications.some((n) => n.to === 'family' && n.ref === 'asked' && now - n.times.sent < 10 * MIN)) return false;
  const name = nameOf(id);
  const text = `${name} told Maya something is not right and said yes to letting you know. ${name} would like to hear from you.`;
  const n = makeNotif(p, { to: 'family', kind: 'alert', text, ref: 'asked' });
  if (pushFamily('notify', { id, notifId: n.id, kind: 'alert', text })) advance(p, n, 'delivered');
  return true;
}

// ---------------------------------------------------------------- scam shield (scam.js judges the message; this keeps the tickets)
// A scam ticket is its own small list (p.scams), NOT a flag: a scam is not an emergency and not a "couldn't reach" case, so it never
// rings the senior back, never feeds the silence rules, and is never closed by the senior talking ("back and okay"). It reuses the same
// notification, Seen and expiry machinery: an alert goes to the family (topic only: the KIND of scam, never the letter text, a transcript
// or the photo); "Seen" closes it; unseen it closes after the light 2 days (cfg.expireLightMs: not an emergency, and a stale warning is
// worth little). If the person says no, only a dashboard Flag is kept: no notification, no push, and Maya never asks again.
const SCAM_ASK_MS = 20 * MIN;
const SCAM_KEEP = 30;
const SCAM_CHANNELS = new Set(['photo', 'text', 'spoken']);
// The family's sentence about how Maya learned of it: the kind of scam and the channel only, never any words from the message or the call.
function scamToldLine(sc, name, type) {
  if (sc.channel === 'text') return `${name} told Maya about a message that looks like a possible ${type}.`;
  if (sc.channel === 'spoken') return `${name} told Maya about a call or message that looks like a possible ${type}.`;
  return `${name} showed Maya a message that looks like a possible ${type}.`;
}
// opts.channel: how Maya learned of it (photo | text | spoken); opts.pause: they may have been about to pay or act. Both are topic-only facts.
// After a no on an incident Maya never asks again about it: an open dashboard flag of the same kind of scam means they already said no.
// A different kind of scam is a new incident and is asked about as usual. (Enforced here, so a call, the chat and a photo all obey it.)
const scamKind = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
function scamDeclined(id, type) { const p = get(id); return (p && (p.scams || []).find((x) => x.level === 'flag' && x.status === 'active' && scamKind(x.type) === scamKind(type))) || null; }
function scamAsk(id, type, opts = {}) {
  const p = get(id);
  if (!p) return null;
  if (scamDeclined(id, type)) return null;   // they said no to this one: never asked again
  p.pendingScam = { type, left: 2, at: Date.now(), channel: SCAM_CHANNELS.has(opts.channel) ? opts.channel : 'photo', pause: opts.pause === true, official: opts.official || null }; save(id);
  return p.pendingScam;
}
function scamPending(id) {
  const p = get(id);
  if (!p || !p.pendingScam) return null;
  if (Date.now() - p.pendingScam.at > SCAM_ASK_MS) { p.pendingScam = null; save(id); return null; }
  return p.pendingScam;
}
// The unseen scam alert, if their family was already told (until they see it): the one fact every reply and every new incident goes by.
function scamTold(id) { const p = get(id); return (p && (p.scams || []).find((x) => x.level === 'alert' && x.status === 'active')) || null; }
function scamClear(id) { const p = get(id); if (p && p.pendingScam) { p.pendingScam = null; save(id); } }
// An answer that is neither yes nor no: she may lean in once more, then it is dropped (no nagging).
function scamUnclear(id) { const p = get(id); if (p && p.pendingScam) { p.pendingScam.left -= 1; if (p.pendingScam.left <= 0) p.pendingScam = null; save(id); } }
function scamTicket(p, type, level, how = {}) {
  const now = Date.now();
  const sc = { id: uid(), level, type, createdAt: now, status: 'active', notified: 'none', notifId: null, resolvedAt: null, channel: SCAM_CHANNELS.has(how.channel) ? how.channel : 'photo', pause: how.pause === true, official: how.official ? { checked: true, found: how.official.found === true, name: how.official.found === true ? String(how.official.name || '').slice(0, 60) : null } : null };
  p.scams.unshift(sc); p.scams.length = Math.min(p.scams.length, SCAM_KEEP);
  return sc;
}
function scamAlert(id, type, how = {}) {
  const p = get(id);
  if (!p) return { isNew: false };
  let sc = p.scams.find((x) => x.status === 'active' && x.level === 'alert');
  if (sc) { sc.repeats = (sc.repeats || 0) + 1; save(id); return { isNew: false, ticket: sc }; } // same incident: no second alert
  sc = p.scams.find((x) => x.status === 'active' && x.level === 'flag') || scamTicket(p, type, 'flag', how); // they said no, then changed their mind: the flag becomes the alert
  sc.level = 'alert'; sc.type = type; sc.notified = 'alert'; if (how.channel) { sc.channel = SCAM_CHANNELS.has(how.channel) ? how.channel : sc.channel; sc.pause = how.pause === true || sc.pause; }
  if (how.official && !sc.official) sc.official = { checked: true, found: how.official.found === true, name: how.official.found === true ? String(how.official.name || '').slice(0, 60) : null };
  const name = nameOf(id);
  const told = scamToldLine(sc, name, type);
  const text = `${told} ${sc.pause ? `${name} may have been about to pay or share details, so Maya asked ${name} to stop and check first, and` : `Maya told ${name} not to pay or share any details, and`} ${name} asked Maya to let you know. Please check in with ${name}.`;
  const n = makeNotif(p, { to: 'family', kind: 'alert', text, ref: sc.id, incident: sc.id });
  sc.notifId = n.id;
  if (pushFamily('notify', { id, notifId: n.id, kind: 'alert', text })) advance(p, n, 'delivered');
  console.log('care scam alert', JSON.stringify({ profile: id, type }));
  save(id); pushFamily('refresh', { id });
  return { isNew: true, ticket: sc };
}
function scamFlag(id, type, how = {}) {
  const p = get(id);
  if (!p) return { isNew: false };
  const sc = p.scams.find((x) => x.status === 'active');
  if (sc) return { isNew: false, ticket: sc };
  const t = scamTicket(p, type, 'flag', how);
  console.log('care scam flag', JSON.stringify({ profile: id, type }));
  save(id); // dashboard only: no notification and no push
  return { isNew: true, ticket: t };
}
// The person answered Maya's one question: yes -> alert, no -> flag only. The pending question is always cleared.
// The reconfirm was answered after the family question was already asked (or answered): the official-source line is attached to the open question and to the
// newest ticket of this conversation that has none. Topic only: the flag, the found flag and the official name.
function scamOfficial(id, official) {
  const p = get(id);
  if (!p || !official) return;
  const o = { checked: true, found: official.found === true, name: official.found === true ? String(official.name || '').slice(0, 60) : null };
  if (p.pendingScam && !p.pendingScam.official) p.pendingScam.official = o;
  const sc = (p.scams || []).find((x) => x.status === 'active' && !x.official && Date.now() - x.createdAt <= SCAM_ASK_MS);
  if (sc) sc.official = o;
  save(id);
}
// ---- Background checks (checks.js): a lookup Maya said she would do. Stored on the profile (server side only; facts from the lookup, never the person's words, a number
// or a link), delivered ONCE on their next turn (chat or call) as a fact, then marked delivered. Never faked: a lookup that never finished is reported as cannot verify.
const CHECK_STALE_MS = 5 * MIN, CHECK_KEEP = 10;
function checkStart(id) {
  const p = get(id);
  if (!p) return null;
  p.checks = p.checks || [];
  const c = { id: uid(), at: Date.now(), status: 'pending', note: null, delivered: false };
  p.checks.unshift(c); p.checks.length = Math.min(p.checks.length, CHECK_KEEP); save(id);
  return c;
}
function checkDone(id, checkId, note) {
  const p = get(id), c = p && (p.checks || []).find((x) => x.id === checkId);
  if (!c || c.status === 'done') return null;
  c.status = 'done'; c.doneAt = Date.now(); c.note = String(note || '').slice(0, 3000); save(id);
  return c;
}
// What is due for the next reply: finished and not yet told (or pending for too long = could not finish). One fact string, or ''. Safety first: nothing while a safety ticket is open.
function checkFacts(p, now = Date.now()) {
  if (!p || !p.checks || !p.checks.length || hasActiveSafety(p.id)) return '';
  const ago = (t) => { const m = Math.round((now - t) / MIN); return m < 2 ? 'moments ago' : m < 90 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`; };
  const out = [];
  for (const c of p.checks) {
    if (c.delivered) continue;
    if (c.status === 'pending' && now - c.at > CHECK_STALE_MS) { c.status = 'done'; c.doneAt = now; c.note = 'BACKGROUND CHECK (a fact from the app): the lookup could not be finished, so NOTHING was verified. Say plainly that you could not finish looking into it and cannot verify it; do not guess, and never invent a result.'; }
    if (c.status === 'done') out.push(`A lookup you started earlier and told them you would look into has FINISHED (${ago(c.doneAt)}). Tell them the result now, in your own words, once, and only what this says: ${c.note}`);
    else out.push(`You started a lookup ${ago(c.at)} and told them you would look into it; it is still running. If they ask, say you are still looking; give no result and no guess.`);
  }
  return out.join(' ');
}
// The reply that carried a finished lookup was produced: now it counts as told, once.
// ids: the lookups that were due when the reply began (a lookup that finished during the reply was not in it and is still owed).
function checkDueIds(id) { const p = get(id); return p && !hasActiveSafety(id) ? (p.checks || []).filter((c) => !c.delivered && (c.status === 'done' || Date.now() - c.at > CHECK_STALE_MS)).map((c) => c.id) : []; }
function checkDelivered(id, ids) { const p = get(id); if (!p || !p.checks) return; let any = false; for (const c of p.checks) if (ids.includes(c.id) && !c.delivered) { c.delivered = true; any = true; } if (any) save(id); }
function scamAnswer(id, yes) {
  const pend = scamPending(id);
  if (!pend) return null;
  scamClear(id);
  return yes ? scamAlert(id, pend.type, pend) : scamFlag(id, pend.type, pend);
}
function closeScamUnseen(p, sc, now = Date.now()) {
  sc.status = 'expired'; sc.expiredAt = now; sc.resolvedBy = null;
  sc.expiredDays = Math.max(1, Math.round((now - sc.createdAt) / (24 * 60 * MIN * SCALE)));
  if (sc.notified === 'alert') {
    const text = `The scam warning about ${nameOf(p.id)} from ${fmtTime(sc.createdAt, p.tz)} was never marked seen. It has closed after ${sc.expiredDays} ${sc.expiredDays === 1 ? 'day' : 'days'}, closed unseen. Maya could not confirm anything came of it.`;
    const n = makeNotif(p, { to: 'family', kind: 'expired', text, ref: sc.id, incident: sc.id });
    if (pushFamily('notify', { id: p.id, notifId: n.id, kind: 'expired', text })) advance(p, n, 'delivered');
  }
  console.log('care expired', JSON.stringify({ profile: p.id, scam: true, days: sc.expiredDays }));
  save(p.id); pushFamily('refresh', { id: p.id });
}

// WhatsApp status of a family alert (Feature 6 will report real receipts through here; until then it is a mock entry point).
// Delivered alone is NOT Seen (read receipts can be switched off). Read, or any reply from the family ("ok", "I'll call"), is.
function whatsappStatus(id, nid, status) {
  const p = get(id);
  const n = p && p.notifications.find((x) => x.id === nid && x.to === 'family');
  if (!n || !['delivered', 'read', 'replied'].includes(status)) return false;
  n.channel = 'whatsapp'; n.waStatus = status;
  if (status === 'delivered') advance(p, n, 'delivered');
  else {
    advance(p, n, status === 'replied' ? 'replied' : 'seen');
    for (const f of p.flags) if (f.safety && f.status === 'active' && f.notifId === n.id) resolveSafety(p, f, status === 'replied' ? 'whatsapp_reply' : 'whatsapp_read');
  }
  save(id);
  pushFamily('refresh', { id });
  return true;
}

// The senior ended a call (closed the page, dropped, pressed End) after Tier A. Ring them back like the silence call-back
// (5 s, in-app only, Accept/Decline, 3 tries 1-2 min apart) while the safety Alert is still active. Nothing here resolves it.
// If their page is closed the ring cannot reach them: that is expected and the family Alert is the safety net.
function safetyCut(id, { kind = 'with_talk' } = {}) {
  const p = get(id);
  // CORRECT BY DESIGN, do not "fix": once the ticket is closed (family Seen) there is no call-back (the family is handling it).
  // While it is open, EVERY end of a call rings again, whatever happened in that call (0 turns, mid-talk, after a call-back
  // pickup, no repeat of the words): answering once does not close a ticket.
  const f = p && safetyFlag(p);
  if (!f) return null;
  f.cuts = (f.cuts || 0) + 1; f.lastCut = { at: Date.now(), kind };
  (f.events = f.events || []).push({ at: Date.now(), kind: 'cut', how: kind });
  save(id);
  return startOutreach(id, { kind: 'callback', talked: kind !== 'no_talk', safety: true });
}
// Pain ladder facts: when (not what) the senior mentioned pain or discomfort, last 3 days. Spark tags each turn pain=1; Maya is told
// how many times it came up BEFORE the current turn, so she decides first-time vs repeat from facts, not from a keyword list.
function painCount(id, now = Date.now()) {
  const p = get(id);
  if (!p) return 0;
  p.pain = (p.pain || []).filter((t) => now - t < cfg.lineWindowMs);
  return p.pain.length;
}
function painMention(id, now = Date.now()) {
  const p = get(id);
  if (!p) return 0;
  const before = painCount(id, now);
  p.pain.push(now); p.pain = p.pain.slice(-20); save(id);
  return before;
}

// The family saw a safety alert (dashboard Seen, WhatsApp Read or Reply) and the person has not yet been told that their family knows.
// True for 3 days; cleared once a reply that carried it was spoken (call.js commitReminder) or Maya said it unprompted (onTicketClosed).
const SEEN_TELL_MS = 3 * 24 * 60 * MIN;
const seenToTell = (id) => { const p = get(id); return Boolean(p && p.seenToTell && Date.now() - p.seenToTell < SEEN_TELL_MS); };
function clearSeenToTell(id) { const p = get(id); if (p && p.seenToTell) { p.seenToTell = 0; save(id); } }

// Maya asked whether they are safe (once per incident is the aim; this is the fact she is given).
function safeAsked(id) { const p = get(id), f = p && safetyFlag(p); if (f) { f.safeAsked = (f.safeAsked || 0) + 1; save(id); } }

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
      const n = makeNotif(p, { to: 'family', kind: 'resolved', text, ref: f.id, incident: f.id });
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

// What the family was actually told, by TOPIC, from the records only (never from what anyone said): safety / health tickets (last 7 days), a scam alert,
// "tell my family" notes (last day), a could-not-reach alert. [] = nobody was told anything. The one source of truth for every reply (appFacts) and
// for the guard that stops a reply claiming an alert that does not exist (call.js breaksFacts).
function familyToldTopics(id, now = Date.now()) {
  const p = get(id);
  if (!p) return [];
  const out = [], DAY = 24 * 60 * MIN;
  for (const f of p.flags) if (f.safety && now - f.createdAt < 7 * DAY) out.push(f.kind === 'health' ? 'a health worry' : 'a safety worry');
  for (const f of p.flags) if (!f.safety && f.level === 'alert' && now - f.createdAt < DAY) out.push('that they could not be reached');
  for (const x of p.scams || []) if (x.level === 'alert' && (x.status === 'active' || now - (x.resolvedAt || x.createdAt) < DAY)) out.push(`a possible ${x.type}`);
  for (const n of p.notifications) if (n.to === 'family' && (n.ref === 'asked' || n.ref === 'family_ask') && now - n.times.sent < DAY) out.push(n.ref === 'asked' ? 'a worry they said yes to sharing' : 'that they would like to hear from them');
  return [...new Set(out)];
}
// Something family-related happened in the last ms (an alert, a flag after a no, a note, a safety ticket, a seen-to-tell): the reply to that turn may speak of it.
function familyEventRecent(id, ms = 2 * MIN, now = Date.now()) {
  const p = get(id);
  if (!p) return false;
  return p.flags.some((f) => now - f.createdAt < ms) || (p.scams || []).some((x) => now - x.createdAt < ms) || p.notifications.some((n) => n.to === 'family' && n.times && now - n.times.sent < ms) || seenToTell(id);
}
// Facts only. No alert = say so plainly; an alert = its topic only. Never a sentence to copy, never a reason, never their words.
function familyFacts(id, now = Date.now()) {
  const t = familyToldTopics(id, now);
  if (!t.length) return 'FAMILY ALERTS (facts from the app): the app has told their family NOTHING about them: no alert, no note, on any topic, and no safety concern was ever raised. If they ask whether or why you told their family, say plainly in your own words that nobody was told and no note was sent. Being ABLE to let their family know (when they ask you to) is not the same as having done it: if they ask whether you can, say yes you can when they ask, and that you have not sent anything yet. Never say or imply they asked you to, never say a note "went over" or was passed on, and never use "you asked" to explain anything. Never claim you told or alerted anyone, never give a reason for an alert, and never say or suggest they spoke of hurting themselves: if they say they never said that, agree plainly that you got it wrong, with no soothing line.';
  return `FAMILY ALERTS (facts from the app): the app has told their family about ONLY these topics: ${t.join('; ')} (topic only: no words of theirs, no photo). If they ask, name that topic and nothing else, plainly. Never give a reason beyond the topic, never say "because I care about you", never quote or guess what they said, and never claim anything else was sent: for any other topic nobody was told.`;
}

// What the app is doing right now, as plain FACTS for Maya's notes (never a script, never read out as written). She decides the
// wording; nothing here says an action happened unless the code did it. Topic-only for safety: no words, diagnosis or place.
function appFacts(id, now = Date.now(), { family = true } = {}) {
  const p = get(id);
  if (!p) return '';
  const name = nameOf(id), tz = p.tz;
  const ago = (t) => { const m = Math.round((now - t) / MIN); return m < 2 ? 'moments ago' : m < 90 ? `${m} minutes ago` : m < 36 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`; };
  const f = [`Mode set by their family: ${MODES[p.mode].label}; quiet hours ${cfg.quietStart}:00 to ${cfg.quietEnd}:00 (asleep is not an alarm).`];
  const lc = p.lastCall;
  const HOW = { quiet: 'it went quiet and you hung up, then rang back', safety: 'they said something that worried you about their safety', left: 'they ended it themselves', normal: 'it ended normally' };
  if (lc) f.push(`Last call with you: ${ago(lc.at)}; ${HOW[lc.how] || HOW.normal}. This is call number ${p.callCount}.`); else f.push(`This is call number ${p.callCount || 1}; there is no earlier call.`);
  const act = p.flags.find((x) => x.status === 'active' && x.safety);
  const lastSafe = p.flags.find((x) => x.safety && (x.status === 'resolved' || x.status === 'expired'));
  const CUTW = { no_talk: 'no talking', mid_talk: 'mid-conversation', with_talk: 'after talking' };
  if (act) {
    f.push(`A safety ticket for ${name} is open (topic only), open since ${fmtTime(act.createdAt, tz)} (${ago(act.createdAt)}). Their family has been told, once, by the app. The family has NOT yet seen it (not marked seen, not read, not replied). Calls cut so far: ${act.cuts || 0}${act.lastCut ? `; the last cut was ${CUTW[act.lastCut.kind]}, ${ago(act.lastCut.at)}` : ''}. Rings you made that they answered: ${act.answers || 0}. They have raised it again ${act.repeats || 0} time(s) since it opened, which made no second alert. You have asked whether they are safe ${act.safeAsked || 0} time(s).`);
  } else if (lastSafe && lastSafe.status === 'expired') {
    f.push(`The last safety ticket for ${name} (opened ${ago(lastSafe.createdAt)}) closed unseen after ${lastSafe.expiredDays} days: their family never saw it, and nobody has confirmed ${name} is safe. Your care for them goes on: check in gently and ask how they are.`);
  } else if (lastSafe) {
    f.push(`The last safety ticket for ${name} (opened ${ago(lastSafe.createdAt)}) is closed: ${{ whatsapp_read: 'their family read the alert on WhatsApp', whatsapp_reply: 'their family replied to the alert on WhatsApp' }[lastSafe.resolvedBy] || 'their family marked it seen'} at ${fmtTime(lastSafe.resolvedAt, tz)} (${ago(lastSafe.resolvedAt)}). That only stopped the alerting; your care for them goes on: you still check in gently and ask how they are.`);
  }
  // Family notes Maya sent because the senior said yes or asked her to (concernAlert / familyAsk): not tickets, so the lines above do not
  // cover them. She must be able to say they exist and must never deny them; what the family has done with them she does not know.
  const asked = p.notifications.filter((n) => n.to === 'family' && (n.ref === 'asked' || n.ref === 'family_ask') && now - n.times.sent < 24 * 60 * MIN);
  if (asked.length) f.push(`The app has sent their family ${asked.length} note${asked.length > 1 ? 's' : ''} in the last day because they said yes or asked you to (topic only, the latest ${ago(asked[0].times.sent)}). That is true and on the family's dashboard: if they ask whether you told their family, or why there is a note, say yes plainly; never say you have not told them or that nothing was sent. You do not know whether the family has opened it or what they will do, so say you do not know what the dashboard shows now.`);
  // Scam shield state, this person only: what the family was (or was not) told about, by topic. Kept for the whole conversation so she never
  // denies an alert that exists, and never claims one that was refused. The kind of scam only: no words from the message or the call.
  const sc = (p.scams || []).find((x) => x.status === 'active' || now - (x.resolvedAt || x.createdAt) < 24 * 60 * MIN);
  if (sc && sc.level === 'alert') f.push(`The app has told their family about a possible ${sc.type} (topic only), ${ago(sc.createdAt)}, because they said yes. That is true and on the family's dashboard: if they ask whether you told their family, say yes and name the topic, never "an earlier message". ${sc.status === 'active' ? 'Their family has not marked it seen yet.' : 'Their family has seen it.'} Nothing more is known, and it is not sent again. If they are upset about it, be factual about what was sent (only the kind of scam, no words, no photo) and that it was already sent and cannot be undone; never deny it, and never excuse it by saying you did it because you care about them.`);
  else if (sc && sc.level === 'flag') f.push(`They said no to letting their family know about a possible ${sc.type}, so nobody was told: no message, no alert (only a quiet note on the family's dashboard). If they ask, say honestly that you did not tell their family.`);
  if (family) f.push(familyFacts(id, now));   // internal: only on a turn that is about the family / an alert (call.js familyRelevant), never volunteered
  const pc = painCount(id, now);
  f.push(pc ? `They have mentioned pain or discomfort ${pc} time${pc > 1 ? 's' : ''} before this turn in the last 3 days (not counting what they say next).` : 'They have not mentioned pain or discomfort in the last 3 days.');
  const fl = p.flags.find((x) => x.status === 'active' && !x.safety);
  if (fl) f.push(`Earlier you could not reach them (${fl.level === 'alert' ? 'family was alerted' : fl.notified === 'gentle' ? 'family got a gentle note' : 'only noted, family not alerted'}); they have not been back since.`);
  const rem = p.reminders.filter((r) => r.dueAt).sort((a, b) => a.dueAt - b.dueAt)[0];
  if (rem) f.push(`Next family reminder: "${rem.task}" at ${fmtTime(rem.dueAt, tz)}${rem.dueAt - now > 20 * 3600000 ? ' (not today)' : ''}. Information only, only the family's words.`);
  const msgs = p.notifications.filter((n) => n.to === 'senior' && n.kind === 'family_message' && n.status !== 'replied' && n.status !== 'seen').length;
  if (msgs) f.push(`${msgs} family message${msgs > 1 ? 's' : ''} waiting for ${name} that they have not opened yet.`);
  if (p.lastActivity.whatsapp) f.push(`Last seen on WhatsApp ${ago(p.lastActivity.whatsapp)}.`);
  const chk = checkFacts(p, now); if (chk) f.push(chk);
  return f.join(' ');
}

// ---------------------------------------------------------------- reminders (information only, as the family wrote them)
const PERIOD = { daily: 24 * 60 * MIN, weekly: 7 * 24 * 60 * MIN };
const DELIVER = ['call', 'text', 'voice'];   // the per-reminder picker; none = the old default (voice or text per person)
function addReminder(id, { task, dueAt, repeat, deliver }) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  task = clip(task, 80);
  if (!task) throw Object.assign(new Error('Please enter what Maya should remind them about.'), { status: 400 });
  dueAt = Number(dueAt);
  if (!Number.isFinite(dueAt) || dueAt < Date.now() - 60000) throw Object.assign(new Error('Please choose a time that has not passed.'), { status: 400 });
  repeat = repeat || 'none';
  if (repeat !== 'none' && !PERIOD[repeat]) throw Object.assign(new Error('Repeat must be none, daily or weekly.'), { status: 400 });
  if (deliver != null && deliver !== '' && !DELIVER.includes(deliver)) throw Object.assign(new Error('Delivery must be call, text or voice note.'), { status: 400 });
  const r = { id: uid(), task, dueAt, repeat, active: null, last: null, created: Date.now(), ...(deliver ? { deliver } : {}) };
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

function finishOccurrence(p, rid, state, extra = {}) {
  const r = p.reminders.find((x) => x.id === rid);
  if (!r) return;
  const act = r.active || { dueAt: r.dueAt, attempts: 0 };
  const wa = act.channel === 'whatsapp' ? { channel: 'whatsapp', via: act.via || null, wamid: act.wamid || null, voiceUnavailable: Boolean(act.voiceUnavailable), sentAt: act.sentAt || null, deliveredAt: act.deliveredAt || null, readAt: act.readAt || null, nudged: Boolean(act.nudged), ...(act.pausedBy ? { pausedBy: act.pausedBy } : {}) } : {};
  r.last = { dueAt: act.dueAt, state, at: Date.now(), attempts: act.attempts || 0, ...wa, ...extra };
  r.active = null;
  if (state === 'done') trendEvent(p.id, { kind: 'reminder', acked: true });                          // answered
  else if (state === 'no_reply' || state === 'unanswered' || state === 'wa_missed' || state === 'wa_failed') trendEvent(p.id, { kind: 'reminder', acked: false });   // missed (a decline is a choice, not counted)
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

// ---- a reminder delivered by an outbound WhatsApp CALL (whatsapp.js placeReminderCall; C2) ----
// The occurrence uses the same states and labels as the app's own ring: calling (Calling now) -> answered (Picked up; set by claim() when the Call starts) -> done (the
// acknowledgement, call.js) | no_reply (the call ended without one) ; or unanswered (Couldn't reach: nobody picked up / they rejected it). A pretend ring (an outreach in state 'ringing',
// no timer, nothing sent to the app) lets the Call claim it exactly as it claims an app ring, so the greeting IS the reminder and the acknowledgement rule is the one already tested.
function reminderFor(id, { rid, task, message }) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  let r;
  if (rid) {
    r = p.reminders.find((x) => x.id === rid);
    if (!r) throw Object.assign(new Error('That reminder no longer exists.'), { status: 404 });
  } else {
    r = addReminder(id, { task, dueAt: Date.now(), repeat: 'none' });   // typed for this test only; it keeps its result on the dashboard
    if (message) r.msg = true;   // a family MESSAGE delivered by a call: shown under Messages, not Reminders
  }
  if (r.active) throw Object.assign(new Error('That reminder is already being delivered.'), { status: 409 });
  return { p, r };
}
function reminderCallStart(id, spec) {
  const { p, r } = reminderFor(id, spec); const now = Date.now(), dueAt = spec.dueAt || r.dueAt || now;
  const n = makeNotif(p, { to: 'senior', kind: 'reminder', text: 'Maya is calling with a reminder from your family.', ref: null });
  const o = { id: uid(), profileId: id, kind: 'reminder', reminderId: r.id, talked: false, safety: false, attempts: 1, state: 'ringing', timer: null, notif: n, startedAt: now };
  n.ref = o.id; outreaches.set(o.id, o); activeByProfile.set(id, o);
  r.active = { dueAt, state: 'calling', attempts: 1, outreachId: o.id, notifId: n.id };
  advanceDue(r, now);
  save(id); pushFamily('refresh', { id });
  return { rid: r.id, outreachId: o.id };
}
// ---- a welfare check call (whatsapp.js placeWelfareCall; Step 1) ----
// One entry in the activity list (channel WhatsApp, kind welfare, no words), labelled with the existing words: Calling now -> Picked up, waiting for a reply -> Replied (they said at least one thing)
// | Hasn't replied yet (picked up, nothing heard) | Couldn't reach senior (nobody picked up / rejected). A pretend ring (outreach kind welfare) lets the Call claim it as it does an app ring.
function welfareCallStart(id) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  if (activeByProfile.get(id)) throw Object.assign(new Error('Maya is already trying to reach them.'), { status: 409 });
  const now = Date.now();
  const n = makeNotif(p, { to: 'senior', kind: 'welfare', text: 'Maya called on WhatsApp to check how they are (welfare check).', ref: null });
  n.channel = 'whatsapp'; n.via = 'call'; n.calling = true;
  const o = { id: uid(), profileId: id, kind: 'welfare', reminderId: null, talked: false, safety: false, attempts: 1, state: 'ringing', timer: null, notif: n, startedAt: now };
  n.ref = o.id; outreaches.set(o.id, o); activeByProfile.set(id, o);
  save(id); pushFamily('refresh', { id });
  return { nid: n.id, outreachId: o.id, startedAt: now };
}
// A welfare check asked for by CALL while calls were paused (2 unanswered in a row, or 5 answered today) and nothing could be sent instead: one entry that says so (no words).
function welfarePaused(id, reason) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  const n = makeNotif(p, { to: 'senior', kind: 'welfare', text: 'A welfare check call was not placed: calls are paused.', ref: null });
  n.channel = 'whatsapp'; n.via = 'call'; n.paused = reason === 'cap' ? 'cap' : 'misses'; save(id); pushFamily('refresh', { id });
  return n;
}
// The call is over (whatever way). Returns 'unreached' | 'spoke' | 'silent' | null (unknown entry). Safe to call twice.
function welfareCallEnded(id, nid, startedAt) {
  const p = get(id); const n = p && p.notifications.find((x) => x.id === nid);
  if (!n || !n.calling && !n.pickedUp) return null;
  const o = n.ref && outreaches.get(n.ref);
  let out;
  if (o) { closeOutreach(o, 'missed'); n.unreached = true; n.noReply = true; out = 'unreached'; }   // nobody picked up: the ring was never claimed
  else if (n.status === 'replied' || n.noReply) return null;                                      // already settled
  else { const lc = p.lastCall, talked = Boolean(lc && lc.at >= startedAt && lc.talked); if (talked) advance(p, n, 'replied'); else n.noReply = true; out = talked ? 'spoke' : 'silent'; }
  n.calling = false; save(id); pushFamily('refresh', { id });
  return out;
}
// The call is over (whatever way). Settles what is still open, once: nobody picked up -> Couldn't reach; picked up with no acknowledgement -> Hasn't replied yet. Returns the state it settled, or null.
function reminderCallEnded(id, rid) {
  const p = get(id); const r = p && p.reminders.find((x) => x.id === rid);
  if (!r || !r.active) return null;
  const a = r.active;
  if (a.state === 'calling') {
    const o = a.outreachId && outreaches.get(a.outreachId); if (o) closeOutreach(o, 'missed');
    const n = p.notifications.find((x) => x.id === a.notifId); if (n) n.noReply = true;
    finishOccurrence(p, rid, 'unanswered'); pushFamily('refresh', { id }); return 'unanswered';
  }
  if (a.state === 'answered') { reminderNoAck(id, rid); return 'no_reply'; }
  return null;
}
// The calls are blocked (2 unanswered in a row, or the 5 a day cap): the SAME reminder goes as a WhatsApp message through the ordinary reminder path (inside the 24 h window; outside it that
// path records Not sent, honestly). Nothing is called.
function reminderViaMessage(id, spec) {
  if (!reminderSender) throw Object.assign(new Error('WhatsApp is not set up on this server.'), { status: 503 });
  const { p, r } = reminderFor(id, spec);
  fireReminderWhatsApp(p, r, Date.now());
  if (spec.pausedBy && r.active) { r.active.pausedBy = spec.pausedBy; save(id); }   // so the list can say the call was paused (and show Paused if nothing could be sent)
  return r.id;
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
  } else if (r.deliver === 'call' && reminderSender && reminderSender.placeCall && reminderSender.channelFor(p.id) === 'whatsapp') {
    // The family chose a CALL for this reminder: the same call as the test button, with every limit. If it cannot be placed the occurrence says Not sent (never a call that did not happen).
    const rid = r.id, id = p.id, dueAt = r.dueAt;
    advanceDue(r, now); save(id);
    Promise.resolve().then(() => reminderSender.placeCall(id, rid, dueAt)).then(() => pushFamily('refresh', { id }), (e) => {
      const q = get(id); if (q) { finishOccurrence(q, rid, 'wa_failed', { reason: 'call_not_placed', error: { title: String((e && e.message) || 'error').slice(0, 120) } }); waLog({ event: 'not sent', reason: 'call_not_placed' }); pushFamily('refresh', { id }); }
    });
    return true;
  } else if (reminderSender && reminderSender.channelFor(p.id) === 'whatsapp') {
    return fireReminderWhatsApp(p, r, now);
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

// ---------------------------------------------------------------- reminders on WhatsApp (whatsapp.js registers the sender)
// States of one occurrence: wa_sending -> wa_sent (WhatsApp accepted it AND gave a message id) -> wa_delivered -> wa_read (only from WhatsApp's own status
// webhooks, never guessed) -> done (they replied) | wa_missed (no reply by waMissMs) ; or wa_failed (not sent / WhatsApp failed it). Nothing is hidden.
let reminderSender = null;   // { channelFor(profileId) -> 'whatsapp' | null, send(profileId, { task, nudge }) -> Promise<{ ok, via, wamid, voiceUnavailable, reason, error }> }
function setReminderSender(sender) { reminderSender = sender; }
const WA_OPEN = new Set(['wa_sent', 'wa_delivered', 'wa_read']);
const WA_RANK = { wa_sent: 1, wa_delivered: 2, wa_read: 3 };
const waLog = (o) => console.log('reminder', JSON.stringify(o));   // counts and kinds only: never the task, never a number

function fireReminderWhatsApp(p, r, now) {
  const n = makeNotif(p, { to: 'senior', kind: 'reminder', text: 'Maya sent you a reminder on WhatsApp.', ref: null });
  const occ = { dueAt: r.dueAt, state: 'wa_sending', channel: 'whatsapp', attempts: 1, nudged: false, key: `${r.id}:${r.dueAt}`, wamid: null, via: null, notifId: n.id, startedAt: now, sentAt: null, nudgeAt: now + cfg.waNudgeMs, missAt: now + cfg.waMissMs };
  r.active = occ;
  advanceDue(r, now);
  flushOne(p.id);   // on disk BEFORE the network call: a restart in the middle can never send this reminder twice
  const id = p.id, rid = r.id, key = occ.key, task = r.task;
  Promise.resolve().then(() => reminderSender.send(id, { task, nudge: false, deliver: r.deliver }))
    .then((res) => reminderSent(id, rid, key, res), (e) => reminderSent(id, rid, key, { ok: false, reason: 'error', error: { title: String((e && e.message) || 'error').slice(0, 120) } }));
  return true;
}

// The send came back. Only a result WITH a message id counts as sent.
function reminderSent(id, rid, key, res) {
  const p = get(id); const r = p && p.reminders.find((x) => x.id === rid);
  if (!r || !r.active || r.active.key !== key || r.active.state !== 'wa_sending') return false;   // deleted, or already settled
  const a = r.active;
  if (res && res.ok && res.wamid) {
    a.state = 'wa_sent'; a.wamid = res.wamid; a.via = res.via === 'voice' ? 'voice' : 'text'; a.voiceUnavailable = Boolean(res.voiceUnavailable); a.sentAt = Date.now();
    save(id); pushFamily('refresh', { id }); waLog({ event: 'sent', via: a.via, voiceUnavailable: a.voiceUnavailable });
    return true;
  }
  const reason = (res && res.reason) || 'error', error = (res && res.error) || null;
  finishOccurrence(p, rid, 'wa_failed', { reason, error });
  waLog({ event: 'not sent', reason, code: error && error.code ? Number(error.code) || null : null });
  escalate(p, r, 'failed');
  pushFamily('refresh', { id });
  return true;
}

// WhatsApp's own status for a message we sent (webhook): delivered / read / failed. An unknown id is not ours.
function reminderStatus(wamid, status, errors) {
  if (!wamid) return false;
  for (const p of cache.values()) for (const r of p.reminders) {
    const a = r.active && r.active.wamid === wamid ? r.active : null, l = !a && r.last && r.last.wamid === wamid ? r.last : null, t = a || l;
    if (!t) continue;
    if (status === 'delivered' || status === 'read') {
      t[`${status}At`] = t[`${status}At`] || Date.now();
      const to = status === 'delivered' ? 'wa_delivered' : 'wa_read';
      if (a && WA_RANK[to] > WA_RANK[a.state]) a.state = to;   // never goes back: read stays read
    } else if (status === 'failed') {
      const e = (errors || [])[0] || {}, error = { code: e.code || null, title: String(e.title || '').slice(0, 120) };
      if (a) { finishOccurrence(p, r.id, 'wa_failed', { reason: 'whatsapp_failed', error }); waLog({ event: 'failed after sent', code: Number(error.code) || null }); escalate(p, r, 'failed'); }
      else if (l && l.state !== 'done') { l.error = error; l.reason = l.reason || 'whatsapp_failed'; }
    } else continue;
    save(p.id); pushFamily('refresh', { id: p.id });
    return true;
  }
  return false;
}

// The person answered on WhatsApp (words judged as an acknowledgement by the caller): the MOST RECENTLY SENT reminder still waiting for one is answered. A reply refers to the latest
// message, not to one from an hour ago; older ones stay waiting, honestly, until they turn Missed. (Live: the oldest-first rule answered a stale reminder and left the new one Delivered.)
// The WhatsApp reminders still waiting for an answer, NEWEST SENT first (a tie goes to the one added last): sent, not answered, and not yet past their Missed line. The one list that
// both the acknowledgement (which reminder a reply answers) and reminderContext (what Maya is told) read, so the two can never disagree.
function waitingWhatsApp(p, now = Date.now()) {
  return p.reminders.map((r, i) => ({ r, i })).filter(({ r }) => r.active && r.active.channel === 'whatsapp' && WA_OPEN.has(r.active.state) && !(r.active.missAt && now >= r.active.missAt))
    .sort((x, y) => (y.r.active.sentAt || 0) - (x.r.active.sentAt || 0) || y.i - x.i).map(({ r }) => r);
}

// What a person is dealing with on WhatsApp right now, for what Maya is told before she answers (pure: it changes nothing and logs nothing). The task is the family's own text.
//   waiting:  the most recently sent reminder still waiting for an answer (inside its 60 minute window), how long ago, voice or text, nudged or not, how many OTHER ones wait.
//   answered: the most recently answered reminder, if that was in the last 30 minutes (minutesAgo since it was answered, sentMinutesAgo since it was sent); thisMessage is true when the reply being answered right now is the one that answered it.
//   missed:   the most recent Missed reminder, if in the last 2 hours. A reminder that was never sent (Not sent) is not here: it never reached them.
function reminderContext(id, now = Date.now()) {
  const p = get(id);
  const out = { waiting: null, answered: null, missed: null };
  if (!p) return out;
  const mins = (t) => Math.max(0, Math.round((now - (t || now)) / MIN));
  const waiting = waitingWhatsApp(p, now);
  if (waiting.length) { const a = waiting[0].active; out.waiting = { id: waiting[0].id, task: waiting[0].task, minutesAgo: mins(a.sentAt || a.startedAt), via: a.via === 'voice' ? 'voice' : 'text', nudged: Boolean(a.nudged), others: waiting.length - 1 }; }
  const done = (state, windowMs) => p.reminders.filter((r) => r.last && r.last.channel === 'whatsapp' && r.last.state === state && now - r.last.at <= windowMs).sort((x, y) => y.last.at - x.last.at)[0];
  const ans = done('done', cfg.waAnsweredCtxMs);
  if (ans) out.answered = { id: ans.id, task: ans.task, minutesAgo: mins(ans.last.at), sentMinutesAgo: mins(ans.last.sentAt || ans.last.dueAt), thisMessage: Boolean(p.lastAck && p.lastAck.fresh && p.lastAck.rid === ans.id && now - p.lastAck.at <= cfg.waThisMessageMs) };
  const miss = done('wa_missed', cfg.waMissedCtxMs);
  if (miss) out.missed = { id: miss.id, task: miss.task, minutesAgo: mins(miss.last.at) };
  return out;
}

// Which door the chat turn being answered right now came through. The written chat is ONE session per person, shared by the app and WhatsApp, and chat.js does not say which; whatsapp.js
// wraps its chat call in this, so the facts about a WhatsApp reminder reach Maya only for a reply that really came through WhatsApp (never for the same person typing in the app).
const turnChannels = new Map();
async function withTurnChannel(id, channel, fn) {
  turnChannels.set(id, channel);
  try { return await fn(); } finally { if (turnChannels.get(id) === channel) turnChannels.delete(id); }
}
const turnChannel = (id) => turnChannels.get(id) || null;

// The turn that the acknowledgement belonged to is over (whatsapp.js calls this when its chat turn ends, success or not): the NEXT message is no longer "the one that answered it".
function consumeAck(id) { const p = get(id); if (p && p.lastAck) p.lastAck.fresh = false; }

function reminderAckWhatsApp(id, ack = true, now = Date.now()) {
  const p = get(id); if (!p) return false;
  const waiting = waitingWhatsApp(p, now);
  // Every reply while ANY reminder is in flight (or that reads as an acknowledgement) leaves one line: did it read as an acknowledgement, how many WhatsApp reminders were waiting and in
  // which states, how many other reminders are in flight. Names and counts only: never a word of the reply, never the reminder. It shows why a reply did or did not answer a reminder.
  const inFlight = p.reminders.filter((r) => r.active).length;
  if (ack || inFlight) waLog({ event: 'reply checked', ack: Boolean(ack), waiting: waiting.length, states: waiting.map((r) => r.active.state), inFlightOtherChannel: inFlight - waiting.length });
  if (!ack) return false;
  const r = waiting[0]; if (!r) return false;
  const n = p.notifications.find((x) => x.id === r.active.notifId); if (n) advance(p, n, 'replied');
  finishOccurrence(p, r.id, 'done', { answeredBy: 'a reply on WhatsApp' });
  p.lastAck = { rid: r.id, at: now, fresh: true };   // so Maya can tell that THIS message was the one that answered it (reminderContext.thisMessage); consumeAck closes it once that turn is over
  pushFamily('refresh', { id }); waLog({ event: 'answered' });
  return true;
}

// Mode decides how far a reminder that was not answered (or not sent) goes. Nothing is ever hidden: the dashboard shows Missed / Not sent in every mode.
//   standard: nothing more.  cautious: a gentle note to the family.  ultra: an alert.  Recent activity on WhatsApp / the app means they are fine (assess: Green).
//   Quiet hours (22:00-07:00 in their time zone, when it is known): the note waits until they end. A reminder itself is not held: the family chose its time.
function escalate(p, r, why, now = Date.now()) {
  if (!r.last || p.mode === 'standard') return;
  if (assess(p, { now }).level === 'green') { r.last.escalate = { skipped: 'green' }; save(p.id); return; }
  if (p.tz && inQuietHours(now, p.tz)) { r.last.escalate = { pending: true, why }; save(p.id); return; }
  sendEscalation(p, r, why);
}
function sendEscalation(p, r, why) {
  const kind = p.mode === 'ultra' ? 'alert' : 'gentle', name = nameOf(p.id);
  const text = why === 'failed' ? `Maya could not send the reminder "${r.task}" to ${name}.` : `${name} has not confirmed the reminder "${r.task}" (sent ${fmtTime(r.last.sentAt || r.last.dueAt, p.tz)}).`;
  const n = makeNotif(p, { to: 'family', kind, text, ref: `reminder_${why}` });
  if (pushFamily('notify', { id: p.id, notifId: n.id, kind, text })) advance(p, n, 'delivered');
  r.last.escalate = { pending: false, at: Date.now(), kind };
  save(p.id); waLog({ event: 'family told', kind, why });
}

// Once a second (tick): the nudge, the Missed line, a stuck send, a family note that waited for quiet hours to end.
function waTick(p, r, now) {
  const a = r.active;
  if (a && a.channel === 'whatsapp') {
    const quiet = Boolean(p.tz) && inQuietHours(now, p.tz);
    if (a.state === 'wa_sending') {
      if (now - a.startedAt > cfg.waSendStuckMs) { finishOccurrence(p, r.id, 'wa_failed', { reason: 'no_answer', error: { title: 'WhatsApp did not answer' } }); waLog({ event: 'not sent', reason: 'no_answer' }); escalate(p, r, 'failed', now); pushFamily('refresh', { id: p.id }); }
    } else if (WA_OPEN.has(a.state)) {
      if (now >= a.missAt) {
        finishOccurrence(p, r.id, 'wa_missed', {}); waLog({ event: 'missed' }); escalate(p, r, 'missed', now); pushFamily('refresh', { id: p.id });
      } else if (!a.nudged && now >= a.nudgeAt && !quiet) {
        a.nudged = true; a.attempts = 2; save(p.id);
        const id = p.id, task = r.task, deliver = r.deliver;
        Promise.resolve().then(() => reminderSender.send(id, { task, nudge: true, deliver })).then((res) => waLog({ event: res && res.ok && res.wamid ? 'nudge sent' : 'nudge not sent', reason: res && res.reason ? res.reason : undefined }), () => waLog({ event: 'nudge not sent', reason: 'error' }));
      }
    }
  }
  const e = r.last && r.last.escalate;
  if (e && e.pending && !(p.tz && inQuietHours(now, p.tz))) sendEscalation(p, r, e.why);
}

let ticker = null;
function tick(now = Date.now()) {
  for (const p of cache.values()) {
    for (const f of p.flags) if (f.status === 'active' && now - f.createdAt >= (f.safety ? cfg.expireCriticalMs : cfg.expireLightMs)) closeUnseen(p, f, now);
    for (const sc of p.scams || []) if (sc.status === 'active' && now - sc.createdAt >= cfg.expireLightMs) closeScamUnseen(p, sc, now); // scam: not an emergency, so the 2-day (light) rule
    for (const r of p.reminders) {
      waTick(p, r, now);
      if (r.dueAt == null || r.dueAt > now || r.active) continue;
      if (now - r.dueAt > cfg.reminderLateMs) {
        r.last = { dueAt: r.dueAt, state: 'missed', at: now, attempts: 0 };
        advanceDue(r, now); save(p.id);
        continue;
      }
      fireReminder(p, r, now);
    }
    const keep = p.reminders.filter((r) => !(r.repeat === 'none' && r.dueAt == null && !r.active && r.last && now - r.last.at > cfg.doneKeepMs));   // finished one-time reminders go after 30 days
    if (keep.length !== p.reminders.length) { p.reminders = keep; save(p.id); }
  }
}
function start() {
  for (const f of fs.readdirSync(DIR)) { const m = /^([a-f0-9]{8})\.json$/.exec(f); if (m) get(m[1]); }
  // A WhatsApp reminder that was still "sending" when the server stopped: we cannot know if it went out, so it is shown as not sent and NEVER sent again.
  let cut = 0;
  for (const p of cache.values()) for (const r of p.reminders) if (r.active && r.active.channel === 'whatsapp' && r.active.state === 'wa_sending') {
    finishOccurrence(p, r.id, 'wa_failed', { reason: 'restart', error: { title: 'The server restarted while sending' } }); cut += 1;
  }
  console.log('care loaded', JSON.stringify({ profiles: cache.size, reminderSendsCutByRestart: cut }));
  if (!ticker) { ticker = setInterval(() => tick(), 1000); ticker.unref(); }
}
function stop() { clearInterval(ticker); ticker = null; }

// ---------------------------------------------------------------- family-facing views and actions
function setDelivery(id, body) {
  const p = get(id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 404 });
  const v = body && body.reminders;
  if (!DELIVERY.includes(v)) throw Object.assign(new Error('Reminders can go as a voice note or as text.'), { status: 400 });
  p.delivery = { ...p.delivery, reminders: v }; save(id);
  return p.delivery;
}
// One honest line for each state of a WhatsApp occurrence. The reason codes are ours, the numbers are WhatsApp's own.
function waLabel(o) {
  const code = o.error && o.error.code ? ` (WhatsApp error ${o.error.code})` : '';
  switch (o.state) {
    case 'wa_sending': return 'Sending on WhatsApp';
    case 'wa_sent': return o.via === 'voice' ? 'Sent as a voice note. WhatsApp accepted it.' : o.voiceUnavailable ? 'Sent as text (voice unavailable). WhatsApp accepted it.' : 'Sent as text. WhatsApp accepted it.';
    case 'wa_delivered': return 'Delivered to their phone, not read yet';
    case 'wa_read': return 'Read, no reply yet';
    case 'wa_missed': return `Missed: no reply within ${Math.round(cfg.waMissMs / MIN)} minutes`;
    case 'wa_failed': return {
      window_closed: "Not sent: WhatsApp's 24-hour window is closed, so Maya cannot message them yet",
      restart: 'Not sent: the server restarted while sending, so it may not have reached them',
      whatsapp_failed: `WhatsApp could not deliver it${code}`,
      not_linked: 'Not sent: no WhatsApp number is linked, or they have stopped messages',
      not_configured: 'Not sent: WhatsApp is not set up on the server',
      daily_cap: 'Not sent: the daily limit of reminder messages was reached',
      no_answer: 'Not sent: WhatsApp did not answer',
      no_id: 'Not sent: WhatsApp gave no message id',
    }[o.reason] || `Not sent${o.error && o.error.title ? `: ${o.error.title}` : ''}${code}`;
    default: return null;
  }
}
const occLabel = (o) => waLabel(o) || OCC_LABEL[o.state];
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

// One incident = one flag/alert. Its alert note, gentle note, call-back tries and resolution are steps of ONE timeline, so the
// dashboard shows one card, never three or four look-alike notifications.
function timeline(p, f) {
  const RANK = { alert: 0, gentle: 0, cut: 1, callback: 2, resolved: 3, seen: 3, expired: 3 };
  const steps = [];
  const mine = p.notifications.filter((n) => n.incident === f.id).reverse(); // list is newest first
  for (const n of mine) {
    if (n.to === 'family' && n.kind === 'alert') steps.push({ at: n.times.sent, kind: 'alert', label: 'Alert sent to you' });
    else if (n.to === 'family' && n.kind === 'gentle') steps.push({ at: n.times.sent, kind: 'gentle', label: 'Gentle note sent to you' });
    else if (n.to === 'senior') steps.push({ at: n.times.sent, kind: 'callback', label: n.status === 'replied' ? 'Call-back answered' : n.noReply ? 'Call-back not answered' : n.status === 'seen' ? 'Call-back declined' : 'Call-back ringing' });
    else if (n.kind === 'resolved' && !f.safety) steps.push({ at: n.times.sent, kind: 'resolved', label: 'Back and okay' }); // a safety ticket's closing step is added below
  }
  const CUT = { no_talk: 'Call ended with no talking', mid_talk: 'Call cut mid-conversation', with_talk: 'Call ended' };
  for (const e of f.events || []) if (e.kind === 'cut') steps.push({ at: e.at, kind: 'cut', label: CUT[e.how] || 'Call ended' });
  if (f.status === 'expired') steps.push({ at: f.expiredAt, kind: 'expired', label: `Closed unseen after ${f.expiredDays} ${f.expiredDays === 1 ? 'day' : 'days'}, NOT confirmed safe` });
  else if (f.safety && f.status === 'resolved') steps.push({ at: f.resolvedAt, kind: 'seen', label: f.resolvedBy === 'whatsapp_read' ? 'You read this on WhatsApp' : f.resolvedBy === 'whatsapp_reply' ? 'You replied on WhatsApp' : 'You saw this' });
  else if (f.status === 'resolved' && f.resolvedAt && !steps.some((x) => x.kind === 'resolved')) steps.push({ at: f.resolvedAt, kind: 'resolved', label: 'Back and okay' });
  const seq = new Map(steps.map((x, i) => [x, i]));
  return steps.sort((x, y) => x.at - y.at || RANK[x.kind] - RANK[y.kind] || seq.get(x) - seq.get(y));
}

// A scam card's steps, oldest first: what was shown to the family and what they did with it. No letter text, no photo, ever.
function scamTimeline(p, sc) {
  const steps = [];
  if (sc.level === 'flag' || !sc.notifId) steps.push({ at: sc.createdAt, kind: 'flag', label: 'Kept on this page only (they chose not to alert you)' });
  for (const n of p.notifications.filter((x) => x.incident === sc.id).reverse()) {
    if (n.kind === 'alert') steps.push({ at: n.times.sent, kind: 'alert', label: 'Alert sent to you' });
  }
  if (sc.status === 'expired') steps.push({ at: sc.expiredAt, kind: 'expired', label: `Closed unseen after ${sc.expiredDays} ${sc.expiredDays === 1 ? 'day' : 'days'}` });
  else if (sc.status === 'resolved' && sc.resolvedAt) steps.push({ at: sc.resolvedAt, kind: 'seen', label: 'You saw this' });
  return steps.sort((a, b) => a.at - b.at);
}

function view(id) {
  const p = get(id);
  if (!p) return null;
  const seen = lastSeen(p);
  const fl = (f) => ({ ...f, name: nameOf(id), timeline: timeline(p, f) });
  const rem = (r) => ({ id: r.id, task: r.task, dueAt: r.dueAt, repeat: r.repeat, deliver: r.deliver || null, msg: Boolean(r.msg),
    active: r.active && { ...r.active, label: occLabel(r.active) },
    last: r.last && { ...r.last, label: occLabel(r.last) } });
  return {
    id, name: nameOf(id), mode: p.mode, modes: MODES, delivery: p.delivery, appOpen: appOpen(id), inCall: liveCalls.has(id),
    lastActivity: p.lastActivity, lastSeen: seen, lastCallAt: p.lastActivity.maya, callCount: p.callCount || 0,
    activeOutreach: activeByProfile.has(id) ? { kind: activeByProfile.get(id).kind, attempts: activeByProfile.get(id).attempts, of: cfg.maxAttempts, state: activeByProfile.get(id).state } : null,
    flags: p.flags.filter((f) => f.level === 'flag').map(fl),
    alerts: p.flags.filter((f) => f.level === 'alert').map(fl),
    scams: (p.scams || []).map((sc) => ({ ...sc, name: nameOf(id), timeline: scamTimeline(p, sc) })),
    reminders: p.reminders.map(rem),
    notifications: p.notifications.filter((n) => !n.incident).slice(0, 30).map((n) => ({ id: n.id, to: n.to, kind: n.kind, text: n.text, channel: n.channel, status: n.status, label: statusLabel(n), times: n.times })),
  };
}
function overview() { return memory.listProfiles().map((x) => { const v = view(x.id); return { id: x.id, name: x.name, mode: v.mode, flags: v.flags.filter((f) => f.status === 'active').length + v.scams.filter((x) => x.status === 'active' && x.level === 'flag').length, alerts: v.alerts.filter((f) => f.status === 'active').length + v.scams.filter((x) => x.status === 'active' && x.level === 'alert').length }; }); }

module.exports = {
  cfg, MODES, get, remove, start, stop, tick,
  trendEvent, trendTurn, trendView, localParts,
  linesWithin, touch, lastSeen, callStarted, callEnded, callCount, liveCalls, liveChats, pushSenior, lastCall, appFacts, safeAsked, closeUnseen, painMention, painCount,
  recentLines, isRepeatLine, addLine, seenToTell, clearSeenToTell,
  attachSenior, attachFamily, pushFamily, appOpen,
  statusLabel, markNotif, makeNotif, advance,
  startOutreach, claim, decline, silenceHangup, suddenSilence, selfHarmAlert, healthAlert, whatsappStatus, familyAsk, concernAlert, scamAsk, scamOfficial, checkStart, checkDone, checkFacts, checkDueIds, checkDelivered, scamDeclined, scamTold, scamPending, scamClear, scamUnclear, scamAnswer, scamAlert, scamFlag, safetyCut, onSeniorSpoke, hasActiveFlag, hasActiveSafety, safetyHistoryNote, familyToldTopics, familyFacts, familyEventRecent, assess, raise, ring,
  addReminder, welfarePaused, welfareCallStart, welfareCallEnded, reminderCallStart, reminderCallEnded, reminderViaMessage, deleteReminder, findReminder, reminderAck, reminderNoAck, setReminderSender, reminderStatus, reminderAckWhatsApp, reminderContext, consumeAck, withTurnChannel, turnChannel, setDelivery, flush,
  setMode, sendMessage, view, overview, fmtTime, inQuietHours, outreaches, activeByProfile,
};
