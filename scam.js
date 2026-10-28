// Scam shield. The person shows Maya a letter, message or screen (a photo); Meta vision (Spark, the same chat-completions endpoint and
// image format as describeImage in brain.js) answers five plain yes/no questions about it from ITS OWN CONTEXT, not from a word list.
// The decision is made here, in code, from those five answers: two or more = warning, one = caution, none = nothing at all. An ordinary
// letter has all five false, so a normal letter never gets a warning. Nothing from the image is kept: only the kind of scam (a few
// plain words) can ever reach the family, never the letter's text, never the photo.
const SIGNALS = ['urgency', 'money', 'impersonation', 'secrecy', 'payment'];
const READS = ['remoteAccess', 'idDetails', 'happeningNow', 'aboutToAct'];   // extra reads for spoken / typed talk (ASK_TALK); the photo path (ASK) is unchanged
const WARN_AT = 2;       // two or more signals: "this looks like a scam"
const CAUTION_AT = 1;    // one signal: be careful, check first (not called a scam)

const ASK = [
  'You are helping an older person who has just shown you a letter, message, email or screen. Read it as a careful, fair friend would.',
  'Reply with ONLY one JSON object and no other text:',
  '{"reading":"<one or two short plain sentences saying what it is and what it wants, with no names, phone numbers or account numbers>","type":"<two to four plain words for the kind of message, for example payment scam, prize scam, bank impersonation scam, or ordinary letter>","urgency":true|false,"money":true|false,"impersonation":true|false,"secrecy":true|false,"payment":true|false}',
  'Judge each of the five from this message\'s own context, not from single words:',
  '- urgency: it pressures or threatens them to act now or something bad will happen (more than an ordinary due date);',
  '- money: it promises or demands money out of the blue (a prize, refund, inheritance, fee or fine);',
  '- impersonation: it claims to be a bank, government, company, family member or authority but cannot be trusted from what is shown (generic greeting, mismatched sender, odd link or number);',
  '- secrecy: it asks them not to tell anyone, such as family or the bank;',
  '- payment: it asks them to pay or send money, gift cards, crypto, codes or bank details, or to click or call to "verify" something.',
  'An ordinary letter (a bill from a known sender with a normal due date, an appointment, a newsletter, a note from a friend) has all five false. Do not guess: if the picture cannot be read, set all five to false and say so in "reading".',
].join('\n');

// Spoken or typed talk: the person has received a message, or is TELLING Maya about a message, call, visit or page. The same five signals (their
// definitions are taken from ASK so there is one source), plus the three extra reads. Spark reads the words; code decides the level.
const DEFS = ASK.split('\n').filter((l) => /^- (urgency|money|impersonation|secrecy|payment):/.test(l));
const ASK_TALK = [
  'You are helping an older person. They have either received a message, or they are telling you about a message, phone call, visit or web page. Read it as a careful, fair friend would.',
  'Reply with ONLY one JSON object and no other text:',
  '{"reading":"<one or two short plain sentences saying what it is and what it wants, with no names, phone numbers or account numbers>","type":"<two to four plain words for the kind of message, for example payment scam, prize scam, bank impersonation scam, or ordinary message>","urgency":true|false,"money":true|false,"impersonation":true|false,"secrecy":true|false,"payment":true|false,"remoteAccess":true|false,"idDetails":true|false,"happeningNow":true|false,"aboutToAct":true|false}',
  'Judge each of the nine from this message\'s own context, not from single words:',
  ...DEFS,
  '- remoteAccess: it asks them to install a program or app, give someone control of their computer or phone, open a page or link the other person gives them, or read out a code or number that was sent to them or shown on their screen;',
  '- idDetails: someone who contacted them (a caller, a message, a visitor) asks them to give identity numbers (national insurance, Medicare, passport or ID numbers), a date of birth together with other personal details, or security answers. Do not count an ordinary check by a service they themselves called or were expecting, such as a clinic confirming a date of birth for an appointment they booked;',
  '- happeningNow: the other person is contacting or pressing them right now (still on the phone or at the door, waiting for an answer), not something that already ended;',
  '- aboutToAct: because of this, the person says they are about to, on their way to, or already in the middle of: paying, sending money, buying gift cards or vouchers, handing over card or account details, reading out a code, or installing or clicking something the other person told them to.',
  'An ordinary message (a bill from a known sender with a normal due date, an appointment, a reminder, a note from family or a friend, a genuine bank alert that says never to share a code) has all nine false. A payment the person chose to make themselves, to someone they know, for something they asked for (their own bill, a purchase, a gift, rent they agreed) is not a scam: aboutToAct on its own does not make anything one. Do not guess: if you cannot tell, set the signs to false and say so in "reading".',
].join('\n');

