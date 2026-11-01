// The senior's own menu: only their own reminders are listed and can be stopped; the family's are never shown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-smenu-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory');
const care = require('../care');
const soon = (h = 5) => Date.now() + h * 3600000;

test('seniorMenu lists only reminders the senior set; stopping a family one is refused', () => {
  const id = memory.createProfile('Menua', 'female').id; care.setTimezone(id, 'Europe/London', 'manual');
  const fam = care.addReminder(id, { task: 'family reminder', dueAt: soon(), repeat: 'none' });
  const own = care.addSeniorReminder(id, { task: 'call my sister', dueAt: soon(3), repeat: 'daily', every: 1, deliver: 'voice', channel: 'app', origin: 'chat' });
  const m = care.seniorMenu(id);
  assert.equal(m.name, 'Menua'); assert.equal(m.tz, 'Europe/London');
  assert.deepEqual(m.reminders.map((r) => r.task), ['call my sister']);
  assert.equal(care.stopSeniorReminder(id, fam.id), false, 'a family reminder is not theirs to stop');
  assert.equal(care.stopSeniorReminder(id, own.id), true);
  assert.deepEqual(care.seniorMenu(id).reminders, []);
  assert.equal(care.seniorMenu('00000000'), null);
});

test('a push token belongs to one senior: linking the phone to another person drops it from the old one; pushes say whose they are', () => {
  const a = memory.createProfile('Tokena', 'female').id, b = memory.createProfile('Tokenb', 'male').id;
  const token = 'K'.repeat(64);
  care.registerDevice(a, { platform: 'android', token });
  assert.equal(care.get(a).devices.length, 1);
  care.registerDevice(b, { platform: 'android', token });
  assert.equal(care.get(a).devices.length, 0, 'the old senior no longer rings this phone');
  assert.equal(care.get(b).devices.length, 1);
  assert.equal(care.removeDevice(b, token), true, 'sign out removes it');
});
