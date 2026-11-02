// Runs public/inbox.js (the senior's page logic) in a fake browser: fake DOM, fake timers, fake Web Audio, fake EventSource.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'inbox.js'), 'utf8');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.handlers = {}; this.removed = false; this.textContent = ''; }
  setAttribute() {}
  append(...k) { this.children.push(...k); k.forEach((x) => { x.parent = this; }); }
  insertBefore(n, ref) { this.children.splice(this.children.indexOf(ref), 0, n); n.parent = this; }
  addEventListener(ev, fn) { this.handlers[ev] = fn; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  focus() {}
  click() { this.handlers.click && this.handlers.click(); }
  matches(sel) { return sel.startsWith('.') ? this.className.split(' ').includes(sel.slice(1)) : this.tag === sel; }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const f = c.querySelector(sel); if (f) return f; } return null; }
  all(sel, out = []) { for (const c of this.children) { if (c.matches(sel)) out.push(c); c.all(sel, out); } return out; }
}

function browser({ inCall = false, hidden = false, permission = null } = {}) {
  const log = { starts: [], freqs: [], peaks: [], ctxMade: 0, ctxClosed: 0, posts: [], started: [], notes: [], noteClosed: 0, asked: 0, events: [] };
  let now = 0, id = 0; const timers = new Map();
  const setTimeout_ = (fn, ms) => { id += 1; timers.set(id, { fn, at: now + ms }); return id; };
  const clearTimeout_ = (i) => timers.delete(i);
  const advance = (ms) => { const end = now + ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; };
  class Ctx {
    constructor() { log.ctxMade += 1; this.state = 'suspended'; this.destination = {}; }
    get currentTime() { return now / 1000; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { log.ctxClosed += 1; return Promise.resolve(); }
    createOscillator() { const o = { frequency: { value: 0 }, connect() {}, start() { log.starts.push(o.frequency.value); }, stop() {}, onended: null }; return o; }
    createGain() { return { connect() {}, gain: { setValueAtTime(v) { }, linearRampToValueAtTime(v) { log.peaks.push(v); }, exponentialRampToValueAtTime(v) { log.peaks.push(v); }, cancelScheduledValues() {} } }; }
  }
  const handlers = {};
  const sources = [];
  class ES { constructor(url) { this.url = url; this.l = {}; sources.push(this); } addEventListener(e, f) { this.l[e] = f; } close() {} emit(e, d) { this.l[e]({ data: JSON.stringify(d) }); } }
  const inboxEl = new El('div');
  const window = {
    mayaProfile: { id: 'abcd1234' }, mayaInCall: () => inCall, mayaStartCall: (o) => log.started.push(o), AudioContext: Ctx,
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
  };
  const fire = (ev) => (handlers[ev] || []).forEach((f) => f({ target: { closest: () => null } }));
  if (permission !== null) { window.Notification = class N { constructor(title, o) { log.notes.push({ title, ...o }); this.close = () => { log.noteClosed += 1; }; } static get permission() { return permission; } static requestPermission() { log.asked += 1; permission = 'granted'; return Promise.resolve('granted'); } }; }
  window.focus = () => {};
  window.dispatchEvent = (ev) => { log.events.push([ev.type, ev.detail]); (handlers[ev.type] || []).forEach((f) => f(ev)); return true; };
  const document = { getElementById: () => inboxEl, createElement: (t) => new El(t), hidden, hasFocus: () => !hidden, title: 'Maya' };
  const sandbox = { window, document, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }, EventSource: ES, fetch: (u, o) => { log.posts.push(u); return Promise.resolve(); }, setTimeout: setTimeout_, clearTimeout: clearTimeout_, Intl, encodeURIComponent, JSON, Date, console };
  vm.runInNewContext(SRC, sandbox);
  fire('maya-profile'); // connect
  return { window, fire, es: () => sources[sources.length - 1], inboxEl, log, advance, setInCall(v) { inCall = v; window.mayaInCall = () => v; }, ring: () => JSON.parse(JSON.stringify(window.mayaInbox.ring())),
    incoming(n = 1) { this.es().emit('incoming', { outreachId: `o${n}`, notifId: `n${n}`, kind: 'callback', text: 'Maya is calling to check on you.', attempt: 1, of: 3 }); },
    cards: () => inboxEl.children };
}
const tick = () => new Promise((r) => setImmediate(r));
const button = (b, label) => b.cards()[0].all('button').find((x) => x.textContent === label);

