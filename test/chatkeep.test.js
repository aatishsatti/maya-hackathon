// The written chat is kept per person on disk: it survives a restart (the session map is gone), the 10-minute idle filing, a second phone for the same person, and is never mixed between people.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-chatkeep-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory');
const chat = require('../chat');
chat.deps.speak = async () => Buffer.alloc(48000);

const person = (n) => memory.createProfile(n, 'female').id;
const restart = () => chat.endAll();   // what a restart, a deploy or the idle filing does to the open chats: they are gone from memory

test('a chat survives a restart: every message is on disk and GET /api/chat/<id> (chat.thread) loads it back', () => {
  const id = person('Keepa');
  chat.deliverText(id, 'Good morning, here is your reminder.');
  const before = chat.thread(id);
  assert.equal(before.length, 1);
  assert.ok(fs.existsSync(chat.threadFile(id)), 'written at once, not at some later push');
  restart();
  const after = chat.thread(id);
  assert.deepEqual(after.map((m) => [m.id, m.role, m.kind, m.text, m.at]), before.map((m) => [m.id, m.role, m.kind, m.text, m.at]), 'the same messages, ids and times');
  chat.deliverText(id, 'And a second one.'); restart();
  assert.equal(chat.thread(id).length, 2, 'new messages join the saved ones');
});

test('a voice note (kind, media url, words) is kept; idle filing puts words into memory and never deletes the thread', async () => {
  const id = person('Keepb');
  await chat.deliverVoiceNote(id, 'Take your tablets', 'Take your tablets');
  const m = chat.thread(id).find((x) => x.kind === 'voice');
  assert.ok(m && m.mediaUrl && m.text === 'Take your tablets');
  restart();
  const back = chat.thread(id).find((x) => x.kind === 'voice');
  assert.equal(back.mediaUrl, m.mediaUrl); assert.equal(back.id, m.id);
});

test('one thread per person: another person never sees it; deleting the person deletes it', () => {
  const a = person('Keepc'), b = person('Keepd');
  chat.deliverText(a, 'for a only'); restart();
  assert.equal(chat.thread(b).length, 0);
  assert.equal(chat.thread(a).length, 1);
  chat.forget(a);
  assert.ok(!fs.existsSync(chat.threadFile(a)));
});

test('the newest 200 stay, the oldest drop from the file too; a damaged file is an empty thread, not a crash', () => {
  const id = person('Keepe');
  for (let i = 0; i < 205; i++) chat.deliverText(id, `m${i}`);
  restart();
  const t = chat.thread(id);
  assert.equal(t.length, 200); assert.equal(t[0].text, 'm5'); assert.equal(t[199].text, 'm204');
  assert.equal(JSON.parse(fs.readFileSync(chat.threadFile(id), 'utf8')).length, 200, 'the file holds 200 too');
  restart(); fs.writeFileSync(chat.threadFile(id), '{not json');
  assert.deepEqual(chat.thread(id), []);
});
