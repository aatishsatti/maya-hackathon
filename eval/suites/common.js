// Shared plumbing for the evaluation suites. Meta text only: the voice is stubbed out BEFORE call.js loads, so ElevenLabs can never be reached.
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');

// Runs fn over items with at most n at a time; results keep the order of items.
async function pool(n, items, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}
const letters = (k) => { let o = ''; do { o = String.fromCharCode(97 + (k % 26)) + o; k = Math.floor(k / 26) - 1; } while (k >= 0); return o; };
let seq = 0;
const nextName = (prefix) => `${prefix}${letters(seq++)}`;

// Loads the real stack with no voice. Called by every suite before it needs Call / memory / care.
function stack() {
  const brain = require(path.join(ROOT, 'brain'));
  brain.streamSpeech = async () => {};   // no voice: only the words matter here (and call.js has not loaded yet, so it picks this up)
  return { brain, memory: require(path.join(ROOT, 'memory')), care: require(path.join(ROOT, 'care')), ...require(path.join(ROOT, 'call')), ...require(path.join(ROOT, 'reply')), meta: require(path.join(ROOT, 'meta')) };
}

// A Call on a fake socket with a fresh profile. Always end() it when done so its silence timers cannot fire extra requests.
function makeCall(S, profileId) {
  const ws = { send() {}, close() {}, onmessage: null, onclose: null };
  const c = new S.Call(ws, 'k');
  c.profile = S.memory.load(profileId); c.callId = `c${Math.random().toString(16).slice(2)}`; c.registered = true; c.names.set('A', c.profile.name); c.seen.add('A');
  S.care.callStarted(profileId, c, null); c.greeted = true; S.memory.startCall(profileId, c.callId, null);
  return c;
}

// One turn exactly as respond() does it for a normal reply: care notes, memory focus, Spark, reply filters. No audio.
async function turn(S, c, text) {
  const extra = c.careNotes(text);
  c.history.push({ role: 'user', content: `${c.profile.name}: ${text}` });
  S.memory.appendTurn(c.profile.id, c.callId, { label: 'A', text, userSaid: true });
  c.abort = new AbortController(); const gen = ++c.gen; c.responding = true;
  c.setFocus(text, extra); const offered = Boolean(c.focus && c.focus.thread);
  try { await c.speakReply(S.startReply(c.history, c.roster(`${c.replyNote()} ${extra}`.trim()), c.abort.signal), null, gen, { record: true, stripGreeting: true }); } finally { c.focus = null; }
  return { user: text, maya: c.history[c.history.length - 1].content, offered };
}

// Records the private tag (topic, personal, beat...) of every reply, per Call, without changing anything.
function watchTags(S) {
  if (S.Call.prototype.__evalWatched) return;
  const orig = S.Call.prototype.applyBeat;
  S.Call.prototype.applyBeat = function (d, raw, special) { orig.call(this, d, raw, special); (this.__evalTags = this.__evalTags || []).push({ topic: raw && raw.topic, personal: raw && raw.personal, beat: d.beat, emotion: d.emotion }); };
  S.Call.prototype.__evalWatched = true;
}
module.exports = { ROOT, pool, nextName, stack, makeCall, turn, watchTags };
