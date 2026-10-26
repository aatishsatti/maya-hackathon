// Maya server: plain Node, no dependencies.
// Serves public/ and the voice-loop API. Keys come from server env only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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
const MOCK_GREETING = 'Hello. I am Maya. I am here with you.';
const MOCK_REPLY = 'I heard you. I am here.';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---- Real mode ----
// Brain: Meta Model API, Chat Completions (https://dev.meta.ai/docs/protocols/chat-completions).
//   POST https://api.meta.ai/v1/chat/completions
//   Headers: Authorization: Bearer <key>, Content-Type: application/json
//   Body: model "muse-spark-1.3"; messages roles user|assistant|developer|system
//   (developer preferred for instructions); max_completion_tokens (max_tokens deprecated);
//   reasoning_effort minimal|low|medium|high|xhigh ("none" is HTTP 400); temperature
//   default 1.0; stop/logprobs/verbosity are HTTP 400.
//   Reply text: choices[0].message.content.
// Voice: ElevenLabs TTS (https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
//   Headers: xi-api-key, Content-Type: application/json. Body: { text, model_id? }
//   (model_id default eleven_multilingual_v2). Query output_format default mp3_44100_128.
//   200 response body is the audio file (mp3 by default).
const META_URL = 'https://api.meta.ai/v1/chat/completions';
const META_MODEL = 'muse-spark-1.3';
const ELEVEN_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const REAL_GREETING = 'Hello. I am Maya. I am here with you.';
const UPSTREAM_TIMEOUT_MS = 20000;

const PERSONA = [
  'You are Maya, a warm voice companion for older adults, made by the Maya team.',
  'You are speaking out loud, so reply in plain spoken words: no lists, no markdown, no emoji.',
  'Be warm, patient and slow. Use one to two short, simple sentences. One idea at a time.',
  'If you did not understand, say so kindly and ask them to say it again.',
  'You are Maya and nothing else. Never say you are Google, or a Meta model, or any other AI model.',
  'Never invent facts about their life, past conversations, the weather, the news, phone numbers, or things you can do.',
  'You can only talk with them right now. You cannot look things up, make calls, or remember earlier talks yet.',
  'If you do not know something, say you do not know.',
].join(' ');

function requireRealEnv() {
  const missing = ['META_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Real mode needs these in .env: ${missing.join(', ')}`);
}

// Error text from upstream never includes keys (we only forward status and error message).
async function upstreamError(name, r) {
  let detail = '';
  try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  return new Error(`${name} failed (HTTP ${r.status}) ${detail}`.trim());
}

async function sparkReply(userText) {
  const r = await fetch(META_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: META_MODEL,
      messages: [
        { role: 'developer', content: PERSONA },
        { role: 'user', content: userText },
      ],
      reasoning_effort: 'minimal',
      max_completion_tokens: 400,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok) throw await upstreamError('Meta Spark', r);
  const data = await r.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Meta Spark returned no reply text');
  return text.trim();
}

// Returns { audio: base64 mp3 } or { ttsError } so the client can show the reply and fall back.
async function elevenSpeech(text) {
  try {
    const r = await fetch(ELEVEN_URL + encodeURIComponent(process.env.ELEVENLABS_VOICE_ID), {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) throw await upstreamError('ElevenLabs', r);
    return { audio: Buffer.from(await r.arrayBuffer()).toString('base64'), audioType: 'audio/mpeg' };
  } catch (e) {
    console.error('TTS error:', e.message);
    return { ttsError: e.message };
  }
}

async function realReply(res, text) {
  const tts = await elevenSpeech(text);
  sendJson(res, 200, { reply: text, ...tts });
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
  if (url.pathname === '/api/greet' && req.method === 'POST') {
    if (MODE === 'real') return realReply(res, REAL_GREETING);
    return sendJson(res, 200, { reply: MOCK_GREETING, mock: true });
  }
  if (url.pathname === '/api/turn' && req.method === 'POST') {
    if (MODE === 'real') {
      // Ears are the browser's speech recognition; it sends the transcript as JSON.
      let text = '';
      try { text = String(JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')).transcript || '').trim(); }
      catch { return sendJson(res, 400, { error: 'Bad request' }); }
      if (!text) return sendJson(res, 400, { error: 'No speech heard' });
      try { return await realReply(res, await sparkReply(text)); }
      catch (e) { console.error('Brain error:', e.message); return sendJson(res, 502, { error: e.message }); }
    }
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
server.listen(PORT, () => console.log(`Maya running at http://localhost:${PORT} (mode: ${MODE})`));
