// Chat client logic (no screens): talks to /api/chat/<profile id>/... (chat.js on the server). Not loaded by any page yet;
// the chat screens will use window.mayaChat. Voice notes are recorded, decoded and written as a 24 kHz mono 16-bit WAV
// here, because Meta's file Transcribe takes WAV only (docs: dev.meta.ai/docs/api-reference/voice/transcribe).
// Each call returns { messages: [yourBubble, mayaBubble] }; a bubble is { id, role: 'senior'|'maya', kind: 'text'|'voice'|'image',
// text, mediaUrl?, voiceError? }. While a call is live (mayaCallState.live) the server answers a voice note with text only.
const MayaWav = {
  RATE: 24000,
  // Float32 mono at any rate -> Float32 at 24 kHz (box filter, the same idea as the server's call resampler).
  resample(f32, fromRate) {
    if (fromRate === this.RATE) return f32;
    const ratio = fromRate / this.RATE;
    const out = new Float32Array(Math.floor(f32.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const a = i * ratio, b = a + ratio;
      let sum = 0;
      for (let k = Math.floor(a); k < Math.min(Math.ceil(b), f32.length); k++) sum += f32[k] * (Math.min(k + 1, b) - Math.max(k, a));
      out[i] = sum / ratio;
    }
    return out;
  },
  encode(f32) {
    const data = new DataView(new ArrayBuffer(44 + f32.length * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) data.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); data.setUint32(4, 36 + f32.length * 2, true); str(8, 'WAVEfmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, this.RATE, true); data.setUint32(28, this.RATE * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
    str(36, 'data'); data.setUint32(40, f32.length * 2, true);
    for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); data.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); }
    return new Uint8Array(data.buffer);
  },
};

if (typeof module !== 'undefined') module.exports = { MayaWav };

(() => {
  'use strict';
  if (typeof window === 'undefined') return;
  const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = () => `/api/chat/${window.mayaProfile && window.mayaProfile.id}`;

  async function call(path, init) {
    if (!window.mayaProfile || !window.mayaProfile.id) throw new Error('Please pick who is talking first.');
    const res = await fetch(`${base()}${path}${path.includes('?') ? '&' : '?'}tz=${encodeURIComponent(tz())}`, init);
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  // Records from the microphone until stop() is called; stop() resolves to the WAV bytes. Uses its own stream, so it never
  // touches a live call's microphone.
  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start();
    const done = new Promise((resolve) => { rec.onstop = resolve; });
    return {
      async stop() {
        if (rec.state !== 'inactive') rec.stop();
        await done;
        stream.getTracks().forEach((t) => t.stop());
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        try {
          const audio = await ctx.decodeAudioData(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer());
          return MayaWav.encode(MayaWav.resample(audio.getChannelData(0), audio.sampleRate));
        } finally { ctx.close().catch(() => {}); }
      },
      cancel() { try { rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ } stream.getTracks().forEach((t) => t.stop()); },
    };
  }

  window.mayaChat = {
    thread: () => call(''),
    sendText: (text) => call('/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }),
    sendVoiceNote: (wavBytes) => call('/voicenote', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavBytes }),
    sendImage: (file, caption = '') => call(`/image?caption=${encodeURIComponent(caption)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }),
    startRecording,
    // The senior page's live stream carries Maya's own messages (the family-Seen line) as 'chat' events.
    onMayaMessage(es, fn) { es.addEventListener('chat', (e) => { try { fn(JSON.parse(e.data).message); } catch { /* ignore */ } }); },
  };
})();
