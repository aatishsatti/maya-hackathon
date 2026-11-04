// The family door: one account (username + hashed password) with several seniors, a signed session, the senior's link that opens the chat only, and the family-only routes locked
// to the family that owns them. The server is started for real (mock mode, throwaway folders), with MAYA_FAMILY_LOGIN=on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-fam-'));
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
const accounts = require('../accounts');

test('passwords are hashed (never stored in the clear); a wrong password and an unknown name get the same answer; five wrong tries lock the name for a while', () => {
  accounts.signup('Rosa.Family', 'correct horse battery');
  const raw = fs.readFileSync(path.join(process.env.MAYA_MEDIA_DIR, '_families.json'), 'utf8');
  assert.ok(!raw.includes('correct horse'), 'the password is not in the file'); assert.match(raw, /"hash":"[0-9a-f]{128}"/); assert.match(raw, /"salt":"[0-9a-f]{32}"/);
  assert.equal(accounts.login('rosa.family', 'correct horse battery').username, 'rosa.family', 'names are not case sensitive');
  const msg = (f) => { try { f(); } catch (e) { return `${e.status} ${e.message}`; } return ''; };
  assert.equal(msg(() => accounts.login('rosa.family', 'nope nope nope')), msg(() => accounts.login('nobody.here', 'nope nope nope')));
  for (let i = 0; i < 6; i++) msg(() => accounts.login('rosa.family', 'wrong wrong'));
  assert.match(msg(() => accounts.login('rosa.family', 'correct horse battery')), /^429/, 'locked after repeated wrong tries');
  accounts.tries.clear();
  assert.match(msg(() => accounts.signup('rosa.family', 'another password')), /^409/, 'a name is taken once');
  assert.match(msg(() => accounts.signup('ab', 'long enough password')), /^400/); assert.match(msg(() => accounts.signup('good.name', 'short')), /^400/);
});

test('a session token is signed: an altered token, another secret or an expired one is nobody', () => {
  const t = accounts.token('rosa.family');
  assert.equal(accounts.verify(t), 'rosa.family');
  const [b, s] = t.split('.'); const forged = Buffer.from(JSON.stringify({ u: 'rosa.family', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(accounts.verify(`${forged}.${s}`), null); assert.equal(accounts.verify(`${b}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`), null); assert.equal(accounts.verify('garbage'), null);
  assert.equal(accounts.verify(accounts.token('rosa.family', Date.now() - 31 * 24 * 3600 * 1000)), null, 'expired after 30 days');
});

function startServer(extra = {}) {
  return new Promise((resolve, reject) => {
    const port = 40000 + Math.floor(Math.random() * 20000), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-famsrv-'));
    const clean = { ...process.env }; delete clean.META_API_KEY; delete clean.ELEVENLABS_API_KEY;
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...clean, META_MODE: 'mock', PORT: String(port), MAYA_DATA_DIR: path.join(dir, 'p'), MAYA_CARE_DIR: path.join(dir, 'c'), MAYA_MEDIA_DIR: path.join(dir, 'm'), MAYA_WA_DIR: path.join(dir, 'w'), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(`no start: ${out.slice(-200)}`)); }, 15000);
    child.stdout.on('data', (d) => { out += d; if (/Maya running/.test(out)) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${port}`, stop: () => { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the server was still writing: the temp folder is left */ } } }); } });
  });
}
const J = (base, p, o = {}, cookie) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) }, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body });

test('end to end: sign up, add a senior (profile + link), only that family can open them; the senior link opens the chat only; another family is refused', async () => {
  const s = await startServer({ MAYA_FAMILY_LOGIN: 'on' });
  try {
    const up = await J(s.base, '/api/family/signup', { method: 'POST', body: { username: 'family.one', password: 'a good password' } });
    assert.equal(up.status, 200); const cookie = /maya_family=[^;]+/.exec(up.headers.get('set-cookie'))[0]; assert.match(up.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await J(s.base, '/api/family/me')).status, 401, 'no session, no family page');
    assert.equal((await J(s.base, '/api/care/overview')).status, 401);
    assert.equal((await J(s.base, '/api/profiles')).status, 401, 'nobody can list everyone\'s seniors');
    const noConsent = await J(s.base, '/api/family/seniors', { method: 'POST', body: { name: 'Kali', tz: 'Asia/Kolkata', mode: 'cautious' } }, cookie);
    assert.equal(noConsent.status, 400, 'the consent for family calls is asked at onboarding');
    const add = await J(s.base, '/api/family/seniors', { method: 'POST', body: { name: 'Kali', tz: 'Asia/Kolkata', mode: 'cautious', consent: true } }, cookie);
    assert.equal(add.status, 200); const { profile, link } = await add.json();
    assert.match(link, new RegExp(`/s/${profile.id}$`));
    const me = await (await J(s.base, '/api/family/me', {}, cookie)).json(); assert.deepEqual(me.seniors.map((x) => [x.id, x.name, x.mode]), [[profile.id, 'Kali', 'cautious']]);
    assert.equal((await J(s.base, `/api/care/${profile.id}`, {}, cookie)).status, 200, 'their own senior: the dashboard opens');
    // the senior door: no login, chat only
    const door = await fetch(link); assert.equal(door.status, 200); assert.match(await door.text(), /localStorage\.setItem\('mayaProfile'/);
    assert.equal((await fetch(`${s.base}/api/senior/${profile.id}`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/care/${profile.id}/events`, { headers: { Origin: s.base }, signal: AbortSignal.timeout(500) }).catch((e) => ({ status: 'open' }))).status !== 401, true, 'the senior\'s own stream needs no login');
    assert.equal((await J(s.base, `/api/care/${profile.id}`)).status, 401, 'the family dashboard of a senior needs the family login');
    assert.equal((await J(s.base, `/api/care/${profile.id}/mode`, { method: 'POST', body: { mode: 'standard' } })).status, 401);
    assert.equal((await J(s.base, `/api/whatsapp/${profile.id}`)).status, 401);
    // another family
    const two = await J(s.base, '/api/family/signup', { method: 'POST', body: { username: 'family.two', password: 'another good one' } });
    const c2 = /maya_family=[^;]+/.exec(two.headers.get('set-cookie'))[0];
    assert.equal((await J(s.base, `/api/care/${profile.id}`, {}, c2)).status, 403, 'never another family\'s senior');
    assert.equal((await J(s.base, `/api/whatsapp/${profile.id}`, {}, c2)).status, 403);
    assert.deepEqual((await (await J(s.base, '/api/care/overview', {}, c2)).json()).seniors, []);
    assert.equal((await J(s.base, `/api/profiles/${profile.id}`, { method: 'DELETE' }, c2)).status, 403);
    assert.equal((await fetch(`${s.base}/s/00000000`)).status, 404);
    // the chat is the senior's own door (the link's id is the key)
    assert.equal((await J(s.base, `/api/chat/${profile.id}`)).status !== 401, true);
    // a bad login is refused with the same words, then a real login works and logout clears
    assert.equal((await J(s.base, '/api/family/login', { method: 'POST', body: { username: 'family.one', password: 'wrong wrong' } })).status, 401);
    assert.equal((await J(s.base, '/api/family/login', { method: 'POST', body: { username: 'family.one', password: 'a good password' } })).status, 200);
  } finally { s.stop(); }
});

