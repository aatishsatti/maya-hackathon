// WhatsApp consent invite + unlink buttons: invite endpoint exists, refuses cleanly when not set up, unlink clears the link, and dashboard HTML/JS contains the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
function startServer(extra = {}) {
  return new Promise((resolve, reject) => {
    const port = 40000 + Math.floor(Math.random() * 20000), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-wainv-'));
    const clean = { ...process.env }; delete clean.META_API_KEY; delete clean.ELEVENLABS_API_KEY; delete clean.WHATSAPP_TOKEN; delete clean.WHATSAPP_PHONE_ID;
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...clean, META_MODE: 'mock', PORT: String(port), MAYA_DATA_DIR: path.join(dir, 'p'), MAYA_CARE_DIR: path.join(dir, 'c'), MAYA_MEDIA_DIR: path.join(dir, 'm'), MAYA_WA_DIR: path.join(dir, 'w'), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(`no start: ${out.slice(-200)}`)); }, 15000);
    child.stdout.on('data', (d) => { out += d; if (/Maya running/.test(out)) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${port}`, stop: () => { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} } }); } });
  });
}
const J = (base, p, o = {}, cookie) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) }, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body });
test('whatsapp invite endpoint + unlink + dashboard buttons', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'family.html'), 'utf8');
  assert.match(html, /id="waInviteBtn"/); assert.match(html, /Send WhatsApp consent message/); assert.match(html, /id="waUnlinkBtn"/); assert.match(html, /Unlink WhatsApp/);
  const js = fs.readFileSync(path.join(ROOT, 'public', 'family.js'), 'utf8');
  assert.match(js, /\/api\/whatsapp\/\$\{id\}\/invite/); assert.match(js, /maya_reminder template/);
  assert.doesNotMatch(js, /hello_world/);
  const s = await startServer({ MAYA_FAMILY_LOGIN: 'on' });
  try {
    const up = await J(s.base, '/api/family/signup', { method: 'POST', body: { username: 'wa.family', password: 'a good password' } });
    const c = /maya_family=[^;]+/.exec(up.headers.get('set-cookie'))[0];
    const senior = await (await J(s.base, '/api/family/seniors', { method: 'POST', body: { name: 'Henry', consent: true } }, c)).json();
    const id = senior.profile.id;
    // Invite with WhatsApp not configured in test env: clean 503, not silent, not hello_world (configured is checked before linked in guardOut)
    const noLink = await J(s.base, `/api/whatsapp/${id}/invite`, { method: 'POST' }, c);
    assert.equal(noLink.status, 503);
    // Link, then invite with WhatsApp not configured in test env: clean 503, exact reason
    const link = await J(s.base, `/api/whatsapp/${id}/link`, { method: 'POST', body: { phone: '917006328237', optIn: true } }, c);
    assert.equal(link.status, 200);
    const invite = await J(s.base, `/api/whatsapp/${id}/invite`, { method: 'POST' }, c);
    assert.equal(invite.status, 503);
    assert.match((await invite.json()).error, /not set up/);
    // Unlink clears the link, view shows Not linked again
    const unlink = await J(s.base, `/api/whatsapp/${id}`, { method: 'DELETE' }, c);
    assert.equal(unlink.status, 200);
    const view = await (await J(s.base, `/api/whatsapp/${id}`, {}, c)).json();
    assert.equal(view.linked, false);
  } finally { s.stop(); }
});
