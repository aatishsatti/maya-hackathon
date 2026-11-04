// Web parity with the app: the root page has NO picker (no list of people, no "Add a person"); a browser that knows no senior sees Log in / Sign up / Enter code;
// the senior has the same menu as in the app; the family page shows a Log out button and the senior's link with Copy and Share.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('the web root has no picker: no list of people, no "Who is Maya talking with?", no "Add a person"; it has the start screen and the menu button', () => {
  const html = P('index.html'), js = P('profiles.js');
  for (const gone of ['Who is Maya talking with', 'profileList', 'Add a person', 'addBtn', 'addForm', 'Gender']) assert.ok(!html.includes(gone), `index.html must not contain ${gone}`);
  for (const door of ['Log in', 'Sign up', 'Enter code']) assert.ok(html.includes(`>${door}<`), `the start screen has ${door}`);
  assert.ok(html.includes('id="menuBtn"') && html.includes('aria-label="Menu"'), 'the menu button, left of the header');
  assert.ok(!/api\/profiles/.test(js), 'the root page never asks for the list of people');
  assert.match(js, /\/api\/senior\//, 'it learns who it is from the senior route, by the id in the link or code');
  assert.match(js, /signOut/, 'Sign out is there');
});

test('the senior web menu uses the senior-safe routes only, and has the four choices', () => {
  const js = P('menu.js');
  for (const w of ['My Reminders', 'My Profile', 'Help / About Maya', 'Sign out', 'Stop this reminder', 'Waiting until morning']) assert.ok(js.includes(w), w);
  assert.match(js, /\/api\/senior\/\$\{[^}]+\}\/menu/); assert.match(js, /\/api\/senior\/\$\{[^}]+\}\/reminders\//);
  assert.ok(!/api\/care|api\/profiles|family/i.test(js.replace(/the family's|your family|ask your family|family sent|from your family|tells your family|the family/gi, '')), 'never the family routes');
});

test('the family page: a Log out button at the top, Add a family member, and the link with Copy and Share and a copyable code', () => {
  const html = P('family.html'), js = P('family.js');
  assert.ok(html.includes('id="logoutTop"') && html.includes('Log out') && html.includes('Add a family member'));
  for (const id of ['linkUrl', 'linkCode', 'linkCopy', 'codeCopy', 'linkShare']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(js, /navigator\.share/); assert.match(js, /clipboard\.writeText/);
  assert.ok(P('login.html').includes('id="shareBtn"') && P('login.html').includes('id="copyCode"'), 'also right after adding someone');
});

test('demo start screen: two buttons (Talk to Maya, Family Dashboard) on start screen only when demo flag is ON, login doors kept when OFF, and active senior chat has no dashboard or family link', async () => {
  const vm = require('node:vm');
  const html = P('index.html'), js = P('profiles.js');
  const startBlock = html.slice(html.indexOf('<main id="start"'), html.indexOf('</main>') + 7);
  const demoBlock = /<div id="demoDoors"[^>]*>([\s\S]*?)<\/div>/.exec(startBlock)[1];
  const demoBtns = [...demoBlock.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(demoBtns, ['Talk to Maya', 'Family Dashboard'], 'exactly two buttons in demoDoors on the start screen');
  assert.match(startBlock, /<div id="demoDoors" class="start-doors" hidden>/, 'demo doors hidden by default (flag OFF)');
  const chatBlock = html.slice(html.indexOf('<main id="callScreen"'));
  assert.doesNotMatch(chatBlock, /Family Dashboard|demoDash|demoTalk|\/family\.html|\/login\.html/, 'active senior chat has no dashboard link and no family link');

  function runStart(demoResp) {
    const els = {};
    const mk = (id) => ({ id, hidden: id === 'demoDoors' || id === 'codeForm' || id === 'callScreen' || id === 'startError', textContent: '', value: '', disabled: false, handlers: {}, addEventListener(e, fn) { this.handlers[e] = fn; }, focus() {} });
    const loc = { href: '/' };
    const store = new Map();
    const sandbox = {
      window: { dispatchEvent() {} },
      location: loc,
      Event: class { constructor(t) { this.type = t; } },
      localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      document: { getElementById: (id) => (els[id] = els[id] || mk(id)) },
      fetch: async (url) => ({ ok: true, status: 200, json: async () => (url === '/api/senior/demo' ? demoResp : {}) }),
    };
    vm.runInNewContext(js, sandbox);
    return { els, loc, window: sandbox.window };
  }

  // Flag OFF (default): login doors shown, demo doors hidden
  const off = runStart({ demo: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(off.els.start.hidden, false);
  assert.equal(off.els.callScreen.hidden, true);
  assert.equal(off.els.demoDoors.hidden, true);
  assert.equal(off.els.loginDoors.hidden, false);
  assert.equal(off.els.startNote.hidden, false);

  // Flag ON: only the two demo buttons shown; Talk to Maya opens senior chat; Family Dashboard opens /family.html
  const on = runStart({ demo: true, profile: { id: 'a1b2c3d4', name: 'Clara' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(on.els.demoDoors.hidden, false);
  assert.equal(on.els.loginDoors.hidden, true);
  assert.equal(on.els.startNote.hidden, true);
  on.els.demoDash.handlers.click();
  assert.equal(on.loc.href, '/family.html', 'Family Dashboard button opens dashboard with no login screen');
  await on.els.demoTalk.handlers.click();
  assert.equal(on.els.start.hidden, true, 'start screen hides once senior chat is active');
  assert.equal(on.els.callScreen.hidden, false, 'senior chat + call screen opens with no login screen');
  assert.equal(on.els.titleChat.textContent, 'Maya and Clara');
});
