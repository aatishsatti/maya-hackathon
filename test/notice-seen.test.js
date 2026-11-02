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
