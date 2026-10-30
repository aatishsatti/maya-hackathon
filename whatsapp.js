// WhatsApp door to the same Maya (Feature 6, prototype steps 1 text, 2 voice notes and 3 outgoing from the dashboard). Not a second bot: an incoming text goes through chat.sendText, so it
// uses the same Spark brain, profile memory, scam rules, family question and dashboard flag as the app chat. Only the door differs.
// Docs read at build time (developers.facebook.com/documentation/business-messaging/whatsapp):
//   Webhook verify (GET): query hub.mode=subscribe, hub.verify_token (our own string), hub.challenge. Valid -> 200 and the challenge echoed as the body;
//     anything else -> a non-200 (we send 403).
//   Webhook POST: header X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, the JSON body). The docs do not say raw or re-serialized bytes; we
//     hash the RAW body exactly as received (any change to the bytes changes the hash). Answer 200 fast, work afterwards.
//   Incoming text: body.object "whatsapp_business_account"; entry[].changes[].field "messages"; value.metadata.phone_number_id; value.messages[]
//     { from (wa id, digits), id (wamid...), timestamp, type: "text", text: { body } }; value.statuses[] { id, status, recipient_id, errors? }.
//   Send (POST https://graph.facebook.com/{Version}/{Phone-Number-ID}/messages, Authorization: Bearer <token>):
//     { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } }  -> { messages: [{ id }] }
//   Media (step 2): GET {Version}/{MEDIA_ID} with the bearer token -> { url, mime_type, file_size }; the url (valid 5 minutes) is then fetched with the SAME bearer token.
//     Upload: POST {Version}/{Phone-Number-ID}/media, multipart: messaging_product=whatsapp, file (type "audio/ogg; codecs=opus") -> { id } (kept 30 days).
//     Send a voice note: { messaging_product, recipient_type, to, type: "audio", audio: { id, voice: true } }. Voice notes must be mono Ogg/Opus (oggopus.js);
//     the play icon shows only up to 512 KB. Incoming voice note: type "audio", audio.id and audio.mime_type ("audio/ogg; codecs=opus"). The pages read did not
//     list the other inbound audio fields, so only id and mime_type are used.
//   Outgoing rules (step 3): the 24 h "customer service window" opens when the person writes and resets with each message they send; only then may free-form
//     text or audio be sent. Outside it ONLY a pre-approved template can be sent (type "template", template.name, template.language.code; components only when the
//     template has variables); Meta answers a free-form send outside the window with error 131047. The one template Meta pre-creates is "hello_world" / "en_US".
//     Template name and language are WHATSAPP_TEMPLATE_NAME / WHATSAPP_TEMPLATE_LANG in the server env (a template with variables is not supported here).
//   Status webhook: value.statuses[] { id (the wamid we sent), status: sent | delivered | read | failed, recipient_id, errors?: [{ code, title }] }.
//   The Graph API version is not named on the pages read: WHATSAPP_API_VERSION in the server env, default below, change it there if Meta retires it.
// Server env only (never in the repo, the page or a log): WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID.
// Privacy: message words are never logged and never stored here. This file keeps only: which phone belongs to which profile, whether they opted in,
// when they last wrote (for the 24 h window) and recent message ids (so a Meta retry is not answered twice).
// Not built in this step (by design): live WhatsApp calls, PSTN, closed-phone ringing, video, groups.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const chat = require('./chat');
const oggopus = require('./oggopus');
const memory = require('./memory');

const DIR = () => process.env.MAYA_WA_DIR || path.join(__dirname, 'data', 'whatsapp'); // env override is for tests
const API_VERSION = () => (/^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION || '') ? process.env.WHATSAPP_API_VERSION : 'v26.0'); // v26.0 is the version the Graph API Explorer send that worked used; WHATSAPP_API_VERSION overrides
const GRAPH = 'https://graph.facebook.com';
const SEEN_KEEP = 50;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const OUT_MIN_GAP_MS = 10 * 1000;      // never two sends within 10 s
const OUT_MAX_PER_DAY = 10;            // free-form + template, rolling 24 h, per person: a family cannot flood one phone
const OUT_MAX_TEMPLATES_PER_DAY = 2;   // an invitation to reply is not repeated
const OUT_KEEP = 30;
const MAX_INBOUND_AUDIO = 2 * 1024 * 1024; // a long monologue is not worth a minute of Transcribe; ~2 MB of Opus is several minutes

