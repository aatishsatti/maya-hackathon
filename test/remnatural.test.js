// Natural reminders: said in the senior's own words, the same way on a call, in a voice note and in typed chat; a short ask on a call happens RIGHT AFTER the hang-up;
// a promise to call back is a real call reminder (or she says plainly she cannot); no 1-minute timer as the pattern.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-remnat-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media'); process.env.MAYA_WA_DIR = path.join(tmp, 'wa');
const memory = require('../memory');
const care = require('../care');
const setrem = require('../setrem');
const TZ = 'Asia/Kolkata';
let n = 0; const person = () => memory.createProfile(`Rema${String.fromCharCode(97 + n++)}`, 'female').id;
const NIGHT = 'I have to take my medicine every night at 9 pm. Can you call me and remind me every night so I will take my medicine?';
const say = (id, text, origin) => setrem.step(id, text, { origin, tz: TZ });

// These three tests are about the DAYTIME wording ("right after you hang up"). At night (22:00 to 07:00 where they are) Maya says it is quiet hours instead (see setrem.test.js), so they run with the clock at midday.
const atNoon = (fn) => () => { const real = Date.now, d = new Date(real()); d.setUTCHours(12, 0, 0, 0); const off = d.getTime() - real(); Date.now = () => real() + off; try { return fn(); } finally { Date.now = real; } };

test('a natural recurring ask in the senior\'s own words becomes ONE plain daily call at 9 pm, whichever door it came by', () => {
  for (const origin of ['app', 'call', 'whatsapp']) {   // typed chat and a voice note both arrive as app / whatsapp text, a live call as call: the same system
    const id = person();
    const r = say(id, NIGHT, origin);
    assert.equal(r.label, 'setrem-confirm', origin);
    assert.match(r.text, /every day at 9:00 PM/); assert.match(r.text, /I will call you (?:in the Maya app|on WhatsApp) and remind you to take your medicine/);
    assert.doesNotMatch(r.text, /so i will/i, 'the task is the medicine, not the rest of the sentence');
    setrem.reset && setrem.reset();
  }
});

test('in-call ask: "remind me in a minute" is NOT agreed as a timer and NOT refused: she says she will remind them right after they hang up', atNoon(() => {
  const id = person();
  const r = say(id, 'Remind me in one minute to take my pills', 'call');
  assert.equal(r.label, 'setrem-confirm');
  assert.match(r.text, /I will remind you to take your pills right after you hang up the call/);
  assert.doesNotMatch(r.text, /in 1 minute|in one minute/);
  const sv = say(id, 'Yes', 'call');   // nothing is asked: a text in the app (WhatsApp is not set up for them)
  assert.equal(sv.label, 'setrem-saved');
  assert.match(sv.text, /right after you hang up the call/);
  const rem = care.get(id).reminders.find((x) => x.by === 'senior');
  assert.ok(rem.dueAt - Date.now() > 60 * 60000, 'parked while the call is on: it cannot fire during the call');
  // the call ends: it now comes right after the hang-up (not a minute-timer that ran during the call)
  const t0 = Date.now(); assert.equal(setrem.afterHangup(id), 1);
  const after = care.get(id).reminders.find((x) => x.id === rem.id);
  assert.ok(after.dueAt >= t0 + 5000 && after.dueAt <= t0 + 70000, 'due within about a minute of the hang-up');
  assert.equal(setrem.afterHangup(id), 0, 'once only');
}));

test('a promise to call back is a real call reminder: "call me back in 5 minutes" is understood, said back, and saved as a CALL', atNoon(() => {
  const id = person();
  const r = say(id, 'Can you call me back in 5 minutes', 'app');
  assert.equal(r.label, 'setrem-confirm'); assert.match(r.text, /in 5 minutes, I will call you for a chat/);
  const y = say(id, 'yes', 'app'); assert.equal(y.label, 'setrem-saved');
  const rem = care.get(id).reminders.find((x) => x.by === 'senior');
  assert.equal(rem.deliver, 'call'); assert.equal(rem.channel, 'app');
  assert.ok(Math.abs(rem.dueAt - (Date.now() + 5 * 60000)) < 20000, 'it is due in 5 minutes: the call is really scheduled');
}));

test('callback asked ON a call: "call me back in a minute" means right after this call, and it really calls', atNoon(() => {
  const id = person();
  const r = say(id, 'Call me back in a minute', 'call');
  assert.match(r.text, /I will call you right after you hang up this call/);
  const sv = say(id, 'yes', 'call');   // WhatsApp is not set up for them: no channel question, it comes to the app
  assert.equal(sv.label, 'setrem-saved');
  assert.equal(setrem.afterHangup(id), 1);
  assert.equal(care.get(id).reminders.find((x) => x.by === 'senior').deliver, 'call');
}));

test('a longer ask on a call keeps its real time (not parked): "every night at 9" is not an after-hang-up timer', () => {
  assert.equal(setrem.afterCall(setrem.parseRequest('remind me every night at 9 pm to take my pills', { tz: TZ }), { origin: 'call' }), false);
  assert.equal(setrem.afterCall(setrem.parseRequest('remind me in two hours to rest', { tz: TZ }), { origin: 'call' }), false);
});
