// Written chat with Maya: typed text, voice notes and photos. It is the SAME Maya as a voice call, not a second bot:
//   - same brain request (reply.startReply -> Spark with docs/maya-prompt.md and the persona), same profile memory
//     (memory.js: the words go to the same pending file and are filed into the same profile after the chat goes quiet),
//     same tone tiers (emotion.mapEmotionToDelivery + reply.ChunkSplitter), same pain ladder and safety rules, same ticket,
//     alert, Seen and family notes (care.js). The care logic is call.js's own methods (Call.prototype), borrowed below, so
//     there is one copy of each rule. Only the voice is missing: a typed reply is text.
//   - one session per profile id; nothing is shared between profiles (every note, memory and alert is keyed by profile id).
// A reply is never faked: if Spark, Transcribe, vision or the voice fails, the error is returned as it is.
//
// Voice notes: the app uploads a WAV (Meta's file Transcribe takes WAV only, see transcribe.js); words -> the brain -> an
// ElevenLabs voice (brain.streamSpeech, PCM 24 kHz) wrapped as WAV for playback. While a live call exists for the profile
// the reply is text only (no second voice over the call).
// Photos: Meta vision (brain.describeImage) writes a plain description; the brain answers it as it answers words.
// Audio and photos are stored only under data/media/<profile id>/ (git-ignored), never in the repo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startReply } = require('./reply');
const { ChunkSplitter, isQuestion } = require('./reply');
const { mapEmotionToDelivery, INTENTS, selfHarmText } = require('./emotion');
const { Call, TONES, scale, STORY_ASK, RECALL_ASK, IDENTITY_LINE, simpleAffirmation } = require('./call');
const memory = require('./memory');
const care = require('./care');

const MEDIA_DIR = () => process.env.MAYA_MEDIA_DIR || path.join(__dirname, 'data', 'media');
const IDLE_MS = 10 * 60 * 1000;          // a chat that has been quiet this long is filed into memory, like a call that ended
const MAX_THREAD = 200;
const MAX_HISTORY = 12;
const REPLY_TIMEOUT_MS = 120000;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }; // Meta vision types (image-understanding docs)
const MEDIA_TYPES = { wav: 'audio/wav', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const MEDIA_FILE = /^[a-f0-9]{16}\.(wav|jpg|png|gif|webp)$/;

// Network edges, replaceable in tests. Looked up when called so a test's stubbed brain module is the one used.
const deps = {
  transcribe: (wav) => require('./transcribe').transcribeWav(process.env.META_API_KEY, wav),
  describe: (buf, mime) => require('./brain').describeImage(buf, mime),
  scam: (buf, mime) => (process.env.META_API_KEY ? require('./scam').assess(buf, mime) : null), // Spark vision: is this a scam? (null = no key, no check)
  scamText: (text) => (process.env.META_API_KEY ? require('./scam').assessText(text) : null), // Spark text: is what they typed or said a scam? (null = no key, no check)
  official: (words, opts) => require('./official').check(words, opts), // the company they named, looked up on its official site only (official.js; typed chat only). Lookup failure is a fact, never a guess
  web: (words, opts) => require('./web').lookup(words, opts), // general web check (web.js, Tavily; key in the server env only): for what is not on the official allow-list. A failure is a fact (cannot verify), never a guess
  speak: (text, previous) => new Promise((resolve, reject) => { // one ElevenLabs piece -> Buffer of PCM16 24 kHz
    const parts = [];
    require('./brain').streamSpeech(text, new AbortController().signal, (c) => parts.push(c), previous).then(() => resolve(Buffer.concat(parts)), reject);
  }),
};

function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const isWav = (b) => b.length > 44 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
function imageMime(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function saveMedia(profileId, ext, data) {
  const dir = path.join(MEDIA_DIR(), profileId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), data);
  return name;
}
const mediaUrl = (profileId, name) => `/api/chat/${profileId}/media/${name}`;
function readMedia(profileId, name) {
  if (!/^[a-f0-9]{8}$/.test(profileId) || !MEDIA_FILE.test(name)) return null;
  try { return { data: fs.readFileSync(path.join(MEDIA_DIR(), profileId, name)), type: MEDIA_TYPES[name.split('.')[1]] }; } catch { return null; }
}

class ChatError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }

