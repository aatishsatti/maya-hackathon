// Ear-pick greetings: 3 return-call greetings for Samantha, written by real Spark
// and spoken by Maya's own voice pipeline (ElevenLabs, same settings; cheerful uses the same [happy] handling). Files go to
// data/samples/greetings/<style>-greet<N>.{txt,wav} (git-ignored). Run once per style. No server needed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env */ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-grt-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
const STYLE = 'cheerful';
const memory = require('../memory');
const care = require('../care');
const { Call } = require('../call');
const { fixedReply } = require('../reply');

(async () => {
  const out = path.join(__dirname, '..', 'data', 'samples', 'greetings'); fs.mkdirSync(out, { recursive: true });
  const p = memory.createProfile('Samantha', 'female');
  for (let i = 0; i < 3; i++) { const c = { userTurns: 2 }; care.callStarted(p.id, c, null); care.callEnded(p.id, c, 'left'); } // a returning senior, not a first call
  const hours = [9, 14, 19];
  for (let i = 0; i < 3; i++) {
    let audio = [];
    const ws = { send(d) { if (Buffer.isBuffer(d) || d instanceof Uint8Array) audio.push(Buffer.from(d)); }, close() {}, onmessage: null, onclose: null };
    const c = new Call(ws, 'k'); c.profile = memory.load(p.id); c.callId = 'x'; c.registered = true; c.shortGreeting = true; c.nameChance = 0.4;
    const line = await c.dynamicLine({ pool: 'greeting', signal: new AbortController().signal, what: c.greetingNote(hours[i]), sentences: 2 });
    care.addLine(p.id, 'greeting', line.said);
    c.gen = 1; c.abort = new AbortController(); c.responding = true;
    await c.speakReply(fixedReply(line.full), null, 1, { greeting: true, maxSentences: 2, bright: STYLE === 'cheerful' && c.greetingPlain === true });
    await new Promise((r) => setTimeout(r, 400));
    const pcm = Buffer.concat(audio);
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    const wav = path.join(out, `${STYLE}-greet${i + 1}.wav`);
    fs.writeFileSync(wav, Buffer.concat([h, pcm])); fs.writeFileSync(path.join(out, `${STYLE}-greet${i + 1}.txt`), `${line.said}\n`);
    console.log(`${STYLE}-greet${i + 1}.wav  ${fs.statSync(wav).size} bytes  ${(pcm.length / 48000).toFixed(2)} s  "${line.said}"`);
  }
  care.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