test('R1 sound is blocked before the first interaction: card shows with a tap hint, nothing claims a ring', async () => {
  const b = browser();
  b.incoming();
  assert.equal(b.cards().length, 1);
  assert.deepEqual(b.ring(), { key: 'oo1', sounding: false, blocked: true });
  assert.ok(b.cards()[0].querySelector('.inbox-hint'));
  assert.equal(b.log.starts.length, 0);
  b.fire('pointerdown'); await tick();
  assert.equal(b.ring().sounding, true); assert.equal(b.ring().blocked, false);
  assert.equal(b.cards()[0].querySelector('.inbox-hint'), null, 'hint gone once it rings');
  assert.deepEqual(b.log.starts.slice(0, 4).sort(), [440, 440, 480, 480]);
});

test('R2 the phone ring repeats (2 bursts, ~3 s pause), loud enough, ONE shared AudioContext kept alive', async () => {
  const b = browser();
  b.fire('pointerdown'); await tick();
  b.incoming();
  assert.equal(b.log.starts.length, 4);
  b.advance(4800); assert.equal(b.log.starts.length, 8);
  b.advance(4800); assert.equal(b.log.starts.length, 12);
  assert.ok(Math.max(...b.log.peaks) >= 0.2, 'louder than the old 0.08 chime');
  assert.equal(b.log.ctxMade, 1); assert.equal(b.log.ctxClosed, 0);
});

test('R3 the ring stops at once on Accept, on Decline, on incomingEnd and on pagehide', async () => {
  for (const how of ['Accept', 'Decline', 'end', 'pagehide']) {
    const b = browser();
    b.fire('pointerdown'); await tick();
    b.incoming();
    assert.equal(b.ring().sounding, true);
    const before = b.log.starts.length;
    if (how === 'end') b.es().emit('incomingEnd', { outreachId: 'o1' });
    else if (how === 'pagehide') b.fire('pagehide');
    else button(b, how).click();
    assert.equal(b.ring().key, null, how); assert.equal(b.ring().sounding, false);
    b.advance(20000);
    assert.equal(b.log.starts.length, before, `${how}: no more bursts`);
    if (how === 'Accept') assert.deepEqual(JSON.parse(JSON.stringify(b.log.started)), [{ reason: 'callback', outreachId: 'o1' }]);
    if (how === 'Decline') assert.ok(b.log.posts.some((u) => u.endsWith('/decline')));
  }
});

test('R4 never rings over a live call, and stops if a call starts mid-ring; never two rings at once', async () => {
  const b = browser({ inCall: true });
  b.fire('pointerdown'); await tick();
  b.incoming();
  assert.equal(b.cards().length, 0); assert.equal(b.log.starts.length, 0);
  const c = browser();
  c.fire('pointerdown'); await tick();
  c.incoming(1); c.incoming(2);
  assert.equal(c.cards().length, 1, 'one card');
  const n = c.log.starts.length;
  c.advance(4800);
  assert.equal(c.log.starts.length - n, 4, 'a single ring loop: 4 oscillators per cycle');
  c.setInCall(true); c.advance(4800);
  assert.equal(c.ring().key, null, 'stops when a call is live');
});

test('R5 a family message is a soft chime only (not the phone ring), never a loop', async () => {
  const b = browser();
  b.fire('pointerdown'); await tick();
  b.es().emit('notice', { notifId: 'm1', kind: 'family_message', text: 'Dinner at 6' });
  assert.deepEqual(b.log.starts, [523.25, 659.25]);
  assert.ok(Math.max(...b.log.peaks) <= 0.08 + 1e-9);
  assert.equal(b.ring().key, null);
  b.advance(30000); assert.equal(b.log.starts.length, 2);
  const bt = b.cards()[0].all('button'); assert.deepEqual(bt.map((x) => x.textContent), ['Got it'], 'a card with the one button');
});

