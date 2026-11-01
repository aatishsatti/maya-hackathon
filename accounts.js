// Family accounts: ONE family account (a username and a password, never stored in the clear) that can have SEVERAL seniors, each with their own dashboard.
// The senior never has an account: the senior door is a link that opens the chat only. The family door is this login, in the app and on the web, with the same credentials.
//   - passwords: scrypt with a random salt per account, compared in constant time; a wrong password and an unknown name give the same answer
//   - sessions: a signed token (HMAC-SHA256) carrying the username and an expiry; no session table, nothing to leak; the signing secret lives only on the server's disk or env
//   - which seniors an account owns is written on the account; a family can never open another family's senior
//   - too many wrong tries for a name (5 in 10 minutes) are refused for a while
// The account file is on the persistent disk, next to the chat folders: MEDIA_DIR/_families.json (never served: the media route only serves named files inside a profile folder).
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = () => process.env.MAYA_MEDIA_DIR || path.join(__dirname, 'data', 'media');
const FILE = () => path.join(DIR(), '_families.json');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const NAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const MIN_PASSWORD = 8;
const tries = new Map();   // username -> [timestamps of wrong tries]

class AccountError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

function readAll() { try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return j && typeof j === 'object' && j.families ? j : { families: {} }; } catch { return { families: {} }; } }
function writeAll(all) { fs.mkdirSync(DIR(), { recursive: true }); const tmp = `${FILE()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, FILE()); }

let secretCache = null;
function secret() {
  if (process.env.MAYA_SESSION_SECRET) return process.env.MAYA_SESSION_SECRET;
  if (secretCache) return secretCache;
  const f = path.join(DIR(), '_session_secret');
  try { secretCache = fs.readFileSync(f, 'utf8').trim(); } catch { /* first run */ }
  if (!secretCache || secretCache.length < 32) { secretCache = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(f, secretCache, { mode: 0o600 }); }
  return secretCache;
}

const hash = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');
const normName = (u) => String(u || '').trim().toLowerCase();
const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function token(username, now = Date.now()) { const body = Buffer.from(JSON.stringify({ u: username, e: now + SESSION_MS })).toString('base64url'); return `${body}.${sign(body)}`; }
// -> the username, or null for anything wrong, altered or expired
function verify(tok, now = Date.now()) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.e > now && readAll().families[p.u] ? p.u : null; } catch { return null; }
}

function signup(username, password) {
  const u = normName(username);
  if (!NAME.test(u)) throw new AccountError('Choose a username of 3 to 30 letters, numbers, dots, dashes or underscores.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AccountError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
  if (password.length > 200) throw new AccountError('That password is too long.');
  const all = readAll();
  if (all.families[u]) throw new AccountError('That username is taken. Please choose another.', 409);
  const salt = crypto.randomBytes(16).toString('hex');
  all.families[u] = { salt, hash: hash(password, salt), seniors: [], created: Date.now() };
  writeAll(all);
  return { username: u, token: token(u) };
}

function login(username, password, now = Date.now()) {
  const u = normName(username);
  const recent = (tries.get(u) || []).filter((t) => now - t < 10 * 60000);
  if (recent.length >= 5) throw new AccountError('Too many tries. Please wait a few minutes and try again.', 429);
  const f = readAll().families[u];
  const ok = f && crypto.timingSafeEqual(Buffer.from(hash(password, f.salt), 'hex'), Buffer.from(f.hash, 'hex'));
  if (!ok) { recent.push(now); tries.set(u, recent); throw new AccountError('That username or password is not right.', 401); }   // the same words for an unknown name
  tries.delete(u);
  return { username: u, token: token(u, now) };
}

const seniorsOf = (username) => { const f = readAll().families[username]; return f ? f.seniors.slice() : []; };
const owns = (username, profileId) => seniorsOf(username).includes(profileId);
function addSenior(username, profileId) {
  const all = readAll(); const f = all.families[username];
  if (!f) throw new AccountError('Please log in again.', 401);
  if (!f.seniors.includes(profileId)) f.seniors.push(profileId);
  writeAll(all);
}
// The family's phones, for a ring while the app is closed. Same rules as a senior's push token (the token is never returned or logged); several phones per account, newest five kept.
function addDevice(username, platform, token) {
  if (!['ios', 'android'].includes(platform)) throw new AccountError('The platform must be ios or android.');
  if (typeof token !== 'string' || !/^[\w:\-.]{16,4096}$/.test(token)) throw new AccountError('That is not a push token.');
  const all = readAll(), f = all.families[username]; if (!f) throw new AccountError('Please log in again.', 401);
  f.devices = (f.devices || []).filter((d) => d.token !== token); f.devices.push({ platform, token, at: Date.now() }); f.devices = f.devices.slice(-5);
  writeAll(all);
}
const devicesOf = (username) => ((readAll().families[username] || {}).devices || []).slice();
function removeDevice(username, token) { const all = readAll(), f = all.families[username]; if (!f) return; const n = (f.devices || []).length; f.devices = (f.devices || []).filter((d) => d.token !== token); if (f.devices.length !== n) writeAll(all); }
const ownersOf = (profileId) => Object.entries(readAll().families).filter(([, f]) => f.seniors.includes(profileId)).map(([u]) => u);
function removeSenior(profileId) { const all = readAll(); let ch = false; for (const f of Object.values(all.families)) { const n = f.seniors.length; f.seniors = f.seniors.filter((x) => x !== profileId); if (f.seniors.length !== n) ch = true; } if (ch) writeAll(all); }

// The token from a request: the app sends it as "Authorization: Bearer ...", the web keeps it in an HttpOnly cookie.
function fromRequest(req) {
  const h = String(req.headers.authorization || '');
  if (/^Bearer /i.test(h)) return verify(h.slice(7).trim());
  const m = /(?:^|;\s*)maya_family=([^;]+)/.exec(String(req.headers.cookie || ''));
  return m ? verify(decodeURIComponent(m[1])) : null;
}
const cookie = (tok, secure) => `maya_family=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
const clearCookie = (secure) => `maya_family=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

module.exports = { addDevice, devicesOf, removeDevice, ownersOf, AccountError, signup, login, verify, token, seniorsOf, owns, addSenior, removeSenior, fromRequest, cookie, clearCookie, MIN_PASSWORD, tries };
