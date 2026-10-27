// Runs public/family.js (the dashboard) in a fake browser against the real care.js: after a reminder is acknowledged, do the
// Reminders list AND the Notifications list change to Done / Replied (by live refresh event, and by the 3 s poll alone)?
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-fam-'));
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
}
const tick = () => new Promise((r) => setImmediate(r));

function dashboard(id, { bridge }) {
  const els = {}; const timers = new Map(); let tid = 0; const es = { l: {} };
  const document = { getElementById: (i) => (els[i] = els[i] || new El('x')), createElement: (t) => new El(t) };
  const sandbox = {
    document, window: {}, localStorage: { getItem: () => id, setItem() {} }, Date, JSON, Promise, console, Intl,
    EventSource: class { constructor() { es.l = {}; this.l = es.l; } addEventListener(e, f) { es.l[e] = f; } },
    setInterval: (fn, ms) => { tid += 1; timers.set(tid, { fn, ms }); return tid; }, clearInterval: (i) => timers.delete(i),
    fetch: async (url, opts = {}) => {
      const m = /^\/api\/care\/([a-f0-9]{8})$/.exec(url);
      const body = url === '/api/profiles' ? { profiles: memory.listProfiles() } : m ? care.view(m[1]) : {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    },
  };
  vm.runInNewContext(SRC, sandbox);
  if (bridge) care.attachFamily({ write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m && es.l[m[1]]) es.l[m[1]]({ data: m[2] }); return true; } });
  return { els, pollMs: () => [...timers.values()].map((t) => t.ms), poll: () => [...timers.values()].forEach((t) => t.fn()), reminders: () => els.reminders.text(), notifs: () => els.notifs.text() };
}

async function ringedAndPickedUp(name) {
  const p = memory.createProfile(name, 'female');
  care.cfg.ringMs = 60000;
  const ev = [];
  care.attachSenior(p.id, { write(s) { const m = /event: (\w+)\ndata: (.*)\n/.exec(s); if (m) ev.push({ ev: m[1], data: JSON.parse(m[2]) }); return true; } });
  const r = care.addReminder(p.id, { task: 'medicine for back', dueAt: Date.now() + 5 });
  await new Promise((r2) => setTimeout(r2, 15)); care.tick(); await new Promise((r2) => setTimeout(r2, 15));
  const info = care.claim(p.id, ev.find((e) => e.ev === 'incoming').data.outreachId); // senior pressed Accept
  assert.equal(info.reminderId, r.id);
  return { id: p.id, r };
}

test('F1 ack -> Reminders AND Notifications both change to Done / Replied on the live refresh event', async () => {
  const { id, r } = await ringedAndPickedUp('Fiona');
  const d = dashboard(id, { bridge: true });
  await tick(); await tick();
  assert.match(d.reminders(), /Picked up, waiting for a reply/); assert.match(d.notifs(), /Seen/);
  care.reminderAck(id, r.id);                   // the senior said "okay, thank you" in the call
  await tick(); await tick();                   // refresh event -> load()
  assert.match(d.reminders(), /Last \(.*\): Done, senior replied/);
  assert.match(d.notifs(), /Replied/); assert.doesNotMatch(d.notifs(), /Seen ·/);
});

test('F2 even with no live event, the 3 s poll brings both lists up to date', async () => {
  const { id, r } = await ringedAndPickedUp('Gina');
  const d = dashboard(id, { bridge: false });
  await tick(); await tick();
  assert.match(d.reminders(), /waiting for a reply/);
  assert.ok(d.pollMs().includes(3000));
  care.reminderAck(id, r.id);
  assert.match(d.reminders(), /waiting for a reply/, 'not yet: nothing told the page');
  d.poll(); await tick(); await tick();
  assert.match(d.reminders(), /Done, senior replied/); assert.match(d.notifs(), /Replied/);
});

test('F3 an in-call reminder (no ring) also ends Replied on the right notification', async () => {
  const p = memory.createProfile('Hana', 'female');
  care.setMode(p.id, 'standard');
  care.get(p.id).notifications.length = 0;
  const other = care.makeNotif(care.get(p.id), { to: 'senior', kind: 'family_message', text: 'hello' }); // a notification with ref null must not be hit
  const live = { deliverReminder: () => true };
  care.callStarted(p.id, live, null);
  const r = care.addReminder(p.id, { task: 'tea', dueAt: Date.now() + 5 });
  await new Promise((r2) => setTimeout(r2, 15)); care.tick();
  care.reminderAck(p.id, r.id);
  const v = care.view(p.id);
  assert.equal(v.reminders[0].last.label, 'Done, senior replied');
  assert.equal(v.notifications.find((n) => n.id === other.id).label, 'Sent', 'the unrelated message is untouched');
  assert.equal(v.notifications.find((n) => n.kind === 'reminder').label, 'Replied');
  care.callEnded(p.id, live);
});

test.after(() => care.stop());