// Network edge, replaceable in tests.
const deps = { fetch: (...a) => globalThis.fetch(...a) };

const configured = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

// ---- links: phone <-> profile, opt-in, window ----
const linkFile = () => path.join(DIR(), 'links.json');
function readLinks() { try { return JSON.parse(fs.readFileSync(linkFile(), 'utf8')); } catch { return {}; } }
function writeLinks(all) {
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = `${linkFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, linkFile());
}
const cleanPhone = (v) => { const d = String(v == null ? '' : v).replace(/[^\d]/g, ''); return /^\d{8,15}$/.test(d) ? d : null; };
const linkOf = (profileId) => readLinks()[profileId] || null;
function findByPhone(phone) {
  const d = cleanPhone(phone);
  if (!d) return null;
  const all = readLinks();
  const id = Object.keys(all).find((k) => all[k].phone === d);
  return id ? { profileId: id, ...all[id] } : null;
}
// The family links a phone to ONE profile and says the person agreed to hear from Maya there (opt-in). A phone can belong to one profile only.
function link(profileId, phone, optIn) {
  if (!memory.load(profileId)) throw Object.assign(new Error('Not found'), { status: 404 });
  const d = cleanPhone(phone);
  if (!d) throw Object.assign(new Error('Please enter the WhatsApp number with its country code, digits only.'), { status: 400 });
  if (optIn !== true) throw Object.assign(new Error('The person must have agreed to messages from Maya on WhatsApp. Tick the box once they have.'), { status: 400 });
  const all = readLinks();
  const other = Object.keys(all).find((k) => k !== profileId && all[k].phone === d);
  if (other) throw Object.assign(new Error('That number already belongs to someone else.'), { status: 409 });
  const old = all[profileId] || {};
  all[profileId] = { phone: d, optIn: true, optInAt: Date.now(), optOutAt: null, lastInboundAt: old.phone === d ? old.lastInboundAt || null : null, seen: old.phone === d ? old.seen || [] : [], sent: old.phone === d ? old.sent || [] : [] };
  writeLinks(all);
  return view(profileId);
}
function unlink(profileId) { const all = readLinks(); if (!all[profileId]) return false; delete all[profileId]; writeLinks(all); return true; }
function update(profileId, fn) { const all = readLinks(); if (!all[profileId]) return null; fn(all[profileId]); writeLinks(all); return all[profileId]; }
// What the dashboard may know: the state, never a message word.
function view(profileId) {
  const l = linkOf(profileId);
  if (!l) return { linked: false, configured: configured() };
  const open = Boolean(l.lastInboundAt && Date.now() - l.lastInboundAt < WINDOW_MS);
  const last = (l.sent || []).slice(-1)[0] || null;
  return { linked: true, configured: configured(), phoneEnd: l.phone.slice(-4), optIn: l.optIn, windowOpen: open, windowEndsAt: open ? l.lastInboundAt + WINDOW_MS : null, lastSent: last ? { at: last.at, kind: last.kind, via: last.via, status: last.status, error: last.error } : null };
}

// ---- webhook security ----
function verifyChallenge(query) {
  const want = process.env.WHATSAPP_VERIFY_TOKEN || '';
  const got = String(query.get('hub.verify_token') || '');
  const a = Buffer.from(got), b = Buffer.from(want);
  const ok = want && query.get('hub.mode') === 'subscribe' && a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? String(query.get('hub.challenge') || '') : null;
}
function validSignature(raw, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!secret || !m) return false;
  const mine = crypto.createHmac('sha256', secret).update(raw).digest();
  return crypto.timingSafeEqual(mine, Buffer.from(m[1], 'hex'));
}

// ---- Graph API calls ----
// Which token value this process really reads, without showing it: length, sha256 prefix (compare with `printf %s "$TOKEN" | shasum -a 256`), and stray whitespace / quote / 'Bearer ' flags.
function tokenShape() {
  const t = process.env.WHATSAPP_TOKEN || '';
  const odd = [t !== t.trim() && 'whitespace', /^["']|["']$/.test(t) && 'quotes', /^bearer\s/i.test(t) && 'Bearer-prefix'].filter(Boolean).join('+');
  return `token length ${t.length}, sha256 ${crypto.createHash('sha256').update(t).digest('hex').slice(0, 8)}${odd ? ', ODD: ' + odd : ''}`;
}
class WaError extends Error { constructor(msg, status, code) { super(msg); this.status = status || 502; this.code = code || null; } }
async function graph(pathPart, body) {
  if (!configured()) throw new WaError('WhatsApp is not set up on this server.', 503);
  let r;
  try {
    r = await deps.fetch(`${GRAPH}/${API_VERSION()}/${pathPart}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { throw new WaError(`WhatsApp could not be reached: ${e.message}`, 502); }
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  if (!r.ok) { const er = (d && d.error) || {}; throw new WaError(`WhatsApp refused it (${er.code || r.status}): ${er.message || 'no reason given'}`, 502, er.code || null); } // error text only, never the token
  return d;
}
async function sendTextTo(to, body) {
  const d = await graph(`${process.env.WHATSAPP_PHONE_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: String(body).slice(0, 4000) } });
  return d && d.messages && d.messages[0] ? d.messages[0].id : null;
}

// ---- media (voice notes) ----
async function graphGet(url, binary) {
  if (!configured()) throw new WaError('WhatsApp is not set up on this server.', 503);
  let r;
  try { r = await deps.fetch(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new WaError(`WhatsApp could not be reached: ${e.message}`, 502); }
  if (!r.ok) { let er = {}; try { er = (await r.json()).error || {}; } catch { /* not json */ } throw new WaError(`WhatsApp refused it (${er.code || r.status}): ${er.message || 'no reason given'}`, 502, er.code || null); }
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
}
async function downloadMedia(id) {
  if (!/^[\w-]{1,100}$/.test(String(id))) throw new WaError('Bad media id.', 400);
  const meta = await graphGet(`${GRAPH}/${API_VERSION()}/${id}`);
  if (!meta || typeof meta.url !== 'string' || !/^https:\/\//.test(meta.url)) throw new WaError('WhatsApp gave no download link.');
  if (Number(meta.file_size) > MAX_INBOUND_AUDIO) throw new WaError('That voice note is too long.', 413);
  const buf = await graphGet(meta.url, true);
  if (buf.length > MAX_INBOUND_AUDIO) throw new WaError('That voice note is too long.', 413);
  return buf;
}
async function uploadAudio(ogg) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([ogg], { type: 'audio/ogg; codecs=opus' }), 'maya.ogg');
  let r;
  try { r = await deps.fetch(`${GRAPH}/${API_VERSION()}/${process.env.WHATSAPP_PHONE_ID}/media`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, body: form, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new WaError(`WhatsApp could not be reached: ${e.message}`, 502); }
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  if (!r.ok || !d || !d.id) { const er = (d && d.error) || {}; throw new WaError(`WhatsApp refused the voice note (${er.code || r.status}): ${er.message || 'no reason given'}`, 502, er.code || null); }
  return d.id;
}
async function sendAudioTo(to, ogg) {
  const id = await uploadAudio(ogg);
  const d = await graph(`${process.env.WHATSAPP_PHONE_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'audio', audio: { id, voice: true } });
  return d && d.messages && d.messages[0] ? d.messages[0].id : null;
}
// Maya's WAV (24 kHz mono PCM16, chat.pcmToWav: a 44 byte header) -> a WhatsApp voice note. Null when it is too big for the play icon (the caller sends the words instead).
function wavToVoiceNote(wav) {
  const ogg = oggopus.encode(wav.subarray(44), 24000);
  return ogg.length <= oggopus.MAX_PLAY_BYTES ? ogg : null;
}

