// The web call's "Maya did not answer in time" timer must survive the heartbeat: a pong arrives every few seconds and used to clear it, so an unanswered turn was never ended.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MayaThink, MayaLine } = require('../public/app.js');

// A tiny clock-driven copy of what onServerEvent does with the helper (the page code is the same three lines).
function run(events, until) {
  let deadline = null, fired = null;
  for (const [t, type] of events.sort((a, b) => a[0] - b[0])) {
    if (deadline !== null && t >= deadline && fired === null) fired = deadline;
    const a = MayaThink.action(type);
    if (a === 'start') deadline = t + MayaThink.TIMEOUT_MS; else if (a === 'clear') deadline = null;
  }
  if (deadline !== null && until >= deadline && fired === null) fired = deadline;
  return fired;
}
const pongs = (from, to) => { const out = []; for (let t = from; t < to; t += MayaLine.PING_MS) out.push([t, 'pong']); return out; };

test('the heartbeat does NOT cancel the unanswered-reply timeout, and the timeout still fires on time', () => {
  const ev = [[0, 'thinking'], ...pongs(MayaLine.PING_MS, 45000)];
  assert.equal(run(ev, 45000), 30000, 'thinking at 0 with pongs every few seconds: the timer fires at 30 s');
});

test('an answer from Maya stops the timer; a new turn starts it again', () => {
  assert.equal(run([[0, 'thinking'], [2500, 'pong'], [4000, 'speak'], ...pongs(5000, 60000)], 60000), null, 'she answered at 4 s: no timeout');
  assert.equal(run([[0, 'thinking'], [4000, 'speak'], [20000, 'audioEnd'], [21000, 'speechEnd'], ...pongs(22000, 60000)], 60000), 51000, 'the next turn starts a fresh 30 s');
  assert.equal(MayaThink.action('speechEnd'), 'start'); assert.equal(MayaThink.action('pong'), 'keep'); assert.equal(MayaThink.action('partial'), 'clear');
});

test('the page really asks the helper (the clear is skipped for a pong)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /const think = MayaThink\.action\(ev\.type\);\s*\n\s*if \(think !== 'keep'\) clearTimeout\(c\.thinkTimer\);/);
});