class ChatSession {
  constructor(profile, tz) {
    this.profile = profile;
    this.tz = tz || null;
    this.channel = 'chat';       // care.selfHarmAlert words the family note for a chat, not a call
    this.noTimers = true;        // in-call timers need a voice call (call.js careNotes)
    this.callId = `chat-${crypto.randomBytes(4).toString('hex')}`;
    this.names = new Map();
    this.seen = new Set();
    this.history = [];
    this.thread = [];            // what the app shows; memory only, never written to disk
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.started = false;
    this.closed = false;
    // The same per-conversation state call.js keeps, with the same meaning.
    this.escalations = 0; this.userTurns = 0; this.replyCount = 0; this.beatCount = 0; this.focus = null; this.followUpOffered = false; this.lastReplyAsked = false; this.askHistory = [];
    this.identitySaid = false; this.repeatRetried = false; this.openedWithInterjection = false; this.lastNameUse = -10;
    this.askedName = false; this.willAskName = false; this.lastExclaimed = false;
    this.health = false; this.safety = false; this.pendingConcern = null; this.familyAsked = false; this.ticketInCall = false;
    this.familyDeclined = false; this.said = []; this.reminderShown = null; this.seenShown = false; this.safetyAsked = new Set(); this.safetyFreshShown = false; this.healthFreshShown = false; this.scamOwed = null; this.rc = require('./official').newRc();   // rc: the one clarifying question about which company / link (official.js); as in call.js: a no to telling family lasts the whole chat; what they said, for recall asks
    this.prevDelivery = null; this.askWhat = false;
    this.reminderFacts = null; this.reminderPending = null; this.awaitAck = null; this.nameChance = 0;
  }

