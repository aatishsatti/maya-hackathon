// Ear-pick samples: 3 normal chats, the SAME senior lines,. Real Spark + real
// ElevenLabs voice. Writes data/samples/<style>-chat<N>.txt and .wav (git-ignored). Run once per style:
//   node test/samples.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env */ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-smp-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const STYLE = 'cheerful';
const memory = require('../memory');
const care = require('../care');
const { Call } = require('../call');
const { startReply } = require('../reply');

const CHATS = [
  ['I slept well last night', 'My grandson called me this morning', 'He got a new job at a bakery!', 'I am going to make some tea now', 'It is a sunny afternoon here'],
  ['Good afternoon Maya', 'I watched a cooking programme today', 'They made a lemon cake, it looked lovely', 'I used to bake with my sister', 'I think I will try one this weekend'],
  ['Hello', 'The garden has some new flowers', 'The neighbour gave me the seeds', 'I am a little tired today though', 'But it was a good morning'],
];
const SILENCE = Buffer.alloc(24000 * 2 * 0.7);
(async () => {
  const out = path.join(__dirname, '..', 'data', 'samples'); fs.mkdirSync(out, { recursive: true });
  for (const [ci, lines] of CHATS.entries()) {
    const audio = []; let turnAudio = [];
    const ws = { send(d) { if (Buffer.isBuffer(d) || d instanceof Uint8Array) turnAudio.push(Buffer.from(d)); }, close() {}, onmessage: null, onclose: null };
    const p = memory.createProfile(['Sama', 'Samb', 'Samc'][ci], 'female');
    const c = new Call(ws, 'k'); c.profile = memory.load(p.id); c.callId = 'x'; c.registered = true; c.names.set('A', c.profile.name); c.seen.add('A'); c.greeted = true;
    care.callStarted(p.id, c, null);
    const text = [];
    for (const l of lines) {
      turnAudio = [];
      const notes = c.careNotes(l);
      c.history.push({ role: 'user', content: `${c.profile.name}: ${l}` });
      c.abort = new AbortController(); const g = ++c.gen; c.responding = true;
      await c.speakReply(startReply(c.history, c.roster(`${c.replyNote()} ${notes}`.trim()), c.abort.signal), null, g, { record: true, stripGreeting: true });
      await new Promise((r) => setTimeout(r, 300));
      text.push(`SENIOR: ${l}\nMAYA:   ${c.history[c.history.length - 1].content}\n`);
      audio.push(Buffer.concat(turnAudio), SILENCE);
    }
    const pcm = Buffer.concat(audio);
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(path.join(out, `${STYLE}-chat${ci + 1}.wav`), Buffer.concat([h, pcm]));
    fs.writeFileSync(path.join(out, `${STYLE}-chat${ci + 1}.txt`), text.join('\n'));
    console.log(`--- ${STYLE} chat ${ci + 1} (${(pcm.length / 48000).toFixed(1)} s)\n${text.join('\n')}`);
  }
  care.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
