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
