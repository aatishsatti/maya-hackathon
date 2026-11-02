// The web call's microphone uplink and line watch, from the live numbers of a bad call (mic frames stalled 300 to 1080 ms, a lost line): the mic has its own 16 kHz context (what the app sends),
// frames are dropped (and counted) while the line is backed up, a silent line is noticed in seconds, and a long reconnect says so plainly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const { MayaLine } = require('../public/app.js');
const RESUME_GRACE_MS = Number(/const RESUME_GRACE_MS = (\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8'))[1]);

test('the microphone is captured on its own 16 kHz context and the start message carries that rate (the server resamples from what it is told)', () => {
  assert.match(src, /const MIC_RATE = 16000/);
  assert.match(src, /new \(window\.AudioContext \|\| window\.webkitAudioContext\)\(\{ sampleRate: MIC_RATE \}\)/);
  assert.match(src, /type: 'start', sampleRate: \(c\.micCtx \|\| c\.ctx\)\.sampleRate/, 'the rate sent is the mic context\'s own');
  assert.match(src, /mic\.createMediaStreamSource\(c\.stream\)\.connect\(tap\)/);
  assert.match(src, /c\.ctx\.createGain\(\); \/\/ Maya's voice/, 'Maya\'s voice and the orb stay on the page\'s own context (no 16 kHz voice)');
});

test('frames are dropped, and counted, while the line is backed up; the counts are printed when the call ends', () => {
  assert.match(src, /const MIC_BACKLOG_BYTES = 65536/);
  assert.match(src, /c\.ws\.bufferedAmount > MIC_BACKLOG_BYTES\) \{ c\.micStats\.dropped \+= 1; return; \}/);
  assert.match(src, /console\.log\('mic uplink', c\.micStats\)/);
});

test('a silent line is noticed within seconds, and the page says so plainly if reconnecting takes long', () => {
  assert.ok(MayaLine.DEAD_MS <= 6000 && MayaLine.PING_MS * 2 < MayaLine.DEAD_MS, 'a pong every 2.5 s, dead after 6 s: well above a 1 s mic stall');
  assert.ok(MayaLine.SLOW_MS < MayaLine.WINDOW_MS && MayaLine.WINDOW_MS < RESUME_GRACE_MS);
  assert.equal(MayaLine.SLOW_TEXT, 'Still trying to reconnect. You can press End call and call again.');
  assert.match(src, /if \(!c\.slowTimer\) c\.slowTimer = setTimeout/, 'armed once per lost line: re-arming it on every failed attempt meant it never fired');
});