  push(msg) {
    const m = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), ...msg };
    this.thread.push(m);
    if (this.thread.length > MAX_THREAD) this.thread.shift();
    return m;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await memory.flushPending(this.profile.id); // words an earlier chat or call left behind are filed first
    memory.startCall(this.profile.id, this.callId, this.tz);
    this.ticketInCall = care.hasActiveSafety(this.profile.id);
    care.liveChats.set(this.profile.id, this);
  }

  // Quiet for IDLE_MS (or the app closed): file this chat's words into the profile's memory, like a call ending.
  finish() {
    clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.closed = true;
    if (care.liveChats.get(this.profile.id) === this) care.liveChats.delete(this.profile.id);
    if (!this.started) return;
    const heavy = this.escalations > 0 || (this.prevDelivery && ['sad', 'lonely', 'grief', 'anxious'].includes(this.prevDelivery.emotion));
    memory.endCall(this.profile.id, this.callId, { heavy: Boolean(heavy) });
  }
  armIdle() { clearTimeout(this.idleTimer); this.idleTimer = setTimeout(() => { sessions.delete(this.profile.id); this.finish(); }, IDLE_MS); this.idleTimer.unref(); }

  // One at a time per person: a second message waits for the first reply.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // heard = the person's own words (what the care rules read); message = what the brain is shown (a photo adds its description).
  turn({ heard, message = heard, how = 'text', note = '', scam = null, short = false }) {
    return this.serial(() => this.runTurn(heard, message, how, note, scam, short));
  }

  async runTurn(heard, message, how, note = '', scam = null, short = false) {
    await this.start();
    clearTimeout(this.idleTimer);
    const id = this.profile.id;
    this.seen.add('A');
    // Same order as Call.respond: care effects of the words first (safety words alert here, before any reply is written).
    const extra = this.careNotes(heard);
    this.history.push({ role: 'user', content: `${this.who('A')}: ${message}` });
    this.history = this.history.slice(-MAX_HISTORY);
    this.said = [...this.said, `${this.who('A')}: ${message}`].slice(-60);
    memory.appendTurn(id, this.callId, { label: 'A', text: message, userSaid: true });
    const channelNote = `CHANNEL: this is a written chat message in their app, not a call. ${how === 'voice' ? 'They sent you a voice note and the words above are what they said in it; you will answer by voice note, so write the way you would speak.' : how === 'image' ? 'They sent you a photo; the bracketed words describe it. Answer what matters to them, never claim to see more than the description says.' : 'They cannot hear you; write plainly, warm and short as in a call.'}`;
    this.setFocus(heard, `${extra} ${note}`.trim());
    this.shortReply = (short || Boolean(scam)) && !ASKS_MORE.test(heard);   // a web / scam / lookup answer is the gist in one or two sentences unless they asked for more
    this.scamReply = scam;   // 'warn' | 'caution' | null: the shape of THIS reply (see reply())
    try {
      const said = await this.reply(`${this.replyNote()} ${channelNote} ${extra} ${note}`.trim());
      this.commitReminder();   // the reply is out: a next-call reminder it carried now counts as delivered
      return said;
    } catch (e) {
      if (this.history.length && this.history[this.history.length - 1].role === 'user') this.history.pop(); // a failed turn cannot poison the next one
      throw e instanceof ChatError ? e : new ChatError(e.message);
    } finally { this.scamReply = null; this.shortReply = false; this.focus = null; this.reminderShown = null; this.seenShown = false; this.safetyFreshShown = false; this.healthFreshShown = false; this.armIdle(); }
  }

  // Runs Spark through the same splitter and delivery rules as speakReply, without audio. Returns { text, feel }.
  async reply(note, { again = false, safetyRetry = false } = {}) {
    const signal = AbortSignal.timeout(REPLY_TIMEOUT_MS);
    const rs = startReply(this.history, this.roster(note), signal);
    const pieces = [];
    let delivery = null, feel = null, repeated = null, retryWhy = 'repeat';
    const splitter = new ChunkSplitter({
      stripInterjection: this.openedWithInterjection,
      stripGreeting: true,
      onName: (l, n) => this.recordName(l, n),
      // Mirrors the onFeel in Call.speakReply (call.js): Spark's read goes through the deterministic map, then the same care effects.
      onFeel: (raw) => {
        const d = mapEmotionToDelivery(raw && raw.emotion, raw && raw.intensity, this.prevDelivery);
        const intent = raw && String(raw.intent).toLowerCase();
        const lastUser = ([...this.history].reverse().find((m) => m.role === 'user') || { content: '' }).content;
        if ((intent === 'story' && STORY_ASK.test(lastUser)) || (intent === 'recall' && RECALL_ASK.test(lastUser))) { d.maxSentences = Infinity; d.moments = 3; }
        if (this.lastExclaimed) d.maxExclaim = 0;
        if (this.safety || this.health || this.pendingConcern || (raw && (/^(1|yes|true)$/i.test(String(raw.pain || '')) || ['unsure', 'urgent'].includes(String(raw.concern || '').toLowerCase())))) { d.noBright = true; d.maxExclaim = 0; d.excitedOpening = false; if (d.openingTone === 'bright') d.openingTone = null; }
        if (this.safety) { d.escalate = false; d.maxExclaim = 0; d.excitedOpening = false; d.openingTone = null; d.moments = 0; d.maxSentences = 3; }
        const concern = String((raw && raw.concern) || '').toLowerCase();
        if (raw && /^(1|yes|true)$/i.test(String(raw.pain || ''))) care.painMention(this.profile.id); // counted AFTER the facts for this reply were built
        { const lu = ([...this.history].reverse().find((m) => m.role === 'user') || { content: '' }).content; const it = String((raw && raw.intent) || '').toLowerCase();
          if (simpleAffirmation(lu) && it !== 'story' && it !== 'recall' && !this.safety && !this.health && !this.pendingConcern && !this.scamReply && !(raw && (/^(1|yes|true)$/i.test(String(raw.pain || '')) || ['unsure', 'urgent'].includes(concern)))) d.maxSentences = 1; }   // a bare yes / okay gets one short line, as in a call
        d.noQuestion = this.lastReplyAsked && concern !== 'unsure';
        if (concern === 'unsure' && this.familyDeclined && !this.health && !this.safety) d.noQuestion = true; // already said no to telling family: no second ask
        if (concern === 'urgent' && !this.health && !this.safety && !this.inScamTurn(lastUser)) this.enterHealth();
        else if (concern === 'unsure' && !this.familyDeclined && !this.health && !this.safety && !this.scamReply && !this.inScamTurn(lastUser)) this.pendingConcern = { left: 2 }; // a scam question is its own question: never also the older "is something wrong?" one
        // A scam reading is a few short sentences, not the usual two: what it says, that it looks like a scam and what not to do yet (in her own words), and (for a
        // warning) the ONE question about telling their family. Calm and plain: nothing bright, no exclamation.
        if (this.scamReply) { d.noBright = true; d.maxExclaim = 0; d.excitedOpening = false; d.openingTone = null; d.moments = 0; d.noQuestion = !['warn', 'pause'].includes(this.scamReply); d.maxSentences = ASKS_MORE.test(lastUser) ? 4 : ['warn', 'pause'].includes(this.scamReply) && !care.scamTold(this.profile.id) ? 3 : 2; }   // the gist: two short sentences, three when the one question about telling their family is still owed; more only if they asked
        if (this.shortReply && !this.scamReply && !this.safety && !this.health) d.maxSentences = Math.min(d.maxSentences, 2);
        this.applyBeat(d, raw, Boolean(this.safety || this.health || this.pendingConcern || this.scamReply));
        delivery = d;
        feel = { emotion: d.emotion, intensity: d.intensity, intent: raw && INTENTS.includes(String(raw.intent).toLowerCase()) ? String(raw.intent).toLowerCase() : 'unclear' };
        return d;
      },
      onPiece: (text, kind) => {
        if (this.breaksFacts(text)) { if (again) return; repeated = text; retryWhy = 'facts'; splitter.halted = true; return; }   // nothing is shown until the whole reply is done: any piece that claims what the app never did, or a stock counselling line, means write it again
        if (!pieces.length && !again && !this.safety) {
          const why = this.repeatsOpening(text) ? 'repeat' : this.beatBlocks(text, delivery) ? 'beat' : null;
          if (why) { repeated = text; retryWhy = why; splitter.halted = true; return; }
        } // nothing shown yet: write it again
        pieces.push({ text, kind });
      },
    });
    try {
      for await (const d of rs.chunks()) { splitter.feed(d); if (splitter.halted) break; }
      splitter.end();
    } catch (e) {
      if (!(e && e.empty && !pieces.length)) throw new ChatError(`Maya could not answer: ${e.message}`);
    }
    if (splitter.halted && repeated) return this.reply(`${note} ${retryWhy === 'facts' ? `Your draft said "${repeated}", which the app's facts do not support (a family alert that was never made, a reason nobody gave, or a stock comfort line). Write the whole reply again in plain, short, direct words: say only what the FAMILY ALERTS fact says, no excuse, no soothing line.` : retryWhy === 'beat' ? `Your draft began "${repeated}", but this reply must not ask a question. Write the whole reply again from the start as a short statement, in your own words.` : `Your draft began "${repeated}", which repeats something you already said. Write the whole reply again from the start, opening in completely different words, with no stock comfort phrase and no mention of who you are.`}`, { again: true });
    if (splitter.halted && !safetyRetry) { // Spark read the person as in crisis before saying anything: Tier A, then the reply is written again with the safety note
      this.enterSafety();
      return this.reply(`${this.replyNote()} ${this.safetyNote()}`, { safetyRetry: true });
    }
    if (!pieces.length) throw new ChatError('Maya could not answer right now: no reply came back.'); // never a faked reply
    const all = pieces.map((p) => p.text).join(' ').replace(/\s+([,.;:!?])/g, '$1');
    this.history.push({ role: 'assistant', content: all });
    memory.appendTurn(this.profile.id, this.callId, { who: 'Maya', text: all });
    // Bookkeeping the next reply depends on (same as the end of Call.speakReply).
    if (IDENTITY_LINE.test(all)) this.identitySaid = true;
    care.addLine(this.profile.id, 'open', pieces[0].text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).slice(0, 8).join(' '));
    this.openedWithInterjection = /^(oh|well|ah|hmm|um)\b/i.test(pieces[0].text);
    for (const n of this.names.values()) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(all)) this.lastNameUse = this.replyCount;
    this.replyCount += 1;
    if (delivery && delivery.beatN != null) this.beatCount = delivery.beatN;
    care.trendTurn(this.profile.id, delivery);   // counts only (see call.js)
    this.lastReplyAsked = isQuestion(all);
    this.lastExclaimed = /!/.test(all);
    if (this.safety) care.addLine(this.profile.id, 'safety', all);
    this.askHistory = [...this.askHistory, this.lastReplyAsked].slice(-4);
    if (this.safety && /\bsafe\b/i.test(all) && isQuestion(all)) care.safeAsked(this.profile.id);
    if (this.safety && isQuestion(all)) this.noteSafetyAsked(all);
    this.prevDelivery = delivery;
    return { text: all, pieces, feel };
  }

  // The family looked at the ticket while this person is chatting: say so in fresh words, once, as a message from Maya.
  onTicketClosed() {
    if (this.closed || !this.ticketInCall || this.ticketTold) return;
    this.ticketTold = true;
    this.ticketInCall = false;
    const SEEN_ANGLES = ['lead with reassurance', 'lead with how glad you are to be with them', 'lead with the fact that their family knows', 'lead with saying they are not alone'];
    this.serial(async () => {
      const l = await this.dynamicLine({ pool: 'seen', signal: AbortSignal.timeout(60000), sentences: 2, what: `FACT: a moment ago their family looked at the worry about them and now knows. You are already mid-conversation in a written chat: do NOT greet them, do NOT say hello, do NOT introduce yourself or say your name. Tell them so in one or two short, warm, fresh sentences: their family knows, someone will check on them, and you are with them, so they need not worry (${SEEN_ANGLES[Math.floor(Math.random() * SEEN_ANGLES.length)]}). If you use a name, use ONLY the name in your notes for them, never any other name. Never say "let them sort things out" or leave it to others; never copy a comfort phrase. Never promise an exact time or a call, never name a button, page, app, notification or anything technical, do not ask a question, do not repeat what they said earlier.` });
      care.addLine(this.profile.id, 'seen', l.said); care.clearSeenToTell(this.profile.id);
      this.history.push({ role: 'assistant', content: l.said });
      const m = this.push({ role: 'maya', kind: 'text', text: l.said, unprompted: true });
      care.pushSenior(this.profile.id, 'chat', { message: m });
    }).catch((e) => console.error('chat seen line failed:', e.message));
  }
}
// Care and prompt rules live in call.js; the chat borrows those methods so each rule has one copy.
for (const m of ['commitReminder', 'noteSafetyAsked', 'careNotes', 'enterSafety', 'enterHealth', 'healthNote', 'safetyNote', 'safetyContext', 'roster', 'replyNote', 'recentOpenings', 'recentReplies', 'setFocus', 'applyBeat', 'beatBlocks', 'repeatsOpening', 'breaksFacts', 'familyRelevant', 'limitsFacts', 'lastHeard', 'recordName', 'who', 'dynamicLine', 'inScamTurn']) {
  ChatSession.prototype[m] = Call.prototype[m];
}

