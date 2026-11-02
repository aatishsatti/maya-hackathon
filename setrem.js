// Call-set FUTURE reminders: a senior says it in plain words ("remind me in 1 hour to take my medicine", "remind me every hour to ...", "every morning at 8 remind me to ...")
// on a call, on WhatsApp or in the app chat, and Maya sets it up. CODE owns every step; Spark only puts the facts into words (the same rule as the rest of the care layer):
//   1. understand  : what, when and how often. Anything unclear is ONE short question, never a guess; a second miss drops it (nothing saved).
//   2. confirm     : the plain-words sentence is said back BEFORE anything is saved ("So, every hour, I will remind you to ... Is that right?"). Only a yes goes on.
//   3. way + place : NEVER asked. The way is what they said ("by calling me", "by texting me", "by voice note"), else a text. The place is the door they asked on (WhatsApp -> WhatsApp, the app chat or a call -> the app);
//                    a place they name wins. Both are in the say-back, and the yes saves. WhatsApp asked for but not set up: the one question "is the app okay?".
//   4. save        : care.addReminder with by:'senior' (the reminder is "strict": at due time it goes EXACTLY that way, on that channel, never changed on its own; see care.js / whatsapp.js).
// Never invented: the task is the senior's own words (pronouns turned to "you" only when spoken back), no medicine, dose, condition or time is ever added.
// This is a FUTURE reminder, not the in-call timer (call.js parseTimer, up to 30 minutes, only while the call stays open). The senior hangs up after setting it.
// Nothing here is written to a log with words: counts and labels only.
'use strict';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const TTL_MS = 10 * MIN;            // an open set-up conversation is forgotten after this long without an answer
const MAX_OPEN = 10;                // reminders a senior can have set by talking at once (a loop must stop somewhere; the family can manage more)
const MAX_AHEAD_MS = 60 * DAY;
const EVERY_MAX = { hourly: 72, daily: 60, weekly: 12 };   // the most they can ask for: every 72 hours, every 60 days, every 12 weeks
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const num = (w) => (/^\d+(\.\d+)?$/.test(w) ? Number(w) : NUMW[String(w).toLowerCase()] || null);

// ---------------------------------------------------------------- time zones (Intl only)
function partsIn(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'long' }).formatToParts(new Date(ts));
  const g = (t) => f.find((x) => x.type === t).value;
  return { y: Number(g('year')), m: Number(g('month')), d: Number(g('day')), h: Number(g('hour')) % 24, mi: Number(g('minute')), wd: WEEKDAYS.indexOf(g('weekday').toLowerCase()) };
}
function zonedEpoch(y, m, d, h, mi, tz) {   // local wall time in tz -> epoch ms
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (ts) => { const p = partsIn(ts, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - ts; };
  let t = guess - off(guess); t = guess - off(t);
  return t;
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return Boolean(tz); } catch { return false; } };