test('a pop-up card (a notice with no chat message): "Your reminder" for the person\'s own, "Reminder from your family" for the family\'s, a bell, ONE button (Got it) that reports Seen once', async () => {
  const b = browser(); b.fire('pointerdown'); await tick();
  b.es().emit('notice', { notifId: 'r1', kind: 'reminder', by: 'senior', text: 'Take your tablets' });
  assert.equal(b.cards()[0].children[0].children[1].textContent, 'Your reminder');
  assert.equal(b.cards()[0].children[1].textContent, 'Take your tablets');
  assert.deepEqual(b.cards()[0].all('button').map((x) => x.textContent), ['Got it'], 'no Open: there is nothing to open');
  button(b, 'Got it').handlers.click(); assert.equal(b.log.posts.filter((u) => /notifications\/r1\/seen/.test(u)).length, 1, 'Got it reports Seen once'); assert.equal(b.cards().length, 0);
  b.es().emit('notice', { notifId: 'r2', kind: 'reminder', text: 'Drink water' });
  assert.equal(b.cards()[0].children[0].children[1].textContent, 'Reminder from your family');
});

test('a page that is hidden: the reminder also becomes a browser notification (once allowed), and closing the card closes it; a visible page makes none', async () => {
  const away = browser({ hidden: true, permission: 'granted' }); away.fire('pointerdown'); await tick();
  away.es().emit('notice', { notifId: 'h1', kind: 'reminder', by: 'senior', text: 'Take your tablets' });
  assert.deepEqual(away.log.notes.map((n) => [n.title, n.body, n.requireInteraction]), [['Your reminder', 'Take your tablets', true]]);
  button(away, 'Got it').handlers.click(); assert.equal(away.log.noteClosed, 1);
  away.incoming(7); assert.equal(away.log.notes.at(-1).title, 'Maya is calling', 'a ring too');
  const here = browser({ hidden: false, permission: 'granted' }); here.fire('pointerdown'); await tick();
  here.es().emit('notice', { notifId: 'h2', kind: 'family_message', text: 'Dinner at 6' }); assert.equal(here.log.notes.length, 0, 'the page is in front: the card is enough');
});

test('notification permission is asked only when the person presses Allow; refused or unsupported says so plainly or says nothing', async () => {
  const ask = browser({ hidden: false, permission: 'default' }); ask.fire('pointerdown'); await tick();
  ask.es().emit('notice', { notifId: 'p1', kind: 'family_message', text: 'Hello' });
  assert.equal(ask.log.asked, 0, 'never asked by itself');
  const allow = ask.cards()[0].all('button').find((x) => x.textContent === 'Allow'); assert.ok(allow, 'a plain Allow button on the card');
  allow.handlers.click(); assert.equal(ask.log.asked, 1);
  const no = browser({ permission: 'denied' }); no.fire('pointerdown'); await tick(); no.es().emit('notice', { notifId: 'p2', kind: 'family_message', text: 'Hello' });
  assert.ok(!no.cards()[0].all('button').some((x) => x.textContent === 'Allow'));
  assert.match(no.cards()[0].all('small').map((x) => x.textContent).join(' '), /Notifications are off for this page, so Maya can only tell you while it is open/);
  const none = browser(); none.fire('pointerdown'); await tick(); none.es().emit('notice', { notifId: 'p3', kind: 'family_message', text: 'Hello' });
  assert.equal(none.cards()[0].all('small').filter((x) => /Notifications/.test(x.textContent)).length, 0, 'a browser with no notifications: no line at all');
});

test('a click removes the card at once, reports Seen exactly once, and a Seen on another page takes the card down too; a replayed notice that was already answered is not a second Seen', async () => {
  const b = browser(); b.fire('pointerdown'); await tick();
  b.es().emit('notice', { notifId: 'z1', kind: 'reminder', by: 'senior', text: 'Take your meds' });
  assert.equal(b.cards().length, 1);
  button(b, 'Got it').handlers.click(); assert.equal(b.cards().length, 0, 'gone at once');
  assert.equal(b.log.posts.filter((u) => /notifications\/z1\/seen/.test(u)).length, 1, 'Seen once');
  b.es().emit('notice', { notifId: 'z2', kind: 'reminder', by: 'senior', text: 'Drink water' }); assert.equal(b.cards().length, 1);
  b.es().emit('noticeSeen', { notifId: 'z2' }); assert.equal(b.cards().length, 0, 'seen on another page: this card goes too');
  assert.equal(b.log.posts.filter((u) => /notifications\/z2\/seen/.test(u)).length, 0, 'and this page does not report it again');
  b.es().emit('notice', { notifId: 'z1', kind: 'reminder', by: 'senior', text: 'Take your meds' }); b.es().emit('notice', { notifId: 'z2', kind: 'reminder', by: 'senior', text: 'Drink water' });
  assert.equal(b.cards().length, 0, 'a replay of a notice already answered raises nothing');
});