const sessions = new Map(); // profile id -> ChatSession
function session(profileId, tz) {
  const profile = memory.load(profileId);
  if (!profile) throw new ChatError('Not found', 404);
  let s = sessions.get(profileId);
  if (!s) { s = new ChatSession(profile, tz); sessions.set(profileId, s); }
  if (tz && !s.tz) s.tz = tz;
  return s;
}

// What was SPOKEN on a call joins the same written thread (memory only, like the rest of it), so minimising the call shows the whole
// conversation in the chat and nothing said aloud disappears. Pushed to the open app as a normal chat message. Never throws into a call.
function mirrorSpoken(profileId, role, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || (role !== 'maya' && role !== 'senior')) return null;
  try {
    const m = session(profileId).push({ role, kind: 'text', text: t, spoken: true });
    care.pushSenior(profileId, 'chat', { message: m });
    return m;
  } catch { return null; }
}

// When the person last wrote to Maya or she wrote to them in the chat (not the lines mirrored from a call), or 0: a fact for the next greeting.
const ASKS_MORE = /\b(more|details?|explain|in full|everything|the whole|elaborate|go on|longer|in depth)\b/i;
const lastWrittenAt = (profileId) => { const s = sessions.get(profileId); const m = s && [...s.thread].reverse().find((x) => !x.spoken); return m ? m.at : 0; };
// Chat -> call continuity, decided in code: when they wrote to Maya minutes ago, these are the facts the next call's greeting picks up from (call.js greetingNote).
// Topic by code: an open scam question or scam of the last half hour first (the kind only), else the gist of their last written message. Facts only, never a sentence.
const CONT_MS = 30 * 60000;
function continuity(profileId, now = Date.now()) {
  const at = lastWrittenAt(profileId), s = sessions.get(profileId);
  if (!at || now - at > CONT_MS || !s) return null;
  const p = care.get(profileId), mins = Math.max(1, Math.round((now - at) / 60000));
  const last = [...s.thread].reverse().find((m) => !m.spoken && m.role === 'senior');
  const clip = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const pend = care.scamPending(profileId), recent = (p && p.scams || []).find((x) => now - x.createdAt < CONT_MS), type = (pend && pend.type) || (s.rc && s.rc.scam && s.rc.scam.type) || (recent && recent.type) || null;
  const bits = [`last chat turn ${mins} minute${mins === 1 ? '' : 's'} ago`];
  let topic;
  if (type) {
    topic = `a possible ${type} message they told you about or showed you`;
    bits.push(`the chat topic is ${topic}${last && last.text ? ` (their last written words, quoted data: "${clip(last.text)}")` : ''}`);
    const open = require('./official').asking(s.rc);
    if (open) bits.push('you asked them for the company name, the web address, or a screenshot, and they have not sent it yet');
    if (pend) bits.push('you asked whether to let their family know, and it is still unanswered');
    bits.push(care.scamTold(profileId) ? 'their family WAS told about it (topic only)' : care.scamDeclined(profileId, type) ? 'they said NO to telling their family about it: nobody was told' : 'their family was NOT told about it');
  } else {
    topic = last ? (last.kind === 'image' && !last.text ? 'a photo they sent' : `"${clip(last.text)}"`) : null;
    if (!topic) return null;
    bits.push(`the chat topic is their last written message (quoted data): ${topic}`);
  }
  const owed = (p && p.checks || []).filter((c) => !c.delivered);
  if (owed.length) bits.push(owed.some((c) => c.status === 'done') ? 'a lookup you started has finished and its result is not yet told' : 'a lookup you started is still running');
  return { at, topic, open: Boolean(type) || owed.length > 0, facts: bits.join('; ') };
}
const callLive = (profileId) => care.liveCalls.has(profileId);
const thread = (profileId) => { session(profileId); return sessions.get(profileId).thread.slice(); };

