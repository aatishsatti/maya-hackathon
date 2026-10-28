// Same-origin rules: http (local) and https (hosted) for this server's own host, nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sameOrigin, wsOriginOk } = require('../origin');

const H = (origin, host) => ({ origin, host });

test('local http still works, on the right host and port', () => {
  assert.equal(sameOrigin(H('http://localhost:3000', 'localhost:3000')), true);
  assert.equal(wsOriginOk(H('http://localhost:3000', 'localhost:3000')), true);
  assert.equal(sameOrigin(H('http://127.0.0.1:3101', '127.0.0.1:3101')), true);
});

test('hosted https works: the browser Origin is https://host, the proxy passes the same Host', () => {
  assert.equal(sameOrigin(H('https://maya-demo.onrender.com', 'maya-demo.onrender.com')), true);
  assert.equal(wsOriginOk(H('https://maya-demo.onrender.com', 'maya-demo.onrender.com')), true);
});

test('no other site, host, port or scheme can drive state or open a stream (no wildcard)', () => {
  const host = 'maya-demo.onrender.com';
  for (const o of ['https://evil.example', 'http://evil.example', `https://evil.${host}`, `https://${host}.evil.example`, `https://x${host}`, 'https://onrender.com',
    `https://${host}:8443`, `http://${host}:80x`, `ftp://${host}`, `//${host}`, host, 'null', 'https://', '*', `https://${host}/`, `https://${host}/path`, ` https://${host}`, `HTTPS://${host.toUpperCase()}`]) {
    assert.equal(sameOrigin(H(o, host)), false, `sameOrigin must refuse ${o}`);
    assert.equal(wsOriginOk(H(o, host)), false, `ws must refuse ${o}`);
  }
  assert.equal(sameOrigin(H('http://localhost:3001', 'localhost:3000')), false, 'another local port is another site');
  assert.equal(sameOrigin(H('https://localhost:3000', 'localhost:3001')), false);
});

test('no Origin: allowed for plain requests (a tool, as before) but never for the call socket; a missing Host is never trusted', () => {
  assert.equal(sameOrigin({ host: 'localhost:3000' }), true);
  assert.equal(wsOriginOk({ host: 'localhost:3000' }), false, 'a browser always sends Origin on a WebSocket');
  assert.equal(sameOrigin(H('https://maya-demo.onrender.com', undefined)), false);
  assert.equal(wsOriginOk(H('https://maya-demo.onrender.com', '')), false);
  assert.equal(wsOriginOk(H(undefined, undefined)), false);
});

test('server.js uses these rules for chat, care and the call socket (no hard-coded http:// check is left)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/origin'\)/);
  assert.ok(!/`http:\/\/\$\{req\.headers\.host\}`/.test(src), 'the http-only comparison is gone');
  assert.match(src, /origin\.sameOrigin\(req\.headers\)/); assert.match(src, /origin\.wsOriginOk\(req\.headers\)/);
});