// ---- a reminder is a chat message first (the server put it in the thread): in front -> in the chat, no card; not in front -> pop-up, whose Got it brings the chat to the message
const MSG = (nid, text, by = 'senior') => ({ id: `m${nid}`, role: 'maya', kind: 'text', text, reminder: { notifId: nid, by, seen: false } });

test('chat in front: the reminder arrives IN the chat (one chime, no pop-up, no Open); its Got it reports Seen exactly once', async () => {
  const b = browser({ hidden: false }); b.fire('pointerdown'); await tick();
  b.es().emit('notice', { notifId: 'c1', kind: 'reminder', by: 'senior', text: 'Your reminder: take my meds.', message: MSG('c1', 'Your reminder: take my meds.') });
  assert.equal(b.cards().length, 0, 'no pop-up over the chat'); assert.deepEqual(b.log.events.filter(([n]) => n === 'maya-reminder').map(([, d]) => d.message.text), ['Your reminder: take my meds.']);
  assert.deepEqual(b.log.starts, [523.25, 659.25], 'the one gentle chime');
  b.window.dispatchEvent(new (class { constructor() { this.type = 'maya-reminder-got'; this.detail = { notifId: 'c1' }; } })());
  b.window.dispatchEvent(new (class { constructor() { this.type = 'maya-reminder-got'; this.detail = { notifId: 'c1' }; } })());
  assert.equal(b.log.posts.filter((u) => /notifications\/c1\/seen/.test(u)).length, 1, 'Seen exactly once, however often it is pressed');
  b.es().emit('notice', { notifId: 'c1', kind: 'reminder', by: 'senior', text: 'x', message: MSG('c1', 'x') });
  assert.equal(b.log.events.filter(([n]) => n === 'maya-reminder').length, 1, 'a replay of an answered reminder adds nothing'); assert.equal(b.cards().length, 0);
});

test('chat NOT in front: the message is in the chat AND a pop-up (and a browser notification) appears with Got it only; its Got it brings the chat to that message, shown as done, Seen once', async () => {
  const b = browser({ hidden: true, permission: 'granted' }); b.fire('pointerdown'); await tick();
  b.es().emit('notice', { notifId: 'h9', kind: 'reminder', by: 'senior', text: 'Your reminder: take my meds.', message: MSG('h9', 'Your reminder: take my meds.') });
  assert.equal(b.log.events.filter(([n]) => n === 'maya-reminder').length, 1, 'the message is in the chat for when they come back');
  assert.equal(b.cards().length, 1); assert.deepEqual(b.cards()[0].all('button').map((x) => x.textContent), ['Got it']); assert.deepEqual(b.log.notes.map((n) => n.title), ['Your reminder']);
  button(b, 'Got it').handlers.click();
  assert.equal(b.log.posts.filter((u) => /notifications\/h9\/seen/.test(u)).length, 1); assert.equal(b.cards().length, 0); assert.equal(b.log.noteClosed, 1);
  const show = b.log.events.find(([n]) => n === 'maya-show-reminder'); assert.ok(show && show[1].id === 'h9' && show[1].done === true, 'the chat is brought to that message, as done');
});

test('two pages: Seen on the other page (noticeSeen) marks the in-chat message done here and takes any card down, with no second Seen', async () => {
  const b = browser({ hidden: false }); b.fire('pointerdown'); await tick();
  b.es().emit('notice', { notifId: 't1', kind: 'reminder', by: 'senior', text: 'x', message: MSG('t1', 'Your reminder: x') });
  b.es().emit('noticeSeen', { notifId: 't1' });
  assert.deepEqual(b.log.events.filter(([n]) => n === 'maya-reminder-done').map(([, d]) => d.notifId), ['t1']); assert.equal(b.log.posts.filter((u) => /notifications\/t1\/seen/.test(u)).length, 0, 'this page does not report it again');
});
