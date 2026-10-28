// Scam shield for spoken / typed talk: the three extra reads (remote access, happening now, about to act), the pause level, and the Spark text call.
// The sentences below exist only in this test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scam');

const sig = (...on) => Object.fromEntries(S.SIGNALS.map((k) => [k, on.includes(k)]));
const reads = (...on) => Object.fromEntries(S.READS.map((k) => [k, on.includes(k)]));

test('the photo path is untouched: five signals, the same levels, and levelOf called the old way never returns pause', () => {
  assert.deepEqual(S.SIGNALS, ['urgency', 'money', 'impersonation', 'secrecy', 'payment']);
  assert.deepEqual(S.levelOf(sig('money', 'payment')), { count: 2, level: 'warn' });
  assert.deepEqual(S.levelOf(sig('urgency')), { count: 1, level: 'caution' });
  assert.equal(S.levelOf(sig('urgency', 'money', 'impersonation', 'secrecy', 'payment')).level, 'warn');
  assert.deepEqual(S.READS, ['remoteAccess', 'idDetails', 'happeningNow', 'aboutToAct']);
  assert.doesNotMatch(S.ASK, /remoteAccess|idDetails|happeningNow|aboutToAct/, 'the photo prompt does not mention the new reads');
});

test('remote access counts as one more warning sign; it never makes a scam by itself (one sign is only a caution)', () => {
  assert.deepEqual(S.levelOf(sig(), reads('remoteAccess')), { count: 1, level: 'caution' });
  assert.deepEqual(S.levelOf(sig('impersonation'), reads('remoteAccess')), { count: 2, level: 'warn' });
  assert.deepEqual(S.levelOf(sig(), reads()), { count: 0, level: 'none' });
});

test('identity details: being asked for ID numbers or a date of birth by someone who contacted them is a warn on its own, and a pause when they are about to give them', () => {
  assert.deepEqual(S.levelOf(sig(), reads('idDetails')), { count: 2, level: 'warn' });
  assert.equal(S.levelOf(sig(), reads('idDetails', 'aboutToAct')).level, 'pause');
  assert.equal(S.levelOf(sig(), reads('idDetails', 'happeningNow')).level, 'warn', 'still being pressed, but not about to give them: a warn');
  assert.deepEqual(S.levelOf(sig('impersonation'), reads('idDetails')), { count: 3, level: 'warn' });
  assert.match(S.ASK_TALK, /ordinary check by a service they themselves called or were expecting/, 'a clinic confirming a date of birth for a booked appointment is not a scam');
  assert.match(S.ASK_TALK, /- idDetails:/);
});

test('pause: a warn that is also about to happen. Being about to pay never pauses an innocent message', () => {
  const warn = sig('money', 'payment');
  assert.equal(S.levelOf(warn, reads()).level, 'warn', 'a warn that is not about to happen stays a warn');
  assert.equal(S.levelOf(warn, reads('happeningNow')).level, 'warn', 'happening now alone is not enough');
  assert.equal(S.levelOf(warn, reads('aboutToAct')).level, 'pause');
  assert.equal(S.levelOf(sig('impersonation'), reads('remoteAccess', 'aboutToAct')).level, 'pause', 'remote access plus about to act');
  assert.equal(S.levelOf(sig('urgency'), reads('aboutToAct')).level, 'caution', 'one sign and about to act, with nobody pressing: only a caution');
  assert.equal(S.levelOf(sig('urgency'), reads('aboutToAct', 'happeningNow')).level, 'pause', 'one sign, about to act, and still being pressed now');
  assert.deepEqual(S.levelOf(sig(), reads('aboutToAct', 'happeningNow')), { count: 0, level: 'none' }, 'a genuine payment: no signs, never paused');
  assert.deepEqual(S.levelOf(sig(), reads('aboutToAct')), { count: 0, level: 'none' });
});

test('the talk prompt: the five definitions come from the photo prompt, the three new reads are defined, and genuine payments are not scams', () => {
  for (const k of S.SIGNALS) assert.ok(S.ASK_TALK.includes(`- ${k}:`), k);
  for (const k of S.READS) assert.ok(S.ASK_TALK.includes(`- ${k}:`) && S.ASK_TALK.includes(`"${k}":true|false`), k);
  const def = (k) => S.ASK.split('\n').find((l) => l.startsWith(`- ${k}:`));
  for (const k of S.SIGNALS) assert.ok(S.ASK_TALK.includes(def(k)), `${k} is defined exactly as in the photo prompt`);
  assert.match(S.ASK_TALK, /telling you about a message, phone call, visit or web page/);
  assert.match(S.ASK_TALK, /all nine false/); assert.match(S.ASK_TALK, /not from single words/); assert.match(S.ASK_TALK, /is not a scam: aboutToAct on its own does not make anything one/);
  assert.ok(!/\d{3}[- ]\d{3,4}/.test(S.ASK_TALK), 'no phone numbers'); assert.doesNotMatch(S.ASK_TALK, /gift card scam|IRS|Microsoft/i, 'no invented list of scams or companies');
});

