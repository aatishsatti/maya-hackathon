// WhatsApp door to the same Maya (Feature 6, prototype step 1: text). Not a second bot: an incoming text goes through chat.sendText, so it
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
//   The Graph API version is not named on the pages read: WHATSAPP_API_VERSION in the server env, default below, change it there if Meta retires it.
// Server env only (never in the repo, the page or a log): WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID.
// Privacy: message words are never logged and never stored here. This file keeps only: which phone belongs to which profile, whether they opted in,
// when they last wrote (for the 24 h window) and recent message ids (so a Meta retry is not answered twice).
// Not built in this step (by design): live WhatsApp calls, PSTN, closed-phone ringing, video, groups.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const chat = require('./chat');
const memory = require('./memory');

const DIR = () => process.env.MAYA_WA_DIR || path.join(__dirname, 'data', 'whatsapp'); // env override is for tests
const API_VERSION = () => (/^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION || '') ? process.env.WHATSAPP_API_VERSION : 'v23.0');
const GRAPH = 'https://graph.facebook.com';
const SEEN_KEEP = 50;
const WINDOW_MS = 24 * 60 * 60 * 1000;

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
  return { linked: true, configured: configured(), phoneEnd: l.phone.slice(-4), optIn: l.optIn, windowOpen: open, windowEndsAt: open ? l.lastInboundAt + WINDOW_MS : null };
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

async function onMessage(msg) {
  const l = findByPhone(msg.from);
  if (!l || !l.optIn) return 'ignored'; // unknown or not opted in: no reply, so a stranger can never use Maya (or make her message them)
  if ((l.seen || []).includes(msg.id)) return 'duplicate';
  update(l.profileId, (x) => {
    x.lastInboundAt = Math.max(x.lastInboundAt || 0, Number(msg.timestamp) * 1000 || Date.now());
    x.seen = [...(x.seen || []), msg.id].slice(-SEEN_KEEP);
  });
  if (msg.type === 'text' && msg.text && typeof msg.text.body === 'string') { await onText(l, msg); return 'text'; }
  // Step 1 is text only. Any other kind is answered once, truthfully, never guessed at.
  await sendTextTo(l.phone, 'I can only read written messages here for now. Please type it for me.');
  return 'unsupported';
}

// Called by server.js after it answered 200. Never throws; errors are logged as a message only (no words, no numbers).
async function handleWebhook(payload) {
  const done = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return done;
  for (const e of payload.entry || []) for (const c of e.changes || []) {
    if (c.field !== 'messages' || !c.value) continue;
    const pid = c.value.metadata && c.value.metadata.phone_number_id;
    if (pid && process.env.WHATSAPP_PHONE_ID && pid !== process.env.WHATSAPP_PHONE_ID) continue; // meant for another number
    for (const msg of c.value.messages || []) {
      if (!msg || typeof msg.from !== 'string' || typeof msg.id !== 'string') continue;
      done.push(serial(msg.from, () => onMessage(msg)).catch((err) => { console.error('whatsapp error:', err.message); return 'error'; }));
    }
  }
  return Promise.all(done);
}

module.exports = { deps, configured, link, unlink, view, linkOf, findByPhone, cleanPhone, verifyChallenge, validSignature, handleWebhook, sendTextTo, mayaWords, NO_CALL_LINE, WaError, WINDOW_MS };