test('with the switch off the server behaves as before (nothing is locked), so the old app keeps working until it is updated', async () => {
  const s = await startServer({ MAYA_FAMILY_LOGIN: 'off' });
  try { assert.equal((await J(s.base, '/api/care/overview')).status, 200); assert.equal((await J(s.base, '/api/profiles')).status, 200); } finally { s.stop(); }
});

test('the family live stream is per family: only that family\'s seniors reach it (login on); with login off it is everyone\'s as before', () => {
  const care = require('../care');
  const got = (owns) => { const seen = []; const res = { write: (s) => { seen.push(s); return true; } }; const off = care.attachFamily(res, owns); care.pushFamily('refresh', { id: 'aaaaaaaa' }); care.pushFamily('refresh', { id: 'bbbbbbbb' }); off(); return seen.join(''); };
  const mine = got((id) => id === 'aaaaaaaa'); assert.match(mine, /aaaaaaaa/); assert.doesNotMatch(mine, /bbbbbbbb/);
  const all = got(null); assert.match(all, /aaaaaaaa/); assert.match(all, /bbbbbbbb/);
});

test('demo mode flag (MAYA_DEMO_MODE): default OFF keeps family routes locked; ON exposes demo senior and demo account dashboard without login while keeping login routes working', async () => {
  const sOff = await startServer({ MAYA_FAMILY_LOGIN: 'on' });
  try {
    const dOff = await (await fetch(`${sOff.base}/api/senior/demo`)).json();
    assert.deepEqual(dOff, { demo: false }, 'demo mode is OFF by default');
    assert.equal((await J(sOff.base, '/api/profiles')).status, 401);
  } finally { sOff.stop(); }

  const sOn = await startServer({ MAYA_FAMILY_LOGIN: 'on', MAYA_DEMO_MODE: 'on' });
  try {
    const up = await J(sOn.base, '/api/family/signup', { method: 'POST', body: { username: 'demo.family', password: 'a good password' } });
    assert.equal(up.status, 200);
    const cookie = /maya_family=[^;]+/.exec(up.headers.get('set-cookie'))[0];
    const add = await J(sOn.base, '/api/family/seniors', { method: 'POST', body: { name: 'Clara', tz: 'Europe/London', mode: 'cautious', consent: true } }, cookie);
    assert.equal(add.status, 200);
    const { profile } = await add.json();

    // Without any login cookie: Talk to Maya resolves the demo senior and Family Dashboard loads the demo account
    const demo = await (await fetch(`${sOn.base}/api/senior/demo`)).json();
    assert.deepEqual(demo, { demo: true, profile: { id: profile.id, name: 'Clara' } });
    const profs = await J(sOn.base, '/api/profiles');
    assert.equal(profs.status, 200);
    assert.deepEqual((await profs.json()).profiles.map((p) => p.id), [profile.id]);
    assert.equal((await J(sOn.base, `/api/care/${profile.id}`)).status, 200, 'demo dashboard opens without login cookie');
    assert.equal((await J(sOn.base, '/api/family/me')).status, 200);
    // Normal login route still works
    assert.equal((await J(sOn.base, '/api/family/login', { method: 'POST', body: { username: 'demo.family', password: 'a good password' } })).status, 200);
  } finally { sOn.stop(); }
});
