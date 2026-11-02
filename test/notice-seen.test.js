// A reminder card that stays on screen: with the senior page open in two tabs (or on a phone and a computer), Got it in one reported Seen but left the other page's card up. The server now tells every open
// page of theirs when a notice was seen, and a click removes the card at once and says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-nseen-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory'); const care = require('../care');
const page = (id) => { const ev = []; const detach = care.attachSenior(id, { write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }, null); return { ev, detach }; };

test('Seen on one page is pushed to every open page of the senior (noticeSeen), once, and to nobody else', async () => {
  const id = memory.createProfile('Nseena', 'female').id; const other = memory.createProfile('Nseenb', 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual');
  const tabA = page(id), tabB = page(id), stranger = page(other);
  care.addSeniorReminder(id, { task: 'take my meds', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app' });
  care.tick(Date.now() + 5000); await new Promise((r) => setTimeout(r, 50));
  const notice = tabA.ev.find(([k]) => k === 'notice'); assert.ok(notice, 'both open pages got the card'); assert.ok(tabB.ev.some(([k]) => k === 'notice'));
  assert.equal(care.markNotif(id, notice[1].notifId, 'delivered'), true);
  assert.equal(tabB.ev.filter(([k]) => k === 'noticeSeen').length, 0, 'delivered is not seen');
  assert.equal(care.markNotif(id, notice[1].notifId, 'seen'), true);
  for (const t of [tabA, tabB]) assert.deepEqual(t.ev.filter(([k]) => k === 'noticeSeen').map(([, d]) => d.notifId), [notice[1].notifId], 'every open page is told, once');
  assert.equal(stranger.ev.filter(([k]) => k === 'noticeSeen').length, 0, 'another person\'s page is not');
  tabA.detach(); tabB.detach(); stranger.detach();
});

test('a text reminder for the app is a normal chat message that stays in the thread (once), carried on the notice; Seen marks that message seen; the wording is the senior\'s own or the family\'s', async () => {
  const chat = require('../chat');
  const id = memory.createProfile('Nseenc', 'female').id; care.setTimezone(id, 'Asia/Kolkata', 'manual');
  const tab = page(id);
  care.addSeniorReminder(id, { task: 'take my meds', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'app', origin: 'app' });
  care.addReminder(id, { task: 'drink water', dueAt: Date.now() + 3000, repeat: 'none', deliver: 'text', channel: 'app' });
  care.tick(Date.now() + 5000); await new Promise((r) => setTimeout(r, 50));
  const notices = tab.ev.filter(([k]) => k === 'notice').map(([, d]) => d);
  assert.equal(notices.length, 2, 'one notice per reminder: no duplicate firing');
  const own = notices.find((d) => /meds/.test(d.text)), fam = notices.find((d) => /water/i.test(d.text));
  assert.equal(own.message.text, 'Your reminder: take my meds'); assert.equal(fam.message.text, 'Reminder from your family: drink water');
  assert.deepEqual([own.message.reminder.notifId, own.message.reminder.seen], [own.notifId, false]);
  const thread = chat.loadThread(id).filter((m) => m.reminder); assert.equal(thread.length, 2, 'both stay in the chat history, once each');
  care.markNotif(id, own.notifId, 'seen');
  const after = chat.loadThread(id).filter((m) => m.reminder); assert.equal(after.find((m) => m.reminder.notifId === own.notifId).reminder.seen, true); assert.equal(after.find((m) => m.reminder.notifId === fam.notifId).reminder.seen, false);
  care.markNotif(id, own.notifId, 'seen'); assert.equal(tab.ev.filter(([k, d]) => k === 'noticeSeen' && d.notifId === own.notifId).length >= 1, true);
  tab.detach();
});
