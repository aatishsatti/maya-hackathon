// The TRUE STATE CARD: what the app knows about ONE senior right now, read on the server from the authenticated senior's id (the Call / Chat session's profile), NEVER from a name, id or
// record reference typed in the chat. Rebuilt on every turn (and again when a draft is checked), after any attempted change, BEFORE Spark describes the result.
// It is knowledge for Spark, not a checklist to recite, and it overrides earlier dialogue or memory. Spark writes the words; the server (care.js / social.js) authorises and does the actions.
//
// Never in the card: another senior's records, keys, auth or device tokens, raw phone numbers, the family account, private family text (a family-set record shows its type, time and status only,
// never its words), or any unrestricted dump. A section that cannot be read says UNKNOWN: a failed read is never an empty account. A channel with no delivery evidence is UNKNOWN, never "never rang".
// Opaque references are one-way hashes bound to this senior's id: a reference from another senior resolves to nothing here (resolveRef).
'use strict';
const crypto = require('node:crypto');
const care = require('./care');
const setrem = require('./setrem');

const SALT = process.env.MAYA_REF_SALT || 'maya-state-ref';
const ref = (kind, id, extra = '') => `${kind}_${crypto.createHmac('sha256', SALT).update(`${kind}|${id}|${extra}`).digest('hex').slice(0, 8)}`;
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (h, mi) => `${h % 12 === 0 ? 12 : h % 12}:${pad2(mi)} ${h < 12 ? 'am' : 'pm'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function when(ts, tz) {   // a local date + time in the senior's zone (the zone is named once, in the time section)
  if (ts == null) return null;
  if (!tz) return `${new Date(ts).toISOString().slice(0, 16)}Z (their zone unknown)`;
  const q = setrem.partsIn(ts, tz); return `${DAYS[new Date(Date.UTC(q.y, q.m - 1, q.d)).getUTCDay()]} ${q.d} ${MONTHS[q.m - 1]} ${clock(q.h, q.mi)}`;
}
const dateOnly = (ts, tz) => (ts == null ? null : when(ts, tz).replace(/ \d{1,2}:\d{2} [ap]m$/, ''));

// What the scheduler REALLY supports (read from care.js / setrem.js, not guessed). Do not widen this list without widening the code.
const SCHEDULER = {
  dailyCall: { recurrence: 'every day only, one time of day', max: 1, note: 'ONE daily call from Maya at a time; no several-weekday pattern, no second daily call' },
  reminders: { recurrence: 'once, every N hours (up to 72), every N days (up to 60), every N weeks (up to 12, one weekday); NOT several weekdays in one schedule', max: 10 },
  checkIns: 'set up by the family',
};

function guard(card, name, fn, fallback) {
  try { return fn(); } catch (e) { card.scope.complete = false; card.scope.errors.push(name); return fallback === undefined ? { status: 'unknown', why: 'read failed' } : fallback; }
}

// Everything that states a record, for ONE senior id.
function recordsOf(id, p) {
  const out = [], tz = p.tz || null;
  for (const r of p.reminders || []) {
    const own = care.ownerOf(r), seniorOwned = own !== 'family';
    if (r.social) {
      const v = care.socialView(p, r), o = care.socialOf(id) || {};
      const status = o.revoked ? 'stopped (senior asked Maya not to call)' : o.paused ? 'paused (time zone changed, needs the senior to confirm)' : o.skipDate && o.skipDate === care.localDate(Date.now(), o.tz) ? "today's call skipped" : 'active';
      out.push({ ref: ref('rec', id, r.id), type: 'daily-call', what: 'a friendly daily call from Maya', owner: 'senior', creator: 'senior', source: 'senior chat (one yes to one confirm question)', consent: r.social.consentSource || null, consentAt: when(o.consentAt, tz),
        seniorMay: o.revoked ? ['ask for it back (needs a yes to one question)'] : ['skip today', 'change the time', 'cancel'], familyMay: ['view only (server refuses cancel/change)'],
        status, repeat: 'every day', time: `${clock(o.h, o.mi)} ${o.tz}`, start: o.start, mins: o.h * 60 + o.mi, next: o.revoked || o.paused ? null : when(o.nextAt, o.tz), nextAt: o.nextAt || null, via: 'Maya call in the web page or app (needs Maya open, or a phone registered for push)',
        last: r.last ? { result: care.OCC_LABEL ? care.OCC_LABEL[r.last.state] || r.last.state : r.last.state, at: when(r.last.at, tz), why: r.last.reason || null } : null, status2: v && v.status });
      continue;
    }
    const base = { ref: ref('rec', id, r.id), type: 'reminder', owner: own, creator: seniorOwned ? 'senior' : 'family', source: r.origin || (seniorOwned ? 'senior' : 'family dashboard'),
      status: r.active ? 'going out now' : r.held ? 'held (quiet hours)' : r.dueAt != null ? 'scheduled' : 'finished', repeat: r.repeat === 'none' ? 'once' : `${r.repeat}${(r.every || 1) > 1 ? ` x${r.every}` : ''}`, next: when(r.dueAt, tz), nextAt: r.dueAt || null, mins: r.dueAt != null && tz ? (() => { const q = setrem.partsIn(r.dueAt, tz); return q.h * 60 + q.mi; })() : null, via: `${r.deliver || 'call'} on ${r.channel || 'app'}`,
      last: r.last ? { result: care.OCC_LABEL ? care.OCC_LABEL[r.last.state] || r.last.state : r.last.state, at: when(r.last.at, tz) } : null };
    if (seniorOwned) out.push({ ...base, what: String(r.task || '').slice(0, 60), seniorMay: ['cancel (by telling Maya)'], familyMay: ['view only (server refuses cancel/change)'] });
    else out.push({ ...base, what: 'a reminder from the family (its words are not shown here)', seniorMay: [], familyMay: ['stop', 'edit'] });
  }
  const w = p.welfareSchedule;
  if (w) out.push({ ref: ref('rec', id, 'welfare'), type: 'check-in', what: 'a check-in set by the family (details not shown here)', owner: 'family', creator: 'family', source: 'family dashboard', seniorMay: [], familyMay: ['stop'], status: w.held ? 'held' : 'active', repeat: `every ${Math.round((w.everyMin || 0) / 60)} h`, next: null, via: w.via || null, last: null });
  return out;
}

function historyOf(id, p) {
  const sm = p.smart || {}, tz = p.tz || null, out = [];
  for (const h of sm.history || []) out.push({ ref: ref('his', id, String(h.at)), type: h.type, what: h.what, at: when(h.at, tz), atMs: h.at, actor: h.actor, source: h.source, reason: h.reason, time: h.h != null ? `${clock(h.h, h.mi)} ${h.tz}` : null });
  const c = sm.social && sm.social.cancelledAt;   // older cancels that were noted before the history existed
  if (c && !out.some((h) => Math.abs(h.atMs - c) < 3000)) out.push({ ref: ref('his', id, String(c)), type: 'daily-call', what: 'daily call', at: when(c, tz), atMs: c, actor: 'senior', source: 'not recorded', reason: 'cancelled (details not recorded)', time: null });
  return out.sort((a, b) => a.atMs - b.atMs);
}

function build(id, ctx = {}) {
  const now = ctx.now || Date.now();
  const card = { scope: { senior: ref('sen', id), now: new Date(now).toISOString(), readAt: now, version: null, complete: true, errors: [] } };
  const p = (() => { try { return care.get(id); } catch { return null; } })();
  if (!p) { card.scope.complete = false; card.scope.errors.push('profile'); card.unknown = true; return card; }
  const tz = p.tz || null, sm = p.smart || {}, z = sm.social || {};
  card.time = guard(card, 'time', () => {
    const on = care.quietOn(p), q = on && tz ? care.inQuiet(id, now) : false;
    return { tz, tzSource: p.tzSource || (tz ? 'unknown' : null), tzKnown: Boolean(tz), quiet: { enabled: on, window: `${pad2(care.cfg.quietStart)}:00 to ${pad2(care.cfg.quietEnd)}:00`, appliesNow: q }, effect: !on ? 'no quiet hours: calls may ring at any time' : !tz ? 'quiet hours cannot be applied until their time zone is known' : 'a call due in the window does not ring; a daily call is not caught up, a reminder is held until the window ends' };
  });
  card.channels = guard(card, 'channels', () => {
    const open = care.appOpen(id), push = care.pushReady(id), phone = (p.devices || []).length > 0;
    let wa = 'unknown'; try { wa = care.whatsappLinked(id) ? 'linked' : 'not linked'; } catch { wa = 'unknown'; }
    const current = ctx.channel === 'chat' ? (care.turnChannel(id) === 'whatsapp' ? 'WhatsApp chat' : 'Maya chat (web page or app)') : ctx.channel ? 'Maya voice call' : 'unknown';
    const unavailable = [];
    if (!phone) unavailable.push({ channel: 'phone push', why: 'no phone registered. This does NOT stop calling through Maya open in a browser or the app' });
    if (!open) unavailable.push({ channel: 'Maya page / app', why: 'not open right now, so a call cannot ring there until it is opened' + (push ? ' (a registered phone can still be rung)' : '') });
    if (wa !== 'linked') unavailable.push({ channel: 'WhatsApp', why: wa === 'unknown' ? 'unknown' : 'not set up' });
    return { current, phoneRegistered: phone, pushReady: push, pageOrAppOpenNow: open, whatsapp: wa, callRoutes: ['Maya call in the web page or app'], dailyCallRoute: 'Maya web page or app only (not WhatsApp)', rings: open ? 'yes, Maya is open now' : push ? 'yes, by push to the registered phone' : 'no: Maya is not open and no phone is registered (closed-browser or locked-screen delivery is not verified)', requirements: 'Maya open in a browser tab or the app, or a phone registered for push', unavailable };
  });
  card.records = guard(card, 'records', () => recordsOf(id, p), { status: 'unknown', why: 'read failed: this is NOT an empty account' });
  card.history = guard(card, 'history', () => historyOf(id, p), { status: 'unknown', why: 'read failed' });
  const recs = Array.isArray(card.records) ? card.records : null;
  const social = recs ? recs.find((r) => r.type === 'daily-call') : null;
  card.consent = guard(card, 'consent', () => ({
    callsRevoked: sm.noCalls ? { at: when(sm.noCalls.at, tz), source: sm.noCalls.source || 'chat', reason: sm.noCalls.reason || 'the senior asked Maya to stop calling', needs: 'a fresh yes from the senior before any call is scheduled again' } : null,
    callsRestored: sm.callsRestored ? { at: when(sm.callsRestored.at, tz), source: sm.callsRestored.source } : null,
    dailyCall: social ? { agreedAt: social.consentAt, scope: 'one daily call from Maya at the agreed time and zone', source: social.consent } : null,
  }));
  card.cooldown = guard(card, 'cooldown', () => ({ offerDeclined: z.declinedAt ? when(z.declinedAt, tz) : null, lastOffer: z.offeredAt ? when(z.offeredAt, tz) : null, blocksSeniorsOwnRequest: false, note: 'only limits Maya offering by herself; never blocks what the senior asks for' }));
  card.can = guard(card, 'can', () => {
    const blocked = [];
    const revoked = Boolean(sm.noCalls);
    if (revoked) blocked.push({ action: 'schedule a daily call', why: 'the senior asked Maya to stop calling: needs their fresh yes first' });
    if (!tz) blocked.push({ action: 'schedule a daily call', why: 'their time zone is not known yet (ask it; never guess)' });
    if (social && !social.status.startsWith('stopped')) blocked.push({ action: 'add a second daily call', why: 'only ONE daily call at a time is supported (a limit of the scheduler, not a permission)' });
    const canSet = !revoked && Boolean(tz) && !social;
    return { schedulable: { dailyCall: Boolean(recs) ? canSet : null, why: 'Maya can schedule it herself; the family is not needed, and a registered phone is not needed for a call through Maya open in a browser or the app' },
      actions: [canSet && 'save a daily call (after one yes to one confirm question)', social && 'skip today / change the time / cancel the daily call', 'set reminders (call, text or voice note)'].filter(Boolean), scheduler: SCHEDULER,
      seniorRemindersUsed: (p.reminders || []).filter((r) => r.by === 'senior' && (r.dueAt != null || r.active)).length, family: ['stop or edit family-set reminders', 'view senior-set records (cancel or change is refused by the server)'], blocked };
  });
  card.attempts = guard(card, 'attempts', () => (sm.attempts || []).map((a) => ({ at: when(a.at, tz), actor: a.actor, op: a.op, type: a.type, result: a.result })), []);
  card.transaction = guard(card, 'transaction', () => {
    const hasCall = (p.reminders || []).some((r) => r.social), callRevoked = (p.reminders || []).some((r) => r.social && r.social.revoked);
    const o0 = z.offer && now - z.offer.at < 20 * 60000 ? z.offer : null, ls = z.lastSave || null;
    const o = o0 && !((o0.mode === 'new' && hasCall && !callRevoked) || (o0.mode === 'change' && (!hasCall || callRevoked))) ? o0 : null;   // a stale or impossible offer is not a pending request
    const lastSave = ls ? { h: ls.h == null ? null : ls.h, mi: ls.mi == null ? null : ls.mi, op: ls.op, result: ls.ok === true ? 'saved' : ls.ok === false ? 'failed' : 'unknown (the write was started and not confirmed)', at: when(ls.at, tz), error: ls.ok === false ? String(ls.error || '').slice(0, 100) : null, ref: ls.rid ? ref('rec', id, ls.rid) : null } : null;
    if (!o) return { pending: false, lastSave };
    return { pending: true, op: o.mode === 'new' ? 'save a new daily call' : o.mode === 'change' ? 'change the time of the existing daily call' : o.mode === 'restore' ? 'restore the stopped daily call' : o.mode, stage: o.stage === 'confirm' ? 'waiting for their yes to one confirm question' : o.stage === 'offered' ? 'offered, no answer yet' : 'collecting details',
      proposed: { h: o.time ? o.time.h : null, mi: o.time ? o.time.mi : null, time: o.time ? clock(o.time.h, o.time.mi) : null, start: o.start ? dateOnly(setrem.zonedEpoch(...o.start.split('-').map(Number), 12, 0, tz || 'UTC'), tz) : null, tz: o.tz || null, every: 'day' },
      confirmed: { time: Boolean(o.time), start: Boolean(o.start) || o.mode === 'change', tz: Boolean(o.tz), yesToConfirmQuestion: false }, saveResult: lastSave && lastSave.at && ls.offerId === o.id ? lastSave.result : 'not attempted', lastSave };
  }, { pending: false, lastSave: null, status: 'unknown' });
  card.activity = guard(card, 'activity', () => {
    const la = care.lastSeen(p), src = { maya: 'voice call', app: 'Maya chat (web page or app)', whatsapp: 'WhatsApp' };
    const rec = (p.reminders || []).find((r) => r.social);
    return { lastSeen: la.at ? { at: when(la.at, tz), where: src[la.source] || la.source } : null, dailyCall: rec ? { scheduledAt: when(rec.created, tz), lastOccurrence: rec.last ? { result: care.OCC_LABEL ? care.OCC_LABEL[rec.last.state] || rec.last.state : rec.last.state, at: when(rec.last.at, tz), why: rec.last.reason || null } : null, delivery: rec.last ? 'recorded above' : 'UNKNOWN: no delivery evidence yet (not the same as "never rang")' } : null };
  });
  card.scope.version = crypto.createHash('sha256').update(JSON.stringify([card.records, card.history, card.transaction, card.consent, card.time && card.time.tz])).digest('hex').slice(0, 8);
  return card;
}

const dashList = (a) => (a && a.length ? a.join('; ') : 'none');
function rec1(r) { return `[${r.ref}] ${r.type}: ${r.what}; ${r.owner}-owned (by ${r.creator}, ${r.source}); ${r.status}; ${r.repeat}${r.time ? ` at ${r.time}` : ''}${r.next ? `; next ${r.next}` : '; no next time'}; via ${r.via.replace(/ \(needs.*$/, '')}; senior may: ${dashList(r.seniorMay)}; family: ${r.owner === 'family' ? 'stop/edit' : 'view only'}${r.last ? `; last: ${r.last.result} ${r.last.at}${r.last.why ? ` (${r.last.why})` : ''}` : ''}`; }

// The compact text Spark is given. Unknown stays unknown.
function render(card) {
  const sc = card.scope, L = [];
  L.push(`APP STATE (this senior only, read ${sc.now.slice(0, 16)}Z, v${sc.version || '?'}, ${sc.complete ? 'complete' : `INCOMPLETE, could not read ${sc.errors.join(', ')}: say you cannot see that part, never that it is empty`}). True now; beats earlier chat. Knowledge, not a checklist: follow their words, use only what is relevant, never read ids aloud.`);
  if (card.unknown) return L.join(' ');
  const t = card.time;
  L.push(t.status === 'unknown' ? 'TIME: unknown.' : `TIME: zone ${t.tz || 'NOT KNOWN'} (${t.tzSource || 'no source'}); quiet hours ${t.quiet.enabled ? `ON ${t.quiet.window}${t.quiet.appliesNow ? ', in effect now' : ''}` : 'OFF'}.`);
  const c = card.channels;
  L.push(c.status === 'unknown' ? 'CHANNELS: unknown.' : `CHANNELS: ${c.current}; daily call rings via Maya in a web page or the app (no phone needed); ringing now: ${c.pageOrAppOpenNow ? 'yes, Maya is open' : c.pushReady ? 'yes, by push' : 'no, Maya is closed'}; phone ${c.phoneRegistered ? 'registered' : 'not registered'}; WhatsApp ${c.whatsapp}. Closed-browser or locked-screen delivery is unverified: promise none.`);
  const k = card.can;
  if (k.status !== 'unknown') L.push(`CAN: ${k.actions.join('; ')}. Maya schedules calls herself, the family is not required. LIMITS: daily call = every day, one time, ONE at a time; reminders = once, every N hours/days/weeks, one weekday each, max ${SCHEDULER.reminders.max} (${k.seniorRemindersUsed} used); no several-weekday pattern. Family: edits family-set records only, views senior-set ones (server refuses their change).${k.blocked.length ? ` BLOCKED: ${k.blocked.map((b) => `${b.action} (${b.why})`).join('; ')}.` : ''}`);
  const co = card.consent, cd = card.cooldown;
  L.push(`CONSENT: ${co.status === 'unknown' ? 'unknown' : co.callsRevoked ? `calls STOPPED by the senior ${co.callsRevoked.at}, ${co.callsRevoked.needs}` : 'no stop-calls'}; ${co.dailyCall ? 'daily call agreed' : 'no daily-call agreement'}.${cd.status === 'unknown' ? ' OFFER COOLDOWN unknown.' : cd.offerDeclined ? ` OFFER COOLDOWN (separate, only limits Maya's own offers, never their request): declined ${cd.offerDeclined}.` : ''}`);
  if (Array.isArray(card.records)) L.push(card.records.length ? `RECORDS (${card.records.length}): ${card.records.map(rec1).join(' | ')}.` : 'RECORDS: none saved (read OK).');
  else L.push(`RECORDS: UNKNOWN (${card.records.why}).`);
  if (Array.isArray(card.history)) { if (card.history.length) L.push(`CHANGES: ${card.history.slice(-4).map((h) => `[${h.ref}] ${h.what} ${h.reason} on ${h.at} by ${h.actor} via ${h.source}${h.time ? ` (was ${h.time})` : ''}`).join(' | ')}. A cancelled record was real: never say it was never agreed or never set up; it is not a refusal of future calls.`); }
  else L.push('CHANGES: UNKNOWN.');
  if (card.attempts && card.attempts.length) L.push(`REFUSED ATTEMPTS (nothing changed): ${card.attempts.slice(-2).map((a) => `${a.actor} tried to ${a.op} a ${a.type} on ${a.at}: ${a.result}`).join(' | ')}.`);
  const x = card.transaction;
  if (x.status === 'unknown') L.push('PENDING: unknown.');
  else if (x.pending) L.push(`PENDING (nothing saved by this): ${x.op}; ${x.stage}; proposed time ${x.proposed.time || 'NOT GIVEN'}, start ${x.proposed.start || 'NOT GIVEN'}, zone ${x.proposed.tz}, every day; save result: ${x.saveResult}. Their words bind only to this exact operation.`);
  else if (x.lastSave) L.push(`LAST SAVE: ${x.lastSave.op}: ${x.lastSave.result} ${x.lastSave.at}${x.lastSave.error ? ` (${x.lastSave.error})` : ''}${x.lastSave.result !== 'saved' ? '; if it failed or is unknown, check the RECORDS above before saying anything is set' : ''}.`);
  const a = card.activity;
  if (a.status !== 'unknown' && (a.lastSeen || a.dailyCall)) L.push(`ACTIVITY: last seen ${a.lastSeen ? `${a.lastSeen.at} on ${a.lastSeen.where}` : 'unknown'}${a.dailyCall ? `; daily call last: ${a.dailyCall.lastOccurrence ? `${a.dailyCall.lastOccurrence.result} ${a.dailyCall.lastOccurrence.at}` : 'no delivery evidence yet (UNKNOWN, not "never rang")'}` : ''}.`);
  return L.join(' ');
}

// ---- BOUNDED SCHEDULING LANGUAGE (B1-B3). Code, not a phrase list, decides what a scheduling reply may MEAN, from the verified state:
//   a QUESTION may only name a time that is the pending proposal, the saved time, the attempted time or one the senior said;
//   a READBACK of the existing record ("still 6:35", "your next call will be at 6:35") is checked against STORAGE and needs no new write;
//   a COMPLETION or PROMISE of a change ("done", "I'll move it", "sorted", "from here on", "will be at 6:57") needs a verified write this turn, with that very time;
//   after a failed or uncertain write only a truthful outcome sentence passes; a warm affirmation ("Sounds good") after a yes is blocked unless the write is verified.
// Anything else in a scheduling reply is not spoken: a rewrite, then a plain line built from the state (smart.fallback).
const IMPLIES = /\b(?:done|all set|all sorted|sorted|set up|saved|noted|scheduled|moved|changed|updated|switched|booked|arranged|ready|taken care of|take care of|covered|leave it with me|consider it|you(?:'ve| have)? got it|from here on|from now on|going forward|I(?:'ll| will)\s+(?:\w+\s+){0,2}(?:move|change|set|update|get|make|put|sort|do|switch|book|arrange|have|take)|will be at|will (?:ring|call))\b/i;
const AFFIRM_OPEN = /^\W*(?:perfect|great|sounds good|that works|lovely|wonderful|absolutely|of course|no problem|sure thing|will do|got it|okay|ok|sure|alright|right)\b/i;
const FAIL_WORDS = /\b(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not|unable|wasn'?t|not (?:saved|changed|confirmed|set|moved|sure)|failed|unverified|still)\b/i;
const CHANGE_VERBS = /\b(?:move|moved|change|changed|update|updated|switch|switched|set it|put it|make it|I'll|I will|I'm going to|going to)\b/i;
function timesOf(text) {
  try { text = require('./social').normSpeech(text); } catch { /* digits only */ }
  const out = [], re = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\b/gi; let m;
  while ((m = re.exec(text))) if (m[2] || m[3]) { const h = Number(m[1]); if (h >= 0 && h <= 24) out.push({ h12: h % 12 || 12, mi: Number(m[2] || 0), ap: m[3] ? m[3].toLowerCase() : null }); }
  return out;
}
const timeIn = (t, list) => list.some((a) => a.mi === t.mi && (a.h % 12 || 12) === t.h12 && (!t.ap || (a.h < 12) === (t.ap === 'am')));
function checkScheduling(text, card, ctx = {}) {
  const t = String(text || '').replace(/’/g, "'"); if (!t) return null;
  const recs = card && Array.isArray(card.records) ? card.records.filter((r) => r.type === 'daily-call') : [];
  const recList = recs.map((r) => ({ h: Math.floor(r.mins / 60), mi: r.mins % 60 }));
  const tx = card && card.transaction && card.transaction.status !== 'unknown' ? card.transaction : null;
  const pend = tx && tx.pending && tx.proposed && tx.proposed.h != null ? [{ h: tx.proposed.h, mi: tx.proposed.mi }] : [];
  const last = tx && tx.lastSave && tx.lastSave.h != null ? [{ h: tx.lastSave.h, mi: tx.lastSave.mi }] : [];
  const said = timesOf(ctx.heard || '').map((x) => ({ h: x.ap === 'pm' && x.h12 < 12 ? x.h12 + 12 : x.ap === 'am' && x.h12 === 12 ? 0 : x.h12 % 12, mi: x.mi, any: !x.ap }));
  const allowed = [...recList, ...pend, ...last, ...said, ...(ctx.heardLoose || [])];
  const ex = ctx.exec || {}, V = ex.social ? 'saved' : ex.socialFailed ? 'failed' : ex.socialUnknown ? 'unknown' : 'none';
  const labels = ctx.labels || [], rbTurn = labels.some((l) => /^social-(?:readback|active)/.test(l));
  const yesTurn = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|absolutely|please|go ahead)\b/i.test(ctx.heard || '');
  const readable = Array.isArray(card && card.records);
  for (const x of t.split(/(?<=[.!?])\s+/)) {
    if (!x.trim()) continue;
    const times = timesOf(x), q = /\?\s*$/.test(x);
    const bad = times.find((m) => !timeIn(m, allowed) && !(said.some((a) => a.any && a.mi === m.mi && (a.h % 12 || 12) === m.h12)));
    if (bad) return { why: 'time', note: `the time ${bad.h12}:${String(bad.mi).padStart(2, '0')}${bad.ap ? ` ${bad.ap}` : ''} is not the saved time, the pending proposal, an attempted time or one they said: say only those` };
    if (q) continue;
    const implies = IMPLIES.test(x), affirm = AFFIRM_OPEN.test(x) && (yesTurn || V === 'failed' || V === 'unknown');
    if (!implies && !affirm) continue;
    if (V === 'saved') { if (times.every((m) => timeIn(m, recList))) continue; return { why: 'completion', note: `the saved time is ${recs.map((r) => r.time).join(' / ')}: say only that` }; }
    if (V === 'failed' || V === 'unknown') { if (FAIL_WORDS.test(x) && !/\b(?:done|all set|sorted|saved it|moved it|changed it|is now|are now)\b/i.test(x)) continue; return { why: 'result', note: V === 'failed' ? 'the write FAILED: say plainly that it did not save and the call stays as it was; no success wording, no warm closing' : 'the result could NOT be verified: say plainly that you could not confirm it; no success wording, never "nothing changed"' }; }
    if (readable && times.length && times.every((m) => timeIn(m, recList)) && !CHANGE_VERBS.test(x) && (!AFFIRM_OPEN.test(x) || rbTurn)) continue;   // a readback of the EXISTING record
    return { why: 'unverified', note: 'nothing was changed or saved by a verified write this turn: do not say or promise that it is done, moved, set or sorted (no warm closing that implies it); ask the one question you owe, or read back what is saved' };
  }
  return null;
}

// The compact, authoritative block for a scheduling turn (voice or chat): ownership, web-call eligibility, the current and pending call, and the latest verified action result. Near the END of a short prompt.
// It carries only what the senior's own session may know. Unknown stays unknown.
function compact(card) {
  if (!card || card.unknown || !card.records) return 'APP TRUTH: the saved calls could not be read this turn. Say you cannot see them right now; claim nothing is set or saved, and do not say there are none.';
  const L = ['APP TRUTH (read now for this senior only; it beats everything else you remember or were told):'];
  const dc = Array.isArray(card.records) ? card.records.find((r) => r.type === 'daily-call') : null;
  L.push('The senior owns their daily call. Maya sets it up herself with them: their family is NOT needed and a registered phone is NOT needed; a call rings in the Maya web page or app while it is open. Never say the family arranges it, that you cannot set it up, or that it is app-only. Closed-browser or locked-screen ringing is unverified: promise none.');
  L.push(`DAILY CALL: ${!Array.isArray(card.records) ? 'unknown' : dc ? `${dc.status}, every day at ${dc.time}${dc.next ? `, next ${dc.next}` : ''}` : 'none saved'}.`);
  const h = Array.isArray(card.history) ? card.history.filter((x) => x.type === 'daily-call').slice(-1)[0] : null;
  if (h && !dc) L.push(`EARLIER: their daily call${h.time ? ` at ${h.time}` : ''} was cancelled on ${h.at} by the ${h.actor}; it was real and is not a refusal of new calls.`);
  const t = card.transaction;
  if (t && t.status !== 'unknown' && t.pending) L.push(`PENDING (nothing saved by it): ${t.op}; time ${t.proposed.time || 'NOT GIVEN'}, start ${t.proposed.start || 'NOT GIVEN'}, ${t.proposed.tz}, every day; ${t.stage}. A yes counts only for exactly this.`);
  if (t && t.lastSave) L.push(`LATEST ACTION: ${t.lastSave.op} ${t.lastSave.result}${t.lastSave.error ? ` (${t.lastSave.error})` : ''} ${t.lastSave.at}. Say it is saved ONLY if this says saved and DAILY CALL above shows it.`);
  else L.push('LATEST ACTION: none. Nothing has been saved by you this call.');
  if (card.time && card.time.tz) L.push(`Their zone ${card.time.tz}; quiet hours ${card.time.quiet.enabled ? card.time.quiet.window : 'off'}.`);
  return L.join(' ');
}

// A reference typed by someone resolves ONLY inside this senior's own card (another senior's reference gives null; nothing is ever acted on from a reference in chat).
function resolveRef(id, r) {
  const card = build(id); const all = [...(Array.isArray(card.records) ? card.records : []), ...(Array.isArray(card.history) ? card.history : [])];
  return all.find((x) => x.ref === String(r || '')) || null;
}

// ---------------------------------------------------------------- the draft check (smart.js GUARD): a spoken claim is judged against THIS card, not against a list of banned words.
// Reasons: refusal (a false "family needed / I cannot schedule / app only / no phone number" while the card says otherwise), denies (says nothing is saved or never agreed while a record or its history exists
// or the read is unknown), claims (says a call is set / still on with no active record, or at a time that is not the record's), cancelled (says cancelled while it is active).
const CALLISH = /\b(?:calls?|rings?|ringing|calling|chat)\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;
const FAMILY_NEEDED = [
  /\b(?:ask|need|require|get|have|let)\w*\b[^.?!]{0,30}\b(?:your |the )?(?:family|son|daughter|children|carer|caregiver)\b[^.?!]{0,40}\b(?:set|schedule|arrange|organi[sz]e|add|book)\w*\b[^.?!]{0,30}\b(?:call|calls|it|that|one)\b/i,
  /\b(?:only|has to|have to|must)\b[^.?!]{0,20}\b(?:be\s+)?(?:set up|arranged|scheduled|set)\b[^.?!]{0,10}\bby (?:your |the )?(?:family|son|daughter)\b/i,
  /\byour (?:family|son|daughter)\b[^.?!]{0,25}\b(?:needs? to|must|has to|have to|will need to)\b[^.?!]{0,20}\b(?:set|schedule|arrange|organi[sz]e|book)\w*\b/i,
  /\b(?:family|son|daughter|children|carer|caregiver)\b[^.?!]{0,25}\b(?:arranges?|sets? (?:it |that |those |them )?up|organi[sz]es?|handles?|takes? care of|does that|do that)\b/i,
  /\b(?:something|that'?s|that is|it'?s|it is|up to|left to)\s+(?:for\s+|to\s+)?your\s+(?:family|son|daughter|children)\b/i,
];
const APP_ONLY = /\b(?:calls?|ring\w*|calling|talk\w*)\b[^.?!]{0,40}\b(?:only|just)\b[^.?!]{0,15}\b(?:in|through|on|via|with)\b[^.?!]{0,10}\b(?:the )?(?:maya )?app\b|\b(?:only|just)\b[^.?!]{0,12}\b(?:in|through|on|via)\b[^.?!]{0,10}\bthe (?:maya )?app\b[^.?!]{0,30}\bcalls?\b|\bnot (?:on|in|through) the (?:web|website|browser)\b[^.?!]{0,20}\bcalls?\b/i;
const NO_PHONE = /\b(?:without|no)\b[^.?!]{0,16}\b(?:registered )?phone(?: number)?\b[^.?!]{0,50}\b(?:can(?:'|no)t|cannot|won'?t|unable|nothing|no way|not possible|isn'?t possible|doesn'?t work)\b|\bneed(?:s)? (?:a|your) (?:registered )?phone number\b[^.?!]{0,30}\b(?:call|ring)/i;
const CANT_SCHEDULE = /\bI(?:\s+(?:can(?:'|no)t|cannot|don'?t|do not|won'?t)|\s+am (?:not able|unable) to|'m (?:not able|unable) to)\s+(?:\w+\s+)?(?:schedule|arrange|set up|set|book|make)\b[^.?!]{0,30}\b(?:calls?|daily|ring)/i;
const DENY_CALLS = /\bno\s+(?:daily\s+)?calls?\b[^.?!]{0,30}\b(?:set|scheduled|saved|arranged|booked|on)\b|\bnothing\b[^.?!]{0,20}\b(?:set|scheduled|saved|arranged|booked)\b|\byou\s+(?:don'?t|do not)\s+have\s+(?:a|any)\s+(?:daily\s+)?calls?\b|\bthere(?:'s| is| are)\s+no\s+(?:daily\s+)?calls?\b|\bI\s+(?:don'?t|do not)\s+see\s+(?:a|any)\s+(?:daily\s+)?calls?\b|\bhaven'?t\s+(?:set|arranged|saved)\s+(?:a|any)\b/i;
const NEVER_HAD = /\bnever\s+(?:agreed|asked|set|arranged|scheduled|saved|had|said yes|wanted)\b|\byou\s+(?:never|didn'?t|did not)\s+(?:ask|agree|set|arrange|say yes)\b|\bno record of (?:you|an?)\b[^.?!]{0,30}\b(?:agree|ask|call)/i;
const ARRANGED_ = /\b(?:done|(?:it'?s|that'?s|now)\s+(?:changed|moved|updated|switched)|(?:changed|moved|updated|switched|rescheduled)\s+(?:it|that|your|the)|is|'s|are|been|now|all)\s+(?:all\s+)?(?:set|scheduled|saved|arranged|booked|on|active|confirmed)\b|\b(?:noted|locked in|all set)\b|\bI(?:'ll| will)\s+(?:call|ring|phone)\s+you\b|\bstill\s+(?:on|set|active|scheduled|there)\b|\bwill\s+(?:ring|call)\s+you\s+(?:tomorrow|at|every|each|daily)\b/i;
const SAYS_CANCELLED = /\b(?:cancel(?:l)?ed|stopped|removed|turned off|deleted)\b/i;
const NEGATION = /\b(?:not|no|nothing|never|isn'?t|hasn'?t|haven'?t|didn'?t|can'?t|cannot|yet|unless|if|would|could|once|until|before)\b/i;
function minutesIn(text) {
  try { text = require('./social').normSpeech(text); } catch { /* digits only */ }   // "six oh six" is 6:06
  const out = [], re = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/gi; let m;
  while ((m = re.exec(text))) { let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; out.push(h * 60 + Number(m[2] || 0)); }
  return out;
}
// card = state.build(...) for the AUTHENTICATED senior; ctx.labels = the fact labels of this turn (a cancel / save this turn has just changed the card, which is why it is rebuilt at check time).
function checkDraft(text, card, ctx = {}) {
  const t = String(text || '').replace(/’/g, "'");
  if (!t) return null;
  const sents = t.split(/(?<=[.!?])\s+/);
  if (ctx.sched) { const sc = checkScheduling(t, card, ctx); if (sc) return sc; }
  const callTurn = CALLISH.test(t) || CALLISH.test(String(ctx.heard || '')) || (ctx.labels || []).some((l) => /^(?:social-|smart-calls)/.test(l));   // is this turn about calls?
  const unreadable = !card || card.unknown || !Array.isArray(card.records);
  const recs = unreadable ? [] : card.records.filter((r) => r.type === 'daily-call'), live = recs.find((r) => /^(active|today)/.test(r.status)) || null;
  const hist = !card || !Array.isArray(card.history) ? [] : card.history;
  const canSchedule = card && card.can && card.can.schedulable && card.can.schedulable.dailyCall === true;
  const lastOk = card && card.transaction && card.transaction.lastSave && card.transaction.lastSave.result === 'saved';
  for (const x of sents) {
    if (FAMILY_NEEDED.some((re) => re.test(x)) && callTurn) return { why: 'refusal', note: 'the family is NOT needed: Maya sets the daily call up herself with the senior' };
    if (APP_ONLY.test(x)) return { why: 'refusal', note: 'a call works through Maya open in a web page or the app, not the phone app only' };
    if (NO_PHONE.test(x) && callTurn) return { why: 'refusal', note: 'a registered phone is NOT needed to be called through Maya open in a browser or the app' };
    if (canSchedule && CANT_SCHEDULE.test(x) && callTurn) return { why: 'refusal', note: 'Maya CAN schedule the daily call herself' };
    if (callTurn && DENY_CALLS.test(x) && (live || unreadable || hist.length || lastOk) && !/\b(?:cancel|stopp|remov)/i.test(x)) return { why: 'denies', note: unreadable ? 'the saved calls could not be read: say you cannot see them, not that none exist' : 'a daily call IS on record (or was and was cancelled): say what the record says' };
    if (callTurn && NEVER_HAD.test(x) && (live || hist.length || lastOk)) return { why: 'denies', note: 'it WAS set up (the record or its history says so): never say it was never agreed or set up' };
    if (CALLISH.test(x) && SAYS_CANCELLED.test(x) && live && !NEGATION.test(x) && !(ctx.labels || []).some((l) => /^social-cancel/.test(l))) return { why: 'cancelled', note: 'the daily call is still ACTIVE: it is not cancelled' };
    if ((CALLISH.test(x) || (callTurn && (ctx.labels || []).some((l) => /^social-/.test(l)))) && ARRANGED_.test(x) && !NEGATION.test(x) && !/\?\s*$/.test(x)) {
      if (unreadable) return { why: 'claims', note: 'the saved calls could not be read: claim nothing is set' };
      const set = card.records.filter((r) => /^(active|today|scheduled|going out|held)/.test(r.status));
      if (!set.length && !(ctx.exec && ctx.exec.reminder)) return { why: 'claims', note: 'nothing is saved and active (nothing saved, or it was stopped or cancelled): do not say a call is set or still on' };
      const said = minutesIn(x); if (set.length && said.some((m) => !set.some((r) => r.mins === m))) return { why: 'claims', note: `the saved time is ${set.map((r) => r.time || r.next).join(' / ')}: say only that` };
    }
  }
  return null;
}
function clockMinutes(s) { const m = /^(\d{1,2}):(\d{2}) ([ap]m)/.exec(s); if (!m) return -1; let h = Number(m[1]) % 12; if (m[3] === 'pm') h += 12; return h * 60 + Number(m[2]); }

module.exports = { checkScheduling, build, render, compact, resolveRef, ref, checkDraft, SCHEDULER };