// ---- the three ways in ----
// Typed or spoken talk that may be a scam (scam.js): the cheap word filter decides whether it is worth one Spark check; chat is not
// latency-critical, so the check is simply awaited before Maya answers. A failed check never blocks the reply and never invents a verdict.
// Safety first: nothing is checked while a safety alert is active or when the words themselves are about self-harm, and a pending
// "shall I tell your family?" question is answered, not re-asked.
async function talkCheck(profileId, words) {
  const scam = require('./scam');
  if (!scam.needsCheck(words) || care.hasActiveSafety(profileId) || care.scamPending(profileId) || selfHarmText(words)) return null;
  try { return await deps.scamText(words); } catch (e) { console.error('scam check failed:', e.message); return null; }
}
// Official source (official.js), typed chat only: on a warn / pause the company they named is looked up on its official site; if none is clear, ONE
// reconfirm question is asked first (type the link, or send a photo) and the family question waits for their answer. Returns facts for Spark.
const familyState = (profileId, type) => ({ told: Boolean(care.scamTold(profileId)), declined: Boolean(type && care.scamDeclined(profileId, type)), pending: Boolean(care.scamPending(profileId)) });
const officialStep = (s, profileId, words, scam) => require('./official').step(s.rc, { words, scam, channel: 'text', run: (w, o) => deps.official(w, o), web: (w, o) => deps.web(w, o), background: (w) => require('./checks').start(profileId, w, { official: deps.official, web: deps.web }), family: familyState(profileId, (scam || s.rc.scam || {}).type) });
// After her reply: the one question is out, so the person's yes or no (in the chat or on a call) settles it (care.scamAnswer).
const afterTalkReply = (profileId, scam, channel, off = null) => {
  if (off && off.resolved) { if (off.askFor) care.scamAsk(profileId, off.askFor.type, { channel, pause: off.askFor.level === 'pause', official: off.askFor.official }); else care.scamOfficial(profileId, off.official); return; }   // the reconfirm was answered: the family question now, if it is still owed
  if (scam && (scam.level === 'warn' || scam.level === 'pause') && !care.scamTold(profileId)) care.scamAsk(profileId, scam.type, { channel, pause: scam.level === 'pause', official: off ? off.official : null });
};
const talkTurn = (scam, profileId, off = null) => ({ note: [scam && !(off && off.resolved) ? require('./scam').talkNote(scam, { told: Boolean(care.scamTold(profileId)), declined: Boolean(care.scamDeclined(profileId, scam.type)) }) : '', off ? off.note : ''].filter(Boolean).join(' '), scam: scam && scam.level !== 'none' ? scam.level : null });

