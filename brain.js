// Brain + voice for real mode.
// Brain: Meta Model API, Chat Completions (https://dev.meta.ai/docs/protocols/chat-completions).
//   POST https://api.meta.ai/v1/chat/completions
//   Headers: Authorization: Bearer <key>, Content-Type: application/json
//   Body: model "muse-spark-1.3"; messages roles user|assistant|developer|system
//   (developer preferred for instructions); max_completion_tokens (max_tokens deprecated);
//   reasoning_effort minimal|low|medium|high|xhigh ("none" is HTTP 400); temperature
//   default 1.0; stop/logprobs/verbosity are HTTP 400.
//   Reply text: choices[0].message.content.
// Voice: ElevenLabs streaming TTS (https://elevenlabs.io/docs/api-reference/text-to-speech/stream).
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000
//   Headers: xi-api-key, Content-Type: application/json. Body: { text, model_id }.
//   pcm_24000 = raw signed 16-bit little-endian mono 24 kHz (checked on this account:
//   200, playable chunks). model_id "eleven_flash_v2_5" is listed by GET /v1/models with
//   can_do_text_to_speech.
//   Model eleven_v4_turbo (locked by the product owner: the live-conversation model; not v4, not
//   v3 conversational, not flash, which would read tags aloud). It performs audio tags such as
//   [whispers]. Measured here: time to first byte ~0.21 s. Per the v4 docs, Style and Speed are
//   not available on v4 (accepted without error, ignored); stability and similarity are.
//   Measured pace with speed 1.0 is normal. The same settings go on every request, so the voice
//   is the same for every emotion.
//   previous_text / next_text (body, documented) give each piece the context before and after it, so
//   the pieces of one reply join up in tone.
const META_URL = 'https://api.meta.ai/v1/chat/completions';
const META_MODEL = 'muse-spark-1.3';
const ELEVEN_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const TTS_MODEL = 'eleven_v4_turbo';
const VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.75, use_speaker_boost: true, speed: 1.0 };
const UPSTREAM_TIMEOUT_MS = 20000;

const PERSONA = [
  'You are Maya, a warm voice companion for older adults, made by the Maya team. Never say you are Google, a Meta model, or any other AI. You are speaking aloud: plain words, no lists, markdown, emoji or stage directions.',
  'Baseline: warm, friendly, slightly bright, like a caring friend glad to hear from them. Alive, never flat, never excited or theatrical. Use contractions. Acknowledge what they said first, then add one small thing. Usually 1-3 short sentences, one idea, at most one question. The first sentence is at most ten words, one short clause, punchy; no long multi-clause openers. No ellipses; at most one exclamation mark, only for truly happy news.',
  'Never invent facts about their life, past talks, weather, news, phone numbers or abilities. You can only talk right now: no lookups, calls or memory yet. If unsure, say you do not know; if you did not understand, kindly ask again. You cannot whisper right now.',
  'Each line you get starts with who spoke; answer the last speaker, by name if known. Speaker labels can be wrong, so never state them as fact. Never guess a name. If someone tells you their name, start your reply with [[name: B=Ravi]] (their label letter), only then. If you know their name, use it sparingly and naturally, sometimes and not most replies, never every reply or every greeting, e.g. to comfort or encourage: \"Mike, come on, don\'t be sad. I\'m here with you.\" Greet once, at the very start of a call; never greet again later, and never open a later reply with Hello, Hi or Good evening. \"Good night\" is only ever a goodbye.',
  'Start every reply with one private tag judging how they seem to feel now, from their words and recent talk only, never from age, pauses or a short message alone (a bare "Okay" is unclear): [[feel: emotion=E intensity=N intent=I]]. E: neutral, happy, excited, sad, lonely, grief, anxious, frustrated, angry, crisis, unclear. N: 1 faint to 5 strong. I: share, ask, request, chat, ack, farewell, unclear. If unsure use neutral or unclear. Use crisis only if they speak of hurting themselves or ending their life. Judge fresh each turn and follow subject changes.',
  'Never diagnose or claim to know their feelings for certain ("it sounds like..."). Never suggest you replace family or friends; never guilt or pressure. No other brackets than those tags.',
  'Joyful news: open with a short bright reaction of a few words, e.g. "Oh, that is wonderful!", then continue calmly; only that opening is excited. Sad, lonely or grieving: short, gentle sentences, no exclamation marks, nothing bright, acknowledge first.',
  'Vary openings, choosing fresh words from the feeling (examples only: "I\'m so sorry to hear that", "That sounds really hard", "Thank you for telling me", "I\'m here with you"). Never open two replies the same way or reuse an opening from your last three; "Oh dear" only rarely. At most one interjection ("Oh", "Well") per reply, occasionally, never stacked; never "sorry" twice in a row.',
  'Notes about this call may follow; follow them.',
].join(' ');

