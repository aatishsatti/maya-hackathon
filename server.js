// Maya server: plain Node, no dependencies.
// Serves public/ and the voice-loop API. Keys come from server env only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dataDirs = require('./datadirs').guard();   // FIRST: before memory.js (via call.js) creates its folder at import time; refuses to start with a plain message if a data folder cannot be used
const { accept } = require('./ws');
const { Call } = require('./call');
const { requireRealEnv } = require('./brain');
const memory = require('./memory');
const care = require('./care');
const chat = require('./chat');
const origin = require('./origin');
const accounts = require('./accounts');
const push = require('./push');
const whatsapp = require('./whatsapp');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const MODE = process.env.META_MODE === 'real' ? 'real' : 'mock';
// The commit this server is running, so "is the new code live?" has an exact answer. Render sets RENDER_GIT_COMMIT itself. A commit id is not a secret (the repo
// is public); only a plain 7 to 40 character hex id is ever reported, anything else becomes null. Null on any machine that is not Render.
const COMMIT = /^[0-9a-f]{7,40}$/i.test(process.env.RENDER_GIT_COMMIT || '') ? String(process.env.RENDER_GIT_COMMIT).toLowerCase() : null;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_NOTE_BYTES = 12 * 1024 * 1024; // a WAV voice note (Meta takes up to 10 minutes / 32 MB; the app sends 24 kHz mono)
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Mock persona: warm, patient, slow, short concrete sentences, one idea at a time.
// Mock has no speech-to-text, so it never guesses what was said and never claims
// facts, weather, history, or abilities Maya does not have. Greeting-aware replies
// are tested in real mode, not here.
const MOCK_GREETING = 'Hi. This is practice mode, so I cannot really talk yet.';
const MOCK_REPLY = 'I heard you. I am here.';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Ears: speech to text. Mock never invents what the person said.
function mockEars(audioBytes) {
  return { transcript: null, note: `mock: received ${audioBytes} bytes of audio, no transcription` };
}

