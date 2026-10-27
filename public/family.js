// Family dashboard (minimal, Feature 3). Shows who, when and how many tries; never transcripts, audio, topics or location.
// Status words are the same everywhere: Sent, Delivered, Seen/Played, Replied, Hasn't replied yet, Not replied yet.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let id = null;
  let timer = null;
  const store = { get() { try { return localStorage.getItem('mayaFamilySenior'); } catch { return null; } }, set(v) { try { localStorage.setItem('mayaFamilySenior', v); } catch { /* ignore */ } } };

  const t = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'not seen yet');
  const SRC = { maya: 'a call with Maya', app: 'the app', whatsapp: 'WhatsApp' };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  async function api(path, method, body) {
    const r = await fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  }
  function showErr(m) { $('err').textContent = m || ''; $('err').hidden = !m; }

  // Safety alert: urgent, topic-only (no words, audio or place). Stays until a family member says they have seen it.
  function safetyCard(f, name) {
    const seen = f.status === 'resolved';
    const c = el('div', `card ${seen ? 'resolved' : 'alert'}`);
    const head = el('div', 'row');
    head.append(el('span', 'badge', seen ? 'Seen' : 'Urgent alert'), el('b', null, `Maya is worried about ${name}'s safety`));
    c.append(head, el('div', 'status', seen ? `A family member has seen this (${t(f.resolvedAt)}).` : `Raised ${t(f.createdAt)}. Maya is staying on the call with ${name}. Please contact them now.`), el('div', 'meta', `Mode: ${f.mode} (safety alerts ignore mode and quiet hours) · you decide about emergency services; Maya never calls them`));
    if (f.callbackState) {
      const n = f.callbackAttempts || 0;
      const msg = { pending: 'Maya is about to call back.', ringing: `Maya is calling back (try ${n} of ${f.callbackOf}).`, answered: `${name} picked up Maya's call-back. The alert stays until you have seen it.`, declined: `${name} declined the call-back.`,
        no_answer: `Maya tried to call back ${n} ${n === 1 ? 'time' : 'times'}, no answer.${f.callbackReached ? '' : ` ${name}'s page was not open, so the ring could not reach them.`}` }[f.callbackState];
      c.append(el('div', 'status', `Call-back: ${msg}`));
    }
    if (!seen) { const b = el('button', 'primary', "I've seen this"); b.addEventListener('click', () => api(`/api/care/${id}/notifications/${f.notifId}/seen`, 'POST', {}).then(load)); c.append(b); }
    return c;
  }
  function flagCard(f, name) {
    const resolved = f.status === 'resolved';
    if (f.safety) return safetyCard(f, name);
    const c = el('div', `card ${resolved ? 'resolved' : f.level}`);
    const head = el('div', 'row');
    head.append(el('span', 'badge', resolved ? 'Resolved' : f.level === 'alert' ? 'Alert' : 'Flag'), el('b', null, resolved ? `${name} is back, okay now` : `Couldn't reach ${name}`));
    c.append(head);
    if (resolved) c.append(el('div', 'status', `Returned at ${t(f.returnAt)}`));
    else c.append(el('div', 'status', `Last call at ${t(f.lastCallAt)}, last seen at ${t(f.lastSeenAt)}${f.lastSeenSource ? ` (${SRC[f.lastSeenSource]})` : ''}, hasn't replied yet`));
    const bits = [`Mode: ${f.mode}`, f.attempts ? `${f.attempts} ${f.attempts === 1 ? 'try' : 'tries'}` : 'during a call', f.trigger === 'reminder' && f.task ? `reminder: ${f.task}` : null, f.quietHours ? 'quiet hours' : null, `raised ${t(f.createdAt)}`].filter(Boolean);
    c.append(el('div', 'meta', bits.join(' · ')));
    return c;
  }
  function list(node, items, empty) { node.replaceChildren(...(items.length ? items : [el('div', 'empty', empty)])); }

  function render(v) {
    $('body').hidden = false;
    $('presence').textContent = v.inCall ? 'On a call with Maya now' : v.appOpen ? 'App is open' : 'App is not open (Maya cannot ring)';
    $('modeNow').textContent = v.modes[v.mode].label;
    $('modes').replaceChildren(...Object.entries(v.modes).map(([k, m]) => {
      const l = el('label', `mode${k === v.mode ? ' on' : ''}`);
      const r = el('input'); r.type = 'radio'; r.name = 'mode'; r.value = k; r.checked = k === v.mode;
      r.addEventListener('change', () => api(`/api/care/${id}/mode`, 'POST', { mode: k }).then(load).catch((e) => showErr(e.message)));
      const b = el('b', null, ` ${m.label}${k === 'standard' ? ' (default)' : ''}`);
      l.append(r, b, el('div', 'meta', m.blurb));
      return l;
    }));
    const act = (a) => a.filter((f) => f.status === 'active'), done = (a) => a.filter((f) => f.status === 'resolved').slice(0, 5);
    list($('alerts'), [...act(v.alerts), ...done(v.alerts)].map((f) => flagCard(f, v.name)), 'No alerts.');
    list($('flags'), [...act(v.flags), ...done(v.flags)].map((f) => flagCard(f, v.name)), 'No flags.');
    const rem = v.reminders.map((r) => {
      const c = el('div', 'card');
      const head = el('div', 'row'); head.append(el('b', null, r.task));
      const del = el('button', null, 'Delete'); del.addEventListener('click', () => api(`/api/care/${id}/reminders/${r.id}`, 'DELETE').then(load).catch((e) => showErr(e.message))); head.append(del);
      c.append(head);
      if (r.dueAt) c.append(el('div', 'meta', `Next: ${t(r.dueAt)}${r.repeat !== 'none' ? ` · repeats ${r.repeat}` : ''}`));
      const cur = r.active || r.last;
      if (cur) c.append(el('div', 'status', `${r.active ? 'Now' : 'Last'} (${t(cur.dueAt)}): ${cur.label}${cur.attempts ? ` · ${cur.attempts} ${cur.attempts === 1 ? 'try' : 'tries'}` : ''}`));
      return c;
    });
    list($('reminders'), rem, 'No reminders yet.');
    const nots = v.notifications.map((n) => {
      const c = el('div', 'card');
      c.append(el('div', null, `${n.to === 'family' ? 'To you' : 'To them'} · ${n.kind.replace('_', ' ')}: ${n.text}`), el('div', 'status', `${n.label}${n.channel === 'whatsapp' ? ' · WhatsApp' : ''} · ${t(n.times.sent)}`));
      if (n.to === 'family' && n.status !== 'seen') { const b = el('button', null, 'Close'); b.addEventListener('click', () => api(`/api/care/${id}/notifications/${n.id}/seen`, 'POST', {}).then(load)); c.append(b); }
      return c;
    });
    list($('notifs'), nots, 'Nothing sent yet.');
  }

  async function load() {
    if (!id) return;
    try { render(await api(`/api/care/${id}`)); showErr(''); } catch (e) { showErr(e.message); }
  }
  function pick(newId) { id = newId; store.set(id); clearInterval(timer); load(); timer = setInterval(load, 3000); }

  $('who').addEventListener('change', () => pick($('who').value));
  $('remForm').addEventListener('submit', (e) => {
    e.preventDefault();
    api(`/api/care/${id}/reminders`, 'POST', { task: $('task').value, dueAt: new Date($('at').value).getTime(), repeat: $('repeat').value })
      .then(() => { $('task').value = ''; showErr(''); load(); }).catch((x) => showErr(x.message));
  });
  $('msgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    api(`/api/care/${id}/messages`, 'POST', { text: $('msg').value }).then(() => { $('msg').value = ''; load(); }).catch((x) => showErr(x.message));
  });

  // Live push from the server (only reaches this page while it is open; there is no phone push provider yet).
  const es = new EventSource('/api/care/events');
  es.addEventListener('notify', (e) => {
    const d = JSON.parse(e.data);
    if (window.Notification && Notification.permission === 'granted') new Notification('Maya', { body: d.text });
    if (d.id === id) load();
  });
  es.addEventListener('refresh', (e) => { if (JSON.parse(e.data).id === id) load(); });
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});

  api('/api/profiles').then((b) => {
    const ps = b.profiles || [];
    if (!ps.length) { showErr('No one is set up yet. Add a person on the main page first.'); return; }
    $('who').replaceChildren(...ps.map((p) => { const o = el('option', null, p.name); o.value = p.id; return o; }));
    const saved = ps.find((p) => p.id === store.get());
    $('who').value = (saved || ps[0]).id;
    pick($('who').value);
  }).catch((e) => showErr(e.message));
})();