async function sendText(profileId, text, tz, opts = {}) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new ChatError('Please type a message first.', 400);
  const s = session(profileId, tz);
  care.touch(profileId, opts.source === 'whatsapp' ? 'whatsapp' : 'app'); // whatsapp.js: the same chat, a different door
  if (opts.source !== 'whatsapp') care.chatNote(profileId, 'text');   // an Activity entry for the app chat (a WhatsApp reply is not one: it answers a check or a reminder)
  if (opts.source !== 'whatsapp' && require('./call').isAck(t)) care.reminderAckApp(profileId);   // "okay" to a reminder that came to the app: answered
  const you = s.push({ role: 'senior', kind: 'text', text: t });
  // A reconfirm question is open: this message may settle it (a plain yes / no to the family question does not). Otherwise the usual scam check.
  let scam = null, off = null;
  if (require('./official').asking(s.rc) && !care.hasActiveSafety(profileId) && !selfHarmText(t)) { off = await officialStep(s, profileId, t, null); if (off) scam = off.scam; }
  if (!off) { scam = await talkCheck(profileId, t); if (scam && (scam.level === 'warn' || scam.level === 'pause')) off = await officialStep(s, profileId, t, scam); }
  // Anything else that needs checking (news, a claim, a medicine): the general web check; a failed search tells her she cannot verify it.
  const tt = talkTurn(scam, profileId, off);
  let sources = [];
  if (!off && (!scam || scam.level === 'none') && !care.hasActiveSafety(profileId) && !s.health && !s.safety && !selfHarmText(t)) {
    let g = null;
    try { g = await deps.web(t, {}); } catch (e) { console.error('web check failed:', e.message); g = { topics: [{ kind: 'claim', label: 'what they told you', failed: 'error', results: [] }] }; }
    const wn = require('./web').note(g); if (wn) { tt.note = [tt.note, wn].filter(Boolean).join(' '); tt.short = true; sources = require('./web').sources(g); }
  }
  const due = care.checkDueIds(profileId);
  const r = await s.turn({ heard: t, ...tt });
  care.checkDelivered(profileId, due);   // a finished lookup was handed to her with this reply: told once
  afterTalkReply(profileId, scam, 'text', off);
  return { messages: [you, s.push({ role: 'maya', kind: 'text', text: r.text, ...(sources.length ? { sources } : {}) })], ...(scam && scam.level !== 'none' ? { scam: scam.level } : {}) };
}

// Maya's voice for a written reply: each piece with the same delivery tag and gain as a call (call.js TONES), joined as WAV.
async function voiceFor(pieces) {
  const bufs = [];
  let previous;
  for (const p of pieces) {
    const tone = TONES[p.kind];
    const text = p.text.replace(/^[,;:\s]+/, '');
    let pcm = await deps.speak(tone ? `${tone[0]} ${text}` : text, previous);
    if (tone && tone[1] !== 1) pcm = scale(pcm, tone[1]);
    bufs.push(pcm, Buffer.alloc(120 * 48)); // 24 kHz s16 mono = 48 bytes per ms; a short breath between pieces
    previous = text.slice(-300);
  }
  return pcmToWav(Buffer.concat(bufs));
}

