// The /privacy page: live without login, says what the prototype really does, and carries no secret or test data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'privacy.html'), 'utf8');
const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('privacy page covers every required topic in plain words', () => {
  for (const re of [/chat|types to Maya/i, /voice notes/i, /photos/i, /profile name/i, /WhatsApp phone number/i, /dashboard settings/i, /topic only/i, /never shows the words/i,
    /Location/, /Phone contacts/, /Live video/, /Fall detection/, /never sells data/i, /exact words, audio, photos or phone numbers/i,
    /profile is deleted/i, /ask for deletion by email/i, /wiped whenever the service is redeployed or restarted/i, /prototype limit/i,
    /Meta's WhatsApp Business API/, /Meta's own policies/, /can answer a call from a linked number on WhatsApp, and that call audio goes to the same services as in-app calls/i, /sattiaatish94@gmail\.com/,
    /not medical care/i, /not a doctor/i, /no diagnosis/i, /no medicine doses/i]) assert.match(text, re, String(re));
});

test('privacy page has no secret, id, phone number or test data, and loads nothing from elsewhere', () => {
  assert.doesNotMatch(html, /EAA[A-Za-z0-9]{10,}|api[_-]?key|secret|token|1409237678935671|1116892537450220|555\)? ?640|\+?\d{10,}/i);
  assert.doesNotMatch(html, /<script|src=|https?:\/\/(?!$)/i, 'no script, no outside resource');
});

test('/privacy is served live without login, and linked from the app and family pages', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-priv-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, META_MODE: 'mock', PORT: String(port), MAYA_DATA_DIR: path.join(tmp, 'p'), MAYA_CARE_DIR: path.join(tmp, 'c'), MAYA_WA_DIR: path.join(tmp, 'w') }, stdio: 'ignore' });
  try {
    let r;
    for (let i = 0; i < 40 && !r; i++) { try { r = await fetch(`http://localhost:${port}/privacy`); } catch { await new Promise((x) => setTimeout(x, 150)); } }
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(await r.text(), /Maya privacy/);
    for (const page of ['/', '/family.html']) assert.match(await (await fetch(`http://localhost:${port}${page}`)).text(), /href="\/privacy"/, page);
  } finally { child.kill(); }
});