// Brain: reply. Mock is always neutral.
function mockBrain() {
  return MOCK_REPLY;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Audio too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- Care (Feature 3): senior presence stream, call-back / reminder rings, family dashboard data ----
// Same-origin only for anything that changes state or opens a stream (no cross-site page may drive these).
const sameOrigin = (req) => origin.sameOrigin(req.headers); // this host over http (local) or https (hosted), nothing else: see origin.js
function openStream(req, res, attach) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': open\n\n');
  const detach = attach(res);
  const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* closed */ } }, 20000);
  req.on('close', () => { clearInterval(beat); if (detach) detach(); });
}
async function readJson(req, limit = 4096) {
  try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); } catch { return null; }
}
async function handleCare(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /api/care
  const [a, b, c, d] = parts;
  if (req.method === 'GET' && a === 'overview') { if (!needFamily(req, res, null)) return; const fam = dashFamilyOf(req); const mine = familyLoginOn() && fam ? new Set(accounts.seniorsOf(fam)) : null; return sendJson(res, 200, { seniors: care.overview().filter((x) => !mine || mine.has(x.id)) }); }
  if (req.method === 'GET' && a === 'events') { if (!needFamily(req, res, null)) return; const fam = familyLoginOn() ? dashFamilyOf(req) : null; return openStream(req, res, (r) => care.attachFamily(r, fam ? (id) => accounts.owns(fam, id) : null)); }
  if (!/^[a-f0-9]{8}$/.test(a || '') || !care.get(a)) return sendJson(res, 404, { error: 'Not found' });
  // The senior's own routes (the live stream, the push token, the activity ping, delivered / seen, declining a ring, the notification buttons) stay open: the senior has no login. Everything else here is the family's.
  const seniorRoute = (b === 'events' || b === 'device' || b === 'activity' || b === 'notifications' || (b === 'outreach' && d === 'decline') || b === 'ack');
  if (!seniorRoute && !needFamily(req, res, a)) return;
  if (req.method === 'GET' && !b) return sendJson(res, 200, care.view(a));
  if (req.method === 'GET' && b === 'trend' && !c) return sendJson(res, 200, care.trendView(a));   // family page only: plain facts built from daily numbers, see trends.js
  if (req.method === 'GET' && b === 'events') {
    const tz = url.searchParams.get('tz');
    require('./tz').learnFromIp(care, a, require('./tz').clientIp(req)).catch(() => {});   // the zone is still unknown: where their connection is tells it (nothing is kept but the zone)
    return openStream(req, res, (r) => care.attachSenior(a, r, /^[\w/+\-]{1,60}$/.test(tz || '') ? tz : null));
  }
  if (req.method === 'DELETE' && b === 'device' && c) return care.removeDevice(a, c) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });
  if (req.method === 'DELETE' && b === 'reminders' && c) { try { return care.deleteReminder(a, c, 'family') ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' }); } catch (e) { return sendJson(res, e.status || 500, { error: e.message }); } }   // the family can stop THEIR OWN reminders only
  // The family's schedule upload: a PDF, a photo or a voice note arrives as raw bytes (nothing is stored); Maya reads it into items and sets NOTHING until the family ticks the ones they want.
  if (req.method === 'POST' && b === 'schedule' && (c === 'pdf' || c === 'image' || c === 'voice')) {
    if (MODE !== 'real') return sendJson(res, 503, { error: 'Reading a schedule needs real mode.' });
    try { const buf = await readBody(req, c === 'pdf' ? MAX_PDF_BYTES : c === 'image' ? MAX_IMAGE_BYTES : MAX_VOICE_NOTE_BYTES); return sendJson(res, 200, { items: await require('./schedule').read(a, await chat.scheduleText(c, buf)) }); }
    catch (e) { return sendJson(res, e.status || 500, { error: e.message }); }
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: 'Bad request' });
  try {
    if (b === 'mode') return sendJson(res, 200, { mode: care.setMode(a, body.mode) });
    if (b === 'timezone') return sendJson(res, 200, { ok: care.setTimezone(a, body.tz, 'manual') });   // the dashboard asks for this ONLY when it could not be found automatically
    if (b === 'quiethours') return sendJson(res, 200, { on: care.setQuietHours(a, body.on) });   // the family's per-senior Quiet hours switch (default ON)
    if (b === 'delivery') return sendJson(res, 200, { delivery: care.setDelivery(a, body) });   // how reminders reach them on WhatsApp: a voice note in Maya's voice or text
    if (b === 'reminders' && !c) return sendJson(res, 200, { reminder: care.addReminder(a, body) });
    if (b === 'reminders' && c && !d) return sendJson(res, 200, { reminder: care.updateReminder(a, c, body, 'family') });   // the edit popup (the family's own reminders only)
    if (b === 'activity') return sendJson(res, 200, { ok: care.touch(a, 'app', Date.now(), /^[\w/+\-]{1,60}$/.test(body.tz || '') ? body.tz : null) });
    if (b === 'device') return sendJson(res, 200, care.registerDevice(a, body));   // the phone's push token (so Maya can ring it when the app is closed); never returned, never logged
    if (b === 'schedule' && c === 'text') { if (MODE !== 'real') return sendJson(res, 503, { error: 'Reading a schedule needs real mode.' }); return sendJson(res, 200, { items: await require('./schedule').read(a, body.text) }); }
    if (b === 'schedule' && c === 'set') return sendJson(res, 200, require('./schedule').setChosen(a, body.ids, { tz: (care.get(a) || {}).tz || null }));   // only the ticked ones
    if (b === 'escalation' && c && d) return care.escalationAct(a, c, d) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });   // the family's answer to a ring: accepted, declined, seen
    if (b === 'ack') return care.notificationAck(a, body.what) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Nothing waiting' });   // the notification buttons Got it / I'm okay
    if (b === 'outreach' && c && d === 'decline') return care.decline(a, c) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });
    if (b === 'notifications' && c && d === 'whatsapp') return care.whatsappStatus(a, c, body.status) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' }); // mock entry for WhatsApp receipts until Feature 6
    if (b === 'notifications' && c && d) return care.markNotif(a, c, d) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });
  } catch (e) { return sendJson(res, e.status || 500, { error: e.message }); }
  return sendJson(res, 404, { error: 'Not found' });
}