// A reminder (or any short note) as Maya's voice in the chat: a voice message with its words, pushed to the open app as a normal chat message (a closed app finds it in the thread when it opens).
// Returns { message, reached }: reached counts the open apps it was pushed to. Throws if her voice cannot be made (the caller then sends the words as text; never a fake voice note).
async function deliverVoiceNote(profileId, spoken, text) {
  const s = session(profileId);
  const pcm = await deps.speak(spoken);
  const name = saveMedia(profileId, 'wav', pcmToWav(pcm));
  const m = s.push({ role: 'maya', kind: 'voice', text: String(text || spoken), mediaUrl: mediaUrl(profileId, name) });
  return { message: m, reached: care.pushSenior(profileId, 'chat', { message: m }) };
}

async function sendVoiceNote(profileId, wav, tz, opts = {}) {
  if (!isWav(wav)) throw new ChatError('The voice note must be a WAV recording.', 415);
  const s = session(profileId, tz);
  care.touch(profileId, opts.source === 'whatsapp' ? 'whatsapp' : 'app');
  if (opts.source !== 'whatsapp') care.chatNote(profileId, 'voice');
  let words;
  try { words = await deps.transcribe(wav); } catch (e) { throw new ChatError(e.message); }
  if (!words) throw new ChatError('I could not hear any words in that voice note. Please try recording it again.', 422);
  // The words are known but no reply is written yet: the caller (whatsapp.js) may act on them first, so Maya's reply already knows what they did (a spoken "okay" to a reminder is marked answered
  // BEFORE the reply, exactly as for typed text). A failing callback never breaks the chat.
  if (typeof opts.onWords === 'function') { try { opts.onWords(words); } catch (e) { console.error('voice note callback failed:', e.message); } }
  const mine = saveMedia(profileId, 'wav', wav);
  const you = s.push({ role: 'senior', kind: 'voice', text: words, mediaUrl: mediaUrl(profileId, mine) });
  const scam = await talkCheck(profileId, words);
  const r = await s.turn({ heard: words, how: 'voice', ...talkTurn(scam, profileId) });
  afterTalkReply(profileId, scam, 'spoken');
  // A live call has the voice: the note's answer is text only, so two Mayas never talk at once.
  if (callLive(profileId)) return { messages: [you, s.push({ role: 'maya', kind: 'text', text: r.text })], voice: 'suppressed-call-live' };
  try {
    const out = voiceFor(r.pieces);
    const name = saveMedia(profileId, 'wav', await out);
    return { messages: [you, s.push({ role: 'maya', kind: 'voice', text: r.text, mediaUrl: mediaUrl(profileId, name) })] };
  } catch (e) { // voice failed: the words are still shown, labelled, never a silent or fake voice note
    return { messages: [you, s.push({ role: 'maya', kind: 'text', text: r.text, voiceError: `Maya's voice failed: ${e.message}` })], voice: 'failed' };
  }
}

// Spark's private feel tag once read a scam letter as "concern=urgent", which the existing health rule treats as a medical emergency: a
// false safety alert to the family. The note therefore says plainly that this turn is about a message, not about their health.
const SCAM_FEEL = " In your private [[feel: ...]] tag use concern=none and pain=0 and never emotion=crisis: this is about a message, not about their health or safety, so never mark it urgent or unsure.";

// What Maya is told about a photo that looks like a scam. Two or more signals warn; one is caution; none says nothing at all.
function scamNote(scam, profileId) {
  if (!scam || scam.level === 'none') return '';
  const declined = Boolean(profileId && care.scamDeclined(profileId, scam.type)), told = Boolean(profileId && care.scamTold(profileId));
  const signs = require('./scam').said(scam.signals).join('; ');
  // Principles only (like the typed / spoken note in scam.js): Spark finds her own words for the warning; the app dictates no phrase.
  if (scam.level === 'warn') return `SCAM CHECK (a fact from the app, not from them): what they showed you looks like a possible ${scam.type}, with several warning signs (${signs}). In plain, calm words of your own: first say in one or two short sentences what it says, from this reading: ${scam.reading}. Then say that it looks like a scam, never that it is certain, and ask them not to pay, send money, share codes or details, or reply yet. Say the safe way is to check with the real company or bank themselves, through a number or website they already trust; never give a number yourself. ${declined ? 'They already said NO to letting their family know about this: do NOT ask again; nothing was sent.' : told ? 'Their family was ALREADY told about a possible scam earlier: do NOT ask whether to tell them, and do not say you have just told them.' : 'Then ask ONE short question: would they like you to let their family know? (This overrides any earlier instruction about not asking a question: ask it.)'} No diagnosis, no legal advice, no guarantee, no names or blame. Keep it short, warm and plain.${SCAM_FEEL}`;
  return `SCAM CHECK (a fact from the app, not from them): what they showed you has one warning sign (${signs}). Say in one or two short sentences what it says, in your own words, from this reading: "${scam.reading}". Then gently suggest they check with their family or the real company before replying or paying. Do not call it a scam and do not ask about telling their family. No phone numbers, no names or blame. Keep it short, warm and plain.${SCAM_FEEL}`;
}

