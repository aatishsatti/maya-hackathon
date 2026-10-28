// Scam tickets in care.js (no network). yes -> topic-only alert; no -> dashboard flag only; Seen clears; 2-day light expiry; the
// senior talking, the silence rules and the greeting never touch a scam ticket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scam-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: { requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', sparkStream: async () => '' } };

const memory = require('../memory');
const care = require('../care');

let n = 0;
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Rose${letters(n++)}`, 'female').id;
const family = () => { const ev = []; care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } }); return ev; };
const LETTER_WORDS = /lottery|winner|wire|gift card|bank account|\$\d|password|transcript/i;

test('scam: yes -> one alert to the family, topic only (the kind of scam, never the letter, a transcript or a photo)', () => {
  const ev = family(); const id = senior();
  care.scamAsk(id, 'prize scam');
  assert.equal(care.scamPending(id).type, 'prize scam');
  const r = care.scamAnswer(id, true);
  assert.equal(r.isNew, true);
  const v = care.view(id);
  assert.equal(v.scams.length, 1); assert.equal(v.scams[0].level, 'alert'); assert.equal(v.scams[0].status, 'active');
  const note = v.scams[0].timeline; assert.ok(note.some((s) => s.label === 'Alert sent to you'));
  const sent = ev.filter((e) => e.ev === 'notify' && e.data.id === id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].data.text, /possible prize scam/);
  assert.ok(!LETTER_WORDS.test(sent[0].data.text), sent[0].data.text);
  assert.equal(care.scamPending(id), null, 'the question is answered once');
  assert.equal(care.scamAnswer(id, true), null, 'a second yes with nothing pending does nothing');
});

test('scam: no -> a dashboard Flag only: no notification, no push, no alert, and no new question', () => {
  const ev = family(); const id = senior();
  care.scamAsk(id, 'payment scam');
  const before = ev.length;
  const r = care.scamAnswer(id, false);
  assert.equal(r.isNew, true);
  const v = care.view(id);
  assert.equal(v.scams[0].level, 'flag'); assert.equal(v.scams[0].notifId, null);
  assert.equal(care.get(id).notifications.filter((x) => x.to === 'family').length, 0, 'nothing sent to the family');
  assert.equal(ev.length, before, 'no push of any kind to a family page');
  assert.equal(v.alerts.length, 0);
  assert.equal(care.scamPending(id), null);
  assert.ok(v.scams[0].timeline[0].label.includes('this page only'));
});

test('scam: Seen clears an alert (same route as every other alert), and the family hears nothing more', () => {
  const ev = family(); const id = senior();
  care.scamAsk(id, 'bank impersonation scam'); care.scamAnswer(id, true);
  const nid = care.view(id).scams[0].notifId;
  assert.ok(nid);
  assert.equal(care.markNotif(id, nid, 'seen'), true);
  const sc = care.view(id).scams[0];
  assert.equal(sc.status, 'resolved'); assert.equal(sc.resolvedBy, 'family');
  assert.ok(sc.timeline.some((s) => s.label === 'You saw this'));
  assert.ok(ev.some((e) => e.ev === 'refresh'));
});

test('scam: a second yes in the same incident adds no second alert; a flag the person declined earlier becomes the alert on a later yes', () => {
  const id = senior();
  care.scamAsk(id, 'prize scam'); care.scamAnswer(id, false);
  assert.equal(care.view(id).scams.length, 1);
  care.scamAsk(id, 'prize scam'); const up = care.scamAnswer(id, true);
  assert.equal(up.isNew, true);
  assert.equal(care.view(id).scams.length, 1, 'upgraded, not duplicated');
  assert.equal(care.view(id).scams[0].level, 'alert');
  care.scamAsk(id, 'prize scam'); const again = care.scamAnswer(id, true);
  assert.equal(again.isNew, false);
  assert.equal(care.get(id).notifications.filter((x) => x.to === 'family' && x.kind === 'alert').length, 1, 'one alert for one incident');
});

test('scam: the senior talking, the silence rules and the greeting never touch a scam ticket', () => {
  const id = senior();
  care.scamAsk(id, 'prize scam'); care.scamAnswer(id, true);
  const sc = () => care.view(id).scams[0];
  care.onSeniorSpoke(id);                                   // "back and okay now" is for couldn't-reach flags only
  assert.equal(sc().status, 'active');
  assert.equal(care.hasActiveFlag(id), false, 'a scam is not a couldn\'t-reach flag: no worried greeting');
  assert.equal(care.hasActiveSafety(id), false, 'and not a safety ticket: no call-back rings');
  assert.equal(care.get(id).flags.length, 0, 'scams live in their own list');
  assert.equal(care.view(id).alerts.length, 0);
});

test('scam: unseen it closes after 2 days (the light rule, not the 3-day safety rule); an alert tells the family, a flag is silent', () => {
  const ev = family();
  const a = senior(), f = senior();
  care.scamAsk(a, 'prize scam'); care.scamAnswer(a, true);
  care.scamAsk(f, 'prize scam'); care.scamAnswer(f, false);
  const t0 = care.get(a).scams[0].createdAt;
  care.tick(t0 + care.cfg.expireLightMs - 1000);
  assert.equal(care.view(a).scams[0].status, 'active', 'not yet at 2 days');
  care.tick(t0 + care.cfg.expireLightMs + 1000);
  assert.equal(care.view(a).scams[0].status, 'expired');
  assert.ok(care.cfg.expireLightMs < care.cfg.expireCriticalMs);
  assert.equal(care.view(a).scams[0].expiredDays, 2);
  const note = care.get(a).notifications.find((x) => x.kind === 'expired');
  assert.match(note.text, /scam warning/); assert.match(note.text, /closed unseen/); assert.ok(!/is safe/.test(note.text), 'never claims anyone is safe');
  assert.equal(care.view(f).scams[0].status, 'expired');
  assert.equal(care.get(f).notifications.length, 0, 'an expired flag says nothing to the family');
  assert.ok(care.view(a).scams[0].timeline.some((s) => /Closed unseen/.test(s.label)));
  assert.ok(ev.length > 0);
});

test('scam question: pending lasts 20 minutes, an unclear answer leans in once more then lets go, and a clear one clears it', () => {
  const id = senior();
  care.scamAsk(id, 'payment scam');
  care.scamUnclear(id); assert.ok(care.scamPending(id), 'one more try');
  care.scamUnclear(id); assert.equal(care.scamPending(id), null, 'then she lets it go');
  care.scamAsk(id, 'payment scam'); care.get(id).pendingScam.at -= 21 * 60000;
  assert.equal(care.scamPending(id), null, 'a stale question is gone');
  assert.equal(care.scamAnswer(id, true), null, 'so a late yes does nothing');
  assert.equal(care.view(id).scams.length, 0);
});

test('dashboard data: call count and scams are in the one view; the picker counts a scam alert as an alert and a scam flag as a flag', () => {
  const id = senior();
  assert.equal(care.view(id).callCount, 0);
  care.scamAsk(id, 'prize scam'); care.scamAnswer(id, true);
  const o = care.overview().find((x) => x.id === id);
  assert.equal(o.alerts, 1); assert.equal(o.flags, 0);
  const id2 = senior(); care.scamAsk(id2, 'prize scam'); care.scamAnswer(id2, false);
  const o2 = care.overview().find((x) => x.id === id2);
  assert.equal(o2.flags, 1); assert.equal(o2.alerts, 0);
});
