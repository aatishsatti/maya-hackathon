// The greeting's facts about how recent the last contact was (call.js recentContactNote). Facts and principles only: no fixed sentence for Spark.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-greet-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async () => '' } };

const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const { Call } = require('../call');

let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const fakeWs = { send() {}, close() {}, onmessage: null, onclose: null };
const mk = () => { const p = memory.createProfile(`Gwen${letters(n++)}`, 'female'); const c = new Call(fakeWs, 'k'); c.profile = memory.load(p.id); c.callId = 'x'; return { id: p.id, c }; };
const MIN = 60000;

test('first contact today: a normal warm greeting fact, no recent-contact fact', () => {
  const { c } = mk();
  const note = c.recentContactNote();
  assert.match(note, /FIRST CONTACT TODAY/); assert.match(note, /normal warm greeting/); assert.ok(!/RECENT CONTACT/.test(note));
});

test('a call-back minutes after a call that dropped: short, no introduction, no repeated warm line, no "long time"', () => {
  const { id, c } = mk();
  care.callEnded(id, { userTurns: 3 }, 'left');
  const note = c.recentContactNote();
  assert.match(note, /RECENT CONTACT/); assert.match(note, /ended 1 minute ago/); assert.match(note, /they ended it or the line dropped/);
  assert.match(note, /skip any introduction and any full welcome/); assert.match(note, /do not repeat a warm line/); assert.match(note, /not .*been a long time|nothing that suggests it has been a long time/);
  assert.ok(!/FIRST CONTACT/.test(note));
  assert.match(c.recentContactNote(Date.now() + 10 * MIN), /ended 10 minutes ago/);
  assert.match(c.recentContactNote(Date.now() + 3 * 3600000), /FIRST CONTACT TODAY/, 'hours later it is an ordinary call again');
});

test('chat then call: the greeting knows they were just writing, and does not introduce again', () => {
  const { id, c } = mk();
  const s = chat.sessions.get(id) || (chat.sessions.set(id, new chat.ChatSession(memory.load(id), 'UTC')), chat.sessions.get(id));
  s.push({ role: 'senior', kind: 'text', text: 'hello' });
  const note = c.recentContactNote();
  assert.match(note, /writing with you in the chat \d+ minutes? ago/); assert.match(note, /skip any introduction/);
  assert.ok(chat.lastWrittenAt(id) > 0);
});

test('lines mirrored from a call are not "chat": a spoken line alone does not make the next call a chat follow-up', () => {
  const { id, c } = mk();
  const s = chat.sessions.get(id) || (chat.sessions.set(id, new chat.ChatSession(memory.load(id), 'UTC')), chat.sessions.get(id));
  s.push({ role: 'maya', kind: 'text', text: 'hello', spoken: true });
  assert.equal(chat.lastWrittenAt(id), 0); assert.match(c.recentContactNote(), /FIRST CONTACT TODAY/);
});

test('already greeted today is a fact, and the facts hold no sentence to copy and no transcript', () => {
  const { id, c } = mk();
  care.addLine(id, 'greeting', 'Hi there, lovely to talk with you.');
  const note = c.recentContactNote();
  assert.match(note, /already greeted them once in the last 12 hours/);
  assert.ok(!/lovely to talk/.test(note), 'the earlier greeting words are not copied into the note');
});

test('greetingNote carries it for an ordinary call, and not for Maya\'s own call-back', () => {
  const { id, c } = mk(); care.callEnded(id, { userTurns: 2 }, 'left');
  assert.match(c.greetingNote(10), /RECENT CONTACT/);
  const o = mk(); o.c.outreach = { kind: 'callback' };
  assert.ok(!/RECENT CONTACT|FIRST CONTACT/.test(o.c.greetingNote(10)));
});

test.after(() => { chat.endAll(); care.stop(); setTimeout(() => process.exit(), 50).unref(); });
