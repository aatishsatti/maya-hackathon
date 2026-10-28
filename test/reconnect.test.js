// Line recovery (render-test, hosting): a call whose browser socket dies WITHOUT a goodbye is held for a short grace window and handed back to a
// reconnecting browser (same call, same Transcribe session, same memory). Heartbeats notice a dead link in seconds. A goodbye still ends the call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-reconnect-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, sparkComplete: async () => '{}', sparkStream: async () => '', streamSpeech: async () => {} } };
const memory = require('../memory');
const { Call, liveCalls, RESUME_GRACE_MS } = require('../call');
const { accept } = require('../ws');
const { MayaLine } = require('../public/app.js');

// A client frame (masked, as a browser sends it).
function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload).map((b, i) => b ^ mask[i & 3]);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, body]);
}
function fakeSocket() {
  const s = new EventEmitter();
  s.written = []; s.destroyed = false;
  s.write = (b) => { s.written.push(Buffer.from(b)); return true; };
  s.setNoDelay = () => {};
  s.end = () => { s.emit('close'); };
  s.destroy = () => { if (s.destroyed) return; s.destroyed = true; s.emit('close'); };
  return s;
}
const fakeReq = { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', upgrade: 'websocket' } };
const pings = (s) => s.written.filter((b) => b[0] === 0x89).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('heartbeat: the server pings a quiet line, and a line that sends nothing at all is destroyed (so a dead link is noticed fast)', async () => {
  const s = fakeSocket(); const ws = accept(fakeReq, s, { pingMs: 20, deadMs: 120 });
  let closed = 0; ws.onclose = () => { closed += 1; };
  await sleep(70);
  assert.ok(pings(s) >= 2, 'pings go out on a steady beat');
  assert.equal(s.destroyed, false, 'not dead yet');
  await sleep(150);
  assert.equal(s.destroyed, true, 'nothing heard for deadMs: the socket is destroyed');
  assert.equal(closed, 1);
  assert.equal(ws.cleanClose, false, 'a lost line is NOT a clean close');
});

test('heartbeat: anything received (audio or a pong) keeps the line alive', async () => {
  const s = fakeSocket(); const ws = accept(fakeReq, s, { pingMs: 20, deadMs: 100 });
  const t = setInterval(() => s.emit('data', clientFrame(10)), 30); // a pong every 30 ms
  await sleep(300);
  clearInterval(t);
  assert.equal(s.destroyed, false);
  s.emit('data', clientFrame(8)); // the browser says goodbye
  assert.equal(ws.closed, true); assert.equal(ws.cleanClose, true, 'a close frame is a clean close');
});

test('a server-initiated close is a clean close too (a hang-up must end the call, not wait for a reconnect)', () => {
  const s = fakeSocket(); const ws = accept(fakeReq, s, { pingMs: 1000, deadMs: 5000 });
  ws.close(1000); assert.equal(ws.cleanClose, true);
});

let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
function mkWs() { const sent = []; return { sent, closed: false, cleanClose: false, send(d) { sent.push(typeof d === 'string' ? JSON.parse(d) : { binary: d.length }); }, close() { this.cleanClose = true; this.closedByServer = true; }, terminate() { this.terminated = true; }, onmessage: null, onclose: null }; }
// A call that is live: Transcribe session ready, registered for resume.
function liveCall() {
  const ws = mkWs(); const pcm = [];
  const c = new Call(ws, 'k'); c.profile = memory.load(memory.createProfile(`Rae${letters(n++)}`, 'female').id); c.callId = 'x'; c.greeted = true;
  let metaClosed = false;
  c.meta = { ready: true, sendPcm: (b) => pcm.push(b.length), close: () => { metaClosed = true; } };
  liveCalls.set(c.token, c); c.startMicFeed();
  return { c, ws, pcm, metaClosed: () => metaClosed };
}
function placeholder(ws) { return new Call(ws, 'k'); }   // what server.js makes for every new socket

test('a lost line (no goodbye) keeps the call alive and feeds Transcribe silence; the browser reconnecting gets the SAME call back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { c, ws, pcm, metaClosed } = liveCall();
  ws.onclose();                                           // socket died, no close frame
  assert.equal(c.closed, false); assert.equal(c.detached, true);
  t.mock.timers.tick(1000);
  assert.ok(pcm.length >= 9 && pcm.every((len) => len === 4800), 'real-time silence (100 ms of 24 kHz s16) keeps the Transcribe session from timing out');
  assert.equal(metaClosed(), false, 'the Transcribe session is kept');
  const ws2 = mkWs();
  placeholder(ws2).onBrowser(JSON.stringify({ type: 'resume', token: c.token }), false);
  assert.equal(c.ws, ws2, 'the call now talks through the new socket');
  assert.equal(c.detached, false); assert.equal(c.closed, false);
  assert.deepEqual(ws2.sent, [{ type: 'resumed' }]);
  const fed = pcm.length; t.mock.timers.tick(1000);
  assert.ok(pcm.length > fed, 'silence still stands in until real frames arrive');
  c.resampler = { process: (f) => Buffer.alloc(f.length * 2) };
  c.onBrowser(Buffer.from(new Float32Array(1024).buffer), true); // the browser is back sending audio
  assert.equal(pcm.at(-1), 2048, 'real audio goes through again');
  const fed2 = pcm.length; t.mock.timers.tick(150);
  assert.equal(pcm.length, fed2, 'no stand-in silence right after a real frame');
  t.mock.timers.tick(RESUME_GRACE_MS + 1000);
  assert.equal(c.closed, false, 'the grace timer no longer ends the call');
  c.end();
});

