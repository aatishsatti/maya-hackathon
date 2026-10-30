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
//   Calls (Calling API, user-initiated; docs read: developers.facebook.com/docs/whatsapp/cloud-api/calling and .../calling/user-initiated-calls):
//     Webhook change field "calls"; value.calls[] { id ("wacid..."), event: "connect" | "terminate", direction: "USER_INITIATED", from, to, timestamp,
//     session { sdp_type, sdp } (connect only, NEVER logged), and on terminate: status "COMPLETED" | "FAILED", start_time, end_time, duration (seconds), errors[] { code, message } }.
//     The docs' own samples disagree on whether `from` or `to` is the person, so the person is read from value.contacts[].wa_id, else whichever of from / to is not the business number.
//     Answer / refuse: POST {Version}/{Phone-Number-ID}/calls { messaging_product: "whatsapp", call_id, action } with action one of connect | pre_accept | accept | reject | terminate
//     (accept / pre_accept also carry session { sdp_type, sdp } with the answer SDP) -> { messaging_product, success: true }. The business has about 30 to 60 seconds to answer.
//     Enabling: POST {Version}/{Phone-Number-ID}/settings { calling: { status: "ENABLED", call_icon_visibility: "DEFAULT", callback_permission_status: "ENABLED" } }.
//     Terminate error codes (call setup, in the terminate webhook): 138019 call setup failed, 138020 relay connection failed, 138021 / 138022 media receive / transmit timeout,
//     138023 accepted with no media; send-side: 138000 calling not enabled, 138013 / 138014 / 138015 / 138018 the number cannot take calls, 131044 no valid payment method.
//   Calls today (wacall.js signalling + media, wabridge.js, waears.js): a call from a linked, opted-in person is ANSWERED and handed to the app's own Call (call.js): she
//   greets (her own written greeting), listens through the same Meta transcribe engine, answers, files memory and runs the scam shield and family flow exactly as in the
//   app. Order: pre_accept, media connects, the greeting is made while the phone still rings, accept, conversation, terminate (after her goodbye, the 10-minute cap, a fatal
//   error with one fixed line) or the caller / phone ends it (the terminate webhook; its status and error code give the end reason). Every other call is REFUSED
//   (action "reject"): an unlinked or opted-out number, no SDP offer, another call being answered, or a live in-app call for the same person. Logs: counts and times,
//   never the SDP or a word.
// Server env only (never in the repo, the page or a log): WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID.
// Privacy: message words are never logged and never stored here. This file keeps only: which phone belongs to which profile, whether they opted in,
// when they last wrote (for the 24 h window) and recent message ids (so a Meta retry is not answered twice).
// Not built in this step (by design): PSTN, closed-phone ringing, video, groups.
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
const MAX_INBOUND_IMAGE = 8 * 1024 * 1024; // the same ceiling as a photo sent in the app (server.js MAX_IMAGE_BYTES); WhatsApp itself stops at 5 MB
const MAX_INBOUND_AUDIO = 2 * 1024 * 1024; // a long monologue is not worth a minute of Transcribe; ~2 MB of Opus is several minutes

// Network edge, replaceable in tests.
const deps = { fetch: (...a) => globalThis.fetch(...a), answerCall: (o) => require('./wacall').answerWithBridge(o), newCall: (socket, apiKey) => new (require('./call').Call)(socket, apiKey), callTailMs: undefined, callCapMs: undefined, callOut: (o) => require('./wacall').callOut(o), testRingCapMs: undefined, testTailMs: undefined, testCooldownMs: undefined };

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
  return { linked: true, configured: configured(), phoneEnd: l.phone.slice(-4), optIn: l.optIn, windowOpen: open, windowEndsAt: open ? l.lastInboundAt + WINDOW_MS : null, lastSent: last ? { at: last.at, kind: last.kind, via: last.via, status: last.status, error: last.error } : null, testCall: testCalls.get(profileId) || null };
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

