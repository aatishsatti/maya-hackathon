// GET /api/config: the mode, and the commit the server is running (from Render's RENDER_GIT_COMMIT), validated so nothing arbitrary is ever echoed.
// Each case starts the real server in mock mode on throwaway folders and a random port (no Meta, no ElevenLabs), and stops it by its own process id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SHA = '42b610b4e74197c8b4cff8d57034e15d1546476e';

function configFor(env) {
  return new Promise((resolve, reject) => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-config-'));
    const clean = { ...process.env }; delete clean.RENDER_GIT_COMMIT; delete clean.META_API_KEY; delete clean.ELEVENLABS_API_KEY;
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...clean, META_MODE: 'mock', PORT: String(port), MAYA_DATA_DIR: path.join(tmp, 'p'), MAYA_CARE_DIR: path.join(tmp, 'c'), MAYA_MEDIA_DIR: path.join(tmp, 'm'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false, out = '';
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`server did not start: ${out.slice(-300)}`))), 15000);
    child.stdout.on('data', async (d) => {
      out += d; if (!/Maya running/.test(out)) return;
      try { const r = await fetch(`http://127.0.0.1:${port}/api/config`); const body = await r.json(); finish(() => resolve({ status: r.status, body })); } catch (e) { finish(() => reject(e)); }
    });
    child.on('error', (e) => finish(() => reject(e)));
  });
}

test('/api/config reports the running commit exactly (lower case, full length), and still reports the mode', async () => {
  const r = await configFor({ RENDER_GIT_COMMIT: SHA });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { mode: 'mock', commit: SHA });
  assert.deepEqual((await configFor({ RENDER_GIT_COMMIT: SHA.toUpperCase() })).body, { mode: 'mock', commit: SHA }, 'normalised to lower case');
  assert.equal((await configFor({ RENDER_GIT_COMMIT: '42b610b' })).body.commit, '42b610b', 'a short id is accepted too');
});

test('off Render there is no commit: null, never a guess and never an error', async () => {
  const r = await configFor({});
  assert.equal(r.status, 200); assert.deepEqual(r.body, { mode: 'mock', commit: null });
});

test('anything that is not a plain hex id is never echoed: it becomes null', async () => {
  for (const bad of ['<script>alert(1)</script>', 'main', '42b610b; rm -rf /', 'g'.repeat(40), 'abc', 'a'.repeat(41), ' ', '42b610b\nSet-Cookie: x=1']) {
    const r = await configFor({ RENDER_GIT_COMMIT: bad });
    assert.equal(r.body.commit, null, JSON.stringify(bad)); assert.equal(JSON.stringify(r.body).includes('script'), false);
  }
});

test('only the mode and the commit are reported: no key, no key length, no path, no environment', async () => {
  const r = await configFor({ RENDER_GIT_COMMIT: SHA, META_API_KEY: 'sk-secret-should-never-appear-123456', ELEVENLABS_API_KEY: 'xi-secret-should-never-appear-123456' });
  assert.deepEqual(Object.keys(r.body).sort(), ['commit', 'mode']);
  const dump = JSON.stringify(r.body); for (const w of ['secret', 'sk-', 'xi-', '/Users', 'KEY']) assert.ok(!dump.includes(w), w);
});
