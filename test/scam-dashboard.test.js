// The one-screen family dashboard with scam cards: real public/family.js in a fake browser against the real care.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-scamdash-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const memory = require('../memory');
const care = require('../care');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.hidden = false; this.value = ''; this.className = ''; this.handlers = {}; }
  append(...k) { this.children.push(...k); } replaceChildren(...k) { this.children = k; }
  addEventListener(e, f) { this.handlers[e] = f; } focus() {}
  text() { return [this.textContent, ...this.children.map((c) => c.text())].join(' '); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find(pred); if (f) return f; } return null; }
}
const tick = () => new Promise((r) => setImmediate(r));
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
let n = 0;

function dashboard(id) {
  const els = {}; const es = { l: {} }; const posted = [];
  const document = { getElementById: (i) => (els[i] = els[i] || new El('x')), createElement: (t) => new El(t) };
  const sandbox = {
    document, window: {}, localStorage: { getItem: () => id, setItem() {} }, Date, JSON, Promise, console, Intl,
    EventSource: class { constructor() { es.l = {}; this.l = es.l; } addEventListener(e, f) { es.l[e] = f; } },
    setInterval: () => 1, clearInterval() {},
    fetch: async (url, opts = {}) => {
      const view = /^\/api\/care\/([a-f0-9]{8})$/.exec(url), seen = /^\/api\/care\/([a-f0-9]{8})\/notifications\/([a-f0-9]+)\/seen$/.exec(url);
      if (seen) { posted.push(url); care.markNotif(seen[1], seen[2], 'seen'); return { ok: true, status: 200, json: async () => ({}) }; }
      const body = url === '/api/profiles' ? { profiles: memory.listProfiles() } : view ? care.view(view[1]) : {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    },
  };
  vm.runInNewContext(SRC, sandbox);
  return { els, posted };
}
const senior = () => memory.createProfile(`Opal${letters(n++)}`, 'female').id;

test('scam alert: a red card in Alerts with the kind of scam only, a Seen button on the same route as other alerts; Seen turns it green', async () => {
  const id = senior();
  care.scamAsk(id, 'prize scam'); care.scamAnswer(id, true);
  const d = dashboard(id); await tick(); await tick();
  const txt = d.els.alerts.text();
  assert.match(txt, /Scam alert/); assert.match(txt, /possible prize scam/); assert.match(txt, /Notification sent/); assert.match(txt, /Topic only: no letter text, no photo/);
  assert.doesNotMatch(txt, /lottery|wire|gift card|\$\d/i);
  assert.match(d.els.flags.text(), /No flags/);
  const btn = d.els.alerts.find((e) => e.tag === 'button' && /seen this/.test(e.textContent));
  assert.ok(btn, 'a Seen button');
  btn.handlers.click(); await tick(); await tick(); await tick();
  assert.equal(d.posted.length, 1); assert.match(d.posted[0], /\/notifications\/[a-f0-9]+\/seen$/);
  assert.match(d.els.alerts.text(), /Seen/); assert.match(d.els.alerts.text(), /A family member has seen this/);
  assert.equal(d.els.alerts.find((e) => e.tag === 'button'), null, 'nothing left to press');
});

test('scam flag (they said no): a yellow Flag card, dashboard only, no Seen button, never in Alerts', async () => {
  const id = senior();
  care.scamAsk(id, 'payment scam'); care.scamAnswer(id, false);
  const d = dashboard(id); await tick(); await tick();
  assert.match(d.els.alerts.text(), /No alerts/);
  const txt = d.els.flags.text();
  assert.match(txt, /Flag/); assert.match(txt, /possible payment scam/); assert.match(txt, /chose not to alert you/); assert.match(txt, /Dashboard only/);
  assert.equal(d.els.flags.find((e) => e.tag === 'button'), null);
});

test('expired scam alert: grey, "Closed unseen", never shown as handled', async () => {
  const id = senior();
  care.scamAsk(id, 'prize scam'); care.scamAnswer(id, true);
  care.tick(care.get(id).scams[0].createdAt + care.cfg.expireLightMs + 1000);
  const d = dashboard(id); await tick(); await tick();
  const txt = d.els.alerts.text();
  assert.match(txt, /Closed unseen/); assert.match(txt, /Scam warning about/); assert.doesNotMatch(txt, /Scam alert|seen this/);
});

test('one screen: the header line shows last seen and the call count; no new page, chart or score was added', async () => {
  const id = senior();
  care.touch(id, 'app');
  const d = dashboard(id); await tick(); await tick();
  assert.match(d.els.presence.text(), /Last seen/); assert.match(d.els.presence.text(), /0 calls/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8');
  assert.ok(!/<canvas|<svg|chart|graph|score/i.test(html + SRC), 'no charts, graphs or scores');
  assert.equal((html.match(/<section/g) || []).length, 7, 'the same sections as before (mode, alerts, flags, reminders, message, notifications) plus the one approved "What changed" card');
});

test.after(() => care.stop());
