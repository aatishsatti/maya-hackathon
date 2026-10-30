// Deploys and restarts: Render stops the service with SIGTERM. What care.js was still holding (its saves are batched 300 ms) must reach the disk.
// Also the dashboard route that sets how reminders reach the person on WhatsApp. (Where the data lives, and the refusal to start when a data folder cannot be used, are in datadirs.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function boot(mode, dirs, extra = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, META_MODE: mode, PORT: String(port), ...dirs, ...extra };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  return { port, child, out: () => out.join(''), exited };
}
async function up(port) { for (let i = 0; i < 60; i++) { try { return await fetch(`http://localhost:${port}/api/config`); } catch { await sleep(150); } } throw new Error('server did not start'); }
const dirsIn = (tmp) => ({ MAYA_DATA_DIR: path.join(tmp, 'profiles'), MAYA_CARE_DIR: path.join(tmp, 'care'), MAYA_WA_DIR: path.join(tmp, 'wa'), MAYA_MEDIA_DIR: path.join(tmp, 'media') });
const post = (port, p, body) => fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify(body) });

test('SIGTERM (what a deploy sends) saves what care.js was still holding, then exits cleanly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-sigterm-')); const s = boot('mock', dirsIn(tmp));
  try {
    await up(s.port);
    const created = await (await post(s.port, '/api/profiles', { name: 'Shutdown Sam', gender: 'male' })).json(); const id = (created.profile || created).id; assert.match(id, /^[a-f0-9]{8}$/);
    const r = await post(s.port, `/api/care/${id}/reminders`, { task: 'take your tablets', dueAt: Date.now() + 3600000, repeat: 'none' }); assert.equal(r.status, 200);
    s.child.kill('SIGTERM');                       // inside the 300 ms batching window
    const { code } = await s.exited; assert.equal(code, 0); assert.match(s.out(), /SIGTERM: saving and stopping/);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'care', `${id}.json`), 'utf8')); assert.deepEqual(saved.reminders.map((x) => x.task), ['take your tablets'], 'the reminder reached the disk');
  } finally { s.child.kill('SIGKILL'); }
});

test('the dashboard route sets how reminders reach the person on WhatsApp (voice note by default), and refuses anything else', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-deliv-')); const s = boot('mock', dirsIn(tmp));
  try {
    await up(s.port);
    const created = await (await post(s.port, '/api/profiles', { name: 'Delivery Dee', gender: 'female' })).json(); const id = (created.profile || created).id;
    assert.equal((await (await fetch(`http://localhost:${s.port}/api/care/${id}`)).json()).delivery.reminders, 'voice', 'default: a voice note');
    assert.equal((await post(s.port, `/api/care/${id}/delivery`, { reminders: 'text' })).status, 200);
    assert.equal((await (await fetch(`http://localhost:${s.port}/api/care/${id}`)).json()).delivery.reminders, 'text');
    const bad = await post(s.port, `/api/care/${id}/delivery`, { reminders: 'carrier pigeon' }); assert.equal(bad.status, 400); assert.match((await bad.json()).error, /voice note or as text/);
    assert.equal((await fetch(`http://localhost:${s.port}/api/care/${id}/delivery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"reminders":"voice"}' })).status, 403, 'same origin only');
  } finally { s.child.kill('SIGKILL'); }
});