// ---------------------------------------------------------------- reading the words
const UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)';
const IS_REQUEST = new RegExp(String.raw`\bremind(?:ing)? me\b|\b(?:start|begin|first|let'?s start)\s+(?:off\s+)?(?:with\s+)?remind(?:ing|er)|\bset (?:me )?(?:up )?(?:a|an|another|the|some)?\s*(?:daily |hourly |new )?(?:reminder|alarm)s?\b|\b(?:i (?:need|want|would like)|can i (?:get|have)|could i have) (?:a |an )?(?:daily |hourly )?reminder\b|\b(?:tell me|let me know|ping me|nudge me|buzz me|alert me|notify me)\b[^.?!]{0,50}\b(?:in|after)\s+(?:\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|half an?)\s*${UNIT}\b|\b(?:set|start|make|put|use)\s+(?:me\s+|up\s+)?(?:a|an)\s+(?:[\w-]+\s+){0,2}timer\b`, 'i');   // a QUESTION about reminders ("any reminders for me?") is not a request; "remind me", "reminding me", "start with reminding me", "tell me in 5 minutes to...", "set a timer for..." are
const NOT_A_SETUP = /^\s*(?:do|can|could|will|would|are)\s+(?:you|u)\s+(?:\w+\s+){0,2}(?:set|make|do|have|keep|give)\s+(?:\w+\s+){0,2}(?:reminders?|timers?)\s*[?!.]*\s*$|\b(?:next time|when i (?:call|ring|phone) (?:you )?again|the next call)\b|\b(?:stop|keep|kept|don'?t|do not|never|quit|no need to|why (?:do|did) you)\s+(?:\w+\s+){0,2}remind(?:ing)?\s+me\b/i;   // "remind me next time I call" is the next-call reminder (recall.js), not this
// "Call me back in ten minutes", "ring me tonight at 9": a promise to call. It is a real reminder by CALL, so the call really happens (or she says plainly that she cannot); she never just agrees.
const CALLBACK = /\b(?:call|ring|phone) me (?:back|again)\b|\b(?:call|ring|phone) me (?:in|after|at|every|tomorrow|tonight|this|on)\b|\bgive me a (?:call|ring) (?:back|in|after|at|tomorrow|tonight|this|on)\b/i;
const isRequest = (text) => (IS_REQUEST.test(String(text || '')) || CALLBACK.test(String(text || ''))) && !NOT_A_SETUP.test(String(text || ''));

const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// Time words. Returns what was found and the text with those words blanked out (what is left is the task and the delivery words).
function readTime(text, { bare = false } = {}) {
  let s = ` ${norm(text).toLowerCase()} `;
  const o = { repeat: null, rel: null, clock: null, day: null, weekday: null, daypart: null, unsupported: null };
  const cut = (re, fn) => { s = s.replace(re, (...m) => { fn(m); return ' '; }); };
  // "every 2 hours", "every 3 days", "every other week", "every two weeks": N of hours / days / weeks (limits in EVERY_MAX); minutes are not offered
  const unitOf = (u) => (/^h/.test(u) ? 'hourly' : /^d/.test(u) ? 'daily' : /^w/.test(u) ? 'weekly' : null);
  const setEvery = (n, u) => { const r = unitOf(u); if (!r) { o.unsupported = `every ${n} ${u}`; return; } if (!Number.isInteger(n) || n < 1 || n > EVERY_MAX[r]) { o.unsupported = `every ${n} ${u}`; return; } o.repeat = r; o.every = n; };
  cut(/\bevery\s+other\s+(hour|day|week)\b/g, (m) => setEvery(2, m[1]));
  cut(/\bevery\s+(\d+|[a-z]+)\s+(hours?|hrs?|days?|weeks?|minutes?|mins?)\b/g, (m) => { const n = num(m[1]); if (n) setEvery(n, m[2]); else o.unsupported = `every ${m[1]} ${m[2]}`; });
  cut(/\b(?:every|each)\s+(?:single\s+)?(?:minute|min)\b/g, () => { o.unsupported = 'every minute'; });
  cut(/\b(?:every|each)\s+(?:single\s+)?hour\b|\bhourly\b|\bonce an hour\b/g, () => { o.repeat = 'hourly'; o.every = 1; });
  cut(/\b(?:every|each)\s+(?:day|morning|afternoon|evening|night)\b|\bdaily\b|\bonce a day\b|\bevery\s+single\s+day\b/g, (m) => { o.repeat = 'daily'; o.every = 1; const dp = /morning|afternoon|evening|night/.exec(m[0]); if (dp) o.daypart = dp[0]; });
  cut(new RegExp(`\\bevery\\s+(${WEEKDAYS.join('|')})s?\\b`, 'g'), (m) => { o.repeat = 'weekly'; o.every = 1; o.weekday = WEEKDAYS.indexOf(m[1]); });
  cut(/\b(?:every|each)\s+week\b|\bweekly\b|\bonce a week\b/g, () => { o.repeat = o.repeat || 'weekly'; o.every = o.every || 1; });
  // "a 5 minute timer", "a 1 minute reminder": the length is the time
  cut(/\b(\d+(?:\.\d+)?|[a-z]+)[ -]?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+(?:timer|reminder|alarm)\b/g, (m) => { const n = num(m[1]); if (!n) return; o.rel = Math.round(n * (/^h/.test(m[2]) ? HOUR : /^s/.test(m[2]) ? 1000 : MIN)); });
  // "in 30 minutes", "in an hour", "in half an hour", "in two hours", "in an hour and a half"
  cut(/\b(?:in|after|within|(?<=timer )(?:for|of))\s+(half an hour|half hour|an hour and a half|(\d+(?:\.\d+)?|[a-z]+)(?:\s+and a half)?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?))\b/g, (m) => {
    if (/^half/.test(m[1])) { o.rel = 30 * MIN; return; }
    if (/^an hour and a half/.test(m[1])) { o.rel = 90 * MIN; return; }
    const n = num(m[2]); if (!n) return;
    const u = /^d/.test(m[3]) ? DAY : /^h/.test(m[3]) ? HOUR : /^s/.test(m[3]) ? 1000 : MIN;
    o.rel = Math.round((/and a half/.test(m[1]) ? n + 0.5 : n) * u);
  });
  cut(/\b(noon|midday)\b/g, () => { o.clock = { h: 12, mi: 0, ap: 'pm', fixed: true }; });
  cut(/\bmidnight\b/g, () => { o.clock = { h: 0, mi: 0, ap: 'am', fixed: true }; });
  const clock = (m) => { o.clock = { h: Number(m[1]), mi: m[2] ? Number(m[2]) : 0, ap: m[3] ? m[3][0] + 'm' : null }; };
  if (!o.clock) cut(/\b(?:at|around|by|for|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/, clock);
  if (!o.clock) cut(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/, clock);
  if (!o.clock) cut(/\b(\d{1,2}):(\d{2})\b()/, clock);
  if (!o.clock && bare) cut(/^\s*(?:it'?s |make it |let'?s say |say )?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:o'?clock)?\s*(?=$|[\s,.]|in the|at night)/, clock);
  cut(/\b(today|tomorrow|tonight|this morning|this afternoon|this evening)\b/g, (m) => {
    o.day = m[1] === 'tomorrow' ? 'tomorrow' : 'today';
    const dp = /morning|afternoon|evening|night/.exec(m[1]); if (dp) o.daypart = dp[0];
  });
  cut(new RegExp(`\\b(?:on |next |this )?(${WEEKDAYS.join('|')})\\b`, 'g'), (m) => { if (o.weekday == null) o.weekday = WEEKDAYS.indexOf(m[1]); });
  cut(/\b(?:in the |at )?(morning|afternoon|evening|night)\b/g, (m) => { o.daypart = o.daypart || m[1]; });
  return { found: o, rest: norm(s) };
}

// The clock time, resolved to 24 h, or why it cannot be. Never guessed: "at 8" with nothing else says whether it is morning or evening is a question.
function resolveClock(c, daypart) {
  if (!c) return { ok: false };
  let { h, mi, ap } = c;
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return { ok: false, bad: true };
  if (c.fixed) return { ok: true, h, mi };
  if (ap === 'pm') { if (h > 12) return { ok: false, bad: true }; if (h < 12) h += 12; }
  else if (ap === 'am') { if (h > 12) return { ok: false, bad: true }; if (h === 12) h = 0; }
  else if (h >= 13 || h === 0) { /* 24 hour clock: clear */ }
  else if (daypart === 'morning') { if (h === 12) h = 0; }
  else if (daypart === 'afternoon' || daypart === 'evening' || daypart === 'night') { if (h < 12) h += 12; }
  else return { ok: false, ambiguous: true, h: c.h, mi };
  return { ok: true, h, mi };
}

const CALL_TASK = 'talk with Maya';   // what a promised call-back is "for" when they named nothing else
const FILLER_TASK = /^(?:it|that|this|something|stuff|things?|a thing|me|you|please|thanks?|ok(?:ay)?|yes|no)$/i;
// What to remind them of: the words after the LAST "remind me" / "reminder", with the time words already blanked out. Their own words, pronouns untouched.
function readTask(rest) {
  let t = rest;
  const idx = [...t.matchAll(/\bremind(?:ing|ers?|s)?(?:\s+me)?\b|\b(?:tell|ping|nudge|buzz|alert|notify)\s+me\b|\blet\s+me\s+know\b/gi)];
  if (idx.length) { const last = idx[idx.length - 1]; t = t.slice(last.index + last[0].length); }
  else t = t.replace(/^.*?\b(?:set|start|make|put|use) (?:me )?(?:up )?(?:a|an|another|the|some)?\s*(?:[\w-]+\s+){0,2}?(?:daily |hourly )?(?:reminder|alarm|timer)s?\b/i, '');
  t = t.replace(/^.*?\b(?:set|start|make|put)\s+(?:me\s+)?(?:a|an)\s+(?=(?:to|for|about)\b)/i, '');   // "set a [5 minute timer] to check the oven": the timer words went with the time
  t = t.replace(/^[\s,.:;-]+/, '').replace(/^so\s+(?:that\s+)?(?:i|we)\s+(?:will|can|would|do|won'?t forget to|remember to|don'?t forget to)\s+/i, '').replace(/^(?:please\s+|and\s+|also\s+)+/i, '').replace(/^(?:to|that|about|of|for)\s+/i, '');
  t = t.replace(/^(?:i|we)\s+(?:need|have|has|must|should|want|ought|got)\s+to\s+/i, '').replace(/^(?:i|we)\s+(?:need|have|has|must|should|got)\s+(?=\S)/i, (m) => m);
  t = t.replace(/\b(?:please|thanks|thank you)\b[\s.!?,]*$/i, '').replace(/\s+(?:and|then|so)\s*$/i, '').replace(/[\s.!?,;:]+$/g, '').replace(/\s+/g, ' ').trim();
  return t;
}

// Delivery words in a first sentence, only in the shapes that cannot be part of the task ("on WhatsApp", "in the app", "by text", "as a voice note", "call me ..."): blanked out and returned.
// "remind me to call my sister" keeps its "call": a bare verb is never taken as the delivery here.
function takeDelivery(rest) {
  let s = ` ${rest} `, deliver = null, channel = null;
  const cut = (re, fn) => { s = s.replace(re, (...m) => { fn(m); return ' '; }); };
  cut(/\b(?:on|via|through|using|over)\s+(?:whats ?app|what'?s ?app)\b/gi, () => { channel = 'whatsapp'; });
  cut(/\b(?:in|on|via|through|using)\s+(?:the\s+|your\s+)?(?:maya\s+)?app\b/gi, () => { channel = 'app'; });
  cut(/\b(?:by|via|with|as|using|in)\s+(?:a\s+)?(?:voice (?:note|message|memo)|voice)\b/gi, () => { deliver = 'voice'; });
  cut(/\b(?:by|via|with|as|using|in)\s+(?:a\s+)?(?:text(?: message)?|message|sms)\b/gi, () => { deliver = 'text'; });
  cut(/\b(?:by|via|with|as|using|in)\s+(?:a\s+)?(?:phone\s+|voice\s+)?call\b/gi, () => { deliver = 'call'; });
  cut(/\b(?:by|via|through)\s+(?:sending me (?:a )?)?(?:a\s+)?voice\s*(?:note|message|memo)s?\b/gi, () => { deliver = 'voice'; });
  cut(/\b(?:by|via|through)\s+(?:calling|ringing|phoning)(?:\s+me)?\b/gi, () => { deliver = 'call'; });
  cut(/\b(?:by|via|through)\s+(?:texting|messaging|sms-?ing|writing to)(?:\s+me)?\b/gi, () => { deliver = 'text'; });
  cut(/\bsend me (?:a )?(?:voice (?:note|message|memo))\b/gi, () => { deliver = 'voice'; });
  cut(/\bsend me (?:a )?(?:text(?: message)?|message)\b/gi, () => { deliver = 'text'; });
  cut(/\b(?:give me a (?:phone )?call|(?:call|ring|phone) me)\b/gi, () => { deliver = 'call'; });
  cut(/\b(?:text|message) me\b/gi, () => { deliver = 'text'; });
  return { rest: norm(s), deliver, channel };
}
// How they want it delivered / where. Looked for in the words that are NOT the task, so "remind me to call my sister" never means a call.
function readDelivery(rest) {
  const s = ` ${norm(rest).toLowerCase()} `;
  let channel = null; const kinds = []; const s2 = s.replace(/\bvoice (?:note|message|memo)s?\b|\bvoice call\b/g, ' ');   // "a voice message" is one way, not a voice and a message
  if (/\bvoice (?:note|message|memo)s?\b|\bvoice\b|\baudio\b|\brecording\b|\bsay it\b|\bspeak\b/.test(s) && !/\bvoice call\b/.test(s)) kinds.push('voice');
  if (/\b(?:call|ring|phone) me\b|\bgive me a (?:call|ring)\b|\bby (?:a )?(?:phone )?call\b|\bwith a (?:phone )?call\b|\bvoice call\b|\ba (?:phone )?call\b|^ ?(?:a )?(?:phone )?call ?$|\bcall\b|\bring\b|\bphone\b/.test(s)) kinds.push('call');
  if (/\btext(?:ing)?\b|\bwritten\b|\bwriting\b|\bwrite\b|\bmessage me\b|\bsms\b|\ba message\b|\bmessage\b/.test(s2)) kinds.push('text');
  // Two ways named ("a text or a voice note", "text and voice"): the person is asked to pick ONE; it is never guessed. (A call word with a voice word is the old "voice, by call" shape: the call wins as before.)
  let deliver = kinds.includes('call') ? 'call' : kinds.length === 1 ? kinds[0] : null, multi = null;
  if (!kinds.includes('call') && kinds.length > 1) multi = kinds;
  if (/\bwhats ?app\b|\bwhat'?s app\b/.test(s)) channel = /\bboth\b|\bwhats ?app and (?:the )?(?:maya )?app\b|\b(?:maya )?app and whats ?app\b/.test(s) ? 'both' : 'whatsapp';
  else if (/\bboth\b/.test(s)) channel = 'both';
  else if (/\b(?:the |your |maya )?(?:maya )?app\b|\bin app\b/.test(s)) channel = 'app';
  return { deliver, channel, ...(multi ? { multi } : {}) };
}

// ---------------------------------------------------------------- the reminder, from words
// A whole request. Returns { task, repeat, dueAt, deliver, channel, ask:[...what is missing], unsupported, noTz, ambiguous }.
function parseRequest(text, { now = Date.now(), tz = null, bare = false, base = null } = {}) {
  const { found, rest } = readTime(text, { bare });
  const spec = base ? { ...base } : { task: '', repeat: 'none', every: 1, dueAt: null, deliver: null, channel: null, relMs: null, clock: null, weekday: null, startWords: null };
  const td = takeDelivery(rest);
  let task = readTask(td.rest);
  if (!base && CALLBACK.test(String(text || '')) && !/\bremind(?:er)?s?\b/i.test(String(text || ''))) { task = CALL_TASK; td.deliver = 'call'; }   // a callback has no other task
  const dl = { deliver: td.deliver, channel: td.channel };
  if (dl.deliver) spec.deliver = dl.deliver;
  if (dl.channel) spec.channel = dl.channel;
  // the task: delivery words that were the whole answer ("by text") are not a task
  if (task === CALL_TASK && !(base && base.task)) spec.task = task;
  else if (task && !(base && base.task)) {
    const t2 = readDelivery(task); const onlyDelivery = (t2.deliver || t2.channel) && norm(task).split(' ').length <= 4 && !isRequest(text) && !bareTaskLooksReal(task);
    if (!onlyDelivery && !FILLER_TASK.test(task) && task.length >= 3) spec.task = task;
  }
  if (found.unsupported) spec.unsupported = found.unsupported; else if (found.repeat || found.rel || found.clock || found.day || found.weekday != null) spec.unsupported = null;
  if (found.repeat) { spec.repeat = found.repeat; spec.every = found.every || 1; }
  if (found.rel != null) spec.relMs = found.rel;
  if (found.clock) spec.clock = { ...found.clock, daypart: found.daypart };
  if (found.day) spec.day = found.day;
  if (found.weekday != null) spec.weekday = found.weekday;
  if (found.daypart && spec.clock && !spec.clock.daypart) spec.clock.daypart = found.daypart;
  if (found.daypart) spec.daypart = found.daypart;
  return settle(spec, { now, tz });
}
const bareTaskLooksReal = (t) => /\b(?:take|drink|eat|call|check|water|feed|walk|pills?|medic\w*|tablets?|insulin)\b/i.test(t);

// Work out the first due time and what is still missing. Pure.
function settle(spec, { now, tz }) {
  spec.ask = []; spec.noTz = false; spec.ambiguous = null; spec.dueAt = null;
  if (!spec.task) spec.ask.push('task');
  if (spec.task && spec.task.length > 80) { spec.task = ''; spec.ask.push('shorter'); }
  if (spec.unsupported) { spec.ask.push('repeat'); return spec; }
  const rc = spec.clock ? resolveClock(spec.clock, spec.clock.daypart || spec.daypart) : null;
  if (spec.relMs != null && spec.relMs >= 10000 && spec.relMs <= MAX_AHEAD_MS) { spec.dueAt = now + spec.relMs; return spec; }
  if (spec.relMs != null) { spec.ask.push('time'); return spec; }
  if (rc && rc.ok) {
    if (!validTz(tz)) { spec.noTz = true; return spec; }
    const lp = partsIn(now, tz);
    const at = (addDays) => { const dt = new Date(Date.UTC(lp.y, lp.m - 1, lp.d + addDays)); return zonedEpoch(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), rc.h, rc.mi, tz); };
    let add = 0;
    if (spec.weekday != null) { add = (spec.weekday - lp.wd + 7) % 7; if (add === 0 && at(0) <= now) add = 7; }
    else if (spec.day === 'tomorrow') add = 1;
    else if (spec.day === 'today') add = 0;
    else add = at(0) > now + 30000 ? 0 : 1;
    const t = at(add);
    if (t <= now + 10000 || t - now > MAX_AHEAD_MS) { spec.ask.push('time'); return spec; }
    spec.dueAt = t;
    return spec;
  }
  if (rc && rc.ambiguous) { spec.ambiguous = rc; spec.ask.push('ambiguous'); return spec; }
  if (rc && rc.bad) { spec.ask.push('time'); spec.clock = null; return spec; }
  if (spec.repeat === 'hourly') { spec.dueAt = now + (spec.every || 1) * HOUR; spec.startsInHour = true; return spec; }
  spec.ask.push('time');
  return spec;
}

// ---------------------------------------------------------------- saying it back (plain words)
// "I" -> "you" and "my" -> "your" for what is SAID back; the stored task stays exactly as they said it.
function second(task) {
  return String(task || '')
    .replace(/\bI am\b/gi, 'you are').replace(/\bI'm\b/gi, "you're").replace(/\bI've\b/gi, "you've").replace(/\bI'll\b/gi, "you'll").replace(/\bI'd\b/gi, "you'd")
    .replace(/\bmyself\b/gi, 'yourself').replace(/\bmine\b/gi, 'yours').replace(/\bmy\b/gi, 'your').replace(/\bme\b/gi, 'you').replace(/\bI\b/g, 'you').trim();
}
const VERBS = new Set(['take', 'call', 'drink', 'eat', 'check', 'go', 'walk', 'water', 'feed', 'lock', 'turn', 'put', 'bring', 'pick', 'buy', 'get', 'do', 'stretch', 'exercise', 'rest', 'sleep', 'wash', 'clean', 'cook', 'pay', 'write', 'read', 'wake', 'stand', 'sit', 'move', 'use', 'wear', 'open', 'close', 'charge', 'text', 'message', 'phone', 'ring', 'visit', 'meet', 'see', 'say', 'tell', 'ask', 'remember', 'make', 'keep', 'stop', 'start', 'finish', 'send', 'give', 'try', 'change', 'apply', 'measure', 'test', 'brush', 'shower', 'bathe', 'have', 'stay', 'relax', 'breathe', 'pray', 'fill', 'order', 'book', 'bring', 'switch', 'unplug', 'rinse', 'refill', 'log', 'record', 'weigh', 'sign', 'return', 'look', 'be', 'let', 'wait', 'prepare', 'pack', 'set', 'tidy', 'water', 'mail', 'post', 'email', 'attend', 'join', 'listen', 'watch', 'play', 'cut']);
const toOrAbout = (task) => (VERBS.has(String(task).trim().split(/\s+/)[0].toLowerCase()) ? 'to' : 'about');

const dur = (ms) => {
  if (ms % DAY === 0) { const n = ms / DAY; return `${n} ${n === 1 ? 'day' : 'days'}`; }
  const h = Math.floor(ms / HOUR), m = Math.round((ms % HOUR) / MIN);
  if (h && m) return `${h} ${h === 1 ? 'hour' : 'hours'} and ${m} ${m === 1 ? 'minute' : 'minutes'}`;
  if (h) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  if (ms < 90 * 1000) { const s = Math.max(1, Math.round(ms / 1000)); return `${s} ${s === 1 ? 'second' : 'seconds'}`; }
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
};
const clockWords = (ts, tz) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
function dayWords(ts, tz, now) {
  const a = partsIn(ts, tz), b = partsIn(now, tz);
  const n = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / DAY);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `on ${WEEKDAYS[a.wd][0].toUpperCase()}${WEEKDAYS[a.wd].slice(1)}`;
}
const PARK_MS = 3 * HOUR;   // if the end of the call is never seen, the parked reminder still comes after this
const waiting = new Map();   // profile id -> [{ rid, delay }]: reminders waiting for a call to end
// Called when a call ends: what was asked for "in a minute" during it now happens, right after the hang-up (at least 20 seconds, or the delay they asked for if longer).
function afterHangup(id) {
  const w = waiting.get(id); if (!w) return 0; waiting.delete(id);
  const care = require('./care'); let n = 0;
  for (const x of w) if (care.rescheduleReminder(id, x.rid, Date.now() + x.delay)) n++;
  return n;
}
const SHORT_MS = 10 * MIN;   // on a call, an ask for something this soon cannot be kept while the call is on: it happens right after the call ends
const afterCall = (spec, ctx) => ctx && ctx.origin === 'call' && spec.repeat === 'none' && spec.relMs != null && spec.relMs <= SHORT_MS;
function whenWords(spec, { tz, now = Date.now(), origin } = {}) {
  if (afterCall(spec, { origin })) return 'right after you hang up the call';
  const wd = (i) => `${WEEKDAYS[i][0].toUpperCase()}${WEEKDAYS[i].slice(1)}`;
  const k = spec.every || 1;
  if (spec.repeat === 'hourly') {
    const every = k === 1 ? 'every hour' : `every ${k} hours`;
    if (spec.startsInHour && spec.relMs == null && !spec.clock) return `${every}, starting in ${k === 1 ? 'one hour' : `${k} hours`}`;
    return spec.relMs != null ? `${every}, starting in ${dur(spec.relMs)}` : `${every}, starting at ${clockWords(spec.dueAt, tz)} ${dayWords(spec.dueAt, tz, now)}`;
  }
  if (spec.repeat === 'daily') return `${k === 1 ? 'every day' : `every ${k} days`} at ${clockWords(spec.dueAt, tz)}`;
  if (spec.repeat === 'weekly') return `${k === 1 ? 'every' : `every ${k} weeks, starting`} ${k === 1 ? wd(partsIn(spec.dueAt, tz).wd) : `on ${wd(partsIn(spec.dueAt, tz).wd)}`} at ${clockWords(spec.dueAt, tz)}`;
  if (spec.relMs != null) return `in ${dur(spec.relMs)}`;
  return `${dayWords(spec.dueAt, tz, now)} at ${clockWords(spec.dueAt, tz)}`;
}
// Quiet hours: nothing is rung, texted or sent at night (care.js tick), so a reminder whose first time falls in them is HELD until they end. Maya must say so, plainly, when she says it back and when it is saved.
// Returns { at: when it will really go (the end of the quiet hours), words: "7 in the morning" } or null (an ordinary reminder, or no time zone known).
const hourWords = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? ' in the morning' : h < 17 ? ' in the afternoon' : ' in the evening'}`;
function quietHold(spec, { tz, now = Date.now(), origin } = {}) {
  if (!tz || !validTz(tz) || spec.task == null) return null;
  const care = require('./care');
  const first = afterCall(spec, { origin }) ? now + Math.max(20000, spec.relMs) : spec.dueAt;   // after a call it goes 20 seconds or the asked delay after the hang-up
  if (!Number.isFinite(first)) return null;
  const at = care.quietEndsAt(first, tz);
  return at ? { at, words: hourWords(care.cfg.quietEnd), start: care.cfg.quietStart, end: care.cfg.quietEnd } : null;
}
const quietClause = (spec, q) => spec.repeat === 'none' ? `it is quiet hours until ${q.words}, so I will remind you at ${q.words} instead` : `it is quiet hours until ${q.words}, so when one falls at night I will wait and remind you at ${q.words}`;
const VERB_PHRASE = { call: 'call you', text: 'send you a text', voice: 'send you a voice note' };
const WHERE_WORDS = { whatsapp: 'on WhatsApp', app: 'in the Maya app', both: 'in the Maya app and on WhatsApp' };
// The sentence Maya says back before anything is saved. When the way and the place are already known they are in it.
function confirmText(spec, ctx) {
  const when = whenWords(spec, ctx), what = `${toOrAbout(spec.task)} ${second(spec.task)}`;
  const q = quietHold(spec, ctx);
  if (q) return spec.task === CALL_TASK ? `So, ${quietClause(spec, q)}, and I will call you for a chat. Is that right?` : `So, ${quietClause(spec, q)}, ${what}. Is that right?`;
  if (spec.task === CALL_TASK) return afterCall(spec, ctx) ? 'So, I will call you right after you hang up this call. Is that right?' : `So, ${when}, I will call you for a chat. Is that right?`;
  if (afterCall(spec, ctx)) return `So, I will remind you ${what} right after you hang up the call. Is that right?`;
  const how = spec.deliver ? `${VERB_PHRASE[spec.deliver]}${spec.channel ? ` ${WHERE_WORDS[spec.channel]}` : ''} and remind you` : 'remind you';
  return `So, ${when}, I will ${how} ${what}. Is that right?`;
}
const savedText = (spec, ctx) => {
  const when = whenWords(spec, ctx), what = `${toOrAbout(spec.task)} ${second(spec.task)}`;
  const q = quietHold(spec, ctx);
  if (q) return spec.task === CALL_TASK ? `${quietClause(spec, q)[0].toUpperCase()}${quietClause(spec, q).slice(1)}, and I will call you for a chat.` : `${quietClause(spec, q)[0].toUpperCase()}${quietClause(spec, q).slice(1)}, ${what}.`;
  const where = spec.channel ? ` ${WHERE_WORDS[spec.channel]}` : '';
  if (spec.task === CALL_TASK) return afterCall(spec, ctx) ? `I will call you${where} right after you hang up this call.` : `${when[0].toUpperCase()}${when.slice(1)}, I will call you${where} for a chat.`;
  if (afterCall(spec, ctx)) return `I will remind you ${what} right after you hang up the call.`;
  const how = `${VERB_PHRASE[spec.deliver]} ${WHERE_WORDS[spec.channel]} and remind you`;
  return `${when[0].toUpperCase()}${when.slice(1)}, I will ${how} ${what}.`;
};
// What a delivered text or voice note says (whatsapp.js reminderWords, care.js): it is THEIR reminder, never "from your family".
const deliveryWords = (task) => { const w = `Your reminder: ${second(String(task || '').replace(/[\s.!?,;:]+$/, ''))}.`; return w; };

// ---------------------------------------------------------------- the conversation (per person, in memory only)
const states = new Map();
const lost = new Map();   // profile id -> { at }: a set-up that timed out; a short answer to it gets a plain 'I lost that' (never silence, never a made-up result)
  // profileId -> { stage, spec, origin, asks, unclear, at }
const YES = /\b(?:yes|yeah|yep|yup|yea|ya|correct|right|exactly|sure|ok(?:ay)?|please do|go ahead|do it|sounds good|that'?s right|that is right|that'?s correct|that is correct|perfect|good)\b/i;
const NO = /\b(?:no|nope|nah|wrong|not right|cancel|never ?mind|forget it|don'?t|do not|stop|not that)\b/i;
const CANCEL = /\b(?:cancel|never ?mind|forget it|forget about it|don'?t (?:set|bother)|do not (?:set|bother)|stop)\b/i;
// A one-word yes that is mistyped or stretched ("oky", "okk", "okie", "okey", "kk", "yess", "yeaa", "haan") counts as yes too, like the listed words: they are answering the question in front of them.
const SHORT_YES = /^(?:o+k+(?:a+y+|a+|e+y*|i+e*|y+)?|k+|y+e+s+|y+e+a+h*|y+u+p+|y+e+p+|y+s+|ye+|haan+|han+|achh?a+|theek|sahi)$/i;
const sayYes = (t) => (YES.test(t) && !NO.test(t)) || SHORT_YES.test(String(t).trim().replace(/[^\p{L}]+$/u, ''));
const sayNo = (t) => NO.test(t) && !/\b(?:yes|yeah|yep|yup)\b/i.test(t);

const QUESTION = {
  task: 'What should I remind you about?',
  time: 'When should I remind you?',
  repeat: 'I can remind you every few hours (up to 72), every few days (up to 60) or every few weeks (up to 12). How often would you like?',
  shorter: 'Could you say what to remind you about a bit shorter?',
};
function questionFor(spec) {
  const a = spec.ask, parts = [];
  if (a.includes('ambiguous')) { const h = spec.ambiguous.h, mi = spec.ambiguous.mi ? `:${String(spec.ambiguous.mi).padStart(2, '0')}` : ''; parts.push(`Is that ${h}${mi} in the morning or in the evening?`); }
  const needTask = a.includes('task') || a.includes('shorter'), needTime = a.includes('time');
  if (a.includes('repeat')) return QUESTION.repeat;
  if (a.includes('shorter')) return QUESTION.shorter;
  if (needTask && needTime) return 'What should I remind you about, and when?';
  if (needTask) return QUESTION.task;
  if (needTime) return spec.repeat === 'daily' ? 'What time should I remind you each day?' : spec.repeat === 'weekly' ? 'What time should I remind you on that day?' : QUESTION.time;
  return parts[0] || QUESTION.time;
}

const COMMON = 'Use ONLY the details in this fact: add no medicine, no dose, no reason, no advice and nothing you were not told. At most two short sentences, in fresh warm words. Do not say anything is saved or set unless this fact says it is.';
const note = (label, text) => ({ label, text: `FACT: ${text}` });
const cancelNote = (why) => { return note('setrem-dropped', `${why} NOTHING was saved and no reminder was set. Tell them so gently in one short sentence, and that they can ask again whenever they like. Do not ask anything more about it. ${COMMON}`); };

function channelQuestionNote(noWa) {
  return note('setrem-ask-channel', noWa
    ? `WhatsApp is not set up for them, so it cannot go there (nothing is saved yet). Ask as ONE short question whether the Maya app is fine: "Is the Maya app okay for that?" ${COMMON}`
    : `Nothing is saved yet. WhatsApp is set up for them, so ask where it should come to them, as ONE short question: "Would you like that on the Maya app, on WhatsApp, or both?" ${COMMON}`);
}

function begin(id, heard, ctx) {
  const spec = parseRequest(heard, ctx);
  if (ctx.skipEmpty && spec.ask.includes('task') && spec.ask.includes('time')) return null;   // "you remind me" in a call that already has a timer running: talk, not a request
  const st = { stage: 'clarify', spec, origin: ctx.origin, asks: 0, unclear: 0, corrections: 0, at: ctx.now };
  states.set(id, st);
  return progress(id, st, ctx);
}

// After the words are understood: ask the ONE question, or say it back for a yes.
// HOW and WHERE are never asked. Where: the door they asked on (the app chat -> the app, WhatsApp -> WhatsApp). How: what they said ("by calling me", "by voice note", "by text"), else a text in that door.
// Said once, in the say-back, and changed only if they say so there.
function applyDefaults(st) {
  const spec = st.spec;
  if (!spec.deliver) spec.deliver = 'text';
  if (!spec.channel) spec.channel = st.origin === 'whatsapp' ? 'whatsapp' : 'app';
}
function progress(id, st, ctx) {
  const spec = st.spec;
  if (spec.noTz) { states.delete(id); return note('setrem-no-time-zone', `They asked for a reminder at a clock time, but you do not know what time it is where they are, so you cannot set it right now (nothing was saved). Say that kindly in one short sentence and offer one that does not need the clock, like "in an hour". ${COMMON}`); }
  if (spec.ask.length) {
    if (st.asks >= 1) { states.delete(id); return cancelNote('You asked one question and the answer still did not make the reminder clear enough to set it without guessing.'); }
    st.asks += 1; st.stage = 'clarify';
    const q = questionFor(spec);
    return note('setrem-ask-detail', `They asked you to set a reminder but part of it is not clear, and you must not guess. Ask them ONE short question and nothing else: "${q}" ${COMMON}`);
  }
  applyDefaults(st);   // (a call-back's way is the call itself: set when it was parsed)
  st.stage = 'confirm'; st.unclear = 0; st.say = confirmText(spec, ctx);
  return note('setrem-confirm', `They asked you to set a reminder. Nothing is saved yet. Say it back to them in fresh warm words, keeping EVERY detail exactly (how often, when, and what): "${confirmText(spec, ctx)}" End by asking if that is right, then wait for their yes or no. Do not say it is set. ${COMMON}`);
}

function afterYes(id, st, ctx) {
  applyDefaults(st);   // nothing is asked: the way and the place were said back with the confirmation
  return needChannel(id, st, ctx);
}
function needChannel(id, st, ctx) {
  const spec = st.spec;
  // Where = the door they asked on, unless they named one. WhatsApp is only ever mentioned when they ask for it and it is not set up (said plainly, then the app).
  if (!spec.channel) spec.channel = st.origin === 'whatsapp' ? 'whatsapp' : 'app';
  if ((spec.channel === 'whatsapp' || spec.channel === 'both') && !ctx.waLinked) { spec.channel = null; st.noWa = true; }
  if (!spec.channel) { st.stage = 'channel'; st.unclear = 0; return channelQuestionNote(st.noWa); }
  return save(id, st, ctx);
}
function save(id, st, ctx) {
  const spec = st.spec, care = require('./care');
  // They went away between the question and the answer and the time they asked for ("in 2 minutes") has passed: saving it would fail. Not a failure and not "ask your family": say it plainly and ask the time again,
  // keeping what they already told us (what, how, where), so one short answer finishes it.
  if (!afterCall(spec, { origin: st.origin }) && Number.isFinite(spec.dueAt) && spec.dueAt < (ctx.now || Date.now()) - 60000) {
    const was = whenWords(spec, { tz: ctx.tz, now: ctx.now || Date.now(), origin: st.origin });
    st.spec = { ...spec, dueAt: null, relMs: null, clock: null, day: null, weekday: null, daypart: null, startsInHour: false, ask: ['time'] };
    st.stage = 'clarify'; st.asks = 1; st.unclear = 0; st.at = ctx.now || Date.now(); states.set(id, st);
    return note('setrem-ask-detail', `The time they asked for (${was}) has already passed while they were away, so nothing is set yet. Say sorry plainly in one short sentence that that time has gone, and then ask ONE short question and nothing else: "${QUESTION.time}" ${COMMON}`);
  }
  states.delete(id);
  try {
    // On a call, something this soon waits for the call to end (then it happens right after the hang-up). It is parked until then, with a safety time if the hang-up is never seen.
    const park = afterCall(spec, { origin: st.origin });
    const r = care.addSeniorReminder(id, { task: spec.task, dueAt: park ? Date.now() + PARK_MS : spec.dueAt, repeat: spec.repeat, every: spec.every, deliver: spec.deliver, channel: spec.channel, origin: st.origin });
    if (park && r && r.id) { const w = waiting.get(id) || []; w.push({ rid: r.id, delay: Math.max(20000, spec.relMs) }); waiting.set(id, w); }
  } catch (e) {
    return note('setrem-not-saved', `The reminder could NOT be saved (${e.status === 409 ? 'they already have as many reminders set by talking as can be kept' : 'a problem on your side'}). ${e.status === 409 ? 'Tell them kindly in one short sentence that you could not set it because they already have so many, and that they can stop one in My Reminders (the menu button at the top left) to make room, then ask again.' : 'Tell them kindly in one short sentence that you could not set it just now, and that they can ask you again in a moment.'} Never say or suggest their family should add it: they can set their own reminders with you. Do not say it is set. ${COMMON}`);
  }
  console.log('setrem', JSON.stringify({ event: 'saved', repeat: spec.repeat, every: spec.every || 1, deliver: spec.deliver, channel: spec.channel, origin: st.origin }));   // kinds only: never the task
  const q = quietHold(spec, { ...ctx, origin: st.origin });
  const quietSay = q ? ` IMPORTANT: it falls in quiet hours (${String(q.start).padStart(2, '0')}:00 to ${String(q.end).padStart(2, '0')}:00 where they are), when Maya never rings, texts or sends anything. Say that plainly in your own words: that it is quiet hours, and that you will remind them at ${q.words}, not before. Do not say you will remind them right away or right after the call.` : '';
  const stay = q ? '' : st.origin === 'call' ? ' They do NOT need to stay on the call: you will reach them at the time even after they hang up, so they can hang up whenever they like.' : '';
  return note('setrem-saved', `The reminder is now SAVED (it is a real future reminder, not a timer): "${savedText(spec, ctx)}" Tell them in one short sentence that it is set, naming how often or when, how you will reach them and where, in fresh words.${stay} Promise nothing else, and do not offer more.${quietSay} ${COMMON.replace(' Do not say anything is saved or set unless this fact says it is.', '').replace('At most two short sentences', q ? 'At most three short sentences' : 'At most two short sentences')}`);
}

// The next thing they said, while a set-up is open. Returns a note or null when the words are not part of it.
function answer(id, st, heard, ctx) {
  const spec = st.spec;
  if (st.stage === 'clarify') {
    if (CANCEL.test(heard)) { states.delete(id); return cancelNote('They said never mind.'); }
    const next = parseRequest(heard, { ...ctx, bare: true, base: spec });
    st.spec = next;
    return progress(id, st, ctx);
  }
  if (st.stage === 'confirm') {
    const asNew = readTime(heard, { bare: false }).found; const changed = asNew.repeat || asNew.rel != null || asNew.clock || asNew.weekday != null || asNew.unsupported || (asNew.day && (sayNo(heard) || /\b(?:make it|change|instead|rather|actually)\b/i.test(heard)));   // a bare "today" in some other sentence is not a change
    if (changed && !(sayYes(heard) && !changed)) {
      // a correction: "no, at 9" / "make it every day": the new words replace the old ones, and it is said back again
      if (st.corrections >= 3) { states.delete(id); return cancelNote('The details kept changing.'); }
      st.corrections += 1;
      const fresh = { ...spec, repeat: 'none', every: 1, relMs: null, clock: null, day: null, weekday: null, daypart: null, unsupported: null, startsInHour: false };
      st.spec = parseRequest(heard, { ...ctx, base: { ...fresh, task: spec.task } });
      if (!st.spec.task) st.spec.task = spec.task;
      st.asks = 0;
      return progress(id, st, ctx);
    }
    // They name the way or the place while confirming ("call me instead", "yes, by voice note", "on WhatsApp"): it is taken as said, never asked again. Two ways named at once are not guessed: they pick ONE.
    const named = readDelivery(heard);
    if (named.multi && !named.deliver) {
      st.unclear += 1; if (st.unclear >= 3) { states.delete(id); return cancelNote('They did not pick one way.'); }
      const ways = named.multi.map((k) => (k === 'voice' ? 'voice note' : k)).join(' or ');
      return note('setrem-ask-delivery', `They named more than one way (${named.multi.map((k) => (k === 'voice' ? 'voice note' : k)).join(' and ')}). Do NOT pick for them and do not save anything. Ask as ONE short question which ONE they want: "${ways}, pick one?" ${COMMON}`);
    }
    const differs = (named.deliver && named.deliver !== spec.deliver) || (named.channel && named.channel !== spec.channel);
    const restated = Boolean(named.deliver || named.channel) && !differs && !sayYes(heard) && !sayNo(heard);   // only the way, said again ("text"): said back once more, not taken for a yes
    if (differs || restated) {
      if (named.deliver) spec.deliver = named.deliver; if (named.channel) spec.channel = named.channel;
      if (sayYes(heard) && !sayNo(heard)) return afterYes(id, st, ctx);
      if (st.corrections >= 3) { states.delete(id); return cancelNote('The details kept changing.'); }
      st.corrections += 1; return progress(id, st, ctx);   // said back once more with the new way
    }
    if (sayNo(heard) || CANCEL.test(heard)) { states.delete(id); return cancelNote('They said no to it.'); }
    if (sayYes(heard)) return afterYes(id, st, ctx);
    st.unclear += 1;
    if (st.unclear >= 2) { states.delete(id); return cancelNote('They did not say yes.'); }
    return note('setrem-confirm-again', `You asked whether the reminder is right and they did not answer yes or no. Nothing is saved. Ask just once more, briefly: "${confirmText(spec, ctx)}" ${COMMON}`);
  }
  if (st.stage === 'channel') {
    if (CANCEL.test(heard)) { states.delete(id); return cancelNote('They said no to it.'); }
    const dl = readDelivery(heard);
    // channel stage
    if (dl.channel) spec.channel = dl.channel;
    else if (st.noWa && sayYes(heard)) spec.channel = 'app';
    if (!spec.channel) { st.unclear += 1; if (st.unclear >= 2) { states.delete(id); return cancelNote('They did not say where.'); } return channelQuestionNote(st.noWa); }
    if ((spec.channel === 'whatsapp' || spec.channel === 'both') && !ctx.waLinked) { spec.channel = null; st.noWa = true; st.unclear += 1; if (st.unclear >= 2) { states.delete(id); return cancelNote('WhatsApp is not set up for them.'); } return channelQuestionNote(true); }
    return save(id, st, ctx);
  }
  return null;
}

// Called for every thing the person says (call.js careNotes, which the written chat shares). origin: 'call' | 'whatsapp' | 'app'. Returns { label, text } (a FACT for Spark) or null.
function step(id, heard, { origin, tz = null, now = Date.now(), waLinked = false, skipEmpty = false } = {}) {
  heard = norm(heard);
  if (!heard) return null;
  const ctx = { origin, tz: validTz(tz) ? tz : null, now, waLinked, skipEmpty };
  let st = states.get(id);
  if (st && now - st.at > TTL_MS) lost.set(id, { at: now });   // timed out while they were away: if the next thing they say is an answer to it, they are told plainly
  if (st && (now - st.at > TTL_MS || st.origin !== origin)) { states.delete(id); st = null; }
  if (st && isRequest(heard) && st.stage !== 'clarify') { const fresh = parseRequest(heard, ctx); if (fresh.task && (fresh.dueAt || fresh.ask.length)) { states.delete(id); st = null; } }
  if (st) { st.at = now; return answer(id, st, heard, ctx); }
  if (!isRequest(heard)) {
    const gone = lost.get(id);
    if (gone && now - gone.at < 60 * MIN && heard.split(/\s+/).length <= 6 && (readDelivery(heard).channel || readDelivery(heard).deliver || YES.test(heard) || SHORT_YES.test(heard.replace(/[^\p{L}]+$/u, '')) || NO.test(heard))) {
      lost.delete(id);
      return note('setrem-lost', `A reminder they were setting up earlier was forgotten while they were away (nothing was saved), and what they just said looks like an answer to it. Say sorry plainly in one short sentence that you lost that set-up while they were away, and ask them to tell you again what to remind them about and when. Do not say anything is set. Never mention their family. ${COMMON}`);
    }
    return null;
  }
  if (require('./care').seniorSetCount(id) >= MAX_OPEN) return note('setrem-full', `They asked for a reminder, but they already have as many reminders set by talking as can be kept (${MAX_OPEN}). Say so kindly in one short sentence and that they can stop one in My Reminders (the menu button at the top left) to make room. Nothing was saved. Never suggest their family should add it. ${COMMON}`);
  return begin(id, heard, ctx);
}

const reset = (id) => { if (id) states.delete(id); else states.clear(); };
const pending = (id) => { const s = states.get(id); return s ? { stage: s.stage, origin: s.origin, spec: s.spec } : null; };

// The question a person is being asked right now ("how?", "where?"), for the one case where Spark twice closes without asking it: it is then put at the end of her reply so the set-up never stalls on a missing question.
function pendingQuestion(id, label = '') {
  if (label === 'setrem-lost') return 'What would you like me to remind you about, and when?';
  const st = states.get(id); if (!st) return null;
  if (st.stage === 'confirm' && st.say) return st.say;   // the say-back with its "Is that right?" (the only question left to ask)
  if (st.stage === 'channel') return st.noWa ? 'Is the Maya app okay for that?' : 'Would you like that on the Maya app, on WhatsApp, or both?';
  if (st.stage === 'clarify' && st.spec && st.spec.ask && st.spec.ask.length) return questionFor(st.spec);
  return null;
}
module.exports = { pendingQuestion, quietHold, hourWords, savedText, afterHangup, afterCall, CALL_TASK, EVERY_MAX, step, isRequest, parseRequest, readTime, confirmText, whenWords, second, deliveryWords, reset, pending, MAX_OPEN, TTL_MS, HOUR, DAY, MIN, zonedEpoch, partsIn };
