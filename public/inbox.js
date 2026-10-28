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

  function card(key, text, buttons, cls) {
    drop(key);
    const el = document.createElement('div');
    el.className = `inbox-card ${cls || ''}`;
    el.setAttribute('role', 'alert');
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
  }
  function drop(key) { if (ring.key === key) stopRing(); const el = cards.get(key); if (el) { el.remove(); cards.delete(key); } }
  const seen = (nid) => post(`/api/care/${pid}/notifications/${nid}/seen`);

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
      card(`o${d.outreachId}`, `${d.text}`, [
        { label: 'Accept', cls: 'inbox-btn accept', run: () => { seen(d.notifId); window.mayaStartCall({ reason: d.kind, outreachId: d.outreachId }); } },
        { label: 'Decline', cls: 'inbox-btn decline', run: () => post(`/api/care/${id}/outreach/${d.outreachId}/decline`) },
      ], 'incoming');
      startRing(`o${d.outreachId}`);
    });
    // Maya's own unprompted chat message (the family's Seen, said in her words) goes to the chat thread (chat-ui.js).
    es.addEventListener('chat', (e) => { try { window.dispatchEvent(new CustomEvent('maya-chat-message', { detail: JSON.parse(e.data).message })); } catch { /* ignore a bad event */ } });
    es.addEventListener('incomingEnd', (e) => drop(`o${JSON.parse(e.data).outreachId}`));
    es.addEventListener('notice', (e) => {
      const d = JSON.parse(e.data);
      post(`/api/care/${id}/notifications/${d.notifId}/delivered`);
      chime();
      card(`n${d.notifId}`, `Message from your family: ${d.text}`, [{ label: 'Close', run: () => seen(d.notifId) }]);
    });
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