// Written chat (chat.js): text, voice notes, photos. Same Maya, memory and safety rules as a call; needs the real Meta keys.
async function handleChat(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /api/chat
  const [pid, what, file] = parts;
  if (!/^[a-f0-9]{8}$/.test(pid || '')) return sendJson(res, 404, { error: 'Not found' });
  if (req.method === 'GET' && what === 'media' && file) {
    const m = chat.readMedia(pid, file);
    if (!m) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': m.type, 'Cache-Control': 'private, no-store' });
    return res.end(m.data);
  }
  if (MODE !== 'real') return sendJson(res, 503, { error: 'Chat needs real mode: it uses the Meta brain and Meta MMS voice, and mock mode never invents a reply.' });
  const tzParam = url.searchParams.get('tz');
  const tz = /^[\w/+\-]{1,60}$/.test(tzParam || '') ? tzParam : null;
  if (care.get(pid)) { if (tz) care.setTimezone(pid, tz, 'device'); else require('./tz').learnFromIp(care, pid, require('./tz').clientIp(req)).catch(() => {}); }   // the device's own zone first; with none, the connection's
  try {
    if (req.method === 'GET' && !what) { care.appThreadOpened(pid); return sendJson(res, 200, { messages: chat.thread(pid), callLive: chat.callLive(pid) }); }   // opening the chat is how a voice reminder that waited there arrives
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (what === 'message') {
      const body = await readJson(req, 8192);
      if (!body) return sendJson(res, 400, { error: 'Bad request' });
      return sendJson(res, 200, await chat.sendText(pid, body.text, tz));
    }
    if (what === 'voicenote') return sendJson(res, 200, await chat.sendVoiceNote(pid, await readBody(req, MAX_VOICE_NOTE_BYTES), tz));
    if (what === 'image') return sendJson(res, 200, await chat.sendImage(pid, await readBody(req, MAX_IMAGE_BYTES), url.searchParams.get('caption'), tz));
    if (what === 'pdf') return sendJson(res, 200, await chat.sendPdf(pid, await readBody(req, MAX_PDF_BYTES), url.searchParams.get('name'), tz));   // a PDF the person sends: its words are read and answered, the file is not kept
  } catch (e) {
    if (!e.status) console.error('chat error:', e.message); // message only, never the person's words
    return sendJson(res, e.status || 500, { error: e.message });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// WhatsApp (whatsapp.js). The webhook is called by Meta, so it is not same-origin: it is protected by the verify token (GET) and the
// X-Hub-Signature-256 signature over the raw body (POST). Everything else here is the family dashboard, same-origin only.
async function handleWhatsapp(req, res, url) {
  const [a, b] = url.pathname.split('/').filter(Boolean).slice(2); // after /api/whatsapp
  if (a === 'webhook') {
    if (req.method === 'GET') {
      const c = whatsapp.verifyChallenge(url.searchParams);
      if (c === null) return sendJson(res, 403, { error: 'Forbidden' });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(c);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    let raw;
    try { raw = await readBody(req, MAX_WEBHOOK_BYTES); } catch (e) { whatsapp.note('dropped a webhook POST: the body could not be read (too large or cut off)'); return sendJson(res, e.status || 400, { error: 'Bad request' }); }
    whatsapp.noteArrival(raw, req.headers['x-hub-signature-256']);
    if (!whatsapp.validSignature(raw, req.headers['x-hub-signature-256'])) { whatsapp.note('rejected a webhook POST: the X-Hub-Signature-256 did not match (check WHATSAPP_APP_SECRET is the Meta app secret)'); return sendJson(res, 403, { error: 'Forbidden' }); }
    if (MODE !== 'real') { whatsapp.note('dropped a webhook POST: the server is not in real mode'); return sendJson(res, 503, { error: 'WhatsApp needs real mode.' }); }
    let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { whatsapp.note('dropped a webhook POST: the body is not JSON'); return sendJson(res, 400, { error: 'Bad request' }); }
    sendJson(res, 200, { ok: true }); // answer Meta first, then do the work
    whatsapp.handleWebhook(payload);
    return;
  }
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
  if (!/^[a-f0-9]{8}$/.test(a || '') || !memory.load(a)) return sendJson(res, 404, { error: 'Not found' });
  if (!needFamily(req, res, a)) return;   // everything under /api/whatsapp/<id> is the family's
  try {
    if (req.method === 'GET' && !b) return sendJson(res, 200, whatsapp.view(a));
    if (req.method === 'DELETE' && !b) return sendJson(res, 200, { ok: whatsapp.unlink(a) });
    if (req.method === 'POST' && b === 'welfare-call') { // the welfare picker: call | text | voice (a call needs real mode)
      const body = (await readJson(req)) || {}, via = body.via === 'text' || body.via === 'voice' ? body.via : 'call';
      if (typeof body.channel === 'string' && body.channel) return via === 'call' && MODE !== 'real' && body.channel !== 'app' ? sendJson(res, 503, { error: 'Calls need real mode.' }) : sendJson(res, 200, await require('./welfarechan').run(a, { via, channel: body.channel }));   // Where it goes: app | whatsapp | both
      return via === 'call' && MODE !== 'real' ? sendJson(res, 503, { error: 'Calls need real mode.' }) : sendJson(res, 200, await whatsapp.placeWelfare(a, via));
    }
    if (b === 'welfare-schedule') {   // Step 2: scheduled welfare checks, started and stopped by the family
      if (req.method === 'POST') { const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Bad request' }); return sendJson(res, 200, { schedule: care.welfareScheduleStart(a, { everyMin: body.everyMin, every: body.every, unit: body.unit, via: body.via, channel: body.channel }) }); }
      if (req.method === 'DELETE') return sendJson(res, 200, { stopped: care.welfareScheduleStop(a) });
    }
    if (req.method === 'POST' && b === 'link') { const body = await readJson(req); if (!body) return sendJson(res, 400, { error: 'Bad request' }); return sendJson(res, 200, whatsapp.link(a, body.phone, body.optIn)); }
  } catch (e) { return sendJson(res, e.status || 500, { error: e.message, ...(e.needsTemplate ? { needsTemplate: true, windowClosed: true } : e.windowClosed ? { windowClosed: true } : {}) }); }
  return sendJson(res, 404, { error: 'Not found' });
}

// ---- Family accounts (accounts.js). The family door: a username and password, in the app and on the web. MAYA_FAMILY_LOGIN=on makes the family-only routes need it. ----
// The lock is ON by default on a real (hosted) server: nobody can list people or open a dashboard without a family login, and a family sees only its own people. 'off' (or mock mode, local development and the tests)
// leaves it open. MAYA_FAMILY_LOGIN=on forces it on anywhere.
const familyLoginOn = () => process.env.MAYA_FAMILY_LOGIN === 'on' || (MODE === 'real' && process.env.MAYA_FAMILY_LOGIN !== 'off');
// Demo-only: config flag (default OFF). When MAYA_DEMO_MODE=on, the web start screen shows Talk to Maya and Family Dashboard without a login screen.
const demoModeOn = () => /^(on|1|true|yes)$/i.test(String(process.env.MAYA_DEMO_MODE || process.env.DEMO_MODE || '').trim());
function demoResolved() {
  // Demo-only: resolves the demo senior and demo account dynamically from existing data (never creates dummy data or hardcodes an id).
  const all = memory.listProfiles();
  const wantSenior = String(process.env.MAYA_DEMO_SENIOR || '').trim().toLowerCase();
  const wantAcc = String(process.env.MAYA_DEMO_ACCOUNT || '').trim().toLowerCase();
  if (wantSenior) {
    const s = all.find((p) => p.id === wantSenior || p.name.toLowerCase() === wantSenior) || null;
    const owners = s ? accounts.ownersOf(s.id) : [];
    return { senior: s ? { id: s.id, name: s.name } : null, account: wantAcc || owners[0] || null };
  }
  if (wantAcc) {
    const ids = accounts.seniorsOf(wantAcc);
    const owned = all.filter((p) => ids.includes(p.id));
    const s = owned[owned.length - 1] || all[all.length - 1] || null;
    return { senior: s ? { id: s.id, name: s.name } : null, account: wantAcc };
  }
  const withOwner = all.filter((p) => accounts.ownersOf(p.id).length > 0);
  const s = withOwner[withOwner.length - 1] || all[all.length - 1] || null;
  const owners = s ? accounts.ownersOf(s.id) : [];
  return { senior: s ? { id: s.id, name: s.name } : null, account: owners[0] || null };
}
const demoFamily = () => (demoModeOn() ? demoResolved().account : null);
const secureReq = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
// The signed-in family for this request (a username) or null.
const familyOf = (req) => accounts.fromRequest(req);
// Demo-only fallback: uses the signed-in session first, or the demo account when MAYA_DEMO_MODE=on and no session cookie is present.
const dashFamilyOf = (req) => accounts.fromRequest(req) || demoFamily();
// A family-only route for senior `id` (or, with id null, any signed-in family). Sends the refusal itself and returns false when not allowed. With the switch off it lets everything through, as before.
function needFamily(req, res, id) {
  if (!familyLoginOn()) return true;
  const u = dashFamilyOf(req);
  if (!u && demoModeOn()) return true;   // demo-only: allow dashboard without login when demo mode is ON
  if (!u) { sendJson(res, 401, { error: 'Please log in as family.' }); return false; }
  if (id && !accounts.owns(u, id)) { sendJson(res, 403, { error: 'This is not one of your family members.' }); return false; }
  return true;
}
// A ring for a closed family app: every phone of every family that owns this person (ids and the kind only, see care.ringFamily).
care.familyHooks.push = (profileId, payload) => {
  for (const u of accounts.ownersOf(profileId)) for (const d of accounts.devicesOf(u)) push.send(d, payload).then((r) => { console.log('push', JSON.stringify({ event: 'family ring pushed', platform: d.platform, ok: Boolean(r.ok), ...(r.ok ? {} : { reason: r.reason || 'failed' }) })); if (r.gone) accounts.removeDevice(u, d.token); });
};
async function handleFamily(req, res, url) {
  const what = url.pathname.split('/')[3];
  if (req.method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const fail = (e) => sendJson(res, e.status || 500, { error: e.message });
  if (req.method === 'POST' && (what === 'signup' || what === 'login')) {
    const body = await readJson(req, 2048); if (!body) return sendJson(res, 400, { error: 'Bad request' });
    try {
      const r = what === 'signup' ? accounts.signup(body.username, body.password) : accounts.login(body.username, body.password);
      res.setHeader('Set-Cookie', accounts.cookie(r.token, secureReq(req)));
      return sendJson(res, 200, { username: r.username, token: r.token });
    } catch (e) { return fail(e); }
  }
  if (req.method === 'POST' && what === 'logout') { res.setHeader('Set-Cookie', accounts.clearCookie(secureReq(req))); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'GET' && what === 'session') return sendJson(res, 200, { username: familyOf(req) });   // asked by the login page: never an error when nobody is signed in
  if (req.method === 'GET' && what === 'me' && demoModeOn() && !familyOf(req)) {
    // Demo-only: allow the family dashboard's Family Members sheet to read the demo account's seniors without login.
    const df = demoFamily();
    const list = df ? accounts.seniorsOf(df).map((id) => memory.load(id)).filter(Boolean) : memory.listProfiles();
    return sendJson(res, 200, { username: df || 'demo', seniors: list.map((p) => ({ id: p.id, name: p.name, mode: care.view(p.id).mode })) });
  }
  const u = familyOf(req);
  if (!u) return sendJson(res, 401, { error: 'Please log in as family.' });
  if (req.method === 'POST' && what === 'device') { const body = await readJson(req, 4096); if (!body) return sendJson(res, 400, { error: 'Bad request' }); try { accounts.addDevice(u, body.platform, body.token); console.log('push', JSON.stringify({ event: 'family device registered', platform: body.platform, ready: push.configured(body.platform) })); return sendJson(res, 200, { ok: true, ready: push.configured(body.platform) }); } catch (e) { return fail(e); } }   // the family's phone, so a ring reaches it while the app is closed
  if (req.method === 'GET' && what === 'me') {
    const seniors = accounts.seniorsOf(u).map((id) => memory.load(id)).filter(Boolean).map((p) => ({ id: p.id, name: p.name, mode: care.view(p.id).mode }));
    return sendJson(res, 200, { username: u, seniors });
  }
  // Add a family member: Maya makes the senior's profile, links it to this family, and gives the senior link (chat only, no login).
  if (req.method === 'POST' && what === 'seniors') {
    const body = await readJson(req, 4096); if (!body) return sendJson(res, 400, { error: 'Bad request' });
    if (body.consent !== true) return sendJson(res, 400, { error: 'Please confirm that Maya may call the family if they go quiet.' });
    try {
      const profile = memory.createProfile(body.name, body.gender || 'prefer-not');
      accounts.addSenior(u, profile.id); care.setFamilyConsent(profile.id, true);   // the consent box was ticked: Maya may call the family if they go quiet
      if (typeof body.tz === 'string' && body.tz) { try { care.setTimezone(profile.id, body.tz, 'manual'); } catch { /* an unknown zone is learned later */ } }
      if (['standard', 'cautious', 'ultra'].includes(String(body.mode))) { try { care.setMode(profile.id, body.mode); } catch { /* the default stays */ } }
      let whatsappNote = null;
      if (body.phone) { try { whatsapp.link(profile.id, String(body.phone), true); } catch (e) { whatsappNote = String(e.message || 'not linked').slice(0, 120); } }
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      return sendJson(res, 200, { profile, link: `${secureReq(req) ? 'https' : 'http'}://${host}/s/${profile.id}`, whatsapp: whatsappNote });
    } catch (e) { return fail(e); }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api/family/')) return handleFamily(req, res, url);
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { mode: MODE, commit: COMMIT, ...(demoModeOn() ? { demo: true } : {}) });
  }
  // Demo-only: start screen asks if demo mode is ON (default OFF) and, when ON, which demo senior Talk to Maya opens.
  if ((url.pathname === '/api/senior/demo' || url.pathname === '/api/demo') && req.method === 'GET') {
    if (!demoModeOn()) return sendJson(res, 200, { demo: false });
    return sendJson(res, 200, { demo: true, profile: demoResolved().senior });
  }
  // Profiles (family setup). Names and gender only; each profile has its own memory file.
  // The senior door asks who this phone is by the id in its link (the id is the key: it is never listed anywhere). Name only.
  const who = /^\/api\/senior\/([a-f0-9]{8})$/.exec(url.pathname);
  if (who && req.method === 'GET') { const p = memory.load(who[1]); return p ? sendJson(res, 200, { profile: { id: p.id, name: p.name } }) : sendJson(res, 404, { error: 'Not found' }); }
  // The senior's own menu: their reminders (only the ones they set) and basic details. No login (the id is the key), never the family's data. Stopping one removes only a reminder they set.
  const menu = /^\/api\/senior\/([a-f0-9]{8})\/(menu|reminders\/[\w-]+)$/.exec(url.pathname);
  if (menu) {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (menu[2] === 'menu' && req.method === 'GET') { const m = care.seniorMenu(menu[1]); return m ? sendJson(res, 200, m) : sendJson(res, 404, { error: 'Not found' }); }
    if (menu[2] !== 'menu' && req.method === 'DELETE') return care.stopSeniorReminder(menu[1], menu[2].split('/')[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (url.pathname === '/api/profiles' && req.method === 'GET') {
    if (!familyLoginOn()) return sendJson(res, 200, { profiles: memory.listProfiles(), ...(demoModeOn() ? { demo: true } : {}) });
    const u = dashFamilyOf(req);
    if (!u && demoModeOn()) return sendJson(res, 200, { profiles: memory.listProfiles(), demo: true });   // demo-only: no login screen in demo mode
    if (!u) return sendJson(res, 401, { error: 'Please log in as family.' });   // nobody can list everyone's seniors
    return sendJson(res, 200, { profiles: memory.listProfiles().filter((p) => accounts.owns(u, p.id)), ...(demoModeOn() ? { demo: true } : {}) });
  }
  if (url.pathname === '/api/profiles' && req.method === 'POST') {
    if (familyLoginOn()) return sendJson(res, 403, { error: 'A family member is added from the family page, after logging in.' });
    let body;
    try { body = JSON.parse((await readBody(req, 2048)).toString('utf8')); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    try { return sendJson(res, 200, { profile: memory.createProfile(body.name, body.gender) }); }
    catch (e) { return sendJson(res, e.status || 500, { error: e.message }); }
  }
  const del = /^\/api\/profiles\/([a-f0-9]{8})$/.exec(url.pathname);
  if (del && req.method === 'DELETE') { if (!needFamily(req, res, del[1])) return; accounts.removeSenior(del[1]); care.remove(del[1]); chat.forget(del[1]); whatsapp.unlink(del[1]); return memory.deleteProfile(del[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' }); }
  if (url.pathname.startsWith('/api/whatsapp/')) return handleWhatsapp(req, res, url);
  if (url.pathname.startsWith('/api/care')) return handleCare(req, res, url);
  if (url.pathname.startsWith('/api/chat/')) return handleChat(req, res, url);
  // Real mode runs over the /ws call socket; these HTTP endpoints are mock only.
  if (MODE === 'real') return sendJson(res, 404, { error: 'Not found' });
  if (url.pathname === '/api/greet' && req.method === 'POST') {
    return sendJson(res, 200, { reply: MOCK_GREETING, mock: true });
  }
  if (url.pathname === '/api/turn' && req.method === 'POST') {
    let audio;
    try { audio = await readBody(req, MAX_AUDIO_BYTES); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    if (audio.length === 0) return sendJson(res, 400, { error: 'No audio received' });
    const ears = mockEars(audio.length);
    return sendJson(res, 200, { transcript: ears.transcript, note: ears.note, reply: mockBrain(), mock: true });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  // The senior door: a link /s/<id> opens the chat only (no login, no password). It remembers who this phone is, then goes to the chat.
  const sl = /^\/s\/([a-f0-9]{8})$/.exec(url.pathname);
  if (sl) {
    if (!memory.load(sl[1])) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This link is not right. Please ask your family for a new one.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Maya</title><script>try{localStorage.setItem('mayaProfile','${sl[1]}')}catch(e){}location.replace('/')</script>`);
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname === '/privacy' ? '/privacy.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Mic allowed for this origin only.
      'Permissions-Policy': 'microphone=(self)',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('API error:', e.message); // message only, never request bodies or keys
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url);
  } else {
    res.writeHead(405); res.end();
  }
});

if (MODE === 'real') {
  try { requireRealEnv(); } catch (e) { console.error(e.message); process.exit(1); }
  memory.recoverAll(); // file any words a crash left in a pending file
  // Pre-warm the local Meta MMS TTS worker at boot so the first call or voice note never waits for Python/model load.
  const { warmSpeech } = require('./brain');
  if (typeof warmSpeech === 'function') warmSpeech().catch((e) => console.error('MMS warm-up failed:', e.message));
}
care.start(); // reminder scheduler (also runs in mock mode; rings need the page open)
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  // Same-origin only, so other web pages cannot open a call on this machine.
  const okOrigin = origin.wsOriginOk(req.headers);
  if (MODE !== 'real' || url.pathname !== '/ws' || !okOrigin) { socket.destroy(); return; }
  const ws = accept(req, socket);
  if (ws) new Call(ws, process.env.META_API_KEY);
});

server.listen(PORT, () => console.log(`Maya running at http://localhost:${PORT} (mode: ${MODE})`));

// Where the data lives (datadirs.js checked it before anything loaded; this only says what it found). On Render only what is under the disk's mount path survives a deploy or a restart.
dataDirs.report(MODE);

// Render stops a service with SIGTERM on every deploy. Node does not run its exit handlers on SIGTERM by itself, so say "exit" explicitly: care.js saves everything it was
// still holding (its saves are batched 300 ms) in its own exit handler, so the last moments before a deploy are not lost.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`${sig}: saving and stopping`); process.exit(0); });
