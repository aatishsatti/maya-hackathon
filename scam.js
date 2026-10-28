// Scam shield. The person shows Maya a letter, message or screen (a photo); Meta vision (Spark, the same chat-completions endpoint and
// image format as describeImage in brain.js) answers five plain yes/no questions about it from ITS OWN CONTEXT, not from a word list.
// The decision is made here, in code, from those five answers: two or more = warning, one = caution, none = nothing at all. An ordinary
// letter has all five false, so a normal letter never gets a warning. Nothing from the image is kept: only the kind of scam (a few
// plain words) can ever reach the family, never the letter's text, never the photo.
const SIGNALS = ['urgency', 'money', 'impersonation', 'secrecy', 'payment'];
const READS = ['remoteAccess', 'happeningNow', 'aboutToAct'];   // extra reads for spoken / typed talk (ASK_TALK); the photo path (ASK) is unchanged
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
  '{"reading":"<one or two short plain sentences saying what it is and what it wants, with no names, phone numbers or account numbers>","type":"<two to four plain words for the kind of message, for example payment scam, prize scam, bank impersonation scam, or ordinary message>","urgency":true|false,"money":true|false,"impersonation":true|false,"secrecy":true|false,"payment":true|false,"remoteAccess":true|false,"happeningNow":true|false,"aboutToAct":true|false}',
  'Judge each of the eight from this message\'s own context, not from single words:',
  ...DEFS,
  '- remoteAccess: it asks them to install a program or app, give someone control of their computer or phone, open a page or link the other person gives them, or read out a code or number that was sent to them or shown on their screen;',
  '- happeningNow: the other person is contacting or pressing them right now (still on the phone or at the door, waiting for an answer), not something that already ended;',
  '- aboutToAct: because of this, the person says they are about to, or on their way to, pay, send money, buy gift cards or vouchers, hand over card or account details, read out a code, or install or click something.',
  'An ordinary message (a bill from a known sender with a normal due date, an appointment, a reminder, a note from family or a friend, a genuine bank alert that says never to share a code) has all eight false. A payment the person chose to make themselves, to someone they know, for something they asked for (their own bill, a purchase, a gift, rent they agreed) is not a scam: aboutToAct on its own does not make anything one. Do not guess: if you cannot tell, set the signs to false and say so in "reading".',
].join('\n');

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

// reads (optional, only from ASK_TALK): remoteAccess counts as one more warning sign. 'pause' is a warn that is also about to happen: the person is
// about to pay, send, give a code or install something because of it, and the other side is still pressing them now (or the case is already a
// warn). happeningNow and aboutToAct never make something a scam by themselves, so a genuine payment (no signs) is never paused.
function levelOf(signals, reads = null) {
  const count = SIGNALS.filter((k) => signals && signals[k]).length + (reads && reads.remoteAccess ? 1 : 0);
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
  const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  const o = parse(text);
  if (!o) throw new Error('Meta Spark returned no usable scam check');
  const { count, level } = levelOf(o.signals);
  return { reading: o.reading, signals: o.signals, count, level, type: typeLabel(o.type, o.signals) };
}

// One Spark text call for spoken or typed talk (see ASK_TALK). Throws on a Meta error: the caller decides what a failed check means; nothing is invented.
async function assessText(text, signal) {
  const brain = require('./brain');
  const r = await fetch(brain.META_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: brain.liveModel(),
      messages: [{ role: 'user', content: `${ASK_TALK}\n\nWHAT THEY RECEIVED OR TOLD YOU:\n${String(text).slice(0, 2000)}` }],
      reasoning_effort: 'low',
      max_completion_tokens: 3000,
    }),
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]),
  });
  if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 300); } catch { /* ignore */ } throw new Error(`Meta Spark failed (HTTP ${r.status}) ${d}`.trim()); }
  const d = await r.json();
  const o = parse(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
  if (!o) throw new Error('Meta Spark returned no usable scam check');
  const { count, level } = levelOf(o.signals, o.reads);
  return { reading: o.reading, signals: o.signals, reads: o.reads, count, level, type: typeLabel(o.type, o.signals) };
}

const SIGNAL_WORDS = { urgency: 'pressure to act now', money: 'money out of the blue', impersonation: 'someone claiming to be a trusted sender', secrecy: 'a request to keep it secret', payment: 'a request to pay or send details' };
const said = (signals) => SIGNALS.filter((k) => signals[k]).map((k) => SIGNAL_WORDS[k]);

module.exports = { READS, ASK_TALK, assessText, SIGNALS, WARN_AT, CAUTION_AT, ASK, parse, levelOf, typeLabel, assess, said };