// ---- Cheap word filter: which spoken / typed talk is worth one Spark check at all (so ordinary chat costs nothing), and which is happening
// RIGHT NOW (the person is on the way to pay, or the caller is still on the line), where the check is awaited before Maya answers.
// Wide on purpose: a miss means a scam is not checked, a false match only costs one check that comes back "nothing". Pure, no network.
const G = {
  money: /\b(pay|paid|paying|payment|send|sent|sending|transfer\w*|wire|wired|deposit\w*|fees?|fines?|owe|owed|owing|refund\w*|rebates?|invoices?|cash|cheques?|checks?|gift ?cards?|vouchers?|crypto\w*|bitcoin|invest\w*|loans?|bail|prizes?|lottery|won|winnings?|reward|donat\w+|charity|\$|£|€|dollars?|pounds?|thousand|hundred|savings|money|funds?)\b|[$£€]/i,
  secrets: /\b(codes?|pin|passwords?|passcodes?|otp|verif\w+|confirm\w*|security|card number|account number|bank details|bank account|sort code|medicare|national insurance|social security|passport|date of birth|birthday|dob|login|log in|log-in|details)\b/i,
  contact: /\b(rang|ring|phoned|phone|called|calling|calls?|text(ed)?|messages?|e-?mail\w*|letters?|knock\w*|door|pop-?up|web ?site|web ?page|links?|apps?|install\w*|download\w*|remote|screen|computer|laptop|tablet|virus\w*|support|technician|engineer|bank\w*|tax|council|company|insurance|parcel|delivery|customs|courier|police|hospital|energy|gas|electric\w*|water|broadband|internet|provider|pension|benefits?|government|solicitor|landlord|agent)\b/i,
  pressure: /\b(urgent\w*|immediate\w*|today|within|arrest\w*|warrant|suspend\w*|disconnect\w*|cut off|locked|frozen|final (notice|warning|reminder)|expire\w*|don'?t tell|not to tell|do not tell|between us|secret|stay on the (line|phone)|hang up|safe account|limited|hurry|deadline|legal action)\b/i,
};
// Weights, not just groups: a classic tell is enough alone (2); a bait word that ordinary chat almost never uses is enough alone (2); an
// everyday word group counts 1, and it takes two groups to fire. "fine" on its own never counts (people say "I'm fine" all day).
const STRONG = /\b(gift ?cards?|vouchers?|bitcoin|crypto\w*|remote access|safe account|one[- ]time|read (it |them |the (code|numbers?) )?out|control (of )?my (computer|phone)|see my screen|install (a |the )?(program|app)|(don'?t|do not|must not|mustn'?t|never|not to|can'?t|cannot) tell|keep it (a )?(secret|between us)|arrest\w*|warrant|western union|wire (the )?money)\b/i;
const BAIT = /\b(rebates?|refunds?|prizes?|lottery|winnings?|rewards?|cheques?|deposit it|invoices?|bail|loans?|invest\w*|fees?|fines|fined|penalt\w+|overdue|arrears|unpaid|outstanding|eligible|entitled|claim\w*|cash machine|atm|withdraw\w*|take out the cash|disconnected|suspended|locked|frozen|final (notice|warning)|legal action|customs|redelivery|re-delivery|virus\w*|unauthori[sz]ed|fraud team|security department|safe account|courtesy call|free (health check|device|gift|holiday)|selected|chosen)\b/i;
function needsCheck(text) {
  const t = String(text || '').replace(/[\u2018\u2019]/g, "'");
  if (t.trim().length < 12) return false;
  let score = (STRONG.test(t) ? 2 : 0) + (BAIT.test(t) ? 2 : 0) + Object.values(G).filter((re) => re.test(t)).length;
  return score >= 2;
}
// The person is, or is about to be, in the middle of it: on the way to pay, at the cash machine, the caller still on the line, a code in front of them.
const NOW = /\b(on my way|(i am|i'm|im) (just )?(going|walking|heading|driving|off) (to|now)|(i am|i'm|im) (just )?about to|about to (pay|send|transfer|give|read|press|click|install|do|type)|(i am|i'm|im) (at|in) the (cash machine|atm|bank|post office|shop|supermarket|queue)|putting (the |my )?card in|(have|got) (it|them|the (code|numbers?)) (in front of me|in my hand|here)|(still|staying) on the (phone|line)|(he|she|they)('s| is|'re| are) (asking|telling) me to|wants me to (click|press|type|read|install|open|go|pay|send)|just (downloaded|installed|clicked)|right now)\b/i;
const payNow = (text) => NOW.test(String(text || '').replace(/[\u2018\u2019]/g, "'"));
// What to do with a turn of talk: no check, a check beside the reply, or a check awaited before the reply (the rare "happening right now" turns).
function checkPlan(text) { const check = needsCheck(text); return { check, await: check && payNow(text) }; }

// The reply is JSON, possibly wrapped in a code fence or a sentence. Returns null if it is not usable.
function parse(text) {
  const raw = String(text || '');
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o;
  try { o = JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const signals = {};
  for (const k of SIGNALS) signals[k] = o[k] === true || /^(true|yes)$/i.test(String(o[k]));
  const reads = {};
  for (const k of READS) reads[k] = o[k] === true || /^(true|yes)$/i.test(String(o[k]));   // only present in an answer to ASK_TALK; false when missing
  return { reads, reading: String(o.reading || '').replace(/\s+/g, ' ').trim().slice(0, 400), type: String(o.type || ''), signals };
}

// reads (optional, only from ASK_TALK): remoteAccess counts as one more warning sign; idDetails (asked to give identity numbers or a date of birth to
// someone who contacted them) counts as two, so it is a warn on its own: handing those over cannot be taken back, however polite the asker. 'pause' is a warn that is also about to happen: the person is
// about to pay, send, give a code or install something because of it, and the other side is still pressing them now (or the case is already a
// warn). happeningNow and aboutToAct never make something a scam by themselves, so a genuine payment (no signs) is never paused.
function levelOf(signals, reads = null) {
  const count = SIGNALS.filter((k) => signals && signals[k]).length + (reads && reads.remoteAccess ? 1 : 0) + (reads && reads.idDetails ? 2 : 0);
  let level = count >= WARN_AT ? 'warn' : count >= CAUTION_AT ? 'caution' : 'none';
  if (reads && reads.aboutToAct && (level === 'warn' || (level === 'caution' && reads.happeningNow))) level = 'pause';
  return { count, level };
}

// Only a few plain words ever go to the family: letters and spaces, lower case, no digits, no names or numbers.
function typeLabel(raw, signals) {
  const w = String(raw || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const end = w.findIndex((x) => /^(scam|fraud|phishing)$/.test(x));   // the label ends at that word, so nothing after it (a name, a number) can ride along
  let t = w.slice(0, end >= 0 ? end + 1 : 4).slice(0, 4).join(' ');
  if (!t || /^(none|n a|ordinary|ordinary letter|normal|normal letter|unknown|other|unreadable)$/.test(t)) t = '';
  if (!t) t = signals && signals.payment ? 'payment scam' : signals && signals.impersonation ? 'impersonation scam' : 'scam';
  else if (!/scam|fraud|phishing/.test(t)) t = `${t} scam`;
  return t.slice(0, 40);
}

// One Spark vision call. Throws on a Meta error (the caller decides what a failed check means; nothing is invented).
async function assess(buf, mime, signal) {
  const brain = require('./brain'), lm = require('./meta').begin('scam-photo', brain.liveModel()), note = { usage: null };
  try { const out = await assessCore(note, buf, mime, signal); lm.done(true, { usage: note.usage }); return out; }
  catch (e) { lm.done(false, { usage: note.usage }); throw e; }
}
async function assessCore(note, buf, mime, signal) {
  const brain = require('./brain');
  const r = await fetch(brain.META_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: brain.liveModel(),
      messages: [{ role: 'user', content: [{ type: 'text', text: ASK }, { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }] }],
      reasoning_effort: 'low',
      max_completion_tokens: 3000,
    }),
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]),
  });
  if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 300); } catch { /* ignore */ } throw new Error(`Meta Spark failed (HTTP ${r.status}) ${d}`.trim()); }
  const d = await r.json();
  note.usage = d.usage || null;
  const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  const o = parse(text);
  if (!o) throw new Error('Meta Spark returned no usable scam check');
  const { count, level } = levelOf(o.signals);
  return { reading: o.reading, signals: o.signals, count, level, type: typeLabel(o.type, o.signals) };
}

