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
  // Scam shield card (care.js p.scams). Topic only: the KIND of scam, never the letter's words, a transcript or the photo.
  function scamCard(sc, name) {
    const kind = sc.type || 'scam';
    if (sc.status === 'expired') {
      const c = el('div', 'card closed');
      c.append(cardHead('pill-closed', 'Closed unseen', `Scam warning about ${name}`, sc.createdAt));
      c.append(el('div', 'closed-line', 'Closed unseen'));
      c.append(el('div', 'meta', `Nobody marked this seen in ${sc.expiredDays} ${sc.expiredDays === 1 ? 'day' : 'days'}.`));
      return c;
    }
    const resolved = sc.status === 'resolved';
    const isAlert = sc.level === 'alert';
    const c = el('div', `card ${resolved ? 'resolved' : isAlert ? 'alert' : 'flag'}`);
    const how = sc.channel === 'text' ? 'message' : sc.channel === 'spoken' ? 'call or message' : null;   // photo (or older tickets): the original wording
    c.append(cardHead(resolved ? 'pill-ok' : isAlert ? 'pill-alert' : 'pill-flag', resolved ? 'Seen' : isAlert ? 'Scam alert' : 'Flag', how ? `${name} told Maya about a ${how} that looks like a possible ${kind}` : `${name} showed Maya a message that looks like a possible ${kind}`, sc.createdAt));
    if (resolved) c.append(el('div', 'status', `A family member has seen this (${t(sc.resolvedAt)}).`));
    else if (isAlert) c.append(el('div', 'status', sc.pause ? `${name} may have been about to pay or share details, so Maya asked ${name} to stop and check first, and ${name} asked her to let you know. Please check in with ${name}.` : `Maya told ${name} not to pay or share any details, and ${name} asked her to let you know. Please check in with ${name}.`));
    else c.append(el('div', 'status', `Maya told ${name} it looked like a scam. ${name} chose not to alert you, so this stays on this page only.`));
    c.append(chips([isAlert ? 'Notification sent' : 'Dashboard only', sc.channel === 'text' ? 'Typed message' : sc.channel === 'spoken' ? 'Told Maya' : null, sc.pause ? 'May have been about to pay' : null, sc.official && sc.official.found ? `Checked official source: yes (${sc.official.name})` : 'Checked official source: no', sc.official && sc.official.checked && !sc.official.found ? 'Could not verify' : null, 'Topic only: no letter text, no photo']));
    const tl = timelineEl(sc); if (tl) c.append(tl);
    if (!resolved && isAlert && sc.notifId) c.append(closeBtn(sc, "I've seen this", 'primary'));
    return c;
  }
  // ---- What changed: a plain-facts card from daily counts only (server side: trends.js). Yellow at most, never red, never an alert. ----
  // Everything shown is text from the server's own facts, set with textContent; nothing here judges or infers.
  const dayName = (iso) => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
  function trendCard(tr, name) {
    if (!tr || !tr.status) return el('div', 'empty', 'Not available right now.');
    if (tr.learning) {
      const more = Math.max(1, (tr.daysNeeded || 0) - (tr.daysSoFar || 0));
      const c = el('div', 'card');
      c.append(cardHead('pill-plain', 'Still learning', `Maya is still learning ${name}'s usual pattern`));
      c.append(el('div', 'status', `Nothing is judged yet: ${more} more ${more === 1 ? 'day' : 'days'} of daily counts are needed first (${tr.daysSoFar || 0} of ${tr.daysNeeded} so far).`));
      return c;
    }
    if (tr.status === 'ok') {
      const c = el('div', 'card resolved');
      c.append(cardHead('pill-ok', 'Nothing unusual', `${name} looks like ${name}'s usual`));
      c.append(el('div', 'status', 'Nothing has shifted from their own usual pattern over the last 8 days.'));
      return c;
    }
    const c = el('div', 'card flag');
    c.append(cardHead('pill-flag', tr.status === 'notable' ? 'Noticeable change' : 'Worth watching', `A change from ${name}'s usual`));
    for (const line of tr.lines || []) c.append(el('div', 'detail', line));
    c.append(chips([tr.since ? `Since ${dayName(tr.since)}` : null, 'Dashboard only', 'Counts only: no words, topics or audio']));
    c.append(el('div', 'meta', 'This compares them with their own usual. It is not a diagnosis and not advice.'));
    return c;
  }
  let lastName = 'them';
  async function loadTrend() {
    const mine = id;
    try { const tr = await api(`/api/care/${mine}/trend`); if (mine === id) $('trend').replaceChildren(trendCard(tr, lastName)); }
    catch { if (mine === id) $('trend').replaceChildren(el('div', 'empty', 'Not available right now.')); }   // never breaks the rest of the page
  }

  function list(node, items, empty) { node.replaceChildren(...(items.length ? items : [el('div', 'empty', empty)])); }

  // Reminder state -> short pill. Done and Missed are the two the family cares about; the full sentence stays below it.
  const REM_PILL = { done: ['pill-ok', 'Answered'], missed: ['pill-miss', 'Missed'], no_reply: ['pill-wait', "Hasn't replied yet"], unanswered: ['pill-miss', "Couldn't reach"], declined: ['pill-wait', 'Declined'], calling: ['pill-info', 'Calling'], answered: ['pill-info', 'Picked up'],
    wa_sending: ['pill-info', 'Sending'], wa_sent: ['pill-info', 'Sent'], wa_delivered: ['pill-info', 'Delivered'], wa_read: ['pill-wait', 'Read'], wa_missed: ['pill-miss', 'Missed'], wa_failed: ['pill-miss', 'Not sent'] };
  // Message status -> pill. The words are the server's own: Sent, Delivered, Seen, Played, Replied, Hasn't replied yet.
  const NOTE_PILL = (label) => (/^Replied/.test(label) ? 'pill-ok' : /^Hasn't/.test(label) ? 'pill-wait' : /^(Seen|Played)/.test(label) ? 'pill-info' : 'pill-plain');

  function render(v) {
    $('body').hidden = false;
    lastName = v.name || 'them';
    $('presence').textContent = `${v.inCall ? 'On a call with Maya now' : v.appOpen ? 'App is open' : 'App is not open (Maya cannot ring)'} · Last seen ${t(v.lastSeen && v.lastSeen.at)} · ${v.callCount || 0} ${v.callCount === 1 ? 'call' : 'calls'}`;
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
    const sc = v.scams || [], scAlerts = sc.filter((x) => x.level === 'alert' || x.status === 'expired' && x.notified === 'alert'), scFlags = sc.filter((x) => !scAlerts.includes(x));
    list($('alerts'), [...act(scAlerts).map((x) => scamCard(x, v.name)), ...act(v.alerts).map((f) => flagCard(f, v.name)), ...done(scAlerts).map((x) => scamCard(x, v.name)), ...done(v.alerts).map((f) => flagCard(f, v.name))], 'No alerts.');
    list($('flags'), [...act(scFlags).map((x) => scamCard(x, v.name)), ...act(v.flags).map((f) => flagCard(f, v.name)), ...done(scFlags).map((x) => scamCard(x, v.name)), ...done(v.flags).map((f) => flagCard(f, v.name))], 'No flags.');
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
    fillRemPick(v.reminders);
    if (v.delivery && document.activeElement !== $('deliv')) $('deliv').value = v.delivery.reminders;
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

  // ---- WhatsApp (whatsapp.js): link a number with the person's opt-in, send a note as text or a voice note. Every rule (opt-in, 24 h window, template, spam)
  // is enforced by the server; this only shows its answer and never decides. No message words are shown or kept here.
  const WA_STATUS = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Seen', failed: 'Not delivered' };
  let waSubmitKind = 'text';
  async function waCall(path, method, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, j };
  }
  async function loadWa() {
    const mine = id;
    let v;
    try { v = (await waCall(`/api/whatsapp/${mine}`, 'GET')).j; } catch { return; }
    if (mine !== id) return;
    $('waLink').hidden = Boolean(v.linked && v.optIn);
    $('waSend').hidden = !(v.linked && v.optIn);
    $('waNote').hidden = !v.linked;
    $('waTest').hidden = !(v.linked && v.optIn && v.configured);
    if (v.testCall && !waTesting) $('waTestLine').textContent = `Last test call: ${TEST_STATE[v.testCall.state] || v.testCall.state} (${t(v.testCall.at)}).`;
    const canFree = Boolean(v.linked && v.optIn && v.windowOpen);
    for (const b of $('waSend').querySelectorAll ? $('waSend').querySelectorAll('button[data-kind]') : []) b.disabled = !canFree;   // outside the 24 h window WhatsApp refuses free text and voice, so they cannot be pressed
    $('waInvite').hidden = !(v.linked && v.optIn && !v.windowOpen);   // the only thing that can be sent outside the window; needs no typed note
    $('waState').textContent = !v.linked ? 'Not linked' : !v.optIn ? 'Opted out' : v.windowOpen ? 'Can message' : 'Waiting for them to write';
    $('waState').className = `pill ${v.linked && v.optIn && v.windowOpen ? 'pill-ok' : 'pill-plain'}`;
    const last = v.lastSent ? ` Last: ${v.lastSent.kind} ${t(v.lastSent.at)}, ${WA_STATUS[v.lastSent.status] || v.lastSent.status}${v.lastSent.error ? ` (code ${v.lastSent.error.code})` : ''}.` : '';
    $('waLine').textContent = !v.configured ? 'WhatsApp is not set up on this server yet.'
      : !v.linked ? 'Link their number once they have agreed to hear from Maya on WhatsApp.'
      : !v.optIn ? `They stopped messages from Maya (number ending ${v.phoneEnd}).`
      : v.windowOpen ? `Number ending ${v.phoneEnd}. They wrote in the last 24 hours, so you can send a note.${last}`
      : `Number ending ${v.phoneEnd}. They have not written in the last 24 hours, so WhatsApp only allows a standard invitation to reply.${last}`;
  }
  $('waLink').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await waCall(`/api/whatsapp/${id}/link`, 'POST', { phone: $('waPhone').value, optIn: $('waOpt').checked });
    if (!r.ok) return showErr(r.j.error || 'Could not link.');
    showErr(''); $('waPhone').value = ''; $('waOpt').checked = false; loadWa();
  });
  $('waSend').addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (b) waSubmitKind = b.dataset.kind; });
  // The answer shows right here in the panel (not in the banner at the top of the page): "Sent" or the server's plain reason.
  function waSay(msg, bad) { $('waResult').textContent = msg || ''; $('waResult').hidden = !msg; $('waResult').style.color = bad ? '#9c2f27' : ''; }
  let waBusy = false;
  async function waSend(useTemplate) {
    if (waBusy) return;   // one click, one send
    waBusy = true; $('waInvite').disabled = true;
    const had = $('waText').value.trim();
    waSay('Sending...');
    try {
      // The invitation is always a text-type template and carries no words of ours; a free send uses the button that was pressed.
      const r = await waCall(`/api/whatsapp/${id}/send`, 'POST', useTemplate ? { kind: 'text', text: '', useTemplate: true } : { kind: waSubmitKind, text: $('waText').value, useTemplate: false });
      if (!r.ok) { waSay(r.j.error || 'Could not send. Nothing was sent.', true); if (r.j.needsTemplate) $('waInvite').hidden = false; return; }
      $('waText').value = '';
      waSay(useTemplate ? `Invitation sent.${had ? ' Your own words were not sent: WhatsApp only allows the standard invitation until they write back.' : ''}` : 'Sent.');
      loadWa();
    } catch (e) { waSay(`Could not reach the server: ${e.message}. Nothing was sent.`, true); }
    finally { waBusy = false; $('waInvite').disabled = false; }
  }
  // "Call them now (test)": the server places ONE call and says a fixed sentence; this only shows what the server says really happened, polling its label for a minute.
  const TEST_STATE = { starting: 'starting', requested: 'asked WhatsApp to ring them', ringing: 'ringing', answered: 'answered', rejected: 'they rejected it', 'no answer': 'no answer, hung up', completed: 'answered, sentence said, hung up', finished: 'answered, the call finished and Maya hung up', ended: 'ended', failed: 'failed (see the server log)' };
  const TEST_DONE = ['rejected', 'no answer', 'completed', 'finished', 'ended', 'failed'];
  let waTesting = false;
  // The reminders you can choose for a test call. The list is only rebuilt when it really changed and never while the menu is open or has focus (a rebuild closed the menu and moved the choice).
  let remKey = '';
  function fillRemPick(reminders) {
    const pick = $('waRemPick'), items = (reminders || []).filter((r) => !r.active), key = items.map((r) => `${r.id}:${r.task}`).join('|');
    if (key === remKey || document.activeElement === pick) return;
    remKey = key; const keep = pick.value;
    pick.textContent = ''; pick.append(Object.assign(document.createElement('option'), { value: '', textContent: 'No saved reminder: use what I type' }));
    for (const r of items) pick.append(Object.assign(document.createElement('option'), { value: r.id, textContent: r.task }));
    pick.value = items.some((r) => r.id === keep) ? keep : '';
    remSource();
  }
  // Which one the call will use, said plainly: a saved reminder you picked wins over typed text, and "Clear choice" (or the first menu entry) takes you back.
  function remSource() {
    const pick = $('waRemPick'), typed = $('waRemText').value.trim(), opt = [...pick.children].find((o) => o.value && o.value === pick.value);
    $('waRemSource').textContent = opt ? `The call will use the saved reminder "${opt.textContent}".${typed ? ' What you typed is ignored while a saved reminder is chosen.' : ''}` : typed ? 'The call will use what you typed.' : 'Pick a saved reminder or type one.';
  }
  async function runCall(path, body, button) {
    if (waTesting) return;
    waTesting = true; $('waTestCall').disabled = true; $('waRemCall').disabled = true; $('waTestLine').textContent = 'Placing the call...';
    try {
      const r = await waCall(`/api/whatsapp/${id}/${path}`, 'POST', body);
      if (!r.ok) { $('waTestLine').textContent = `${r.j.error || 'Could not place the call.'} Nothing rang.`; return; }
      if (r.j.placed === false) { $('waTestLine').textContent = 'Calls to them are paused (two in a row went unanswered, or 5 answered calls today). The reminder was sent as a WhatsApp message instead. Nothing rang.'; load(); return; }
      $('waTestLine').textContent = 'WhatsApp took the call: their phone should ring now.';
      const mine = id;
      for (let i = 0; i < 25 && mine === id; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const v = (await waCall(`/api/whatsapp/${mine}`, 'GET').catch(() => ({ j: {} }))).j;
        if (v.testCall) $('waTestLine').textContent = `Call: ${TEST_STATE[v.testCall.state] || v.testCall.state}.`;
        if (v.testCall && TEST_DONE.includes(v.testCall.state)) break;
      }
      load();
    } catch (e) { $('waTestLine').textContent = `Could not reach the server: ${e.message}. Nothing rang.`; }
    finally { waTesting = false; $('waTestCall').disabled = false; $('waRemCall').disabled = false; }
  }
  $('waTestCall').addEventListener('click', () => runCall('test-call'));
  // C2: the family's reminder, delivered by the call. A reminder you already set wins over typed text.
  $('waRemPick').addEventListener('change', remSource); $('waRemText').addEventListener('input', remSource);
  $('waRemClear').addEventListener('click', () => { $('waRemPick').value = ''; $('waRemText').value = ''; remSource(); });
  $('waRemCall').addEventListener('click', () => {
    const rid = $('waRemPick').value, task = $('waRemText').value.trim();
    if (!rid && !task) { $('waTestLine').textContent = 'Pick a reminder or type one first. Nothing rang.'; return; }
    runCall('reminder-call', rid ? { reminderId: rid } : { task });
  });
  $('waSend').addEventListener('submit', (e) => { e.preventDefault(); waSend(false); });
  $('waInvite').addEventListener('click', () => waSend(true));

  async function load() {
    if (!id) return;
    try { render(await api(`/api/care/${id}`)); showErr(''); } catch (e) { showErr(e.message); }
    loadTrend();
    loadWa();
  }
  // Who the page is about: their name large at the top, and one chip per person (the chosen one dark, the others quiet). Only the picture
  // of the page changes here: the data calls and the choice itself (pick) are unchanged. Many people: the dropdown takes over from the chips.
  let people = [];
  const CHIP_MAX = 5;
  function showPeople() {
    const me = people.find((p) => p.id === id);
    $('whoName').textContent = me ? me.name : '';
    const chips = people.length > 1 && people.length <= CHIP_MAX;
    $('chips').hidden = !chips;
    $('whoBox').hidden = people.length <= CHIP_MAX;   // the dropdown only when there are too many people for chips
    $('chips').replaceChildren(...(chips ? people.map((p) => {
      const b = el('button', 'chip' + (p.id === id ? ' on' : ''), p.name);
      b.type = 'button'; if (b.setAttribute) b.setAttribute('aria-pressed', String(p.id === id));
      b.addEventListener('click', () => { if (p.id !== id) { $('who').value = p.id; pick(p.id); } });
      return b;
    }) : []));
  }
  function pick(newId) { id = newId; store.set(id); showPeople(); clearInterval(timer); load(); timer = setInterval(load, 3000); }

  $('who').addEventListener('change', () => pick($('who').value));
  $('deliv').addEventListener('change', () => api(`/api/care/${id}/delivery`, 'POST', { reminders: $('deliv').value }).then(() => { showErr(''); load(); }).catch((x) => showErr(x.message)));
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
    people = ps;
    if (!ps.length) { showErr('No one is set up yet. Add a person on the main page first.'); return; }
    $('who').replaceChildren(...ps.map((p) => { const o = el('option', null, p.name); o.value = p.id; return o; }));
    const saved = ps.find((p) => p.id === store.get());
    $('who').value = (saved || ps[0]).id;
    pick($('who').value);
  }).catch((e) => showErr(e.message));
})();