async function sendImage(profileId, buf, caption, tz, opts = {}) {
  const mime = imageMime(buf);
  if (!mime) throw new ChatError('That file is not a photo Maya can read (JPEG, PNG, GIF or WebP).', 415);
  const s = session(profileId, tz);
  care.touch(profileId, 'app');
  if (opts.source !== 'whatsapp') care.chatNote(profileId, 'text');
  let seen, scam = null;
  try {
    // Two Spark vision calls side by side: what the photo shows, and whether it is a scam (scam.js). A failed scam check never blocks
    // the photo and never invents a verdict: the photo is then answered as any other photo.
    const check = Promise.resolve().then(() => deps.scam(buf, mime)).catch((e) => { console.error('scam check failed:', e.message); return null; });
    [seen, scam] = await Promise.all([deps.describe(buf, mime), check]);
  } catch (e) { throw new ChatError(e.message); }
  const said = String(caption || '').trim().slice(0, 1000);
  const mine = saveMedia(profileId, IMAGE_TYPES[mime], buf);
  const you = s.push({ role: 'senior', kind: 'image', text: said, mediaUrl: mediaUrl(profileId, mine) });
  const message = `[They sent a photo. The photo shows: ${seen}]${said ? ` ${said}` : ''}`;
  // Official source (official.js): what the vision read says about the company / link (the photo's text, never kept) is checked like typed words. A photo
  // asked for by a reconfirm question settles it; a photo that is itself a warn gets the check too. Nothing readable = cannot verify, never invented.
  const O = require('./official'), asking = O.asking(s.rc), photoWarn = Boolean(scam && scam.level === 'warn');
  let off = null;
  if (!care.hasActiveSafety(profileId)) {
    if (asking) off = await officialStep(s, profileId, `${seen} ${said}`, null);   // the photo answers the question that was asked
    else if (photoWarn) off = await O.look(`${seen} ${said}`, { run: (w, o) => deps.official(w, o) });
  }
  const shaped = off && off.scam ? off.scam : scam;
  // A web address, e-mail or company on the screenshot that the allow-list did not settle: the web look-up runs in the BACKGROUND and she says she is looking into it.
  let started = '';
  if ((photoWarn || (off && off.resolved)) && !care.hasActiveSafety(profileId) && require('./web').extract(`${seen} ${said}`, { scam: true }).some((tp) => tp.kind === 'link' || tp.kind === 'company') && !(off && off.official && off.official.found)) {
    if (require('./checks').start(profileId, `${seen} ${said}`, { official: deps.official, web: deps.web, skipOfficial: true })) started = require('./checks').startedNote();
  }
  const note = [off && off.resolved ? '' : scamNote(scam, profileId), off ? off.note : '', started].filter(Boolean).join(' ');
  const due = care.checkDueIds(profileId);
  const r = await s.turn({ heard: said, message, how: 'image', note, scam: shaped && shaped.level !== 'none' ? shaped.level : null });
  care.checkDelivered(profileId, due);
  // Her one question is out: from now on the person's yes or no (in the chat or on a call) settles it (care.scamAnswer).
  if (off && off.resolved) { if (off.askFor) care.scamAsk(profileId, off.askFor.type, { official: off.askFor.official }); else care.scamOfficial(profileId, off.official); }
  else if (photoWarn && !care.scamTold(profileId)) care.scamAsk(profileId, scam.type, { official: off ? off.official : null });
  const level = scam ? scam.level : 'none';
  // A warning is read aloud (a voice note) unless a call is live: then it is written, so two Mayas never talk at once.
  if (level !== 'none' && !callLive(profileId)) {
    try {
      const name = saveMedia(profileId, 'wav', await voiceFor(r.pieces));
      return { messages: [you, s.push({ role: 'maya', kind: 'voice', text: r.text, mediaUrl: mediaUrl(profileId, name) })], scam: level };
    } catch (e) { return { messages: [you, s.push({ role: 'maya', kind: 'text', text: r.text, voiceError: `Maya's voice failed: ${e.message}` })], scam: level, voice: 'failed' }; }
  }
  return { messages: [you, s.push({ role: 'maya', kind: 'text', text: r.text })], scam: level };
}

// A deleted profile takes its chat, photos and voice notes with it.
function forget(profileId) {
  const s = sessions.get(profileId);
  if (s) { sessions.delete(profileId); s.finish(); }
  if (/^[a-f0-9]{8}$/.test(profileId)) fs.rmSync(path.join(MEDIA_DIR(), profileId), { recursive: true, force: true });
}
// Test and shutdown helper: files every open chat into memory now.
function endAll() { for (const [id, s] of sessions) { sessions.delete(id); s.finish(); } }

module.exports = { continuity, lastWrittenAt, mirrorSpoken, deliverVoiceNote, deps, sendText, sendVoiceNote, sendImage, thread, readMedia, forget, endAll, callLive, pcmToWav, isWav, imageMime, ChatError, ChatSession, sessions };