// One line for EVERY webhook POST that reaches the server, before any check can drop it: size, whether Meta sent a signature, whether our secret is set, whether it matches. No body, no words, no numbers.
function noteArrival(raw, header) {
  const sig = /^sha256=[0-9a-f]{64}$/i.test(String(header || '')) ? 'present' : header ? 'malformed' : 'missing';
  note(`webhook POST arrived: ${raw.length} bytes, X-Hub-Signature-256 ${sig}, WHATSAPP_APP_SECRET ${process.env.WHATSAPP_APP_SECRET ? 'set' : 'NOT SET'}, signature ${validSignature(raw, header) ? 'valid' : 'INVALID'}`);
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
async function downloadMedia(id, { max = MAX_INBOUND_AUDIO, tooBig = 'That voice note is too long.' } = {}) {
  if (!/^[\w-]{1,100}$/.test(String(id))) throw new WaError('Bad media id.', 400);
  const meta = await graphGet(`${GRAPH}/${API_VERSION()}/${id}`);
  if (!meta || typeof meta.url !== 'string' || !/^https:\/\//.test(meta.url)) throw new WaError('WhatsApp gave no download link.');
  if (Number(meta.file_size) > max) throw new WaError(tooBig, 413);
  const buf = await graphGet(meta.url, true);
  if (buf.length > max) throw new WaError(tooBig, 413);
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
async function sendUploadedAudio(to, id) {
  const d = await graph(`${process.env.WHATSAPP_PHONE_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'audio', audio: { id, voice: true } });
  return d && d.messages && d.messages[0] ? d.messages[0].id : null;
}
async function sendAudioTo(to, ogg) { return sendUploadedAudio(to, await uploadAudio(ogg)); }
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
      const spoken = who === 'family' ? FAMILY_PREFIX + words : words;
      try { pcm = await chat.deps.speak(spoken); note(`voice note made: ${spoken.length} characters sent to speech, ${(pcm.length / 48000).toFixed(1)} s of audio`); } catch (e) { throw new OutError(`Maya's voice could not be made (${e.message}). Nothing was sent; you can send it as text instead.`, 502); }
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
  return require('./care').reminderStatus(st.id, st.status, st.errors); // a reminder we sent: delivered / read / failed come from WhatsApp's own status, never guessed
}

// ---- Reminders (care.js asks for them; the family wrote them on the dashboard) ----
// Delivered like any message from Maya, INSIDE the 24 h window only for now (outside it WhatsApp needs an approved template: the next phase), as a voice note in her voice
// (the default) or as text, per person. The words are the family's own task and nothing of Maya's: no advice, no dose, no extra. Only a result WITH a WhatsApp message id is "sent".
const REMINDER_CAP = 30;   // reminder messages per person per rolling 24 h (a loop or a flood must stop somewhere)
const endPunct = (t) => String(t || '').trim().replace(/[\s.!?,;:]+$/, '');
function reminderWords(task, nudge) {
  const { isFamilyMessage, stripAddressee } = require('./call');
  const message = isFamilyMessage(task), shown = endPunct(message ? task : stripAddressee(task));
  const what = message ? 'message' : 'reminder';
  if (nudge) return { text: `Just checking that you saw this ${what} from your family: ${shown}. Reply when you have seen it.`, spoken: `Just checking that you saw this ${what} from your family: ${shown}. Reply when you have seen it.` };
  return { text: `A ${what} from your family: ${shown}. Reply when you have seen this.`, spoken: `A ${what} from your family: ${shown}. Reply when you have seen this.` };
}
async function sendReminder(profileId, { task, nudge = false } = {}) {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  const l = linkOf(profileId);
  if (!l || !l.optIn) return { ok: false, reason: 'not_linked' };
  const now = Date.now();
  if (!(l.lastInboundAt && now - l.lastInboundAt < WINDOW_MS)) return { ok: false, reason: 'window_closed' };
  const today = (l.remSent || []).filter((t) => now - t < WINDOW_MS);
  if (today.length >= REMINDER_CAP) return { ok: false, reason: 'daily_cap' };
  update(profileId, (x) => { x.remSent = [...today, now]; });   // the slot is taken BEFORE the network call
  const w = reminderWords(task, nudge);
  const care = require('./care'); let voiceFailed = false;
  if (((care.get(profileId) || {}).delivery || {}).reminders !== 'text') {
    // Where a voice note fails is named (never why in words, never a word of the reminder): speech (the voice could not be made), encode, too_long (too big for the play icon),
    // upload (WhatsApp refused the file) or send (WhatsApp refused the message), with WhatsApp's own error code when it gave one. Then it goes as text, and says so.
    let stage = 'speech';
    try {
      const pcm = await chat.deps.speak(w.spoken); stage = 'encode';
      const ogg = oggopus.encode(pcm, 24000);
      if (ogg.length > oggopus.MAX_PLAY_BYTES) { stage = 'too_long'; throw new Error('too long to play'); }
      stage = 'upload'; const mediaId = await uploadAudio(ogg);
      stage = 'send'; const wamid = await sendUploadedAudio(l.phone, mediaId);
      return wamid ? { ok: true, via: 'voice', wamid } : { ok: false, reason: 'no_id' };
    } catch (e) { voiceFailed = true; console.log('reminder', JSON.stringify({ event: 'voice failed', stage, code: Number(e && e.code) || null, then: 'text' })); }
  }
  try { const wamid = await sendTextTo(l.phone, w.text); return wamid ? { ok: true, via: 'text', wamid, voiceUnavailable: voiceFailed } : { ok: false, reason: 'no_id' }; }
  catch (e) { return { ok: false, reason: 'meta_error', error: { code: e.code || null, title: String(e.message).replace(/^WhatsApp refused it \(\d+\): /, '').slice(0, 120) } }; }
}
require('./care').setReminderSender({ channelFor: (profileId) => { const l = linkOf(profileId); return configured() && l && l.optIn ? 'whatsapp' : null; }, send: sendReminder });

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
  require('./care').reminderAckWhatsApp(l.profileId, require('./call').isAck(msg.text.body)); // a reply to a reminder: answered if it reads as an acknowledgement (judged in memory, the words are never kept here)
  const care = require('./care');
  let r;
  try { r = await care.withTurnChannel(l.profileId, 'whatsapp', () => chat.sendText(l.profileId, msg.text.body, null, { source: 'whatsapp' })); } // the reply knows about a reminder in flight (call.js reminderFacts)
  finally { care.consumeAck(l.profileId); }   // this message is over: the next one is not "the one that answered it"
  logReplyFacts(l.profileId);
  const reply = [...r.messages].reverse().find((m) => m.role === 'maya');
  if (!reply || !reply.text) throw new WaError('Maya had no reply.');
  await sendTextTo(l.phone, mayaWords(reply.text));
}
// Which KINDS of fact Maya was given for a WhatsApp reply, by name only (call.js sets chat.sessions.get(id).factLabels): never a fact, never a word.
function logReplyFacts(profileId) {
  const s = chat.sessions.get(profileId), labels = (s && s.factLabels) || [];
  if (labels.length) console.log('reply facts', JSON.stringify({ source: 'whatsapp', labels, turns: 1 }));
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
  const care = require('./care');
  try {
    // The words are judged the moment they are transcribed and BEFORE the reply is written (chat.js onWords), exactly like typed text: a spoken "okay" answers the reminder and Maya is told so.
    r = await care.withTurnChannel(l.profileId, 'whatsapp', () => chat.sendVoiceNote(l.profileId, wav, null, { source: 'whatsapp', onWords: (words) => care.reminderAckWhatsApp(l.profileId, require('./call').isAck(words)) }));
    logReplyFacts(l.profileId);
  }
  catch (e) { if (e.status === 422) { await sendTextTo(l.phone, 'I could not hear any words in that voice note. Could you try again, or type it for me?'); return 'unheard'; } throw e; }
  finally { care.consumeAck(l.profileId); }   // this note is over: the next message is not "the one that answered it"
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

// A photo in -> the same chat.sendImage the app uses (vision description + scam check + official-source look-up + family flow) -> Maya's words back as text.
// Every failure is answered in plain words: a photo is never met with silence, and nothing is guessed about what it showed.
const PHOTO_NOT_SEEN = 'I could not see that photo. Could you send it again?';
const PHOTO_NOT_READ = 'I could not read that file as a photo. Please send it again.';
async function onImage(l, msg) {
  const im = msg.image || {};
  let buf;
  try { if (typeof im.id !== 'string') throw new WaError('The photo had no media id.'); buf = await downloadMedia(im.id, { max: MAX_INBOUND_IMAGE, tooBig: 'That photo is too big.' }); }
  catch (e) { note(`could not download a photo from number ending ${end(msg.from)}: ${e.message}`); await sendTextTo(l.phone, PHOTO_NOT_SEEN); return 'unseen'; }
  require('./care').touch(l.profileId, 'whatsapp'); // chat.sendImage records the 'app' door; this is the WhatsApp door (text and voice do it through opts.source)
  let r;
  try { r = await chat.sendImage(l.profileId, buf, typeof im.caption === 'string' ? im.caption : '', null); }
  catch (e) {
    note(`could not answer a photo from number ending ${end(msg.from)}: ${e.message}`); // the error text only: no caption, no image
    await sendTextTo(l.phone, e.status === 415 ? PHOTO_NOT_READ : PHOTO_NOT_SEEN);
    return e.status === 415 ? 'unreadable' : 'unseen';
  }
  const reply = [...r.messages].reverse().find((m) => m.role === 'maya');
  if (!reply || !reply.text) throw new WaError('Maya had no reply.');
  await sendTextTo(l.phone, mayaWords(reply.text));
  note(`answered a photo from number ending ${end(msg.from)}`);
  return 'image';
}

// The shape of a message object: its field names, two levels deep, sorted, e.g. button{payload,text},context{from,id},from,id,timestamp,type. Names only: a value never appears.
const safeKey = (k) => /^[A-Za-z0-9_]{1,40}$/.test(k);
const typeName = (t) => (/^[a-z_]{1,30}$/.test(String(t)) ? String(t) : 'unknown');   // a message type is a short lower-case name; anything else is not printed
function shapeOf(o, depth = 2) {
  if (Array.isArray(o)) return o.length && depth > 0 ? `[${shapeOf(o[0], depth - 1)}]` : '[]';
  if (!o || typeof o !== 'object') return '';
  return Object.keys(o).filter((k) => safeKey(k) && o[k] !== undefined).sort().slice(0, 30).map((k) => { const v = o[k], inner = depth > 0 && v && typeof v === 'object' ? shapeOf(v, depth - 1) : ''; return !inner ? k : Array.isArray(v) ? `${k}${inner}` : `${k}{${inner}}`; }).join(',');
}

async function onMessage(msg) {
  const l = findByPhone(msg.from);
  if (!l) { note(`ignored a ${typeName(msg.type)} from number ending ${end(msg.from)}: no profile is linked to that number (it must be linked with its country code, digits only, exactly as WhatsApp shows it)`); return 'ignored'; } // unknown: no reply, so a stranger can never use Maya (or make her message them)
  if (!l.optIn) { note(`ignored a ${typeName(msg.type)} from number ending ${end(msg.from)}: that person has not opted in or has stopped messages`); return 'ignored'; }
  if (msg.type === 'interactive' && msg.interactive && msg.interactive.type === 'call_permission_reply') { note(`ignored a call permission reply from number ending ${end(msg.from)}: a WhatsApp system message after a call, nothing is sent back and the 24 h window is not opened by it`); return 'system'; }
  if ((l.seen || []).includes(msg.id)) { note(`ignored a repeated message from number ending ${end(msg.from)} (Meta retry)`); return 'duplicate'; }
  update(l.profileId, (x) => {
    x.lastInboundAt = Math.max(x.lastInboundAt || 0, Number(msg.timestamp) * 1000 || Date.now());
    x.seen = [...(x.seen || []), msg.id].slice(-SEEN_KEEP);
  });
  note(`received a ${typeName(msg.type)} from number ending ${end(msg.from)}${msg.type === 'interactive' ? ` (interactive type ${/^[a-z_]{1,40}$/.test(String(msg.interactive && msg.interactive.type)) ? msg.interactive.type : 'unknown'})` : ''}`); // the interactive type is an enum (button_reply, call_permission_reply ...), never the person's words
  if (msg.type === 'text' && msg.text && typeof msg.text.body === 'string') { await onText(l, msg); note(`replied to number ending ${end(msg.from)}`); return 'text'; }
  if (msg.type === 'audio') { const out = await onAudio(l, msg); note(`answered a voice note from number ending ${end(msg.from)} (${out})`); return out; }
  if (msg.type === 'image') return onImage(l, msg);
  // Documents, stickers, locations and anything else not read here. The log says what SHAPE it had (field names only, never a value), so a type nobody has seen yet (for example the tap
  // on a template's quick-reply button) shows its real structure the first time it arrives, and it is built from that, not guessed.
  note(`unhandled incoming message from number ending ${end(msg.from)}: type ${typeName(msg.type)}, fields [${shapeOf(msg)}]`);
  // Documents, stickers, locations: not read here. Answered once, truthfully, never guessed at.
  await sendTextTo(l.phone, 'I can read your typed messages and listen to voice notes here. Please type it or send a voice note.');
  return 'unsupported';
}

// ---- calls: the linked person's call is answered by the Call, everyone else's is refused ----
// The person's number for a call: contacts[].wa_id, else whichever of from / to is not the business number (the docs' samples disagree on the direction).
function callerOf(value, call) {
  const biz = cleanPhone(value.metadata && value.metadata.display_phone_number);
  const c = (value.contacts || []).find((x) => x && typeof x.wa_id === 'string');
  if (c) return cleanPhone(c.wa_id);
  for (const k of [call.from, call.to]) { const d = cleanPhone(k); if (d && d !== biz) return d; }
  return null;
}
// Call ids are base64 ("wacid....==") so their last characters say nothing: a short hash tells two calls apart without showing the id.
const callTag = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 6);
// Why a call ended, from its terminate webhook (docs: status COMPLETED | FAILED; errors[].code; the troubleshooting page names 138019 call setup failed, 138020 relay connection
// failed, 138021 media receive timeout (the phone got no media for a long time), 138022 media transmit timeout, 138023 accepted with no media signals).
const CALL_ERRORS = { 138019: 'call setup failed', 138020: 'relay connection failed', 138021: 'media receive timeout', 138022: 'media transmit timeout', 138023: 'accepted with no media signals' };
function endReason(call) {
  const code = Array.isArray(call.errors) && call.errors[0] ? Number(call.errors[0].code) : 0;
  if (code) return `the phone ended the call (error ${code}${CALL_ERRORS[code] ? `: ${CALL_ERRORS[code]}` : ''})`;
  return call.status === 'FAILED' ? 'the call failed (no error code given)' : 'caller hung up';
}
const liveEnds = new Map(); // call id -> function that tells the answerer the CALLER hung up (the terminate webhook)
const outboundNow = { cur: null }; // the ONE outbound test call in flight: { id (null until Meta names it), sig, profileId }
const testCalls = new Map();      // profile id -> { state, at } of the last test call (a label and a time, never a word or a number)
let lastTestAt = 0;
const callsSeen = []; let callBusy = false; // one answered call at a time; a Meta retry of a connect is not answered twice
const callAction = (callId, action, session) => graph(`${process.env.WHATSAPP_PHONE_ID}/calls`, { messaging_product: 'whatsapp', call_id: callId, action, ...(session ? { session } : {}) });
const sayWhy = (e) => String(e && e.message).replace(/\s+/g, ' ').slice(0, 200); // an error message only; it never holds the SDP (nothing here puts one in a message)
// Logs the event by FIELD NAMES only (never the SDP, a number, a call id or a word). A linked, opted-in caller is answered (the Call); everyone else is refused so the phone does not ring for a minute.
// The outbound test call this webhook item belongs to: its id once known, or the first item after the connect POST (Meta can name the call in a webhook before our POST has returned).
function outboundOf(id) {
  const o = outboundNow.cur; if (!o) return null;
  if (o.id === null) { o.id = id; liveEnds.set(id, (why) => o.sig.emit('end', why)); }
  return o.id === id ? o : null;
}
async function onCalls(value) {
  const out = [];
  for (const st of value.statuses || []) {   // the lifecycle of OUR call: RINGING, ACCEPTED, REJECTED (docs: statuses[] { id, type: "call", status, recipient_id, timestamp })
    if (!st || typeof st.id !== 'string' || st.type !== 'call') continue;
    const o = outboundOf(st.id);
    if (o) { o.sig.emit('status', String(st.status)); out.push('status'); } else { note(`ignored a call status (${/^[A-Z_]{1,20}$/.test(String(st.status)) ? st.status : 'unknown'}) for call ${callTag(st.id)}: no test call is waiting for it`); out.push('ignored'); }
  }
  for (const call of value.calls || []) {
    if (!call || typeof call.id !== 'string') continue;
    const who = callerOf(value, call), tail = who ? end(who) : 'unknown', cid = callTag(call.id);
    if (call.event === 'terminate') {
      const er = Array.isArray(call.errors) && call.errors[0] ? `, error ${Number(call.errors[0].code) || 'unknown'}` : '';
      if (call.direction === 'BUSINESS_INITIATED') outboundOf(call.id);
      const hangUp = liveEnds.get(call.id); if (hangUp) hangUp(endReason(call)); // an answered call: tell the answerer to stop listening, and why the call ended
      note(`call ended: number ending ${tail}, call ${cid}, status ${String(call.status).slice(0, 12)}, duration ${Number(call.duration) || 0} s${er}`);
      out.push('ended'); continue;
    }
    if (call.event === 'connect' && call.direction === 'BUSINESS_INITIATED') {   // the SDP ANSWER to our offer (session { sdp_type: "answer", sdp }; the SDP is never logged)
      const o = outboundOf(call.id), sdp = call.session && call.session.sdp_type === 'answer' && typeof call.session.sdp === 'string' ? call.session.sdp : null;
      if (o && sdp) { note(`outbound call ${cid}: Meta's SDP answer arrived`); o.sig.emit('answer', sdp); out.push('outbound-answer'); continue; }
    }
    if (call.event !== 'connect' || call.direction !== 'USER_INITIATED') { note(`ignored a call event (${String(call.event).slice(0, 20)}, ${String(call.direction).slice(0, 20)}) for call ${cid}`); out.push('ignored'); continue; }
    note(`call connect: ${call.direction} from number ending ${tail}, call ${cid}, fields [${Object.keys(call).sort().join(', ')}], session [${call.session && typeof call.session === 'object' ? Object.keys(call.session).sort().join(', ') : 'none'}]`);
    if (callsSeen.includes(call.id)) { note(`ignored a repeated connect for call ${cid} (Meta retry)`); out.push('duplicate'); continue; }
    callsSeen.push(call.id); if (callsSeen.length > 20) callsSeen.shift();
    const l = who ? findByPhone(who) : null;
    let why = !l ? 'no profile is linked to that number' : !l.optIn ? 'that person has not opted in or has stopped messages' : null;
    const offer = call.session && call.session.sdp_type === 'offer' && typeof call.session.sdp === 'string' ? call.session.sdp : null;
    if (!why && !offer) why = 'the call carried no SDP offer';
    if (!why && callBusy) why = 'another call is being answered';
    if (!why && require('./care').liveCalls.has(l.profileId)) why = 'that person is already in a call in the app';
    if (!why) {
      callBusy = true;
      let hungUp; const ended = new Promise((r) => { hungUp = r; }); liveEnds.set(call.id, hungUp);
      try {
        const r = await deps.answerCall({ offerSdp: offer, speak: (t) => chat.deps.speak(t), newCall: deps.newCall, apiKey: process.env.META_API_KEY, profileId: l.profileId, tz: require('./care').get(l.profileId) ? require('./care').get(l.profileId).tz : null, ended, tailMs: deps.callTailMs, capMs: deps.callCapMs, send: (action, session) => callAction(call.id, action, session), log: (m) => note(`call ${cid} with number ending ${tail}: ${m}`) });
        note(`answered call ${cid} from number ending ${tail}: conversation, ${r}`); out.push('answered');
      } catch (e) { note(`could NOT answer call ${cid} from number ending ${tail}: ${sayWhy(e)}`); out.push('answer-failed'); }
      finally { callBusy = false; liveEnds.delete(call.id); }
      continue;
    }
    try { await callAction(call.id, 'reject'); note(`rejected call ${cid} from number ending ${tail}: ${why}`); out.push('rejected'); }
    catch (e) { note(`could NOT reject call ${cid} from number ending ${tail}: ${e.message}`); out.push('reject-failed'); }
  }
  return out;
}

// The family page's "Call them now (test)": ONE outbound call to the linked, opted-in person that says a fixed sentence and hangs up (wacall.callOut). Resolves when Meta has taken the
// call (the phone is about to ring) with { placed: true }; the rest (ringing, answered, ended) runs on and is logged and kept as a label in view().testCall. Throws if nothing was placed.
const TEST_COOLDOWN_MS = 60000;
function setTest(profileId, state) { testCalls.set(profileId, { state, at: Date.now() }); }
function placeTestCall(profileId) {
  const l = linkOf(profileId);
  const fail = (m, status) => Promise.reject(new WaError(m, status));
  if (!l) return fail('Link their WhatsApp number first.', 400);
  if (!l.optIn) return fail('They have stopped messages from Maya, so no call is placed.', 400);
  if (!configured()) return fail('WhatsApp is not set up on this server.', 503);
  if (callBusy || outboundNow.cur) return fail('Another call is in progress. Nothing was placed.', 409);
  if (require('./care').liveCalls.has(profileId)) return fail('They are in a call in the app right now. Nothing was placed.', 409);
  if (Date.now() - lastTestAt < (deps.testCooldownMs === undefined ? TEST_COOLDOWN_MS : deps.testCooldownMs)) return fail('A test call was just placed. Wait a minute before another. Nothing was placed.', 429);
  callBusy = true; lastTestAt = Date.now();
  const tail = end(l.phone), sig = new (require('node:events'))(), cur = { id: null, sig, profileId }; outboundNow.cur = cur;
  let cid = 'unknown'; const log = (m) => note(`test call ${cid} to number ending ${tail}: ${m}`);
  setTest(profileId, 'starting');
  return new Promise((resolve, reject) => {
    const place = async (session) => {
      const d = await graph(`${process.env.WHATSAPP_PHONE_ID}/calls`, { messaging_product: 'whatsapp', to: l.phone, action: 'connect', session });
      const viaCalls = d && Array.isArray(d.calls) && d.calls[0] && d.calls[0].id, id = d && (viaCalls || d.call_id);
      note(`test call to number ending ${tail}: connect response fields [${shapeOf(d)}], call id ${viaCalls ? 'from calls[0].id' : id ? 'from call_id' : 'not in the response (taken from the first webhook)'}`); // names only, never a value: shows the real shape of Meta's answer
      if (typeof id === 'string' && id) { if (cur.id === null) { cur.id = id; liveEnds.set(id, (why) => sig.emit('end', why)); } cid = callTag(id); }
      else if (cur.id) cid = callTag(cur.id);
      setTest(profileId, 'requested'); resolve({ placed: true });
    };
    const terminate = async () => { if (!cur.id) throw new Error('Meta has not named the call, so it cannot be hung up by id'); await callAction(cur.id, 'terminate'); };
    const label = { RINGING: 'ringing', ACCEPTED: 'answered', REJECTED: 'rejected' };
    sig.on('status', (s) => { if (label[s]) setTest(profileId, label[s]); });
    Promise.resolve().then(() => deps.callOut({ sig, place, terminate, log, speak: (t) => chat.deps.speak(t), ringCapMs: deps.testRingCapMs, tailMs: deps.testTailMs }))
      .then((r) => { setTest(profileId, /^no answer/.test(r) ? 'no answer' : r === 'rejected' ? 'rejected' : r === 'completed' ? 'completed' : 'ended'); note(`test call ${cid} to number ending ${tail}: finished, ${r}`); })
      .catch((e) => { setTest(profileId, 'failed'); note(`test call ${cid} to number ending ${tail}: FAILED, ${sayWhy(e)}`); reject(e instanceof WaError ? e : new WaError(sayWhy(e), 502)); })
      .finally(() => { callBusy = false; if (cur.id) liveEnds.delete(cur.id); outboundNow.cur = null; });
  });
}

// Called by server.js after it answered 200. Never throws; errors are logged as a message only (no words, no numbers).
async function handleWebhook(payload) {
  const done = [];
  if (!payload || payload.object !== 'whatsapp_business_account') { note(`ignored a webhook POST: object is not whatsapp_business_account`); return done; }
  for (const e of payload.entry || []) for (const c of e.changes || []) {
    if (c.field === 'calls' && c.value) {
      const cp = c.value.metadata && c.value.metadata.phone_number_id;
      if (cp && process.env.WHATSAPP_PHONE_ID && cp !== process.env.WHATSAPP_PHONE_ID) { note('ignored a calls webhook for a different phone number id than WHATSAPP_PHONE_ID'); continue; }
      done.push(onCalls(c.value).catch((err) => { console.error('whatsapp calls error:', err.message); return 'error'; }));
      continue;
    }
    if (c.field !== 'messages' || !c.value) { note(`ignored a webhook change for field ${String(c.field).slice(0, 40)} (only 'messages' and 'calls' are read)`); continue; }
    note(`webhook change: field messages, phone id ending ${end(c.value.metadata && c.value.metadata.phone_number_id)}, ${(c.value.messages || []).length} message(s), ${(c.value.statuses || []).length} status update(s)`);
    const pid = c.value.metadata && c.value.metadata.phone_number_id;
    if (pid && process.env.WHATSAPP_PHONE_ID && pid !== process.env.WHATSAPP_PHONE_ID) { note('ignored a webhook for a different phone number id than WHATSAPP_PHONE_ID'); continue; } // meant for another number
    for (const st of c.value.statuses || []) { try { onStatus(st); } catch (err) { console.error('whatsapp status error:', err.message); } }
    for (const msg of c.value.messages || []) {
      if (!msg || typeof msg.from !== 'string' || typeof msg.id !== 'string') continue;
      done.push(serial(msg.from, () => onMessage(msg)).catch((err) => { console.error('whatsapp error:', err.message); return 'error'; }));
    }
  }
  return (await Promise.all(done)).flat(); // calls answer with one result per call
}

module.exports = { sendReminder, reminderWords, REMINDER_CAP, note, deps, configured, link, unlink, view, linkOf, findByPhone, cleanPhone, verifyChallenge, validSignature, noteArrival, handleWebhook, sendOut, onStatus, OutError, placeTestCall, FAMILY_PREFIX, sendTextTo, sendAudioTo, downloadMedia, mayaWords, NO_CALL_LINE, WaError, WINDOW_MS };
