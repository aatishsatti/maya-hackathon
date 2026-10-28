// The "What changed" card on the family page: runs public/family.js in a fake browser against the real care.js / trends.js.
// Family page only. The test sentences exist only in this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-card-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const memory = require('../memory');
const care = require('../care');
const T = require('../trends');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'family.js'), 'utf8');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.hidden = false; this.value = ''; this.className = ''; this.handlers = {}; }
  append(...k) { this.children.push(...k); } replaceChildren(...k) { this.children = k; }
  addEventListener(e, f) { this.handlers[e] = f; } focus() {}
  text() { return [this.textContent, ...this.children.map((c) => c.text())].join(' ').replace(/\s+/g, ' ').trim(); }
  classes() { return [this.className, ...this.children.flatMap((c) => c.classes())]; }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// opts.trend(url, id) -> body (or throws / returns a promise); calls records every request.
function dashboard(id, { trend, profiles } = {}) {
  const els = {}; const calls = []; const timers = new Map(); let tid = 0;
  const document = { getElementById: (i) => (els[i] = els[i] || new El('x')), createElement: (t) => new El(t) };
  const sandbox = {
    document, window: {}, localStorage: { getItem: () => id, setItem() {} }, Date, JSON, Promise, console, Intl,
    EventSource: class { addEventListener() {} },
    setInterval: (fn, ms) => { tid += 1; timers.set(tid, { fn, ms }); return tid; }, clearInterval: (i) => timers.delete(i),
    fetch: async (url, o = {}) => {
      calls.push({ url, method: o.method || 'GET' });
      const m = /^\/api\/care\/([a-f0-9]{8})(\/trend)?$/.exec(url);
      let body;
      if (url === '/api/profiles') body = { profiles: profiles || memory.listProfiles() };
      else if (m && m[2]) body = trend ? await trend(url, m[1]) : care.trendView(m[1]);
      else if (m) body = care.view(m[1]);
      else body = {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    },
  };
  vm.runInNewContext(SRC, sandbox);
  return { els, calls, poll: () => [...timers.values()].forEach((t) => t.fn()), card: () => els.trend.text(), classes: () => els.trend.classes().join(' ') };
}

let n = 0; const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
const senior = () => memory.createProfile(`Cora${letters(n++)}`, 'female').id;
const today = (id) => care.localParts(Date.now(), care.get(id).tz).date;
function seed(id, kind) {
  const p = care.get(id); const t = today(id);
  p.days = Array.from({ length: 29 }, (_, i) => {
    const k = 29 - i, bad = kind !== 'steady' && k <= 8;
    return { ...T.blank(T.addDays(t, -k)), calls: 2, turns: bad && kind === 'notable' ? 4 : 12 + (i * 7) % 5, heavy: bad && kind === 'notable' ? 3 : (i % 3 === 0 ? 2 : 1), pain: bad ? 3 : (i % 11 === 0 ? 1 : 0), remindersDue: 2, remindersMissed: i % 13 === 0 ? 1 : 0, callbacks: bad && kind === 'notable' ? 2 : 0, firstMin: 520 + (i * 17) % 50 };
  });
  p.trend = null;
}

test('C1 still learning: says so, how many more days, and is neither yellow nor red', async () => {
  const id = senior(); care.get(id).days = [T.blank(T.addDays(today(id), -2))]; care.get(id).trend = null;
  const d = dashboard(id); await settle();
  assert.match(d.card(), /Still learning/); assert.match(d.card(), /Nothing is judged yet: \d+ more days of daily counts are needed first \(\d+ of 19 so far\)/);
  assert.doesNotMatch(d.classes(), /\bflag\b|\balert\b|\bresolved\b/);
  assert.equal(d.els.body.hidden, false, 'the rest of the page is there'); assert.match(d.els.presence.text(), /Last seen/);
});

test('C2 nothing unusual: a calm green card, in their name', async () => {
  const id = senior(); seed(id, 'steady');
  const d = dashboard(id); await settle();
  assert.match(d.card(), /Nothing unusual/); assert.match(d.card(), /Cora[a-z]+ looks like Cora[a-z]+'s usual/); assert.match(d.card(), /last 8 days/);
  assert.match(d.classes(), /resolved/); assert.doesNotMatch(d.classes(), /\bflag\b|\balert\b/);
});

test('C3 a noticeable change: yellow (never red), the evidence lines with their numbers, since when, and what it is and is not', async () => {
  const id = senior(); seed(id, 'notable');
  const d = dashboard(id); await settle();
  const t = d.card();
  assert.match(t, /Noticeable change/); assert.match(t, /A change from Cora[a-z]+'s usual/);
  assert.match(t, /Spoke less: about 4(\.0)? things said a day lately, usual is about 1[2-6]/); assert.match(t, /Pain mentioned about 3/); assert.match(t, /\(shifted on \d of the last 8 days\)/);
  assert.match(t, /Since \w{3},? (\w{3} \d+|\d+ \w{3})/, 'the date is shown in the viewer\'s own locale order'); assert.match(t, /Dashboard only/); assert.match(t, /Counts only: no words, topics or audio/);
  assert.match(t, /not a diagnosis and not advice/);
  assert.match(d.classes(), /\bflag\b/); assert.doesNotMatch(d.classes(), /\balert\b|\bclosed\b/);
});

test('C4 worth watching: one kind of signal gets the gentler label', async () => {
  const id = senior(); seed(id, 'pain');
  const d = dashboard(id); await settle();
  assert.match(d.card(), /Worth watching/); assert.doesNotMatch(d.card(), /Noticeable change/); assert.match(d.card(), /Pain mentioned about 3/);
});

test('C5 server text is shown as text, never as markup: the page uses no HTML insertion at all', async () => {
  const id = senior();
  const d = dashboard(id, { trend: async () => ({ status: 'notable', since: '2026-10-20', learning: false, lines: ['<img src=x onerror=alert(1)>Spoke less <script>alert(2)</script>'], daysSoFar: 30, daysNeeded: 19 }) });
  await settle();
  assert.ok(d.card().includes('<img src=x onerror=alert(1)>'), 'shown literally as text');
  assert.doesNotMatch(SRC.replace(/\/\/.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test('C6 if the trend request fails the card says so and the rest of the dashboard is unaffected (no error banner)', async () => {
  const id = senior(); care.addReminder(id, { task: 'drink water', dueAt: Date.now() + 3600000, repeat: 'none' });
  const d = dashboard(id, { trend: async () => { throw new Error('boom'); } });
  await settle();
  assert.match(d.card(), /Not available right now/); assert.match(d.els.reminders.text(), /drink water/); assert.equal(d.els.err.hidden === true || d.els.err.textContent === '', true, 'no error banner');
});

test('C7 an empty or unknown answer is "not available", never a half-drawn card', async () => {
  const id = senior();
  for (const body of [{}, null, { status: '' }]) { const d = dashboard(id, { trend: async () => body }); await settle(); assert.match(d.card(), /Not available right now/); }
});

test('C8 the page only ever reads trends (GET) from the family-only route; it never writes them', async () => {
  const id = senior(); seed(id, 'steady');
  const d = dashboard(id); await settle(); d.poll(); await settle();
  const t = d.calls.filter((c) => /trend/.test(c.url));
  assert.ok(t.length >= 2, 'refreshed with the page'); assert.ok(t.every((c) => c.method === 'GET' && c.url === `/api/care/${id}/trend`));
});

test('C9 an old answer never overwrites the card after switching to another person', async () => {
  const a = senior(), b = senior(); seed(a, 'notable'); seed(b, 'steady');
  let release; const gate = new Promise((r) => { release = r; });
  const d = dashboard(a, { trend: async (url, who) => { if (who === a) { await gate; } return care.trendView(who); } });
  await settle();                                    // A's trend request is still in flight
  d.els.who.value = b; d.els.who.handlers.change(); await settle();
  assert.match(d.card(), /Nothing unusual/, 'B shown');
  release(); await settle();
  assert.match(d.card(), /Nothing unusual/); assert.doesNotMatch(d.card(), /Noticeable change/, 'the late answer for A was dropped');
});

test('C10 the page structure: one new section, no chart, graph, score or colour-only meaning; the senior app is untouched', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'family.html'), 'utf8');
  assert.match(html, /<h2>What changed<\/h2>/); assert.match(html, /id="trend"/); assert.ok(!/<canvas|<svg|chart|graph|score/i.test(html + SRC));
  for (const f of ['app.js', 'inbox.js', 'profiles.js', 'index.html', 'orb.js', 'chat-ui.js', 'chat-client.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), /\/trend|What changed|trendCard/, `${f} does not show trends`);
});

test.after(() => care.stop());
