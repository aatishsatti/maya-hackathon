// The orb's rules (pure maths in public/orb.js) and the senior page's structure. No browser here; headless Chrome drives the real thing.
// The orb is the phone app's particle sphere (app/lib/widgets/orb.dart) drawn on a canvas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MayaParticles: P } = require('../public/orb.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('particles: 3400 points on a sphere, the same every time, each with its own rhythm', () => {
  const c = P.cloud(), d = P.cloud();
  assert.equal(c.n, 3400);
  for (let i = 0; i < c.n; i += 97) { assert.ok(Math.abs(Math.hypot(c.x[i], c.y[i], c.z[i]) - 1) < 1e-4, 'on the unit sphere'); assert.equal(c.f1[i], d.f1[i]); }
  assert.ok(new Set(Array.from(c.f1.slice(0, 200)).map((v) => v.toFixed(3))).size > 150, 'rhythms differ');
});
test('resting movement: speaking and thinking move more than listening, which moves more than connecting; you speaking answers just as strongly; never still', () => {
  assert.ok(P.rest('speaking') > P.rest('listening') && P.rest('listening') > P.rest('idle'));
  assert.ok(P.rest('thinking') >= P.rest('listening'));
  assert.ok(P.rest('listening', true) >= P.rest('speaking'));
  for (const s of ['idle', 'listening', 'thinking', 'speaking']) assert.ok(P.rest(s) > 0, `${s} is never still`);
});
test('sound drives it: louder = more movement, capped at 1, never negative; quick to rise, slower to settle', () => {
  assert.ok(P.target(0.16, 0.8) > P.target(0.16, 0.2) && P.target(0.16, 0.2) > P.target(0.16, 0));
  assert.equal(P.target(0.3, 5), 1); assert.equal(P.target(0.3, -2), 0.3);
  const up = P.ease(0.2, 1) - 0.2, down = 1 - P.ease(1, 0.2);
  assert.ok(up > down, 'rises faster than it falls');
  assert.ok(Math.abs(P.ease(0.2, 1, 3) - P.ease(P.ease(P.ease(0.2, 1), 1), 1)) < 1e-9, 'three frames at once equals three frames in a row');
});
test('colours: cool only (teal to trust blue), no pink, no purple, no warm colour', () => {
  assert.equal(P.RAMP.length, 4);
  for (const hex of P.RAMP) { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); assert.ok(b > r && b >= g - 40 || g > r, hex); assert.ok(r < 0x70, 'low red: nothing pink or warm'); }
});
test('orb.js: nothing is drawn outside the particles (no shadow, no blur, no glow, no rings); no image or video as the orb', () => {
  const src = read('orb.js');
  assert.ok(!/shadowBlur|shadowColor|\.filter\s*=|ctx\.filter|createRadialGradient/.test(src));
  const pub = fs.readdirSync(path.join(__dirname, '..', 'public'));
  assert.ok(!pub.some((f) => /\.(mp4|webm|mov|png|jpe?g|gif|webp)$/i.test(f)), pub.join(','));
  const html = read('index.html');
  assert.ok(!/<video/.test(html) && !/id="orb"[^]*?<\/div>/.exec(html)[0].includes('<img'));
  assert.match(html, /id="orb"[^>]*>\s*<canvas>/);
});
test('senior page: one page at a time (home, chat, call); no card stacks, no pink, no purple, no gradient of purple', () => {
  const css = read('style.css'), html = read('index.html');
  for (const id of ['pageHome', 'pageChat', 'pageCall']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(css, /body\[data-page='call'\] \.call-page \{ display: flex; \}/);
  assert.ok(!/#(?:ff[0-9a-f]{2}[89a-f][0-9a-f]|e91e63|9c27b0|8e24aa|7b1fa2|6a1b9a)/i.test(css), 'no pink or purple');
  assert.match(css, /max-width: 500px/, 'a centred column about 500px wide, never stretched');
});
test('call page: Mute left, Speaker right, a red End call pill beneath, "Go back to chat" in words above them with room to spare', () => {
  const html = read('index.html');
  const call = html.slice(html.indexOf('id="pageCall"'), html.indexOf('id="attachSheet"'));
  assert.ok(call.indexOf('id="muteBtn"') < call.indexOf('id="speakerBtn"') && call.indexOf('id="speakerBtn"') < call.indexOf('id="cutBtn"'));
  assert.match(call, /Go back to chat/); assert.match(call, />End call</);
  assert.match(read('style.css'), /\.to-chat \{[^}]*margin-bottom: 24px/);
});
test('chat page: paperclip sheet with Attach image / Attach file (PDF) / Take photo, "Write to Maya", recording bar with bin, gallery, wave, time and send', () => {
  const html = read('index.html');
  for (const t of ['Attach image', 'Attach file (PDF)', 'Take photo', 'Write to Maya', 'Back to call', 'Chat with Maya', 'Go back to chat']) assert.ok(html.includes(t), t);
  for (const id of ['recCancel', 'recGallery', 'recWave', 'recTime', 'recSend']) assert.match(html, new RegExp(`id="${id}"`));
});
test('home page: the Call button is on home and in the chat header only', () => {
  const html = read('index.html');
  assert.equal((html.match(/id="callBtn"/g) || []).length, 1); assert.equal((html.match(/id="callBtnHead"/g) || []).length, 1);
  assert.ok(html.indexOf('id="callBtn"') < html.indexOf('id="pageChat"') && html.indexOf('id="callBtnHead"') > html.indexOf('id="pageChat"') && html.indexOf('id="callBtnHead"') < html.indexOf('id="pageCall"'));
});
test('incoming ring: "Maya is calling", one line from the call kind only, Decline on the left and Accept on the right', () => {
  const js = read('inbox.js'), css = read('style.css');
  assert.match(js, /'incoming', 'Maya is calling'/);
  assert.ok(js.indexOf("label: 'Decline'") < js.indexOf("label: 'Accept'"), 'Decline first (left), Accept second (right)');
  for (const k of ['welfare', 'reminder', 'callback']) assert.match(js, new RegExp(`${k}: '`));
  assert.match(css, /\.inbox-btn\.accept::before \{ background-color: var\(--accept\)/);
});
