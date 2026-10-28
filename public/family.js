// Family dashboard (Feature 3 data, restyled). Shows who, when and how many tries; never transcripts, audio, topics or location.
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

  // ---- Cards. Presentation only: every fact shown comes from the server's view; nothing here decides or infers safety. ----
  // One incident = one card: badge, headline, plain status, call-back row, then a vertical timeline of its steps.
  const cardHead = (pillCls, pillText, title, whenMs) => {
    const h = el('div', 'card-head');
    h.append(el('span', `pill ${pillCls}`, pillText), el('span', 'card-title', title));
    if (whenMs) h.append(el('span', 'card-when', t(whenMs)));
    return h;
  };
  const chips = (list) => { const c = el('div', 'chips'); for (const x of list.filter(Boolean)) c.append(el('span', 'chip', x)); return c; };
  const closeBtn = (f, label, cls) => {
    const b = el('button', `btn ${cls || ''}`.trim(), label);
    b.addEventListener('click', () => api(`/api/care/${id}/notifications/${f.notifId}/seen`, 'POST', {}).then(load));
    const w = el('div', 'card-actions'); w.append(b); return w;
  };

  // Expired: never shown as safe or Resolved. Grey, dashed, and says so in plain words.
  function expiredCard(f, name) {
    const c = el('div', 'card closed');
    c.append(cardHead('pill-closed', 'Closed unseen', f.safety ? `Alert about ${name}` : `Note about ${name}`, f.createdAt));
    c.append(el('div', 'closed-line', 'Closed unseen, NOT confirmed safe'));
    c.append(el('div', 'meta', `Nobody marked this seen in ${f.expiredDays} ${f.expiredDays === 1 ? 'day' : 'days'}. This is NOT confirmation that ${name} is safe.`));
    if (f.timeline && f.timeline.length > 1) c.append(timelineEl(f)); // a lone "closed unseen" step would repeat the line above
    return c;
  }
  // Safety alert: urgent, topic-only (no words, audio or place). Stays until a family member says they have seen it.
  function safetyCard(f, name) {
    if (f.status === 'expired') return expiredCard(f, name);
    const seen = f.status === 'resolved';
    const c = el('div', `card ${seen ? 'resolved' : 'alert'}`);
    c.append(cardHead(seen ? 'pill-ok' : 'pill-alert', seen ? 'Seen' : 'Urgent alert', `Maya is worried about ${name}'s safety`, f.createdAt));
    c.append(el('div', 'status', seen ? `A family member has seen this (${t(f.resolvedAt)}).` : `Maya is staying on the call with ${name}. Please contact them now.`));
    c.append(chips([`Mode: ${f.mode} (safety alerts ignore mode and quiet hours)`, 'You decide about emergency services; Maya never calls them']));
    if (f.callbackState) {
      const n = f.callbackAttempts || 0;
      const msg = { pending: 'Maya is about to call back.', ringing: `Maya is calling back (try ${n} of ${f.callbackOf}).`, answered: `${name} picked up Maya's call-back. The alert stays until you have seen it.`, declined: `${name} declined the call-back.`,
        no_answer: `Maya tried to call back ${n} ${n === 1 ? 'time' : 'times'}, no answer.${f.callbackReached ? '' : ` ${name}'s page was not open, so the ring could not reach them.`}` }[f.callbackState];
      const tag = { pending: ['pill-plain', 'Pending'], ringing: ['pill-info', 'Ringing'], answered: ['pill-ok', 'Answered'], declined: ['pill-wait', 'Declined'], no_answer: ['pill-miss', 'No answer'] }[f.callbackState];
      const row = el('div', 'callback');
      row.append(el('span', 'cb-label', 'Call-back:'), tag ? el('span', `pill ${tag[0]}`, tag[1]) : el('span'), el('span', null, msg));
      c.append(row);
    }
    const tl = timelineEl(f); if (tl) c.append(tl);
    if (!seen) c.append(closeBtn(f, "I've seen this", 'primary'));
    return c;
  }
  // The incident's steps (alert, gentle note, call-back tries, resolution), oldest first.
  function timelineEl(f) {
    if (!f.timeline || !f.timeline.length) return null;
    const ol = el('ol', 'timeline');
    for (const s of f.timeline) {
      const li = el('li', `step k-${s.kind}`);
      li.append(el('span', 'step-label', s.label), el('span', 'step-time', t(s.at)));
      ol.append(li);
    }
    return ol;
  }
  function flagCard(f, name) {
    const resolved = f.status === 'resolved';
    if (f.safety) return safetyCard(f, name);
    if (f.status === 'expired') return expiredCard(f, name);
    const isAlert = f.level === 'alert';
    const c = el('div', `card ${resolved ? 'resolved' : isAlert ? 'alert' : 'flag'}`);
    c.append(cardHead(resolved ? 'pill-ok' : isAlert ? 'pill-alert' : 'pill-flag', resolved ? 'Resolved' : isAlert ? 'Alert' : 'Flag', resolved ? `${name} is back, okay now` : `Couldn't reach ${name}`, f.createdAt));
    if (resolved) c.append(el('div', 'status', `Returned at ${t(f.returnAt)}`));
    else c.append(el('div', 'status', `Last call at ${t(f.lastCallAt)}, last seen at ${t(f.lastSeenAt)}${f.lastSeenSource ? ` (${SRC[f.lastSeenSource]})` : ''}, hasn't replied yet`));
    c.append(chips([`Mode: ${f.mode}`, f.attempts ? `${f.attempts} ${f.attempts === 1 ? 'try' : 'tries'}` : 'during a call', f.trigger === 'reminder' && f.task ? `Reminder: ${f.task}` : null, f.quietHours ? 'Quiet hours' : null,
      !resolved && f.notified === 'none' ? 'Dashboard only' : null, !resolved && f.notified === 'gentle' ? 'Gentle note sent' : null, !resolved && f.notified === 'alert' ? 'Notification sent' : null]));
    const tl = timelineEl(f); if (tl) c.append(tl);
    if (!resolved && f.notifId) c.append(closeBtn(f, 'Close'));
    return c;
  }
  function list(node, items, empty) { node.replaceChildren(...(items.length ? items : [el('div', 'empty', empty)])); }

  // Reminder state -> short pill. Done and Missed are the two the family cares about; the full sentence stays below it.
  const REM_PILL = { done: ['pill-ok', 'Done'], missed: ['pill-miss', 'Missed'], no_reply: ['pill-wait', "Hasn't replied yet"], unanswered: ['pill-miss', "Couldn't reach"], declined: ['pill-wait', 'Declined'], calling: ['pill-info', 'Calling'], answered: ['pill-info', 'Picked up'] };
  // Message status -> pill. The words are the server's own: Sent, Delivered, Seen, Played, Replied, Hasn't replied yet.
  const NOTE_PILL = (label) => (/^Replied/.test(label) ? 'pill-ok' : /^Hasn't/.test(label) ? 'pill-wait' : /^(Seen|Played)/.test(label) ? 'pill-info' : 'pill-plain');

  function render(v) {
    $('body').hidden = false;
    $('presence').textContent = v.inCall ? 'On a call with Maya now' : v.appOpen ? 'App is open' : 'App is not open (Maya cannot ring)';
    $('modeNow').textContent = v.modes[v.mode].label;
    $('modes').replaceChildren(...Object.entries(v.modes).map(([k, m]) => {
      const l = el('label', `mode${k === v.mode ? ' on' : ''}`);
      const r = el('input'); r.type = 'radio'; r.name = 'mode'; r.value = k; r.checked = k === v.mode;
      r.addEventListener('change', () => api(`/api/care/${id}/mode`, 'POST', { mode: k }).then(load).catch((e) => showErr(e.message)));
      const b = el('b', null, `${m.label}${k === 'standard' ? ' (default)' : ''}`);
      l.append(r, b, el('div', 'meta', m.blurb));
      return l;
    }));
    const act = (a) => a.filter((f) => f.status === 'active'), done = (a) => a.filter((f) => f.status === 'resolved' || f.status === 'expired').slice(0, 5);
    list($('alerts'), [...act(v.alerts), ...done(v.alerts)].map((f) => flagCard(f, v.name)), 'No alerts.');
    list($('flags'), [...act(v.flags), ...done(v.flags)].map((f) => flagCard(f, v.name)), 'No flags.');
    const rem = v.reminders.map((r) => {
      const c = el('div', 'item');
      const cur = r.active || r.last;
      const head = el('div', 'item-head'); head.append(el('span', 'grow', r.task));
      const tag = cur && REM_PILL[cur.state];
      if (tag) head.append(el('span', `pill ${tag[0]}`, tag[1]));
      const del = el('button', 'btn small danger', 'Delete'); del.addEventListener('click', () => api(`/api/care/${id}/reminders/${r.id}`, 'DELETE').then(load).catch((e) => showErr(e.message))); head.append(del);
      c.append(head);
      if (r.dueAt) c.append(el('div', 'meta', `Next: ${t(r.dueAt)}${r.repeat !== 'none' ? ` · repeats ${r.repeat}` : ''}`));
      if (cur) c.append(el('div', 'detail', `${r.active ? 'Now' : 'Last'} (${t(cur.dueAt)}): ${cur.label}${cur.attempts ? ` · ${cur.attempts} ${cur.attempts === 1 ? 'try' : 'tries'}` : ''}`));
      return c;
    });
    list($('reminders'), rem, 'No reminders yet.');
    const nots = v.notifications.map((n) => {
      const c = el('div', 'item');
      const head = el('div', 'item-head');
      head.append(el('span', 'grow', `${n.to === 'family' ? 'To you' : 'To them'} · ${n.kind.replace('_', ' ')}`), el('span', `pill ${NOTE_PILL(n.label)}`, n.label));
      if (n.channel === 'whatsapp') head.append(el('span', 'pill pill-plain', 'WhatsApp'));
      c.append(head, el('div', 'note-text', n.text), el('div', 'meta', `Sent ${t(n.times.sent)}`));
      if (n.to === 'family' && n.status !== 'seen') { const w = el('div', 'card-actions'); const b = el('button', 'btn small', 'Close'); b.addEventListener('click', () => api(`/api/care/${id}/notifications/${n.id}/seen`, 'POST', {}).then(load)); w.append(b); c.append(w); }
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