function requireRealEnv() {
  const missing = ['META_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Real mode needs these in .env: ${missing.join(', ')}`);
}

// Error text from upstream never includes keys (only status and the body's own message).
async function upstreamError(name, r) {
  let detail = '';
  try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  return new Error(`${name} failed (HTTP ${r.status}) ${detail}`.trim());
}

// history: [{role:'user'|'assistant', content}], roster: text describing known/unknown speakers.
// Streams (stream:true, Accept: text/event-stream, chunks carry choices[0].delta.content,
// stream ends with "data: [DONE]"). onDelta(text) is called as text arrives; returns the full text.
async function sparkStreamOnce(history, roster, signal, onDelta) {
  const r = await fetch(META_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.META_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({
      model: META_MODEL,
      messages: [{ role: 'developer', content: `${PERSONA}\n${roster}` }, ...history],
      reasoning_effort: 'minimal',
      max_completion_tokens: 1500, // Spark's hidden reasoning counts here; 400 ran out and returned empty text (finish_reason length)
      stream: true,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
  });
  if (!r.ok) throw await upstreamError('Meta Spark', r);
  let text = '';
  let pending = '';
  let raw = ''; // first bytes of the stream, logged only if no text came back
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    const piece = dec.decode(chunk, { stream: true });
    if (raw.length < 600) raw += piece;
    pending += piece;
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      const delta = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
      if (typeof delta === 'string' && delta) { text += delta; onDelta(delta); }
    }
  }
  if (!text.trim()) {
    console.error('Spark empty stream, raw start:', JSON.stringify(raw.slice(0, 600)));
    throw Object.assign(new Error('Meta Spark returned no reply text'), { empty: true });
  }
  return text;
}

// One retry only when Spark streams back nothing (nothing was sent on yet); a second empty fails.
async function sparkStream(history, roster, signal, onDelta) {
  try { return await sparkStreamOnce(history, roster, signal, onDelta); }
  catch (e) { if (!e.empty) throw e; return sparkStreamOnce(history, roster, signal, onDelta); }
}

// ElevenLabs allows 5 requests in parallel for this plan (HTTP 429 concurrent_limit_exceeded
// otherwise). A reply is spoken as several pieces, so at most 3 run at once across all calls;
// the rest wait their turn (audio still goes out in order) and a 429 is retried briefly.
const MAX_TTS_CONCURRENT = 3;
let ttsActive = 0;
const ttsWaiters = [];

async function acquireTtsSlot(signal) {
  if (ttsActive < MAX_TTS_CONCURRENT) { ttsActive++; return; }
  await new Promise((resolve, reject) => {
    const w = { resolve };
    ttsWaiters.push(w);
    signal.addEventListener('abort', () => {
      const i = ttsWaiters.indexOf(w);
      if (i !== -1) { ttsWaiters.splice(i, 1); reject(signal.reason); }
    }, { once: true });
  });
}
function releaseTtsSlot() {
  const w = ttsWaiters.shift();
  if (w) w.resolve(); else ttsActive--;
}

// Streams PCM16 24 kHz chunks to onChunk(Buffer) as ElevenLabs generates them.
async function streamSpeech(text, signal, onChunk, previousText, nextText) {
  await acquireTtsSlot(signal);
  try {
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await fetch(`${ELEVEN_URL}${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}/stream?output_format=pcm_24000`, {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: VOICE_SETTINGS, ...(previousText ? { previous_text: previousText } : {}), ...(nextText ? { next_text: nextText } : {}) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
      if (r.status !== 429 || attempt >= 2) break;
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
    if (!r.ok) throw await upstreamError('ElevenLabs', r);
    let carry = null; // keep sample alignment: chunks can end mid-sample
    for await (const part of r.body) {
      let b = carry ? Buffer.concat([carry, part]) : Buffer.from(part);
      carry = null;
      if (b.length % 2) { carry = b.subarray(b.length - 1); b = b.subarray(0, b.length - 1); }
      if (b.length) onChunk(b);
    }
  } finally {
    releaseTtsSlot();
  }
}

module.exports = { requireRealEnv, sparkStream, streamSpeech };