test('parse reads the three extra reads; missing means false; the old fields are unchanged', () => {
  const o = S.parse('{"reading":"A caller wants gift cards.","type":"payment scam","urgency":true,"money":false,"impersonation":true,"secrecy":false,"payment":true,"remoteAccess":"no","happeningNow":true,"aboutToAct":"yes"}');
  assert.deepEqual(o.reads, { remoteAccess: false, idDetails: false, happeningNow: true, aboutToAct: true }); assert.equal(o.signals.payment, true);
  assert.deepEqual(S.parse('{"reading":"r","type":"t"}').reads, { remoteAccess: false, idDetails: false, happeningNow: false, aboutToAct: false });
  assert.equal(S.parse('junk'), null);
});

function withFetch(fake, fn) { const real = global.fetch; global.fetch = fake; return Promise.resolve(fn()).finally(() => { global.fetch = real; }); }
const reply = (obj) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] }) });

test('assessText: one Spark text call; the level is decided in code from the answer; the message goes in, the key stays in the header', async () => {
  process.env.META_API_KEY = 'test-key-not-real';
  let seen;
  const r = await withFetch(async (url, o) => { seen = { url, o }; return reply({ reading: 'A caller wants gift cards now.', type: 'gift card scam', urgency: true, money: false, impersonation: true, secrecy: false, payment: true, remoteAccess: false, happeningNow: true, aboutToAct: true })(); }, () => S.assessText('He wants gift cards and I am going to the shop now.'));
  assert.equal(r.level, 'pause'); assert.equal(r.count, 3); assert.equal(r.type, 'gift card scam'); assert.equal(r.reads.aboutToAct, true);
  const body = JSON.parse(seen.o.body); assert.match(body.messages[0].content, /gift cards and I am going to the shop now/); assert.match(body.messages[0].content, /nine from this message/);
  assert.equal(body.reasoning_effort, 'minimal', 'the live setting for the talk check'); assert.equal(S.TALK_REASONING, 'minimal'); assert.equal(seen.o.headers.Authorization, 'Bearer test-key-not-real'); assert.ok(!body.messages[0].content.includes('test-key-not-real'));
  const calm = await withFetch(reply({ reading: 'A reminder.', type: 'ordinary message', urgency: false, money: false, impersonation: false, secrecy: false, payment: false, remoteAccess: false, idDetails: false, happeningNow: false, aboutToAct: false }), () => S.assessText('Your appointment is Tuesday.'));
  assert.deepEqual([calm.level, calm.count], ['none', 0]);
  const long = await withFetch(async (u, o) => { assert.ok(JSON.parse(o.body).messages[0].content.length < S.ASK_TALK.length + 2200, 'a very long message is cut'); return reply({ reading: 'x', type: 't' })(); }, () => S.assessText('x'.repeat(9000)));
  assert.equal(long.level, 'none');
});

test('the reasoning setting: minimal by default, an explicit setting is honoured, and the photo check is unchanged (still low)', async () => {
  process.env.META_API_KEY = 'test-key-not-real'; const seen = [];
  const spy = async (url, o) => { seen.push(JSON.parse(o.body).reasoning_effort); return reply({ reading: 'x', type: 't', urgency: false, money: false, impersonation: false, secrecy: false, payment: false })(); };
  await withFetch(spy, () => S.assessText('hello there my friend')); await withFetch(spy, () => S.assessText('hello there my friend', undefined, { reasoning: 'low' }));
  await withFetch(spy, () => S.assess(Buffer.from('img'), 'image/png'));
  assert.deepEqual(seen, ['minimal', 'low', 'low']);
});

test('assessText: a Meta error or an unusable answer throws, never a made-up verdict', async () => {
  process.env.META_API_KEY = 'test-key-not-real';
  await assert.rejects(withFetch(async () => ({ ok: false, status: 503, text: async () => 'busy' }), () => S.assessText('hello')), /Meta Spark failed \(HTTP 503\) busy/);
  await assert.rejects(withFetch(reply('not json at all'), () => S.assessText('hello')), /no usable scam check/);
  await assert.rejects(withFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }), () => S.assessText('hello')), /no usable scam check/);
});

test('nothing of the message is kept: assessText returns the reading and the kind only, and the reading is not stored by this module', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'scam.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /writeFile|appendFile|localStorage|memory\.|care\./);
});
