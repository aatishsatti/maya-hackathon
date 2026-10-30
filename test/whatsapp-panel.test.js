// The WhatsApp panel on the family page: the real public/family.js in a fake browser. The invitation button must send the template, say "Sent" or the
// plain reason right in the panel, never be silent, and be pressable with an empty note box.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'family.html'), 'utf8');
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this.handlers = {}; this.style = {}; this.buttons = []; }
  append(...k) { this.children.push(...k); } replaceChildren(...k) { this.children = k; }
  addEventListener(e, f) { this.handlers[e] = f; } focus() {}
  querySelectorAll() { return this.buttons; }
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const PID = 'abcdef12';

function page({ view, reply }) {
  const els = {}; const posts = []; const state = { view, reply };
  const document = { getElementById: (i) => (els[i] = els[i] || new El('x')), createElement: (t) => new El(t) };
  for (const k of ['waText', 'waResult', 'waInvite', 'waLink', 'waNote', 'waState', 'waLine', 'err']) els[k] = new El('x');
  els.waSend = new El('form'); els.waSend.buttons = [new El('button'), new El('button')];
  const sandbox = {
    document, window: {}, localStorage: { getItem: () => PID, setItem() {} }, Date, JSON, Promise, console, Intl,
    EventSource: class { addEventListener() {} }, setInterval: () => 1, clearInterval() {},
    fetch: async (url, opts = {}) => {
      if (url === '/api/profiles') return { ok: true, status: 200, json: async () => ({ profiles: [{ id: PID, name: 'Rosa' }] }) };
      if (url === `/api/whatsapp/${PID}` && opts.method !== 'POST') return { ok: true, status: 200, json: async () => state.view };
      if (url === `/api/whatsapp/${PID}/send`) { posts.push(JSON.parse(opts.body)); const r = state.reply(); if (r instanceof Error) throw r; return { ok: r.ok, status: r.ok ? 200 : 409, json: async () => r.j }; }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  vm.runInNewContext(SRC, sandbox);
  return { els, posts, state };
}
const CLOSED = { linked: true, configured: true, optIn: true, windowOpen: false, phoneEnd: '8237' };
const OPEN = { ...CLOSED, windowOpen: true };

test('the panel has a status line in the panel itself, and the invitation button is a real button, not a form submit', () => {
  assert.match(HTML, /id="waResult"[^>]*role="status"/); assert.match(HTML, /<button id="waInvite"[^>]*type="button"/);
});

test('window closed: the invitation button is shown on load (no failed try needed) and the free text / voice buttons are disabled', async () => {
  const p = page({ view: CLOSED, reply: () => ({ ok: true, j: {} }) }); await tick();
  assert.equal(p.els.waInvite.hidden, false); assert.ok(p.els.waSend.buttons.every((b) => b.disabled === true));
});

test('window open: free buttons enabled, invitation hidden', async () => {
  const p = page({ view: OPEN, reply: () => ({ ok: true, j: {} }) }); await tick();
  assert.equal(p.els.waInvite.hidden, true); assert.ok(p.els.waSend.buttons.every((b) => b.disabled === false));
});

test('click with an EMPTY note box sends the template (kind text, useTemplate true, no words) and says "Invitation sent" in the panel', async () => {
  const p = page({ view: CLOSED, reply: () => ({ ok: true, j: { sent: true, via: 'template', kind: 'template' } }) }); await tick();
  assert.equal(p.els.waText.value, ''); p.els.waInvite.handlers.click(); await tick();
  assert.deepEqual(p.posts, [{ kind: 'text', text: '', useTemplate: true }]);
  assert.match(p.els.waResult.textContent, /^Invitation sent\.$/); assert.equal(p.els.waResult.hidden, false); assert.equal(p.els.waInvite.disabled, false);
});

test('the invitation never uses the last pressed voice button, and says plainly that a typed note was not sent', async () => {
  const p = page({ view: CLOSED, reply: () => ({ ok: true, j: { sent: true } }) }); await tick();
  p.els.waSend.handlers.click({ target: { closest: () => ({ dataset: { kind: 'voice' } }) } });
  p.els.waText.value = 'my own note'; p.els.waInvite.handlers.click(); await tick();
  assert.equal(p.posts[0].kind, 'text'); assert.equal(p.posts[0].text, ''); assert.equal(p.posts[0].useTemplate, true);
  assert.match(p.els.waResult.textContent, /Invitation sent\. Your own words were not sent/);
});

test('a refusal or a Meta error shows its plain reason in the panel; a network failure shows too; nothing is silent', async () => {
  const p = page({ view: CLOSED, reply: () => ({ ok: false, j: { error: 'WhatsApp refused it (131030): Recipient phone number not in allowed list' } }) }); await tick();
  p.els.waInvite.handlers.click(); await tick();
  assert.match(p.els.waResult.textContent, /131030/); assert.equal(p.els.waResult.style.color, '#9c2f27'); assert.equal(p.els.waInvite.disabled, false);
  p.state.reply = () => new Error('fetch failed'); p.els.waInvite.handlers.click(); await tick();
  assert.match(p.els.waResult.textContent, /Could not reach the server: fetch failed\. Nothing was sent\./);
  p.state.reply = () => ({ ok: false, j: {} }); p.els.waInvite.handlers.click(); await tick();
  assert.match(p.els.waResult.textContent, /Nothing was sent/);
});

test('a double click sends once', async () => {
  const p = page({ view: CLOSED, reply: () => ({ ok: true, j: {} }) }); await tick();
  p.els.waInvite.handlers.click(); p.els.waInvite.handlers.click(); await tick();
  assert.equal(p.posts.length, 1);
});

test('a normal send inside the window says Sent and uses the pressed button', async () => {
  const p = page({ view: OPEN, reply: () => ({ ok: true, j: { sent: true } }) }); await tick();
  p.els.waSend.handlers.click({ target: { closest: () => ({ dataset: { kind: 'voice' } }) } });
  p.els.waText.value = 'hello'; p.els.waSend.handlers.submit({ preventDefault() {} }); await tick();
  assert.deepEqual(p.posts, [{ kind: 'voice', text: 'hello', useTemplate: false }]); assert.equal(p.els.waResult.textContent, 'Sent.'); assert.equal(p.els.waText.value, '');
});
