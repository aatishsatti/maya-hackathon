// Maya server: plain Node, no dependencies.
// Serves public/ and the voice-loop API. Keys come from server env only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { accept } = require('./ws');
const { Call } = require('./call');
const { requireRealEnv } = require('./brain');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const MODE = process.env.META_MODE === 'real' ? 'real' : 'mock';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Mock persona: warm, patient, slow, short concrete sentences, one idea at a time.
// Mock has no speech-to-text, so it never guesses what was said and never claims
// facts, weather, history, or abilities Maya does not have. Greeting-aware replies
// are tested in real mode, not here.
const MOCK_GREETING = 'Hi. This is practice mode, so I cannot really talk yet.';
const MOCK_REPLY = 'I heard you. I am here.';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Ears: speech to text. Mock never invents what the person said.
function mockEars(audioBytes) {
  return { transcript: null, note: `mock: received ${audioBytes} bytes of audio, no transcription` };
}

// Brain: reply. Mock is always neutral.
function mockBrain() {
  return MOCK_REPLY;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Audio too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { mode: MODE });
  }
  // Real mode runs over the /ws call socket; these HTTP endpoints are mock only.
  if (MODE === 'real') return sendJson(res, 404, { error: 'Not found' });
  if (url.pathname === '/api/greet' && req.method === 'POST') {
    return sendJson(res, 200, { reply: MOCK_GREETING, mock: true });
  }
  if (url.pathname === '/api/turn' && req.method === 'POST') {
    let audio;
    try { audio = await readBody(req, MAX_AUDIO_BYTES); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    if (audio.length === 0) return sendJson(res, 400, { error: 'No audio received' });
    const ears = mockEars(audio.length);
    return sendJson(res, 200, { transcript: ears.transcript, note: ears.note, reply: mockBrain(), mock: true });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Mic allowed for this origin only.
      'Permissions-Policy': 'microphone=(self)',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('API error:', e.message); // message only, never request bodies or keys
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url);
  } else {
    res.writeHead(405); res.end();
  }
});

if (MODE === 'real') {
  try { requireRealEnv(); } catch (e) { console.error(e.message); process.exit(1); }
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  // Same-origin only, so other web pages cannot open a call on this machine.
  const okOrigin = req.headers.origin === `http://${req.headers.host}`;
  if (MODE !== 'real' || url.pathname !== '/ws' || !okOrigin) { socket.destroy(); return; }
  const ws = accept(req, socket);
  if (ws) new Call(ws, process.env.META_API_KEY);
});

server.listen(PORT, () => console.log(`Maya running at http://localhost:${PORT} (mode: ${MODE})`));
