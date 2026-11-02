// Chat screen and call buttons for the senior page. It only shows what the server really returns (window.mayaChat, from
// chat-client.js): a message appears when /api/chat says it was sent, and any failure is shown as plain words in the thread,
// never as a made-up bubble. Mock mode shows the server's own error. It never decides anything about care, memory or the
// brain; the call view comes from window.mayaCallState (app.js).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const thread = $('thread'), busyEl = $('busy'), msgIn = $('msgIn'), mainBtn = $('mainBtn'), attachBtn = $('attachBtn');
  const photoIn = $('photoIn'), camIn = $('camIn'), pdfIn = $('pdfIn'), recBar = $('recBar'), recTime = $('recTime'), recWave = $('recWave'), writeRow = $('writeRow');
  const muteBtn = $('muteBtn'), cutBtn = $('cutBtn'), speakerBtn = $('speakerBtn'), mutedTag = $('mutedTag'), voiceRule = $('voiceRule');
  const chatEl = $('pageChat'), preview = $('photoPreview'), previewImg = $('previewImg'), sheet = $('attachSheet');
  const cs = () => window.mayaCallState;
  const MAX_RECORD_S = 120;
  const MAX_PHOTO_SIDE = 1600;
  const MAX_BOX_PX = () => Math.max(56, Math.min(150, Math.round(window.innerHeight * 0.25)));
  const MAX_PDF_BYTES = 8 * 1024 * 1024;   // the server's own limit

  let working = false;     // a send is in flight
  let recording = null;    // { rec, timer, startedAt }
  let player = null;       // { audio, btn } the voice note playing now

  // ---- thread ----
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

  function scrollDown() { thread.scrollTop = thread.scrollHeight; }
  function clearEmpty() { const e = thread.querySelector('.empty'); if (e) e.remove(); }
  function showEmpty() {
    if (thread.children.length) return;
    thread.append(el('p', 'empty', 'Say hello to Maya. You can type, record a voice note, or call her.'));
  }

  // One voice-note bubble, like the phone app's: a round play button, a waveform you can touch to move along the sound, and how long it is. Tap play to hear it,
  // tap again to pause. While a call is live, Maya's own voice notes cannot be played (cs().voiceNoteReply === 'text-only'): two Mayas must never talk at once.
  // The senior's own recording is theirs and plays. The bar heights are a fixed pattern for each note (not the real sound).
  const BARS = 34;
  const seeded = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; }; };
  function voiceBubble(m) {
    const b = el('div', 'voice-row');
    const btn = el('button', 'play'); btn.type = 'button'; btn.innerHTML = PLAY;
    btn.setAttribute('aria-label', m.role === 'maya' ? "Play Maya's voice note" : 'Play your voice note');
    const wave = el('div', 'wave'), dur = el('span', 'vdur', ''), rnd = seeded(m.mediaUrl || m.id || 'note'), bars = [];
    wave.setAttribute('role', 'slider'); wave.setAttribute('aria-label', 'Voice note position'); wave.tabIndex = 0;
    for (let i = 0; i < BARS; i++) {
      const env = 0.35 + 0.65 * Math.sin(Math.PI * (i + 0.5) / BARS), h = Math.max(0.12, (0.18 + 0.72 * rnd()) * env);
      const bar = el('i'); bar.style.height = `${Math.round(h * 100)}%`; bars.push(bar); wave.append(bar);
    }
    b.append(btn, wave, dur);
    const audio = new Audio(m.mediaUrl);
    audio.preload = 'metadata';
    const paint = () => { const p = audio.duration ? audio.currentTime / audio.duration : 0; bars.forEach((x, i) => x.classList.toggle('heard', (i + 0.5) / BARS <= p && (p > 0))); wave.setAttribute('aria-valuenow', String(Math.round(p * 100))); };
    const shown = () => { dur.textContent = isFinite(audio.duration) ? mmss(!audio.paused || audio.currentTime > 0 ? audio.currentTime : audio.duration) : ''; };
    audio.addEventListener('loadedmetadata', shown);
    audio.addEventListener('timeupdate', () => { paint(); shown(); });
    const reset = () => { btn.innerHTML = PLAY; btn.setAttribute('aria-label', btn.getAttribute('aria-label').replace('Pause', 'Play')); audio.currentTime = 0; paint(); shown(); if (player && player.audio === audio) player = null; };
    audio.addEventListener('ended', reset);
    audio.addEventListener('error', () => { btn.disabled = true; dur.textContent = 'Could not load this voice note'; });
    btn.addEventListener('click', () => {
      if (!audio.paused) { audio.pause(); btn.innerHTML = PLAY; return; }
      if (player && player.audio !== audio) { player.audio.pause(); player.btn.innerHTML = PLAY; }
      player = { audio, btn };
      btn.innerHTML = PAUSE;
      audio.play().catch(() => { btn.innerHTML = PLAY; showNotice('The voice note could not be played on this device.'); });
    });
    const seek = (clientX) => { const r = wave.getBoundingClientRect(); if (audio.duration && r.width) { audio.currentTime = audio.duration * Math.min(1, Math.max(0, (clientX - r.left) / r.width)); paint(); shown(); } };
    wave.addEventListener('click', (e) => seek(e.clientX));
    wave.addEventListener('keydown', (e) => { if (!audio.duration) return; if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5); else return; e.preventDefault(); paint(); shown(); });
    btn.addEventListener('pause-all', () => { audio.pause(); btn.innerHTML = PLAY; });
    // Maya's voice note arrived while the page is open (a voice reminder): it starts by itself if the browser allows sound here (the person has used this page), and says nothing if it does not; the play button is always there.
    btn.addEventListener('auto-play', () => {
      if (!audio.paused) return;
      if (player && player.audio !== audio) { player.audio.pause(); player.btn.innerHTML = PLAY; }
      player = { audio, btn }; btn.innerHTML = PAUSE;
      audio.play().catch(() => { btn.innerHTML = PLAY; });
    });
    b.dataset.maya = m.role === 'maya' ? '1' : '';
    return b;
  }

  // Where an answer came from: a small eye button under the message; tap to open or close the sources (site, title, excerpt). Never part of the message text.
  function sourceBox(sources) {
    const wrap = el('div', 'sources'), btn = el('button', 'eye', '\u{1F441}'), list = el('div', 'source-list');
    btn.type = 'button'; btn.setAttribute('aria-label', 'Show where this came from'); btn.setAttribute('aria-expanded', 'false'); list.hidden = true;
    for (const x of sources) {
      const item = el('div', 'source');
      item.append(el('strong', '', x.site), el('span', 'source-title', x.title), el('span', 'source-excerpt', x.excerpt));
      list.append(item);
    }
    btn.addEventListener('click', () => { list.hidden = !list.hidden; btn.setAttribute('aria-expanded', String(!list.hidden)); btn.setAttribute('aria-label', list.hidden ? 'Show where this came from' : 'Hide where this came from'); scrollDown(); });
    wrap.append(btn, list);
    return wrap;
  }

  const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm-1 7V3.500L18.500 9H13Z"/></svg>';
  function render(m, { pending = false } = {}) {
    const row = el('div', `msg ${m.role === 'maya' ? 'maya' : 'senior'}${pending ? ' pending' : ''}`);
    row.dataset.id = m.id || '';
    const b = el('div', m.kind === 'voice' ? 'bubble voice' : 'bubble');
    if (m.kind === 'file') {
      // a document the person sent: the name, with its icon
      const f = el('div', 'file-row'), ic = el('span', 'file-ico'); ic.innerHTML = FILE_ICON; f.append(ic, el('span', 'file-name', m.text)); b.append(f);
    } else if (m.text) b.append(el('p', 'btext', m.text));
    if (m.kind === 'voice') {
      if (m.mediaUrl) b.append(voiceBubble(m));
      else { const p = el('div', 'voice-row idle'); p.append(el('span', 'play ghost'), el('span', 'vdur', pending ? 'Sending' : 'Voice note')); b.append(p); }
    } else if (m.kind === 'image') {
      const img = el('img', 'photo'); img.src = m.mediaUrl; img.alt = 'The photo you sent';
      img.addEventListener('load', scrollDown);
      b.append(img);
    }
    if (m.reminder && m.reminder.notifId) {   // a reminder in the chat: one button, Got it; once pressed (here, or on another page of theirs) it is a ticked "Marked as seen"
      row.dataset.reminder = String(m.reminder.notifId); row.classList.add('reminder-msg');
      const foot = el('div', 'rem-foot'); foot.dataset.foot = '1';
      if (m.reminder.seen) { foot.classList.add('is-done'); foot.append(el('span', 'rem-done', '\u2713 Marked as seen')); }
      else { const g = el('button', 'rem-got', 'Got it'); g.type = 'button'; g.addEventListener('click', () => { g.disabled = true; markReminderDone(row); window.dispatchEvent(new CustomEvent('maya-reminder-got', { detail: { notifId: m.reminder.notifId } })); }); foot.append(g); }
      b.append(foot);
    }
    row.append(b);
    if (m.voiceError) row.append(el('p', 'voice-fail', m.voiceError));
    if (Array.isArray(m.sources) && m.sources.length) row.append(sourceBox(m.sources));
    syncVoiceRule();
    return row;
  }
  function append(m, opts) { clearEmpty(); const r = render(m, opts); thread.append(r); syncVoiceRule(); scrollDown(); return r; }

  function showNotice(text) {
    clearNotices();
    clearEmpty();
    const n = el('p', 'notice', text); n.setAttribute('role', 'alert');
    thread.append(n); scrollDown();
  }
  function clearNotices() { thread.querySelectorAll('.notice').forEach((n) => n.remove()); }

  function setBusy(text) { busyEl.hidden = !text; busyEl.textContent = text || ''; working = Boolean(text); syncControls(); }

  function stopAllAudio() {
    if (player) { player.audio.pause(); player.btn.innerHTML = PLAY; player = null; }
  }

  let loadToken = 0;
  async function loadThread() {
    const mine = ++loadToken;
    thread.replaceChildren();
    clearNotices();
    if (!window.mayaProfile || !window.mayaProfile.id) return;
    try {
      const r = await window.mayaChat.thread();
      if (mine !== loadToken) return; // a newer load (another person picked) is in charge
      for (const m of r.messages) append(m);
      showEmpty();
    } catch (e) { if (mine === loadToken) showNotice(e.message); } // mock mode: the server's own words
  }

  // ---- sending ----
  // Each send waits for the server. The person's text bubble shows at once, dimmed, marked as not yet sent; voice notes and
  // photos only appear once the server has accepted them. Nothing is ever added that the server did not return.
  async function sendText() {
    const text = msgIn.value.trim();
    if (!text || working) return;
    clearNotices();
    const pending = append({ role: 'senior', kind: 'text', text }, { pending: true });
    msgIn.value = ''; autosize();
    setBusy('Maya is writing…');
    try {
      const r = await window.mayaChat.sendText(text);
      pending.remove();
      for (const m of r.messages) append(m);
    } catch (e) {
      pending.remove(); msgIn.value = text; autosize();
      showNotice(e.message);
    } finally { setBusy(''); }
  }

  async function sendWav(wav) {
    clearNotices();
    setBusy('Maya is listening to your voice note…');
    try {
      const r = await window.mayaChat.sendVoiceNote(wav);
      for (const m of r.messages) append(m);
    } catch (e) { showNotice(e.message); } finally { setBusy(''); }
  }

  // Photo: picking one only opens a large preview. Send tap uploads it, Cancel throws it away and nothing is sent. A file the
  // browser cannot decode (not a photo, or a format it cannot read) gets the same plain words as the server's answer.
  const NOT_A_PHOTO = 'That file is not a photo Maya can read. Please pick a photo (JPEG, PNG, GIF or WebP).';
  let picked = null; // { file, url }
  function closePreview() {
    if (picked) { URL.revokeObjectURL(picked.url); picked = null; }
    previewImg.removeAttribute('src');
    preview.hidden = true; chatEl.dataset.preview = 'false';
    photoIn.value = '';
    syncControls();
  }
  async function pickPhoto(file) {
    if (!file) return;
    clearNotices();
    const url = URL.createObjectURL(file);
    try {
      const probe = new Image();
      probe.src = url;
      await probe.decode();                       // throws for anything the browser cannot read as an image
      if (!probe.naturalWidth) throw new Error('empty');
    } catch { URL.revokeObjectURL(url); photoIn.value = ''; showNotice(NOT_A_PHOTO); return; }
    picked = { file, url };
    previewImg.src = url;
    preview.hidden = false; chatEl.dataset.preview = 'true';
    syncControls();
    $('previewSend').focus({ preventScroll: true });
  }
  async function sendPicked() {
    if (!picked || working) return;
    const { file } = picked;
    closePreview();
    setBusy('Maya is looking at your photo…');
    try {
      const r = await window.mayaChat.sendImage(await shrink(file), '');
      for (const m of r.messages) append(m);
    } catch (e) { showNotice(e.message); } finally { setBusy(''); }
  }

  // Phone photos are large; the server accepts up to 8 MB. Shrinking keeps it quick. If the browser cannot decode the file,
  // the original is sent unchanged and the server says if it cannot use it.
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 4 * 1024 * 1024 && file.type === 'image/jpeg') return file;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      return blob || file;
    } catch { return file; }
  }

  // ---- recording ----
  // Tap the blue microphone once to start; the box becomes a blue bar (a bin, a picture button, the live waveform, the time, a white arrow). Tap the white arrow to send.
  const MIC_ERROR = 'Maya could not use the microphone. Please allow microphone access and try again.';
  const levels = [];
  async function startRecording() {
    if (recording || working) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { showNotice('This browser cannot record a voice note here. Try Chrome or Safari on localhost or https.'); return; }
    clearNotices();
    let rec;
    try { rec = await window.mayaChat.startRecording(); } catch { showNotice(MIC_ERROR); return; }
    const startedAt = Date.now();
    levels.length = 0;
    recording = { rec, startedAt, timer: setInterval(tickRecording, 90) };
    recBar.hidden = false; writeRow.hidden = true; tickRecording(); syncControls(); scrollDown();
  }
  function drawWave() {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = recWave.clientWidth, h = recWave.clientHeight;
    if (!w || !h) return;
    if (recWave.width !== Math.round(w * dpr)) { recWave.width = Math.round(w * dpr); recWave.height = Math.round(h * dpr); }
    const g = recWave.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const bw = 3, gap = 3, n = Math.floor(w / (bw + gap)), mid = h / 2;
    g.lineWidth = bw; g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const k = levels.length - n + i, has = k >= 0 && k < levels.length, bh = 4 + (has ? levels[k] : 0) * (h - 4), x = i * (bw + gap) + bw / 2;   // the newest sound is at the right edge
      g.strokeStyle = `rgba(255,255,255,${has ? 0.95 : 0.35})`; g.beginPath(); g.moveTo(x, mid - bh / 2); g.lineTo(x, mid + bh / 2); g.stroke();
    }
  }
  function tickRecording() {
    if (!recording) return;
    const s = (Date.now() - recording.startedAt) / 1000;
    levels.push(recording.rec.level ? recording.rec.level() : 0); if (levels.length > 200) levels.shift();
    recTime.textContent = mmss(s); drawWave();
    if (s >= MAX_RECORD_S) stopRecording(true);
  }
  function endRecordingUi() { clearInterval(recording.timer); recording = null; recBar.hidden = true; writeRow.hidden = false; syncControls(); }
  async function stopRecording(send) {
    if (!recording) return;
    const { rec, startedAt } = recording;
    endRecordingUi();
    if (!send) { rec.cancel(); return; }
    if (Date.now() - startedAt < 600) { rec.cancel(); showNotice('That was very short. Tap the microphone, say something, then tap the white arrow.'); return; }
    setBusy('Getting your voice note ready…');
    let wav;
    try { wav = await rec.stop(); } catch { setBusy(''); showNotice('Your voice note could not be read. Please try recording it again.'); return; }
    setBusy('');
    await sendWav(wav);
  }

  // ---- a PDF (a letter, a bill, a message): its words are read on the server, checked for a scam, and answered in simple words ----
  async function sendPdf(file) {
    if (!file) return;
    clearNotices();
    if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name || '')) { showNotice('That file is not a PDF. Please pick a PDF, or send a photo of the page.'); return; }
    if (file.size > MAX_PDF_BYTES) { showNotice('That PDF is too big for Maya (8 MB at most). Please send a photo of the page instead.'); return; }
    const pending = append({ role: 'senior', kind: 'file', text: file.name || 'Document.pdf' }, { pending: true });
    setBusy('Maya is reading your document…');
    try {
      const r = await window.mayaChat.sendPdf(file);
      pending.remove();
      for (const m of r.messages) append(m);
    } catch (e) { pending.remove(); showNotice(e.message); } finally { setBusy(''); pdfIn.value = ''; }
  }

  // ---- the sheet behind the paperclip ----
  function openSheet() { if (attachBtn.disabled) return; sheet.hidden = false; $('aImage').focus({ preventScroll: true }); }
  function closeSheet() { sheet.hidden = true; }

  // ---- controls ----
  function autosize() { msgIn.style.height = 'auto'; msgIn.style.height = `${Math.min(msgIn.scrollHeight, MAX_BOX_PX())}px`; }
  function syncVoiceRule() {
    const live = Boolean(cs() && cs().live);
    voiceRule.hidden = !live;
    // No voice note plays during a call (two voices must never overlap); after it ends the play buttons come back, and a note
    // only ever plays when the person taps it (nothing here calls play() on its own).
    thread.querySelectorAll('.bubble.voice .play').forEach((b) => { b.disabled = live; b.title = live ? 'Voice notes can be played after the call.' : ''; });
    if (live) stopAllAudio();
  }
  function syncMain() {
    const hasText = msgIn.value.trim().length > 0;
    mainBtn.dataset.mode = hasText ? 'send' : 'mic';
    mainBtn.setAttribute('aria-label', hasText ? 'Send' : 'Record a voice note');
  }
  function syncControls() {
    const hasProfile = Boolean(window.mayaProfile && window.mayaProfile.id);
    const recOn = Boolean(recording);
    const prev = Boolean(picked);
    mainBtn.disabled = !hasProfile || working || prev;
    msgIn.disabled = !hasProfile || recOn;
    attachBtn.disabled = !hasProfile || working || recOn || prev;
    $('recGallery').disabled = !hasProfile || working || prev;
    syncMain();
  }
  function syncCall() {
    const c = cs();
    if (!c) return;
    const muted = c.muted;
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.classList.toggle('on', muted);
    $('muteLabel').textContent = muted ? 'Unmute' : 'Mute';
    mutedTag.hidden = !(c.live && muted);
    if (c.live && c.view === 'full' && recording) stopRecording(false);   // the chat is out of sight: a half-made voice note is dropped
    if (c.live && c.view === 'full' && picked) closePreview();           // a call starting drops a photo that was waiting
    if (c.live && c.view === 'full') closeSheet();
    syncVoiceRule();
    restoreScroll();
  }

  // Scroll position is kept across minimize / expand / mute / end. Hiding the chat (display: none) throws its scroll position
  // away, so the thread's position (or "stuck to the newest message") is remembered while it is visible and put back once it is
  // shown again; the page itself is never scrolled.
  const mem = { top: 0, stick: true, page: 0 };
  thread.addEventListener('scroll', () => {
    if (!thread.clientHeight) return;   // hidden: its scroll is not real
    mem.top = thread.scrollTop;
    mem.stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 4;
  }, { passive: true });
  window.addEventListener('scroll', () => { mem.page = window.scrollY; }, { passive: true });
  function restoreScroll() {
    const put = () => {
      if (thread.clientHeight) thread.scrollTop = mem.stick ? thread.scrollHeight : mem.top;
      if (window.scrollY !== mem.page) window.scrollTo(0, mem.page);
    };
    put(); requestAnimationFrame(put);
  }

  // Call page buttons. Mute keeps its state; Speaker is on by default (a browser cannot pick the earpiece, so off is a quieter voice); End call ends it.
  muteBtn.addEventListener('click', () => { const c = cs(); if (!c || !c.live) return; if (c.muted) c.unmute(); else c.mute(); syncCall(); });
  cutBtn.addEventListener('click', () => { if (window.mayaEndCall) window.mayaEndCall(); });
  speakerBtn.addEventListener('click', () => {
    const on = !(speakerBtn.getAttribute('aria-pressed') === 'true');
    if (window.mayaSpeaker) window.mayaSpeaker(on);
    speakerBtn.setAttribute('aria-pressed', String(on)); speakerBtn.classList.toggle('on', on);
  });
  window.addEventListener('maya-callstate', syncCall);
  window.addEventListener('maya-page', () => { restoreScroll(); scrollDown(); });

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
  msgIn.addEventListener('input', () => { autosize(); syncMain(); });
  msgIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); } });
  // One blue button: an arrow once there is something to write, otherwise the microphone (tap to record, tap the white arrow to send).
  mainBtn.addEventListener('click', () => { if (msgIn.value.trim()) sendText(); else startRecording(); });
  $('recCancel').addEventListener('click', () => stopRecording(false));
  $('recSend').addEventListener('click', () => stopRecording(true));
  $('recGallery').addEventListener('click', () => photoIn.click());
  attachBtn.addEventListener('click', openSheet);
  $('aCancel').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  $('aImage').addEventListener('click', () => { closeSheet(); photoIn.click(); });
  $('aPdf').addEventListener('click', () => { closeSheet(); pdfIn.click(); });
  $('aCamera').addEventListener('click', () => { closeSheet(); camIn.click(); });
  photoIn.addEventListener('change', () => pickPhoto(photoIn.files && photoIn.files[0]));
  camIn.addEventListener('change', () => { const f = camIn.files && camIn.files[0]; camIn.value = ''; pickPhoto(f); });
  pdfIn.addEventListener('change', () => sendPdf(pdfIn.files && pdfIn.files[0]));
  $('previewSend').addEventListener('click', sendPicked);
  $('previewCancel').addEventListener('click', closePreview);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!sheet.hidden) closeSheet(); else if (picked) closePreview(); } });

  // Maya's own unprompted line (the family has seen the worry): it joins the thread as her message.
  // ---- reminders in the chat. The server put the reminder in the thread (with reminder: { notifId, seen }); this page shows it with its Got it. A pop-up elsewhere, or Got it on another page of theirs, comes back here.
  const remRow = (nid) => thread.querySelector(`[data-reminder="${String(nid).replace(/[^\w-]/g, '')}"]`);
  function markReminderDone(row) {
    if (!row) return; const foot = row.querySelector('[data-foot]'); if (!foot || foot.classList.contains('is-done')) return;
    foot.classList.add('is-done'); foot.replaceChildren(el('span', 'rem-done', '\u2713 Marked as seen'));
  }
  window.addEventListener('maya-reminder', (e) => {   // a new reminder reached this page: it appears in the chat, once
    const m = e.detail && e.detail.message; if (!m || !m.reminder) return;
    if (remRow(m.reminder.notifId) || (m.id && thread.querySelector(`[data-id="${m.id}"]`))) return;
    append(m);
  });
  window.addEventListener('maya-reminder-done', (e) => markReminderDone(remRow(e.detail && e.detail.notifId)));   // Got it on another page: this one shows it done too
  window.addEventListener('maya-show-reminder', (e) => {   // Got it on a pop-up (or its notification): the chat comes to that same message
    const d = e.detail || {}; const row = remRow(d.id); if (!row) return;
    if (d.done) markReminderDone(row);
    row.classList.add('reminder-shown'); if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
  });
  window.addEventListener('maya-chat-message', (e) => {
    const m = e.detail; if (!m) return;
    const row = append(m);
    if (m.kind === 'voice' && m.role === 'maya' && m.mediaUrl && !m.spoken && !(window.mayaInCall && window.mayaInCall()) && navigator.userActivation && navigator.userActivation.hasBeenActive) {
      const b = row && row.querySelector('.play'); if (b) b.dispatchEvent(new CustomEvent('auto-play'));
    }
  });
  window.addEventListener('maya-profile', () => { if (recording) stopRecording(false); if (picked) closePreview(); stopAllAudio(); loadThread(); syncControls(); });

  // The visible height follows the keyboard where the browser reports it, so the text box stays above the keyboard.
  if (window.visualViewport) {
    const fit = () => { document.documentElement.style.setProperty('--app-h', `${window.visualViewport.height}px`); if (window.visualViewport.height < window.innerHeight - 80) window.scrollTo(0, 0); scrollDown(); };
    window.visualViewport.addEventListener('resize', fit);
    fit();
  }

  syncControls();
  syncCall();
  if (window.mayaProfile && window.mayaProfile.id) loadThread();
})();