// ---- outgoing from the family dashboard (or Maya) ----
// Every send passes the same guards, in this order, and a refused send says exactly why (nothing is silently dropped or faked):
//   set up -> linked -> opted in -> not too soon / too many -> inside the 24 h window (free text or voice) or, outside it, an explicit template.
// Never a call: this module has no way to ring or call anyone; every message sent is of type text, audio or template.
// who: 'family' (the words are announced as the family's, never passed off as Maya's own) or 'maya' (her own words, no announcement).
class OutError extends Error { constructor(msg, status, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }
const FAMILY_PREFIX = 'A message from your family: ';
const templateCfg = () => (process.env.WHATSAPP_TEMPLATE_NAME ? { name: process.env.WHATSAPP_TEMPLATE_NAME, lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US' } : null);

function guardOut(l, now, kind, useTemplate) {
  if (!configured()) throw new OutError('WhatsApp is not set up on this server.', 503);
  if (!l) throw new OutError('This person has no WhatsApp number linked yet.', 409);
  if (!l.optIn) throw new OutError('This person has not agreed to (or has stopped) messages from Maya on WhatsApp, so nothing was sent.', 403);
  const day = (l.sent || []).filter((x) => now - x.at < WINDOW_MS);
  if (day.length && now - day[day.length - 1].at < OUT_MIN_GAP_MS) throw new OutError('That was too soon after the last one. Please wait a few seconds.', 429);
  if (day.length >= OUT_MAX_PER_DAY) throw new OutError('Enough messages for today. To avoid flooding their phone, please try again tomorrow.', 429);
  const open = Boolean(l.lastInboundAt && now - l.lastInboundAt < WINDOW_MS);
  if (open) return 'free';
  if (kind === 'voice') throw new OutError('They have not written to Maya on WhatsApp in the last 24 hours, and WhatsApp only allows a voice note inside that window. Nothing was sent.', 409, { windowClosed: true });
  const t = templateCfg() || { name: 'hello_world', lang: 'en_US' };
  if (!useTemplate) throw new OutError('They have not written to Maya on WhatsApp in the last 24 hours, so WhatsApp does not allow a free message yet. You can send a standard invitation to reply instead; your own words are not sent.', 409, { windowClosed: true, needsTemplate: true, template: t.name });
  if (day.filter((x) => x.via === 'template').length >= OUT_MAX_TEMPLATES_PER_DAY) throw new OutError('An invitation was already sent today. Please wait for them to reply.', 429);
  return 'template';
}

async function sendOutInner(profileId, { kind = 'text', text, who = 'family', useTemplate = false } = {}) {
  if (kind !== 'text' && kind !== 'voice') throw new OutError('Choose a text message or a voice note.', 400);
  if (who !== 'family' && who !== 'maya') throw new OutError('Bad sender.', 400);
  const l = linkOf(profileId);
  const way = guardOut(l, Date.now(), kind, useTemplate === true);
  const words = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (way === 'free' && !words) throw new OutError('Please type a message first.', 400);
  if (way === 'free' && CALL_CLAIM.test(words)) throw new OutError('WhatsApp messages cannot promise a call from here. Please rephrase.', 400);
  const via = way, sentAt = Date.now(), entry = { at: sentAt, kind: via === 'template' ? 'template' : kind, via, who, id: null, status: 'sending', error: null };
  update(profileId, (x) => { x.sent = [...(x.sent || []), entry].slice(-OUT_KEEP); }); // the slot is taken BEFORE the network call, so two quick requests cannot both pass the guard
  let id;
  try {
    if (way === 'template') {
      const t = templateCfg() || { name: 'hello_world', lang: 'en_US' };
      note(`template send: phone id ending ${end(process.env.WHATSAPP_PHONE_ID)}, api ${API_VERSION()}, template ${t.name}/${t.lang}, ${tokenShape()}`); // ids / names only: no token, no full number
      const d = await graph(`${process.env.WHATSAPP_PHONE_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: l.phone, type: 'template', template: { name: t.name, language: { code: t.lang } } });
      id = d && d.messages && d.messages[0] ? d.messages[0].id : null;
    } else if (kind === 'text') {
      id = await sendTextTo(l.phone, who === 'family' ? FAMILY_PREFIX + words : words);
    } else {
      let pcm;
      try { pcm = await chat.deps.speak(who === 'family' ? FAMILY_PREFIX + words : words); } catch (e) { throw new OutError(`Maya's voice could not be made (${e.message}). Nothing was sent; you can send it as text instead.`, 502); }
      const ogg = oggopus.encode(pcm, 24000);
      if (ogg.length > oggopus.MAX_PLAY_BYTES) throw new OutError('That is too long for a voice note. Please shorten it. Nothing was sent.', 400);
      id = await sendAudioTo(l.phone, ogg);
    }
  } catch (e) {
    update(profileId, (x) => { x.sent = (x.sent || []).filter((m) => m.at !== sentAt || m.status !== 'sending'); }); // nothing went out: the slot is given back
    throw e;
  }
  update(profileId, (x) => { const m = (x.sent || []).find((q) => q.at === sentAt && q.status === 'sending'); if (m) { m.id = id; m.status = 'sent'; } });
  return { sent: true, via, kind: via === 'template' ? 'template' : kind };
}

// The dashboard send, with one log line per attempt, per refusal and per Meta error: the last 4 digits and the reason, never the family's words.
async function sendOut(profileId, opts = {}) {
  const l = linkOf(profileId), to = l ? `number ending ${end(l.phone)}` : 'a profile with no linked number';
  note(`dashboard ${opts.kind || 'text'} send to ${to}${opts.useTemplate ? ' (invitation template requested)' : ''}`);
  try {
    const r = await sendOutInner(profileId, opts);
    note(`dashboard ${r.kind} sent to ${to} (${r.via})`);
    return r;
  } catch (e) {
    note(`dashboard send to ${to} NOT sent: ${e.message}`);
    throw e;
  }
}

// A Meta status for something we sent (sent / delivered / read / failed). Recorded as a status word and an error code only.
function onStatus(st) {
  if (!st || typeof st.id !== 'string' || typeof st.status !== 'string') return false;
  const all = readLinks();
  for (const pid of Object.keys(all)) {
    const m = (all[pid].sent || []).find((x) => x.id === st.id);
    if (!m) continue;
    const rank = { sent: 1, delivered: 2, read: 3 };
    if (st.status === 'failed') { m.status = 'failed'; const e = (st.errors || [])[0] || {}; m.error = { code: e.code || null, title: String(e.title || '').slice(0, 120) }; }
    else if (rank[st.status] && rank[st.status] > (rank[m.status] || 0)) m.status = st.status;
    writeLinks(all);
    return true;
  }
  return false;
}

// ---- Maya's words must be true about WhatsApp ----
// A text door cannot ring a phone or hold a live WhatsApp call. A reply that promises one is replaced by the plain truth.
const CALL_CLAIM = /\b(?:i(?:'| a)?m|i am|i(?:'| wi)ll|i will|let me|going to|gonna|i can|shall i|want me to|should i)\s+(?:be\s+)?(?:call(?:ing)?|ring(?:ing)?|phon(?:e|ing)|video[- ]?call(?:ing)?|dial(?:l?ing)?)\b|\bcalling you (?:now|right now|back|in a)|\bgive you a (?:call|ring)\b|\bi(?:'| wi)ll (?:be )?on the phone\b/i;
const NO_CALL_LINE = 'I cannot call you from WhatsApp. If you would like to talk out loud, open the Maya app and we can talk there.';
const mayaWords = (text) => (CALL_CLAIM.test(text) ? NO_CALL_LINE : text);

// ---- incoming ----
const queues = new Map(); // wa id -> promise chain: one message at a time per person, in order
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
  return next;
}
// One plain log line for every message that is dropped or handled, so a missing reply can be diagnosed from the Render log. Last 4 digits of the number and a reason only: never a message word.
const end = (p) => String(p).slice(-4);
const note = (what) => console.log(`whatsapp: ${what}`);
const STOP = /^\s*(stop|unsubscribe|opt[- ]?out|cancel messages)\s*[.!]?\s*$/i;

async function onText(l, msg) {
  if (STOP.test(msg.text.body)) {
    update(l.profileId, (x) => { x.optIn = false; x.optOutAt = Date.now(); });
    await sendTextTo(l.phone, 'Okay. I will not message you here again. You can still talk to me in the Maya app.'); // the one allowed reply: confirms the opt-out
    return;
  }
  const r = await chat.sendText(l.profileId, msg.text.body, null, { source: 'whatsapp' });
  const reply = [...r.messages].reverse().find((m) => m.role === 'maya');
  if (!reply || !reply.text) throw new WaError('Maya had no reply.');
  await sendTextTo(l.phone, mayaWords(reply.text));
}

// A voice note in -> Transcribe -> the same Maya (chat.sendVoiceNote: same scam rules, memory, family flow) -> a voice note out, same voice and tones as the app.
// If her voice cannot be made (or the note is too long to play), the same words go out as text: a real answer is never replaced by silence or a fake note.
async function onAudio(l, msg) {
  const a = msg.audio || {};
  if (typeof a.id !== 'string' || !/^audio\/ogg/i.test(String(a.mime_type || 'audio/ogg'))) { await sendTextTo(l.phone, 'I could not play that. Please send it again as a voice note, or type it for me.'); return 'unsupported'; }
  let wav;
  try { wav = chat.pcmToWav(await oggopus.decode(await downloadMedia(a.id), 24000)); }
  catch (e) { console.error('whatsapp voice note unreadable:', e.message); await sendTextTo(l.phone, 'I could not hear that voice note. Could you send it again, or type it for me?'); return 'unreadable'; }
  let r;
  try { r = await chat.sendVoiceNote(l.profileId, wav, null, { source: 'whatsapp' }); }
  catch (e) { if (e.status === 422) { await sendTextTo(l.phone, 'I could not hear any words in that voice note. Could you try again, or type it for me?'); return 'unheard'; } throw e; }
  const reply = [...r.messages].reverse().find((m) => m.role === 'maya');
  if (!reply || !reply.text) throw new WaError('Maya had no reply.');
  const words = mayaWords(reply.text);
  const file = reply.kind === 'voice' && words === reply.text && /([a-f0-9]{16}\.wav)$/.exec(reply.mediaUrl || '');
  const media = file && chat.readMedia(l.profileId, file[1]);
  let note = null;
  if (media) { try { note = wavToVoiceNote(media.data); } catch (e) { console.error('whatsapp voice reply encode failed:', e.message); } }
  if (!note) { await sendTextTo(l.phone, words); return 'text-reply'; }
  await sendAudioTo(l.phone, note);
  return 'voice';
}

async function onMessage(msg) {
  const l = findByPhone(msg.from);
  if (!l) { note(`ignored a ${msg.type} from number ending ${end(msg.from)}: no profile is linked to that number (it must be linked with its country code, digits only, exactly as WhatsApp shows it)`); return 'ignored'; } // unknown: no reply, so a stranger can never use Maya (or make her message them)
  if (!l.optIn) { note(`ignored a ${msg.type} from number ending ${end(msg.from)}: that person has not opted in or has stopped messages`); return 'ignored'; }
  if ((l.seen || []).includes(msg.id)) { note(`ignored a repeated message from number ending ${end(msg.from)} (Meta retry)`); return 'duplicate'; }
  update(l.profileId, (x) => {
    x.lastInboundAt = Math.max(x.lastInboundAt || 0, Number(msg.timestamp) * 1000 || Date.now());
    x.seen = [...(x.seen || []), msg.id].slice(-SEEN_KEEP);
  });
  note(`received a ${msg.type} from number ending ${end(msg.from)}`);
  if (msg.type === 'text' && msg.text && typeof msg.text.body === 'string') { await onText(l, msg); note(`replied to number ending ${end(msg.from)}`); return 'text'; }
  if (msg.type === 'audio') { const out = await onAudio(l, msg); note(`answered a voice note from number ending ${end(msg.from)} (${out})`); return out; }
  // Photos, documents, stickers, locations: not read here. Answered once, truthfully, never guessed at.
  await sendTextTo(l.phone, 'I can read your typed messages and listen to voice notes here. Please type it or send a voice note.');
  return 'unsupported';
}

// Called by server.js after it answered 200. Never throws; errors are logged as a message only (no words, no numbers).
async function handleWebhook(payload) {
  const done = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return done;
  for (const e of payload.entry || []) for (const c of e.changes || []) {
    if (c.field !== 'messages' || !c.value) continue;
    const pid = c.value.metadata && c.value.metadata.phone_number_id;
    if (pid && process.env.WHATSAPP_PHONE_ID && pid !== process.env.WHATSAPP_PHONE_ID) { note('ignored a webhook for a different phone number id than WHATSAPP_PHONE_ID'); continue; } // meant for another number
    for (const st of c.value.statuses || []) { try { onStatus(st); } catch (err) { console.error('whatsapp status error:', err.message); } }
    for (const msg of c.value.messages || []) {
      if (!msg || typeof msg.from !== 'string' || typeof msg.id !== 'string') continue;
      done.push(serial(msg.from, () => onMessage(msg)).catch((err) => { console.error('whatsapp error:', err.message); return 'error'; }));
    }
  }
  return Promise.all(done);
}

module.exports = { note, deps, configured, link, unlink, view, linkOf, findByPhone, cleanPhone, verifyChallenge, validSignature, handleWebhook, sendOut, onStatus, OutError, FAMILY_PREFIX, sendTextTo, sendAudioTo, downloadMedia, mayaWords, NO_CALL_LINE, WaError, WINDOW_MS };
