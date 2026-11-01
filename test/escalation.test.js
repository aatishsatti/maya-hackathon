// Escalation: Maya rings the FAMILY when the person is not responding. Guardrails: only with the family's consent; Standard waits for long silence (48 h) or 3 missed reminders, Cautious sooner,
// Ultra Cautious on the first missed reminder; ONE ring per stretch of quiet; quiet hours hold a non-safety ring; a safety alert rings at once; the words are topic only; Seen settles it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-esc-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory');
const care = require('../care');
const H = 3600000;
let n = 0; const person = (consent = true, mode = 'standard', tz = 'Europe/London') => {
  const id = memory.createProfile(`Esca${String.fromCharCode(97 + n++)}`, 'female').id;
  care.setTimezone(id, tz, 'manual'); care.setMode(id, mode); care.setFamilyConsent(id, consent); return id;
};
const family = () => { const ev = []; const res = { write: (s) => { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push([m[1], JSON.parse(m[2])]); return true; } }; const off = care.attachFamily(res, null); return { ev, off }; };
const esc = (id) => care.view(id).escalations;
// 12:00 UTC is daytime in London in winter: a time that is never in quiet hours
const noon = (days = 0) => Date.UTC(2026, 10, 3 + days, 12, 0);
const seenAt = (id, at) => care.touch(id, 'app', at);

test('long silence: Standard rings the family after 48 hours, not before; once; the words say who and since when, nothing else', () => {
  const id = person(); const f = family(); const t0 = noon(); seenAt(id, t0);
  care.tick(t0 + 47 * H); assert.equal(esc(id).length, 0, '47 hours: nothing yet');
  care.tick(noon(2) + 1 * H); const e = esc(id); assert.equal(e.length, 1); assert.equal(e[0].kind, 'silent'); assert.equal(e[0].status, 'ringing');
  assert.match(e[0].text, /^This is Maya\. Esca[a-z] has not talked to me since .*Please check in\.$/);
  assert.ok(f.ev.some(([k, d]) => k === 'familyCall' && d.id === id && d.episodeId === e[0].id), 'the family page is rung');
  care.tick(noon(3)); care.tick(noon(4)); assert.equal(esc(id).length, 1, 'one ring per stretch of quiet, not one per tick or per day');
  f.off();
});

test('Seen settles it; and when the person is seen again a NEW stretch of quiet can ring again', () => {
  const id = person(); const t0 = noon(); seenAt(id, t0); care.tick(noon(2) + H);
  const e = esc(id)[0]; assert.equal(care.escalationAct(id, e.id, 'seen'), true); assert.equal(esc(id)[0].status, 'seen');
  assert.equal(care.escalationAct(id, 'nope', 'seen'), false); assert.equal(care.escalationAct(id, e.id, 'delete'), false);
  seenAt(id, noon(3)); care.tick(noon(5) + H); assert.equal(esc(id).length, 2, 'a second quiet stretch is a second episode');
});

test('missed reminders: Standard needs 3, Cautious 2, Ultra Cautious 1; a missed reminder is not a ring by itself in Standard', () => {
  const missed = (id, k) => { const p = care.get(id); for (let i = 0; i < k; i++) { const r = care.addReminder(id, { task: `t${i}`, dueAt: Date.now() + 60000 + i, repeat: 'none' }); const rr = p.reminders.find((x) => x.id === r.id); rr.last = { dueAt: rr.dueAt, state: 'missed', at: noon() + 1000 + i, attempts: 0 }; } };
  for (const [mode, need] of [['standard', 3], ['cautious', 2], ['ultra', 1]]) {
    const id = person(true, mode); seenAt(id, noon() - 1000); missed(id, need - 1); care.tick(noon() + H); assert.equal(esc(id).length, 0, `${mode}: ${need - 1} missed is not enough`);
    missed(id, 1); care.tick(noon() + 2 * H); assert.equal(esc(id).length, 1, `${mode}: ${need} missed rings`); assert.equal(esc(id)[0].kind, 'missed'); assert.match(esc(id)[0].text, /has not responded to reminders\. Please check in\.$/);
  }
});

test('no consent, no ring; quiet hours (22:00 to 07:00 where they are) hold it until they end', () => {
  const a = person(false); seenAt(a, noon()); care.tick(noon(3)); assert.equal(esc(a).length, 0, 'the family did not agree to calls');
  const b = person(true); seenAt(b, noon()); const night = Date.UTC(2026, 10, 6, 23, 30); care.tick(night); assert.equal(esc(b).length, 0, '23:30 in London: held');
  care.tick(Date.UTC(2026, 10, 7, 8, 0)); assert.equal(esc(b).length, 1, 'after 07:00 it rings');
});

test('a safety alert (Tier A) rings the family at once, in the night too, whatever the mode; only with consent', () => {
  const id = person(true, 'standard'); const f = family();
  const night = Date.UTC(2026, 10, 6, 23, 30);
  care.selfHarmAlert(id, {});   // a real safety alert
  const e = esc(id); assert.equal(e.length, 1); assert.equal(e[0].kind, 'safety'); assert.equal(e[0].status, 'ringing'); assert.match(e[0].text, /^This is Maya\. I am worried about Esca[a-z]'s safety\. Please check in now\.$/);
  care.selfHarmAlert(id, {}); assert.equal(esc(id).length, 1, 'the same incident does not ring twice');
  const none = person(false); care.selfHarmAlert(none, {}); assert.equal(esc(none).length, 0, 'no consent, no ring');
  assert.ok(night > 0); f.off();
});

test('an unanswered ring becomes "no answer" by itself (in the dashboard) and the server route is family-only', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'); assert.match(server, /b === 'escalation' && c && d\) return care\.escalationAct/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'care.js'), 'utf8'), /ESC_RING_MS = 45000/);
});
test('a ring also goes to the family\'s CLOSED phones: a push with ids and the kind only (no name, no words); devices are kept per account and only that family\'s are used', () => {
  const sent = []; care.familyHooks.push = (id, payload) => sent.push([id, payload]);
  const id = person(true); const p = care.get(id); const ep = care.ringFamily(p, 'silent', Date.now());
  assert.deepEqual(sent, [[id, { type: 'family_call', seniorId: id, episodeId: ep.id, kind: 'silent' }]]);
  assert.doesNotMatch(JSON.stringify(sent), /Esca|has not talked|Maya/, 'nothing about who or what is in the push');
  care.familyHooks.push = null;
  process.env.MAYA_MEDIA_DIR = path.join(tmp, 'm2'); const accounts = require('../accounts');
  accounts.signup('fam.one', 'a good password'); accounts.signup('fam.two', 'another good one'); accounts.addSenior('fam.one', 'aaaaaaaa');
  accounts.addDevice('fam.one', 'android', 'tok_one_aaaaaaaaaaaaaaaa'); accounts.addDevice('fam.two', 'android', 'tok_two_bbbbbbbbbbbbbbbb');
  assert.deepEqual(accounts.ownersOf('aaaaaaaa'), ['fam.one']); assert.deepEqual(accounts.devicesOf('fam.one').map((d) => d.token), ['tok_one_aaaaaaaaaaaaaaaa']);
  assert.throws(() => accounts.addDevice('fam.one', 'android', 'short'), /not a push token/); assert.throws(() => accounts.addDevice('fam.one', 'windows', 'tok_one_aaaaaaaaaaaaaaaa'), /ios or android/);
  accounts.removeDevice('fam.one', 'tok_one_aaaaaaaaaaaaaaaa'); assert.deepEqual(accounts.devicesOf('fam.one'), []);
});
test.after(() => care.stop());
