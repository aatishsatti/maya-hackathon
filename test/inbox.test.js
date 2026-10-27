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

function browser({ inCall = false } = {}) {
  const log = { starts: [], freqs: [], peaks: [], ctxMade: 0, ctxClosed: 0, posts: [], started: [] };
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
  const document = { getElementById: () => inboxEl, createElement: (t) => new El(t) };
  const sandbox = { window, document, EventSource: ES, fetch: (u, o) => { log.posts.push(u); return Promise.resolve(); }, setTimeout: setTimeout_, clearTimeout: clearTimeout_, Intl, encodeURIComponent, JSON, Date, console };
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
  assert.match(b.cards()[0].all('button')[0].textContent, /Close/);
});
