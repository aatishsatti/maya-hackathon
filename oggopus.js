// Voice-note audio for WhatsApp: Ogg/Opus both ways (whatsapp.js). Docs read (messages/audio-messages, media):
//   Voice messages need .ogg encoded with the OPUS codec, mono only; plain "audio/ogg" without Opus is not supported; upload type "audio/ogg; codecs=opus";
//   the play icon shows only if the file is 512 KB or smaller (bigger = a download icon); an incoming voice note is the same: Ogg/Opus.
// Two dependencies, both pure JS / WASM with no system binary (Render's Node runtime has no ffmpeg): ogg-opus-decoder (incoming) and opusscript (outgoing).
// The Ogg muxer below follows RFC 3533 (pages, lacing, CRC-32 poly 0x04c11db7) and RFC 7845 (OpusHead / OpusTags, granule at 48 kHz).
const OpusScript = require('opusscript');

const RATE = 48000, FRAME = 960;          // Opus runs at 48 kHz; 20 ms = 960 samples
const PRE_SKIP = 312;                      // decoder look-ahead at 48 kHz (RFC 7845 recommends 3840 max; 312 is libopus's value)
const BITRATE = 32000;                     // speech; about 4 KB a second, so 512 KB is over two minutes

const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t[i] = r >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0; for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ buf[i]) & 0xff]) >>> 0; return c; };

function page(type, granule, serial, seq, packets) {
  const segs = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
  const head = Buffer.alloc(27 + segs.length);
  head.write('OggS', 0, 'latin1'); head[4] = 0; head[5] = type;
  head.writeBigUInt64LE(BigInt(granule), 6); head.writeUInt32LE(serial, 14); head.writeUInt32LE(seq, 18); head.writeUInt32LE(0, 22); head[26] = segs.length;
  segs.forEach((s, i) => { head[27 + i] = s; });
  const out = Buffer.concat([head, ...packets]);
  out.writeUInt32LE(crc32(out), 22);
  return out;
}
const segCount = (len) => Math.floor(len / 255) + 1;

// PCM16 LE mono at `rate` Hz -> Ogg/Opus file (Buffer). Rates that divide 48000 evenly (24000, 16000, 12000, 8000, 48000) are resampled by repeating samples
// and smoothing; the voice is speech, so the simple linear step is plenty.
function encode(pcm, rate = 24000) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) throw new Error('No audio to encode.');
  if (!Number.isInteger(RATE / rate)) throw new Error(`Cannot encode ${rate} Hz audio.`);
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const up = RATE / rate, n = src.length * up;
  const wide = new Int16Array(Math.ceil(n / FRAME) * FRAME); // zero padded to whole 20 ms frames
  for (let i = 0; i < n; i++) { const a = src[Math.floor(i / up)], b = src[Math.min(src.length - 1, Math.floor(i / up) + 1)], f = (i % up) / up; wide[i] = Math.round(a + (b - a) * f); }
  const enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  enc.setBitrate(BITRATE);
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const head = Buffer.alloc(19); head.write('OpusHead', 0, 'latin1'); head[8] = 1; head[9] = 1; head.writeUInt16LE(PRE_SKIP, 10); head.writeUInt32LE(rate, 12); head.writeInt16LE(0, 16); head[18] = 0;
  const vendor = Buffer.from('Maya'); const tags = Buffer.alloc(8 + 4 + vendor.length + 4); tags.write('OpusTags', 0, 'latin1'); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12); tags.writeUInt32LE(0, 12 + vendor.length);
  const pages = [page(0x02, 0, serial, 0, [head]), page(0, 0, serial, 1, [tags])];
  let seq = 2, group = [], segs = 0;
  const frames = wide.length / FRAME;
  try {
    for (let f = 0; f < frames; f++) {
      const bytes = Buffer.from(wide.buffer, wide.byteOffset + f * FRAME * 2, FRAME * 2);
      const packet = Buffer.from(enc.encode(bytes, FRAME));
      const last = f === frames - 1;
      if (group.length && segs + segCount(packet.length) > 255) { pages.push(page(0, (f * FRAME) + PRE_SKIP, serial, seq++, group)); group = []; segs = 0; }
      group.push(packet); segs += segCount(packet.length);
      if (last) pages.push(page(0x04, Math.ceil(n) + PRE_SKIP, serial, seq++, group)); // end of stream: granule = real samples + pre-skip, so the zero padding is trimmed
    }
  } finally { enc.delete(); }
  return Buffer.concat(pages);
}

// Ogg/Opus file -> PCM16 LE mono at `rate` Hz (a box-filter step down from the decoder's 48 kHz). Async: the decoder is WASM.
async function decode(file, rate = 24000) {
  if (!Buffer.isBuffer(file) || file.length < 28 || file.toString('latin1', 0, 4) !== 'OggS') throw new Error('That is not an Ogg audio file.');
  const { OggOpusDecoder } = require('ogg-opus-decoder');
  const dec = new OggOpusDecoder();
  let out;
  try {
    await dec.ready;
    out = await dec.decodeFile(new Uint8Array(file.buffer, file.byteOffset, file.length));
  } finally { dec.free(); }
  if (!out || !out.samplesDecoded) throw new Error('No sound could be read from that voice note.');
  const ch = out.channelData, inRate = out.sampleRate, len = out.samplesDecoded;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch.length; c++) for (let i = 0; i < len; i++) mono[i] += ch[c][i] / ch.length;
  const step = inRate / rate, outLen = Math.floor(len / step);
  const pcm = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const from = Math.floor(i * step), to = Math.max(from + 1, Math.floor((i + 1) * step));
    let s = 0; for (let k = from; k < to && k < len; k++) s += mono[k];
    s /= Math.max(1, Math.min(to, len) - from);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return pcm;
}

module.exports = { encode, decode, MAX_PLAY_BYTES: 512 * 1024 };
