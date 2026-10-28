// Chat screen and call buttons for the senior page. It only shows what the server really returns (window.mayaChat, from
// chat-client.js): a message appears when /api/chat says it was sent, and any failure is shown as plain words in the thread,
// never as a made-up bubble. Mock mode shows the server's own error. It never decides anything about care, memory or the
// brain; the call view comes from window.mayaCallState (app.js).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const thread = $('thread'), busyEl = $('busy'), msgIn = $('msgIn'), sendBtn = $('sendBtn'), recBtn = $('recBtn'), recLabel = $('recLabel');
  const photoBtn = $('photoBtn'), photoIn = $('photoIn'), recBar = $('recBar'), recTime = $('recTime');
  const muteBtn = $('muteBtn'), cutBtn = $('cutBtn'), orb = $('orb'), mutedTag = $('mutedTag'), voiceRule = $('voiceRule');
  const screen = $('callScreen'), chatEl = $('chat'), preview = $('photoPreview'), previewImg = $('previewImg');
  const cs = () => window.mayaCallState;
  const MAX_RECORD_S = 120;
  const MAX_PHOTO_SIDE = 1600;
  const MAX_BOX_PX = () => Math.max(56, Math.min(150, Math.round(window.innerHeight * 0.25)));

  let working = false;     // a send is in flight
  let recording = null;    // { rec, timer, startedAt }
  let player = null;       // { audio, btn } the voice note playing now

  // ---- thread ----
  const clock = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

  function scrollDown() { thread.scrollTop = thread.scrollHeight; }
  function clearEmpty() { const e = thread.querySelector('.empty'); if (e) e.remove(); }
  function showEmpty() {
    if (thread.children.length) return;
    thread.append(el('p', 'empty', 'Say hello to Maya. You can type, record a voice note, send a photo, or call her.'));
  }

  // One voice-note bubble: tap play to hear it, tap again to pause. While a call is live, Maya's own voice notes cannot be
  // played (cs().voiceNoteReply === 'text-only'): two Mayas must never talk at once. The senior's own recording is theirs and plays.
  function voiceBubble(m) {
    const b = el('div', 'bubble voice');
    const btn = el('button', 'play'); btn.type = 'button'; btn.innerHTML = PLAY;
    btn.setAttribute('aria-label', m.role === 'maya' ? "Play Maya's voice note" : 'Play your voice note');
    const meta = el('div', 'vmeta'), bar = el('div', 'vbar'), fill = el('i'), dur = el('span', 'vdur', 'Voice note');
    bar.append(fill); meta.append(bar, dur); b.append(btn, meta);
    const audio = new Audio(m.mediaUrl);
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => { if (isFinite(audio.duration)) dur.textContent = mmss(audio.duration); });
    audio.addEventListener('timeupdate', () => { if (audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`; });
    const reset = () => { btn.innerHTML = PLAY; btn.setAttribute('aria-label', btn.getAttribute('aria-label').replace('Pause', 'Play')); fill.style.width = '0'; if (player && player.audio === audio) player = null; };
    audio.addEventListener('ended', reset);
    audio.addEventListener('error', () => { btn.disabled = true; dur.textContent = 'Could not load this voice note'; });
    btn.addEventListener('click', () => {
      if (!audio.paused) { audio.pause(); btn.innerHTML = PLAY; return; }
      if (player && player.audio !== audio) { player.audio.pause(); player.btn.innerHTML = PLAY; }
      player = { audio, btn };
      btn.innerHTML = PAUSE;
      audio.play().catch(() => { btn.innerHTML = PLAY; showNotice('The voice note could not be played on this device.'); });
    });
    btn.addEventListener('pause-all', () => { audio.pause(); btn.innerHTML = PLAY; });
    b.dataset.maya = m.role === 'maya' ? '1' : '';
    return b;
  }

  function render(m, { pending = false } = {}) {
    const row = el('div', `msg ${m.role === 'maya' ? 'maya' : 'senior'}${pending ? ' pending' : ''}`);
    row.dataset.id = m.id || '';
    row.append(el('span', 'who', m.role === 'maya' ? 'Maya' : 'You'));
    if (m.kind === 'voice') {
      row.append(voiceBubble(m));
      if (m.text) row.append(el('p', 'vtext', m.text));
    } else if (m.kind === 'image') {
      const b = el('div', 'bubble photo'), img = el('img'); img.src = m.mediaUrl; img.alt = 'The photo you sent';
      img.addEventListener('load', scrollDown);
      b.append(img); row.append(b);
      if (m.text) row.append(el('p', 'caption-line', m.text));
    } else {
      row.append(el('div', 'bubble', m.text));
    }
    if (m.voiceError) row.append(el('p', 'voice-fail', m.voiceError));
    if (!pending && m.at) row.append(el('span', 'time', clock(m.at)));
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
  const MIC_ERROR = 'Maya could not use the microphone. Please allow microphone access and try again.';
  async function startRecording() {
    if (recording || working) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { showNotice('This browser cannot record a voice note here. Try Chrome or Safari on localhost or https.'); return; }
    clearNotices();
    let rec;
    try { rec = await window.mayaChat.startRecording(); } catch { showNotice(MIC_ERROR); return; }
    const startedAt = Date.now();
    recording = { rec, startedAt, timer: setInterval(tickRecording, 250) };
    recBar.hidden = false; tickRecording(); syncControls(); scrollDown();
  }
  function tickRecording() {
    if (!recording) return;
    const s = (Date.now() - recording.startedAt) / 1000;
    recTime.textContent = `Recording ${mmss(s)}`;
    if (s >= MAX_RECORD_S) stopRecording(true);
  }
  function endRecordingUi() { clearInterval(recording.timer); recording = null; recBar.hidden = true; syncControls(); }
  async function stopRecording(send) {
    if (!recording) return;
    const { rec, startedAt } = recording;
    endRecordingUi();
    if (!send) { rec.cancel(); return; }
    if (Date.now() - startedAt < 600) { rec.cancel(); showNotice('That was very short. Tap Voice, say something, then tap Stop.'); return; }
    setBusy('Getting your voice note ready…');
    let wav;
    try { wav = await rec.stop(); } catch { setBusy(''); showNotice('Your voice note could not be read. Please try recording it again.'); return; }
    setBusy('');
    await sendWav(wav);
  }

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
  function syncControls() {
    const hasProfile = Boolean(window.mayaProfile && window.mayaProfile.id);
    const recOn = Boolean(recording);
    const prev = Boolean(picked);
    sendBtn.disabled = !hasProfile || working || recOn;
    msgIn.disabled = !hasProfile || recOn;
    photoBtn.disabled = !hasProfile || working || recOn || prev;
    recBtn.disabled = !hasProfile || (working && !recOn) || prev;
    recBtn.dataset.on = String(recOn);
    recLabel.textContent = recOn ? 'Stop' : 'Voice';
    recBtn.setAttribute('aria-label', recOn ? 'Stop and send the voice note' : 'Record a voice note');
  }
  function syncCall() {
    const c = cs();
    if (!c) return;
    const muted = c.muted;
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteBtn.title = muted ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', String(muted));
    mutedTag.hidden = !(c.live && muted);
    orb.title = c.live && c.view === 'minimized' ? 'Tap to make the call bigger' : '';
    if (c.live && c.view === 'minimized') { orb.setAttribute('role', 'button'); orb.tabIndex = 0; } else { orb.setAttribute('role', 'img'); orb.removeAttribute('tabindex'); }
    if (c.live && c.view === 'full' && recording) stopRecording(false);
    if (c.live && picked) closePreview(); // a call starting drops a photo that was waiting // the chat is hidden: a half-made voice note is dropped
    syncVoiceRule();
    lastChange = Date.now();
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

  let lastChange = 0;
  // Full screen: a tap anywhere except the orb shrinks the call to the small orb and brings the chat up. The tap that
  // started the call, and taps on the orb itself, do nothing.
  document.addEventListener('click', (e) => { // the whole page, so a click beside the column on a wide screen counts too
    const c = cs();
    if (!c || !c.live || c.view !== 'full') return;
    if (Date.now() - lastChange < 500) return;
    if (e.target.closest('#orb, #callBtn, #inbox')) return; // the orb itself, the Call button, and a ring or message card do nothing here
    c.minimize();
  });
  // Small orb: tap it to grow back to the big orb (a muted call stays muted).
  function expandFromOrb() { if (Date.now() - lastChange < 500) return; const c = cs(); // a pull that just minimized the call must not count as a tap on the small orb
    if (c && c.live && c.view === 'minimized') c.expand(); }
  orb.addEventListener('click', expandFromOrb);
  orb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandFromOrb(); } });
  muteBtn.addEventListener('click', () => { const c = cs(); if (!c || !c.live) return; if (c.muted) c.unmute(); else c.mute(); syncCall(); });
  $('expandBtn').addEventListener('click', () => { const c = cs(); if (c && c.live && c.view === 'minimized') c.expand(); });
  cutBtn.addEventListener('click', () => { if (window.mayaEndCall) window.mayaEndCall(); });

  // Words on a call (status text and captions): OFF by default, remembered per person. Aa in the call strip and in the header.
  const capKey = () => `mayaCaptions:${(window.mayaProfile && window.mayaProfile.id) || ''}`;
  const capGet = () => { try { return localStorage.getItem(capKey()) === 'on'; } catch { return false; } };
  function capApply() {
    const on = capGet();
    document.body.dataset.captions = on ? 'on' : 'off';
    for (const b of [$('capBtn'), $('capBtnTop')]) { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Hide words' : 'Show words'); b.title = on ? 'Hide words' : 'Show words'; }
  }
  function capToggle() { try { localStorage.setItem(capKey(), capGet() ? 'off' : 'on'); } catch { /* private window: it just will not be remembered */ } capApply(); }
  $('capBtn').addEventListener('click', capToggle);
  $('capBtnTop').addEventListener('click', capToggle);
  window.addEventListener('maya-profile', capApply);
  capApply();
  window.addEventListener('maya-callstate', syncCall);

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
  msgIn.addEventListener('input', autosize);
  msgIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); } });
  recBtn.addEventListener('click', () => { if (recording) stopRecording(true); else startRecording(); });
  $('recCancel').addEventListener('click', () => stopRecording(false));
  photoBtn.addEventListener('click', () => photoIn.click());
  photoIn.addEventListener('change', () => pickPhoto(photoIn.files && photoIn.files[0]));
  $('previewSend').addEventListener('click', sendPicked);
  $('previewCancel').addEventListener('click', closePreview);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picked) closePreview(); });

  // Maya's own unprompted line (the family has seen the worry): it joins the thread as her message.
  window.addEventListener('maya-chat-message', (e) => { if (e.detail) append(e.detail); });
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