test('if the browser does not come back within the grace window the call ends (memory saved, Transcribe closed)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { c, ws, metaClosed } = liveCall();
  ws.onclose();
  t.mock.timers.tick(RESUME_GRACE_MS - 100); assert.equal(c.closed, false);
  t.mock.timers.tick(200);
  assert.equal(c.closed, true); assert.equal(metaClosed(), true); assert.equal(liveCalls.has(c.token), false, 'its token is gone');
});

test('a wrong token, or a call that has ended, is refused (resumeFailed) and its socket is closed', () => {
  const { c, ws } = liveCall(); ws.onclose(); c.end();
  for (const token of ['nope', c.token, undefined]) {
    const w = mkWs(); placeholder(w).onBrowser(JSON.stringify({ type: 'resume', token }), false);
    assert.deepEqual(w.sent, [{ type: 'resumeFailed' }]); assert.equal(w.closedByServer, true);
  }
});

test('a goodbye (close frame) ends the call at once: hanging up never waits for a reconnect', () => {
  const { c, ws, metaClosed } = liveCall();
  ws.cleanClose = true; ws.onclose();
  assert.equal(c.closed, true); assert.equal(metaClosed(), true); assert.equal(liveCalls.has(c.token), false);
});

test('before the call is live there is nothing to hold: a lost line ends it', () => {
  const ws = mkWs(); const c = new Call(ws, 'k'); ws.onclose();
  assert.equal(c.closed, true);
});

test('a reconnect that arrives while the old line still looks open takes the call over (the old socket is dropped)', () => {
  const { c, ws } = liveCall();
  const ws2 = mkWs(); placeholder(ws2).onBrowser(JSON.stringify({ type: 'resume', token: c.token }), false);
  assert.equal(ws.terminated, true); assert.equal(ws.onclose, null, 'the old socket can no longer end or detach the call');
  assert.equal(c.ws, ws2); assert.equal(c.closed, false);
  c.end();
});

test('client heartbeat: a ping is answered with a pong', () => {
  const { c, ws } = liveCall();
  c.onBrowser(JSON.stringify({ type: 'ping' }), false);
  assert.deepEqual(ws.sent, [{ type: 'pong' }]);
  c.end();
});

test('the page: reconnects within 1-2 s, keeps trying for the window, then gives up; no token (call never went live) means no retry', () => {
  const lostAt = 1000;
  assert.deepEqual(MayaLine.next({ now: lostAt, lostAt, attempt: 0, hasToken: true }), { retry: true, delay: 300 });
  assert.deepEqual(MayaLine.next({ now: lostAt + 400, lostAt, attempt: 1, hasToken: true }), { retry: true, delay: 1000 });
  assert.deepEqual(MayaLine.next({ now: lostAt + 9000, lostAt, attempt: 7, hasToken: true }), { retry: true, delay: 1000 });
  assert.deepEqual(MayaLine.next({ now: lostAt + MayaLine.WINDOW_MS, lostAt, attempt: 9, hasToken: true }), { retry: false });
  assert.deepEqual(MayaLine.next({ now: lostAt, lostAt, attempt: 0, hasToken: false }), { retry: false });
  assert.ok(MayaLine.WINDOW_MS < RESUME_GRACE_MS, 'the server holds the call longer than the page keeps trying');
  assert.equal(MayaLine.dead({ now: 20000, lastRx: 9000 }), false);
  assert.equal(MayaLine.dead({ now: 22000, lastRx: 9000 }), true, 'nothing heard for over DEAD_MS counts as a dead line');
});

test('audio gap: when mic frames stop (frozen link) Transcribe gets real-time silence; while frames flow it gets none from the stand-in', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { c, pcm } = liveCall();
  c.resampler = { process: (f) => Buffer.alloc(f.length * 2) };
  const frame = Buffer.from(new Float32Array(1024).buffer);
  for (let i = 0; i < 20; i++) { c.onBrowser(frame, true); t.mock.timers.tick(50); }   // 1 s of live audio, a frame every 50 ms
  assert.ok(pcm.every((len) => len === 2048), 'only real frames were sent while audio flowed (no stand-in silence)');
  const real = pcm.length;
  t.mock.timers.tick(5000);                                                           // the link freezes for 5 s
  const silence = pcm.slice(real);
  assert.ok(silence.length >= 40 && silence.length <= 50 && silence.every((len) => len === 4800), `about 5 s of silence in 100 ms pieces (got ${silence.length})`);
  c.end();
});