// One Spark text call for spoken or typed talk (see ASK_TALK). Throws on a Meta error: the caller decides what a failed check means; nothing is invented.
// opts.reasoning (optional, for measuring only): Spark's reasoning_effort for this one call. The default, 'low', is what runs live.
async function assessText(text, signal, opts = {}) {
  const brain = require('./brain'), lm = require('./meta').begin('scam-text', brain.liveModel()), note = { usage: null };
  try { const out = await assessTextCore(note, text, signal, opts); lm.done(true, { usage: note.usage }); return out; }
  catch (e) { lm.done(false, { usage: note.usage }); throw e; }
}
async function assessTextCore(note, text, signal, opts) {
  const brain = require('./brain');
  const r = await fetch(brain.META_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: brain.liveModel(),
      messages: [{ role: 'user', content: `${ASK_TALK}\n\nWHAT THEY RECEIVED OR TOLD YOU:\n${String(text).slice(0, 2000)}` }],
      reasoning_effort: opts && opts.reasoning ? opts.reasoning : 'low',
      max_completion_tokens: 3000,
    }),
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]),
  });
  if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 300); } catch { /* ignore */ } throw new Error(`Meta Spark failed (HTTP ${r.status}) ${d}`.trim()); }
  const d = await r.json();
  note.usage = d.usage || null;
  const o = parse(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
  if (!o) throw new Error('Meta Spark returned no usable scam check');
  const { count, level } = levelOf(o.signals, o.reads);
  return { reading: o.reading, signals: o.signals, reads: o.reads, count, level, type: typeLabel(o.type, o.signals) };
}

