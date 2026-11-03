// Per-senior Quiet hours switch (default OFF: ON only when explicitly set true). No network: Spark is stubbed. ON = a night check/reminder is held until 07:00 there; OFF = nothing is held; Tier A never asks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-quiet-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}',
  sparkStream: async (_h, _r, _s, onDelta) => { const t = 'Okay.'; if (onDelta) onDelta(t); return t; },
} };
const memory = require('../memory');
const care = require('../care');
const setrem = require('../setrem');

let n = 0;
const senior = (tz = 'UTC') => { const p = memory.createProfile(`Quiet${String.fromCharCode(97 + n++)}`, 'male'); if (tz) care.get(p.id).tz = tz; return p.id; };
const NIGHT = (() => { const d = new Date(); d.setUTCHours(23, 30, 0, 0); if (d.getTime() < Date.now() + 60000) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); })();   // the next 23:30 UTC, inside 22:00-07:00
const night = () => NIGHT;
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('1 default OFF for every senior (undefined = OFF); ON only when set true on purpose; the switch flips, persists, and shows in the family view', () => {
  const id = senior();
  assert.equal(care.quietOn(care.get(id)), false, 'a new senior: OFF'); assert.equal(care.view(id).quiet.on, false, 'the dashboard shows OFF');
  assert.equal(care.setQuietHours(id, true), true); assert.equal(care.quietOn(care.get(id)), true); assert.notEqual(care.view(id).quiet.on, false, 'ON: the view carries no "off" marker');
  care.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.MAYA_CARE_DIR, `${id}.json`), 'utf8'));
  assert.equal(saved.quietHours, true, 'persisted on disk');
  assert.equal(care.setQuietHours(id, false), false); assert.equal(care.view(id).quiet.on, false, 'OFF is explicit');
  assert.throws(() => care.setQuietHours(id, 'off'), /on or off/);
  assert.throws(() => care.setQuietHours('deadbeef', true), /Unknown/);
  // an existing profile saved before the field existed (undefined) is OFF; one explicitly true stays ON; one explicitly false stays OFF
  const old = senior(); delete care.get(old).quietHours; assert.equal(care.quietOn(care.get(old)), false); assert.equal(care.view(old).quiet.on, false);
  const yes = senior(); care.get(yes).quietHours = true; assert.equal(care.quietOn(care.get(yes)), true);
  const no = senior(); care.get(no).quietHours = false; assert.equal(care.quietOn(care.get(no)), false);
  assert.equal(care.inQuiet(old, night()), false, 'no hold when OFF by default'); assert.equal(care.inQuiet(yes, night()), true);
});

test('2 + 3 a night welfare check is held when ON (flag + log) and goes when OFF', async () => {
  const id = senior(); let sent = 0; care.setQuietHours(id, true);
  care.setWelfareSender({ blocked: () => null, fire: async () => { sent++; return { ok: true, state: 'sent' }; } });
  const start = () => { care.welfareScheduleStop(id); care.welfareScheduleStart(id, { everyMin: 60, via: 'text' }); care.get(id).welfareSchedule.next = night() - 1000; };
  start(); care.tick(night()); await new Promise((r) => setTimeout(r, 30));
  assert.equal(care.welfareScheduleView(id).held, true, 'ON: held');
  assert.equal(care.welfareScheduleView(id).fired, 0);
  care.setQuietHours(id, false);
  care.tick(night()); await new Promise((r) => setTimeout(r, 30));
  assert.equal(care.welfareScheduleView(id).held, false, 'OFF: no held reason');
  assert.equal(care.welfareScheduleView(id).fired, 1, 'OFF: the same night check goes');
  care.welfareScheduleStop(id);
});

test('2 + 3 a night reminder is held until 07:00 there when ON and not held when OFF', () => {
  for (const on of [true, false]) {
    const id = senior(); care.setQuietHours(id, on);
    const r = care.addReminder(id, { task: 'Take pills', dueAt: night() - 1000, repeat: 'none' });
    care.tick(night());
    const rr = care.get(id).reminders.find((x) => x.id === r.id);
    if (on) { assert.equal(rr.held, true, 'ON: held'); assert.equal(care.waitingUntil(care.get(id), rr, night()), NIGHT + 7.5 * 3600000, 'until 07:00'); }
    else { assert.ok(!rr.held, 'OFF: not held'); assert.equal(care.waitingUntil(care.get(id), rr, night()), null, 'OFF: no "until morning" text'); }
  }
});

test('3 OFF: quietNow / inQuiet / waiting text / what Maya promises all follow the switch; no timezone: nothing held either way', () => {
  const id = senior(); const p = care.get(id); care.setQuietHours(id, true);
  assert.equal(care.inQuiet(id, night()), true);
  assert.equal(setrem.quietHold({ task: 'x', dueAt: night() }, { tz: 'UTC', now: night() - 60000 }) !== null, true);
  care.setQuietHours(id, false);
  assert.equal(care.inQuiet(id, night()), false);
  assert.equal(setrem.quietHold({ task: 'x', dueAt: night() }, { tz: 'UTC', now: night() - 60000, quietOn: false }), null, 'Maya promises no hold when OFF');
  const none = senior(null); assert.equal(care.inQuiet(none, night()), false); assert.equal(care.view(none).quiet.on, false, 'toggle still shows, default OFF');
  void p;
});

test('4 Tier A safety alert fires at night in both ON and OFF (it never asks quiet hours)', () => {
  const src = read('care.js'); const fn = src.slice(src.indexOf('function selfHarmAlert'), src.indexOf('function selfHarmAlert') + 2500);
  assert.doesNotMatch(fn.split('\nfunction ')[0], /inQuiet|quietNow|quietOn/, 'the Tier A path does not consult quiet hours');
  for (const on of [true, false]) {
    const id = senior(); care.setQuietHours(id, on);
    const r = care.selfHarmAlert(id, {});
    assert.equal(r.isNew, true, `quiet hours ${on ? 'ON' : 'OFF'}: alert raised`);
    assert.equal(care.get(id).flags[0].level, 'alert'); assert.equal(care.get(id).flags[0].safety, true);
  }
});

test('5 dashboard + server wiring: switch per senior, warning text only when OFF, "held until" text only when ON', () => {
  const setup = read('app/lib/family/tab_setup.dart'), welfare = read('app/lib/family/tab_welfare.dart'), common = read('app/lib/family/common.dart'), srv = read('server.js');
  assert.match(setup, /Quiet hours/); assert.match(setup, /OFF may wake the senior at night\./); assert.match(setup, /\/quiethours/); assert.match(setup, /SwitchListTile/);
  assert.match(welfare, /q\['on'\] != false \? 'A check/, 'held until text follows the switch');
  assert.match(common, /quiet\['on'\] == false\) return false/, 'the reminder-time warning follows the switch');
  assert.match(srv, /b === 'quiethours'/);
  const js = read('public/family.js'), html = read('public/family.html');
  assert.match(html, /id="quietSw"/); assert.match(js, /OFF may wake the senior at night\./); assert.match(js, /\/quiethours/); assert.match(js, /quiet\.on === false/); assert.match(js, /quiet\.tz && quiet\.on !== false \? `A check/);
});
test.after(() => { care.stop(); for (const o of care.outreaches.values()) clearTimeout(o.timer); });
