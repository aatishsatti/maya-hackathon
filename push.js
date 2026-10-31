// Push to a CLOSED phone, so Maya can ring the app when it is not open.
//   iOS:     Apple VoIP push (PushKit) -> the app shows CallKit's incoming call screen.
//            https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit
//            HTTP/2 POST https://api.push.apple.com/3/device/<token> (sandbox: api.sandbox.push.apple.com),
//            headers: authorization: bearer <JWT ES256, kid = key id, iss = team id>, apns-topic: <bundle id>.voip,
//            apns-push-type: voip, apns-priority: 10, apns-expiration. A refused token answers 410 or 400 BadDeviceToken.
//   Android: Firebase Cloud Messaging HTTP v1, a high priority DATA message -> the app shows its incoming call notification.
//            https://firebase.google.com/docs/cloud-messaging/send-message  (POST fcm.googleapis.com/v1/projects/<id>/messages:send,
//            OAuth2 bearer from a service account: JWT RS256 -> https://oauth2.googleapis.com/token, scope firebase.messaging).
//            A dead token answers 404 UNREGISTERED.
// Every secret is read from the SERVER ENVIRONMENT only (names below). With none set, configured() is false, nothing is sent,
// and the caller falls back (WhatsApp under its rules). NOT yet run against Apple or Google: that needs the accounts' keys.
//   APNS_KEY_P8 (the .p8 text), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_SANDBOX=1 (debug builds)
//   FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_JSON (the service account file's text)
// Logs: platform and a short reason label only. Never a token, a name, a number or a word.
const crypto = require('node:crypto');
const http2 = require('node:http2');

const env = (k) => String(process.env[k] || '').trim();
const b64u = (x) => Buffer.from(x).toString('base64url');
const log = (o) => console.log('push', JSON.stringify(o));

const deps = { send: null, configured: null, timeoutMs: 8000 };   // tests replace these; real ones below

function realConfigured(platform) {
  if (platform === 'ios') return Boolean(env('APNS_KEY_P8') && env('APNS_KEY_ID') && env('APNS_TEAM_ID') && env('APNS_BUNDLE_ID'));
  if (platform === 'android') return Boolean(env('FCM_PROJECT_ID') && env('FCM_SERVICE_ACCOUNT_JSON'));
  return false;
}
const configured = (platform) => (deps.configured ? Boolean(deps.configured(platform)) : realConfigured(platform));

let apnsJwt = { at: 0, v: null };
function apnsToken() {
  if (apnsJwt.v && Date.now() - apnsJwt.at < 40 * 60 * 1000) return apnsJwt.v;   // Apple wants a fresh one between 20 and 60 minutes
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: env('APNS_KEY_ID') })), body = b64u(JSON.stringify({ iss: env('APNS_TEAM_ID'), iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: env('APNS_KEY_P8').replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  apnsJwt = { at: Date.now(), v: `${head}.${body}.${sig.toString('base64url')}` };
  return apnsJwt.v;
}

function sendApns(device, payload) {
  return new Promise((resolve) => {
    let done = false; const fin = (r) => { if (!done) { done = true; try { client.close(); } catch { /* closed */ } resolve(r); } };
    const client = http2.connect(env('APNS_SANDBOX') === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    client.on('error', () => fin({ ok: false, reason: 'apns_unreachable' }));
    const timer = setTimeout(() => fin({ ok: false, reason: 'apns_timeout' }), deps.timeoutMs); timer.unref();
    let req;
    try {
      req = client.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${apnsToken()}`, 'apns-topic': `${env('APNS_BUNDLE_ID')}.voip`, 'apns-push-type': 'voip', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 30) });
    } catch { return fin({ ok: false, reason: 'apns_key_unusable' }); }
    let status = 0; req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', () => {});
    req.on('end', () => { clearTimeout(timer); fin(status === 200 ? { ok: true } : { ok: false, reason: `apns_${status}`, gone: status === 410 || status === 400 }); });
    req.on('error', () => fin({ ok: false, reason: 'apns_error' }));
    req.end(JSON.stringify(payload));
  });
}

let fcmAccess = { at: 0, v: null };
async function fcmToken() {
  if (fcmAccess.v && Date.now() - fcmAccess.at < 50 * 60 * 1000) return fcmAccess.v;
  const sa = JSON.parse(env('FCM_SERVICE_ACCOUNT_JSON')), now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), body = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${body}.${sig}`, signal: AbortSignal.timeout(deps.timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('fcm_auth');
  fcmAccess = { at: Date.now(), v: j.access_token };
  return fcmAccess.v;
}
async function sendFcm(device, payload) {
  try {
    const data = {}; for (const [k, v] of Object.entries(payload)) data[k] = String(v);   // FCM data values must be strings
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${env('FCM_PROJECT_ID')}/messages:send`, { method: 'POST', headers: { authorization: `Bearer ${await fcmToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: device.token, data, android: { priority: 'HIGH', ttl: '30s' } } }), signal: AbortSignal.timeout(deps.timeoutMs) });
    return r.ok ? { ok: true } : { ok: false, reason: `fcm_${r.status}`, gone: r.status === 404 };
  } catch (e) { return { ok: false, reason: e && e.message === 'fcm_auth' ? 'fcm_auth' : 'fcm_unreachable' }; }
}

// One push to one device. Resolves { ok, reason?, gone? } and never throws. payload: flat, strings and numbers only
// ({ type: 'incoming' | 'end', outreachId, ringMs }): no words, no names.
async function send(device, payload) {
  if (!configured(device.platform)) return { ok: false, reason: 'not_configured' };
  try {
    const r = await (deps.send ? deps.send(device, payload) : device.platform === 'ios' ? sendApns(device, payload) : sendFcm(device, payload));
    const out = { ok: Boolean(r && r.ok), ...(r && r.ok ? {} : { reason: String((r && r.reason) || 'failed').replace(/[^\w]/g, '').slice(0, 24) || 'failed', gone: Boolean(r && r.gone) }) };
    log({ platform: device.platform, type: payload.type, ok: out.ok, ...(out.ok ? {} : { reason: out.reason }) });
    return out;
  } catch { log({ platform: device.platform, type: payload.type, ok: false, reason: 'error' }); return { ok: false, reason: 'error' }; }
}

module.exports = { send, configured, deps };
