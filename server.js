// Maya server: plain Node, no dependencies.
// Serves public/ and the voice-loop API. Keys come from server env only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const MODE = process.env.MAYA_MODE === 'real' ? 'real' : 'mock';
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
// Mock replies never claim facts, weather, history, or abilities Maya does not have.
const MOCK_GREETING = 'Hello. I am Maya. I am here with you. What would you like to talk about?';
const MOCK_REPLIES = [
  'I heard you. Thank you for telling me. Take your time.',
  'That sounds important. Tell me a little more.',
  'I am listening. There is no rush.',
  'Thank you. Would you like to say more about that?',
  'I am still here. Go on when you are ready.',
];

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function realModeNotBuilt(res) {
  // Fail fast. No fake reply in real mode.
  sendJson(res, 501, { error: 'Real mode is not built yet. Set MAYA_MODE=mock.' });
}

// Ears: speech to text. Mock never invents what the person said.
function mockEars(audioBytes) {
  return { transcript: null, note: `mock: received ${audioBytes} bytes of audio, no transcription` };
}

// Brain: reply. Mock cycles canned lines by client-supplied turn number.
function mockBrain(turn) {
  return MOCK_REPLIES[Math.abs(turn) % MOCK_REPLIES.length];
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
  if (url.pathname === '/api/greet' && req.method === 'POST') {
    if (MODE === 'real') return realModeNotBuilt(res);
    return sendJson(res, 200, { reply: MOCK_GREETING, mock: true });
  }
  if (url.pathname === '/api/turn' && req.method === 'POST') {
    if (MODE === 'real') return realModeNotBuilt(res);
    let audio;
    try { audio = await readBody(req, MAX_AUDIO_BYTES); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
    if (audio.length === 0) return sendJson(res, 400, { error: 'No audio received' });
    const turn = Number(url.searchParams.get('turn')) || 0;
    const ears = mockEars(audio.length);
    return sendJson(res, 200, { transcript: ears.transcript, note: ears.note, reply: mockBrain(turn), mock: true });
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

server.listen(PORT, () => console.log(`Maya running at http://localhost:${PORT} (mode: ${MODE})`));
