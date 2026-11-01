// Maya knows she can be called: in the chat her notes say so, and the first answer to "can I call you?" must be the phone button, never "I can't pick up a phone call".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-callable-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory');
const chat = require('../chat');

test('in the chat the turn notes say she CAN be called, by the phone button at the top right (and on WhatsApp where set up), and forbid saying she cannot', () => {
  const id = memory.createProfile('Callable', 'female').id;
  chat.thread(id);
  const s = chat.sessions.get(id);
  const note = s.limitsFacts('Can I call you?');
  assert.match(note, /YOU CAN BE CALLED/);
  assert.match(note, /phone button at the top right/);
  assert.match(note, /WhatsApp/);
  assert.match(note, /FIRST thing you say is yes/);
  assert.match(note, /Never say you cannot pick up a phone call/);
  chat.endAll();
});

test('a call is not told this (she is already on one)', () => {
  const call = fs.readFileSync(path.join(__dirname, '..', 'call.js'), 'utf8');
  assert.match(call, /if \(this\.channel === 'chat'\) bits\.push\('YOU CAN BE CALLED/);
});
