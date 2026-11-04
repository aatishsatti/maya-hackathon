// Demo-only wipe: one call deletes every profile except the pinned demo senior, across accounts. Demo OFF refuses, no demo senior refuses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

function startServer(extra = {}) {
  return new Promise((resolve, reject) => {
    const port = 40000 + Math.floor(Math.random() * 20000), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-wipe-'));
    const clean = { ...process.env }; delete clean.META_API_KEY; delete clean.ELEVENLABS_API_KEY;
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...clean, META_MODE: 'mock', PORT: String(port), MAYA_DATA_DIR: path.join(dir, 'p'), MAYA_CARE_DIR: path.join(dir, 'c'), MAYA_MEDIA_DIR: path.join(dir, 'm'), MAYA_WA_DIR: path.join(dir, 'w'), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(`no start: ${out.slice(-200)}`)); }, 15000);
    child.stdout.on('data', (d) => { out += d; if (/Maya running/.test(out)) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${port}`, stop: () => { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} } }); } });
  });
}
const J = (base, p, o = {}, cookie) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) }, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body });

test('wipe-except-demo keeps only the pinned demo senior, across accounts; OFF refuses', async () => {
  const s = await startServer({ MAYA_FAMILY_LOGIN: 'on', MAYA_DEMO_MODE: 'on', MAYA_DEMO_SENIOR: 'Ruth', MAYA_DEMO_ACCOUNT: 'mayademo' });
  try {
    const up1 = await J(s.base, '/api/family/signup', { method: 'POST', body: { username: 'mayademo', password: 'a good password' } });
    const c1 = /maya_family=[^;]+/.exec(up1.headers.get('set-cookie'))[0];
    const ruth = await (await J(s.base, '/api/family/seniors', { method: 'POST', body: { name: 'Ruth', consent: true } }, c1)).json();
    const up2 = await J(s.base, '/api/family/signup', { method: 'POST', body: { username: 'old.family', password: 'another good one' } });
    const c2 = /maya_family=[^;]+/.exec(up2.headers.get('set-cookie'))[0];
    const mathew = await (await J(s.base, '/api/family/seniors', { method: 'POST', body: { name: 'Mathew', consent: true } }, c2)).json();
    const testTwo = await (await J(s.base, '/api/family/seniors', { method: 'POST', body: { name: 'TestTwo', consent: true } }, c2)).json();
    const wipe = await J(s.base, '/api/family/wipe-except-demo', { method: 'POST' });
    assert.equal(wipe.status, 200);
    const result = await wipe.json();
    assert.deepEqual(result.kept, { id: ruth.profile.id, name: 'Ruth' });
    assert.deepEqual(result.deleted.map((x) => x.name).sort(), ['Mathew', 'TestTwo']);
    const after = await (await fetch(`${s.base}/api/profiles`)).json();
    assert.deepEqual(after.profiles.map((p) => p.name), ['Ruth']);
    assert.equal((await fetch(`${s.base}/api/senior/${mathew.profile.id}`)).status, 404, 'Mathew gone after wipe');
    assert.equal((await fetch(`${s.base}/api/senior/${testTwo.profile.id}`)).status, 404, 'TestTwo gone after wipe');
    const demo = await (await fetch(`${s.base}/api/senior/demo`)).json();
    assert.deepEqual(demo, { demo: true, profile: { id: ruth.profile.id, name: 'Ruth' } });
  } finally { s.stop(); }
  const sOff = await startServer({ MAYA_FAMILY_LOGIN: 'on' });
  try {
    const wipeOff = await J(sOff.base, '/api/family/wipe-except-demo', { method: 'POST' });
    assert.equal(wipeOff.status, 403);
  } finally { sOff.stop(); }
});
