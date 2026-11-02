// Senior side of Feature 3: while this page is open for a picked person, Maya can ring them (call-back or
// reminder) and the family can leave a message. In-app only: nothing here can ring a closed app or a locked phone.
// Server-sent events carry 'incoming' (Accept / Decline), 'incomingEnd' and 'notice'; every card has a button, and a
// press is reported so the family sees Seen, not just Sent. Real taps / keys (not the call buttons) count as
// "the person is around" for Maya's care checks and are not sent while a call is live.
(() => {
  'use strict';
  const inbox = document.getElementById('inbox');
  let es = null;
  let pid = null;
  const cards = new Map(); // key -> element

  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), keepalive: true }).catch(() => {});

  // ---- Sound. ONE shared AudioContext, created on the person's first real interaction (browsers refuse sound before
  // that) and kept alive. Incoming CALLS use a repeating phone ring; family messages keep a soft chime, so ring = Maya
  // calling, chime = a message. If sound is blocked, the card still shows, the ring starts on the next interaction, and
  // nothing claims it sounded (ring.blocked shows a tap hint on the card).
  let actx = null;
  const ring = { key: null, timer: null, nodes: new Set(), sounding: false, blocked: false };
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (actx.state === 'suspended') actx.resume().then(() => { if (ring.key && !ring.sounding) startLoop(); }).catch(() => {});
    return actx;
  }
  const running = () => Boolean(actx && actx.state === 'running');

  // Classic two-tone phone ring (440 + 480 Hz): two short bursts (about 1.8 s), then 3 s of quiet, repeated.
  // Clearly audible across a room (0.2 per tone, 30 ms attack so it is firm but not a jolt); no audio file.
  const RING_PEAK = 0.2, BURST_S = 0.8, CYCLE_MS = 4800;
  function burst(t0) {
    for (const f of [440, 480]) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(RING_PEAK, t0 + 0.03);
      g.gain.setValueAtTime(RING_PEAK, t0 + BURST_S - 0.05);
      g.gain.linearRampToValueAtTime(0.0001, t0 + BURST_S);
      o.start(t0); o.stop(t0 + BURST_S + 0.05);
      const n = { o, g };
      ring.nodes.add(n);
      o.onended = () => ring.nodes.delete(n);
    }
  }
  function cycle() {
    if (!ring.key) return;
    if (window.mayaInCall && window.mayaInCall()) { stopRing(); return; } // never ring over a live call
    const t = actx.currentTime + 0.02;
    burst(t); burst(t + 1.0);
    ring.timer = setTimeout(cycle, CYCLE_MS);
  }
  function startLoop() {
    if (!ring.key || ring.sounding) return;
    if (!running()) { ring.blocked = true; hint(); return; } // blocked: wait for the next interaction
    ring.blocked = false; ring.sounding = true; hint();
    cycle();
  }
  function startRing(key) {
    if (ring.key === key) return;
    stopRing();
    ring.key = key;
    startLoop();
  }
  function stopRing() {
    clearTimeout(ring.timer); ring.timer = null;
    for (const n of ring.nodes) { try { n.g.gain.cancelScheduledValues(0); n.g.gain.setValueAtTime(0.0001, 0); n.o.stop(); } catch { /* already stopped */ } }
    ring.nodes.clear();
    ring.key = null; ring.sounding = false; ring.blocked = false;
  }
  function hint() {
    const el = ring.key && cards.get(ring.key);
    if (!el) return;
    let h = el.querySelector('.inbox-hint');
    if (ring.blocked && !h) { h = document.createElement('small'); h.className = 'inbox-hint'; h.textContent = "Tap anywhere to hear Maya's ring."; el.insertBefore(h, el.querySelector('.inbox-row')); }
    else if (!ring.blocked && h) h.remove();
  }
  // Soft two-note chime for messages only; silent (card only) if the browser has not allowed sound yet.
  function chime() {
    if (!running()) { audio(); return; }
    [523.25, 659.25].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + i * 0.28;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.start(t); o.stop(t + 1);
    });
  }
  // The first real interaction creates / resumes the shared context (and starts a ring that was waiting).
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click']) window.addEventListener(ev, () => { audio(); if (ring.key && !ring.sounding) startLoop(); }, { passive: true });
  window.mayaInbox = { ring: () => ({ key: ring.key, sounding: ring.sounding, blocked: ring.blocked }) };

  // ---- A reminder or a message: a card with a bell and two buttons, a gentle chime, and (when this page is hidden or in the background) a browser notification, if the person has allowed them.
  // The browser asks for that permission only when the person presses Allow, never by itself; refused or unsupported, the card says so plainly and everything else still works.
  const away = () => Boolean(document.hidden) || (typeof document.hasFocus === 'function' && !document.hasFocus());
  const answered = new Set();   // notice ids this page has already answered (or heard were seen elsewhere): a replay of one never raises the card again
  const osNotes = new Map();   // card key -> the browser notification, closed when the card is
  let titleFlash = null, baseTitle = document.title;
  function osNotify(key, title, body) {
    if (!('Notification' in window) || window.Notification.permission !== 'granted' || !away()) return;
    try {
      const n = new window.Notification(title, { body, tag: key, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); const nid = String(key).replace(/^n/, ''); if (/^n/.test(key)) emit('maya-show-reminder', { id: nid }); };
      osNotes.set(key, n);
    } catch { /* a browser that refuses to build one: the card is still there */ }
  }
  function flashTitle(on, text) {
    clearTimeout(titleFlash); titleFlash = null;
    if (!on) { document.title = baseTitle; return; }
    let x = false; document.title = text;
    const step = () => { x = !x; document.title = x ? baseTitle : text; titleFlash = setTimeout(step, 1200); };
    titleFlash = setTimeout(step, 1200);
  }
  if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (!document.hidden && !cards.size) flashTitle(false); });
  window.addEventListener('focus', () => { if (!cards.size) flashTitle(false); });
  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.500 2.500 0 0 0 2.450-2h-4.900A2.500 2.500 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.500-6.850V3.500a1.500 1.500 0 0 0-3 0v.650A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';
  const noteLabel = (d) => (d.kind === 'reminder' ? (d.by === 'senior' ? 'Your reminder' : 'Reminder from your family') : d.kind === 'welfare' ? 'Check-in from your family' : 'Message from your family');
  function permissionLine() {
    if (!('Notification' in window)) return null;
    const p = document.createElement('div'); p.className = 'notice-perm';
    if (window.Notification.permission === 'default') {
      const t = document.createElement('small'); t.textContent = 'Allow notifications so Maya can tell you even when this page is hidden.';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'notice-allow'; b.textContent = 'Allow';
      b.addEventListener('click', () => { try { window.Notification.requestPermission().then((r) => { p.textContent = r === 'granted' ? 'Notifications are on.' : 'Notifications stay off. Maya can still tell you while this page is open.'; }); } catch { p.remove(); } });
      p.append(t, b);
    } else if (window.Notification.permission === 'denied') {
      const t = document.createElement('small'); t.textContent = 'Notifications are off for this page, so Maya can only tell you while it is open. You can turn them on in the browser settings for this site.'; p.append(t);
    } else return null;
    return p;
  }
  // A short confirmation after a card button: a small line at the bottom of the page for a moment. Not part of the card list.
  function done(text) {
    if (!text || !document.body || typeof document.body.append !== 'function') return;
    const t = document.createElement('div'); t.className = 'inbox-done'; t.setAttribute('role', 'status'); t.textContent = text;
    document.body.append(t); setTimeout(() => { if (t.parentNode) t.remove(); }, 2200);
  }
  function noticeCard(key, label, text, buttons) {
    drop(key);
    const el = document.createElement('div');
    el.className = 'inbox-card notice'; el.setAttribute('role', 'alert'); el.setAttribute('aria-label', label);
    const top = document.createElement('div'); top.className = 'notice-top';
    const ico = document.createElement('span'); ico.className = 'notice-ico'; ico.innerHTML = BELL;
    const lab = document.createElement('small'); lab.className = 'notice-label'; lab.textContent = label;
    top.append(ico, lab);
    const p = document.createElement('p'); p.className = 'notice-text'; p.textContent = text;
    el.append(top, p);
    const perm = permissionLine(); if (perm) el.append(perm);
    const row = document.createElement('div'); row.className = 'inbox-row';
    for (const b of buttons) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = b.label; btn.className = `inbox-btn ${b.cls || ''}`.trim();
      btn.addEventListener('click', () => { if (el.parentNode) el.remove(); drop(key); done(b.done); b.run(); });   // gone at once (the element itself, not only the map), with a short "done" line so the click is seen to work
      row.append(btn);
    }
    el.append(row); inbox.append(el); cards.set(key, el);
    const first = buttons.findIndex((b) => b.cls === 'primary'); const btns = row.children;
    (btns[first >= 0 ? first : 0]).focus({ preventScroll: true });
    chime();   // one gentle chime (silent, card only, until the browser has allowed sound); never a loop
    osNotify(key, label, text); if (away()) flashTitle(true, `● ${label}`);
  }

  const ringing = (on) => { if (document.body) document.body.dataset.ringing = String(on); };   // the page behind the card hides while a ring is on screen
  // Why Maya is calling, from the KIND of call only (never any private words).
  const WHY = {
    welfare: 'A welfare check: she would like to hear how you are.',
    reminder: 'A reminder from your family.',
    callback: 'A quick check-in: she is calling you back.',
  };
  const whyOf = (kind) => WHY[kind] || 'A check-in: she would like to hear how you are.';

  // head: set for a ring. "Maya is calling" is then large at the top of a whole page, with one line under it for why (text), and Decline (left) and Accept (right) below.
  function card(key, text, buttons, cls, head) {
    drop(key);
    const el = document.createElement('div');
    el.className = `inbox-card ${cls || ''}`;
    el.setAttribute('role', 'alert');
    if (head) { const h = document.createElement('h2'); h.className = 'inbox-head'; h.textContent = head; el.append(h); }
    const p = document.createElement('p');
    p.textContent = text;
    const row = document.createElement('div');
    row.className = 'inbox-row';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = b.label; btn.className = b.cls || 'inbox-btn';
      btn.addEventListener('click', () => { drop(key); b.run(); });
      row.append(btn);
    }
    el.append(p, row);
    inbox.append(el);
    cards.set(key, el);
    el.querySelector('button').focus({ preventScroll: true });
    if (cls === 'incoming') ringing(true);
  }
  function drop(key) {
    const on = osNotes.get(key); if (on) { try { on.close(); } catch { /* gone */ } osNotes.delete(key); }
    if (!cards.has(key) || cards.size <= 1) flashTitle(false);
    dropCard(key);
  }
  function dropCard(key) { if (ring.key === key) stopRing(); const el = cards.get(key); if (el) { el.remove(); cards.delete(key); } if (![...cards.keys()].some((k) => k.startsWith('o'))) ringing(false); }
  // Seen is reported exactly once per notice from this page: Got it in the chat bubble and Got it on a pop-up both come through here.
  const seen = (nid) => { if (answered.has(nid)) return; answered.add(nid); post(`/api/care/${pid}/notifications/${nid}/seen`); };
  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* no chat page to tell */ } };
  window.addEventListener('maya-reminder-got', (e) => { const nid = e.detail && e.detail.notifId; if (!nid) return; seen(nid); drop(`n${nid}`); });   // Got it on the chat message

  function connect() {
    disconnect();
    pid = window.mayaProfile && window.mayaProfile.id;
    if (!pid) return;
    const id = pid;
    es = new EventSource(`/api/care/${id}/events?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    es.addEventListener('incoming', (e) => {
      const d = JSON.parse(e.data);
      post(`/api/care/${id}/notifications/${d.notifId}/delivered`);
      if (window.mayaInCall && window.mayaInCall()) return; // never ring over a live call
      for (const k of [...cards.keys()]) if (k.startsWith('o')) drop(k); // one ring at a time
      card(`o${d.outreachId}`, whyOf(d.kind), [
        { label: 'Decline', cls: 'inbox-btn decline', run: () => post(`/api/care/${id}/outreach/${d.outreachId}/decline`) },
        { label: 'Accept', cls: 'inbox-btn accept', run: () => { seen(d.notifId); window.mayaStartCall({ reason: d.kind, outreachId: d.outreachId }); } },
      ], 'incoming', 'Maya is calling');
      startRing(`o${d.outreachId}`);
      osNotify(`o${d.outreachId}`, 'Maya is calling', whyOf(d.kind));
    });
    // Maya's own unprompted chat message (the family's Seen, said in her words) goes to the chat thread (chat-ui.js).
    es.addEventListener('chat', (e) => {
      try {
        const m = JSON.parse(e.data).message;
        window.dispatchEvent(new CustomEvent('maya-chat-message', { detail: m }));
        if (m && m.role === 'maya' && !m.spoken) osNotify(`c${m.id}`, 'Maya', m.kind === 'voice' ? 'Maya sent you a voice note.' : m.text || 'Maya wrote to you.');   // a call's lines are not news; a message or a voice note is
      } catch { /* ignore a bad event */ }
    });
    es.addEventListener('incomingEnd', (e) => drop(`o${JSON.parse(e.data).outreachId}`));
    es.addEventListener('notice', (e) => {
      const d = JSON.parse(e.data);
      if (answered.has(d.notifId)) return;
      post(`/api/care/${id}/notifications/${d.notifId}/delivered`);
      // A reminder is a chat message first (the server put it in the thread): it is shown IN the chat, with its Got it. A pop-up (and a browser notification) comes only when the chat is not in front of them.
      if (d.message) { emit('maya-reminder', { message: d.message }); if (!away()) { chime(); return; } }   // (the pop-up below makes its own one chime)
      noticeCard(`n${d.notifId}`, noteLabel(d), d.text, [
        // Got it (the only button): reported as Seen, the pop-up goes, and the chat comes forward at that same reminder, shown as done.
        { label: 'Got it', cls: 'primary', done: 'Done. Marked as seen', run: () => { seen(d.notifId); window.focus(); emit('maya-show-reminder', { id: d.notifId, label: noteLabel(d), text: d.text, done: true }); } },
      ]);
    });
    // Seen on another page of theirs (a second tab, their phone): this card goes too.
    es.addEventListener('noticeSeen', (e) => { try { const nid = JSON.parse(e.data).notifId; answered.add(nid); drop(`n${nid}`); emit('maya-reminder-done', { notifId: nid }); } catch { /* ignore a bad event */ } });
  }
  function disconnect() { stopRing(); if (es) es.close(); es = null; for (const k of [...cards.keys()]) drop(k); }
  window.addEventListener('maya-profile', connect);
  window.addEventListener('pagehide', disconnect);

  // "Around" signal: a real interaction, at most every 20 s, never from the call buttons and never during a call.
  let lastPing = 0;
  function around(e) {
    if (!pid || (window.mayaInCall && window.mayaInCall())) return;
    if (e.target && e.target.closest && e.target.closest('#callBtn, .inbox-card')) return;
    const now = Date.now();
    if (now - lastPing < 20000) return;
    lastPing = now;
    post(`/api/care/${pid}/activity`, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(ev, around, { passive: true });
})();