const SIGNAL_WORDS = { urgency: 'pressure to act now', money: 'money out of the blue', impersonation: 'someone claiming to be a trusted sender', secrecy: 'a request to keep it secret', payment: 'a request to pay or send details' };
const READ_WORDS = { remoteAccess: 'a request to install something, give control of a device, or read out a code', idDetails: 'a request for identity numbers or a date of birth' };
const said = (signals, reads = null) => [...SIGNALS.filter((k) => signals[k]).map((k) => SIGNAL_WORDS[k]), ...(reads ? ['remoteAccess', 'idDetails'].filter((k) => reads[k]).map((k) => READ_WORDS[k]) : [])];

// Spark's private feel tag once read a scam letter as "concern=urgent", which the health rule treats as a medical emergency: a false safety alert.
const FEEL_NOTE = " In your private [[feel: ...]] tag use concern=none and pain=0 and never emotion=crisis: this is about a message or a call, not about their health or safety, so never mark it urgent or unsure.";

// What Maya is told about spoken or typed talk that looks like a scam: FACTS and PRINCIPLES only. Spark phrases every word (nothing here is a sentence to say).
function talkNote(scam) {
  if (!scam || scam.level === 'none') return '';
  const signs = said(scam.signals || {}, scam.reads).join('; ');
  const lead = 'SCAM CHECK (a fact from the app, not from them)';
  if (scam.level === 'pause') return `${lead}: what they told you about looks like a possible ${scam.type}, and they may be about to act on it right now (${signs}). Slow down: be steady, calm and brief, with no cheerfulness. First, in your own words, ask them to stop for a moment and not pay, send money, read out a code, give any details, install or click anything yet; if the other person is still on the line, they can simply hang up or say they will call back. Say it looks like a scam, never that it is certain. Say the safe way is to check with the real company or bank themselves, through a number or website they already trust, and never give a number yourself. Then ask ONE short question: would they like you to let their family know now? (This overrides any earlier instruction about not asking a question: ask it.) If they say they will go ahead anyway, say once, gently, why you are worried and that their family can help; do not nag or argue. No diagnosis, no legal advice, no guarantee, no blame.${FEEL_NOTE}`;
  if (scam.level === 'warn') return `${lead}: what they told you about looks like a possible ${scam.type}, with warning signs (${signs}). In your own words and in plain, calm language: say briefly what it seems to be, from this reading: ${scam.reading}. Say it looks like a scam, never that it is certain. Ask them not to pay, send money, read out codes, give details or click anything until they have checked, and to check with the real company or bank themselves through a number or website they already trust; never give a number yourself. Then ask ONE short question: would they like you to let their family know? (This overrides any earlier instruction about not asking a question: ask it.) No diagnosis, no legal advice, no guarantee, no blame. Keep it short, warm and plain.${FEEL_NOTE}`;
  return `${lead}: what they told you about has one warning sign (${signs}). In your own words, in one or two short sentences, say what to double-check, and gently suggest they check with their family or the real company before replying or paying. Do not call it a scam and do not ask about telling their family. No phone numbers, no blame. Keep it short, warm and plain.${FEEL_NOTE}`;
}


module.exports = { talkNote, FEEL_NOTE, needsCheck, payNow, checkPlan, READS, ASK_TALK, assessText, SIGNALS, WARN_AT, CAUTION_AT, ASK, parse, levelOf, typeLabel, assess, said };
