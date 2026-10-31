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
  // ---- Activity: counts, a paged list grouped by day, filtered by type. Everything shown comes from the server's activity list (the family's own reminder words, never the person's). ----
  const ACT_TYPE = { reminder: 'Reminder', welfare: 'Welfare check', message: 'Message' };
  const ACT_CHAN = { call: 'Call', text: 'Text', voice: 'Voice note' };
  const ACT_PILL = { scheduled: 'pill-plain', sent: 'pill-info', delivered: 'pill-info', read: 'pill-info', answered: 'pill-ok', noreply: 'pill-wait', unreached: 'pill-miss', missed: 'pill-miss', paused: 'pill-wait', failed: 'pill-miss' };
  const ACT_ICON = { reminder: '\u25F7', welfare: '\u2661', message: '\u2709' };   // plain type glyphs in a circle: a clock, a heart, an envelope (no pictures, no markup insertion)
  const ACT_FILTERS = [['all', 'All'], ['reminder', 'Reminders'], ['welfare', 'Welfare'], ['message', 'Messages']];
  const ACT_CARDS = [['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['answered', 'Answered'], ['missed', 'Missed']];
  const ACT_PAGE = 8;
  const act = { entries: [], summary: null, filter: 'all', page: 0 };
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayGroup(at, now = new Date()) { const s = dayStart(now), day = 86400000; return at >= s + day ? 'Upcoming' : at >= s ? 'Today' : at >= s - day ? 'Yesterday' : 'Earlier'; }
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const clockOf = (e, group) => (group === 'Earlier' || group === 'Upcoming' ? new Date(e.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : clock(e.at));
  function actRow(e, group) {
    const row = el('div', 'act-row'), icon = el('span', 'act-icon', ACT_ICON[e.type] || '');
    const main = el('div', 'act-main'), pills = el('div', 'act-pills');
    pills.append(el('span', 'pill pill-plain', ACT_CHAN[e.channel] || e.channel), el('span', `pill ${ACT_PILL[e.status] || 'pill-plain'}`, e.label));
    main.append(el('div', 'act-title', e.words || ACT_TYPE[e.type] || 'Activity'), pills);
    if (e.words) main.children[0].title = ACT_TYPE[e.type] || '';
    if (e.note) main.append(el('div', 'act-note', e.note));
    row.append(icon, main, el('div', 'act-time', clockOf(e, group)));
    return row;
  }
  function renderActivity(a) {
    if (a) { act.entries = a.entries || []; act.summary = a.summary || null; }
    $('actSummary').replaceChildren(...ACT_CARDS.map(([k, label]) => { const c = el('div', 'act-card'); c.append(el('b', '', String(act.summary ? act.summary[k] || 0 : 0)), el('span', '', label)); return c; }));
    $('actFilters').replaceChildren(...ACT_FILTERS.map(([k, label]) => { const b = el('button', `chip${act.filter === k ? ' on' : ''}`, label); b.type = 'button'; b.setAttribute && b.setAttribute('aria-pressed', String(act.filter === k)); b.addEventListener('click', () => { act.filter = k; act.page = 0; renderActivity(); }); return b; }));
    const rows = act.entries.filter((e) => act.filter === 'all' || e.type === act.filter), pages = Math.max(1, Math.ceil(rows.length / ACT_PAGE));
    act.page = Math.min(act.page, pages - 1);
    const out = []; let last = null;
    for (const e of rows.slice(act.page * ACT_PAGE, act.page * ACT_PAGE + ACT_PAGE)) { const g = dayGroup(e.at); if (g !== last) { out.push(el('div', 'act-day', g)); last = g; } out.push(actRow(e, g)); }
    list($('actList'), out, act.filter === 'all' ? 'Nothing yet. Reminders, check-ins and messages show here.' : 'Nothing of this kind yet.');
    $('actPager').hidden = pages <= 1; $('actPage').textContent = `Page ${act.page + 1} of ${pages}`; $('actNewer').disabled = act.page === 0; $('actOlder').disabled = act.page >= pages - 1;
  }
  $('actNewer').addEventListener('click', () => { act.page = Math.max(0, act.page - 1); renderActivity(); });
  $('actOlder').addEventListener('click', () => { act.page += 1; renderActivity(); });
  // The one delivery picker: Call / Text / Voice note. clearable: tapping the chosen one again clears it (a reminder with no choice keeps the old default).
  function seg(node) {
    const btns = node.querySelectorAll ? [...(node.querySelectorAll('button') || [])] : [];
    const cur = () => btns.find((b) => b.getAttribute('aria-checked') === 'true');
    const set = (v) => { for (const b of btns) b.setAttribute('aria-checked', String(b.dataset.v === v)); };
    node.addEventListener('click', (e) => { const b = e.target && e.target.closest ? e.target.closest('button') : null; if (!b) return; if (cur() === b && node.dataset.clearable) set(null); else set(b.dataset.v); });
    return { get: () => (cur() ? cur().dataset.v : null), set };
  }
  const deliverSeg = seg($('deliverPick')), welfareSeg = seg($('waWelfareVia')), schedSeg = seg($('schedVia'));
  // ---- scheduled check-ins: every hour / 2 h / 3 h / custom, by call, text or voice note, for 24 hours; the server runs it and pauses it by itself when a check cannot go out ----
  const everyMin = () => { const v = $('schedEvery').value; return v === 'custom' ? Number($('schedCustom').value) : Number(v); };
  const EVERY_TEXT = (n) => (n === 60 ? 'hour' : n % 60 === 0 ? `${n / 60} hours` : `${n} minutes`);
  function schedPlan() {
    const n = everyMin(), via = schedSeg.get() || 'call';
    $('schedCustom').hidden = $('schedEvery').value !== 'custom';
    if (!Number.isInteger(n) || n < 5 || n > 720) { $('schedPlan').textContent = 'Choose between 5 and 720 minutes.'; return; }
    const count = Math.max(1, Math.floor(24 * 60 / n)), what = via === 'call' ? 'calls' : via === 'voice' ? 'voice notes' : 'texts';
    $('schedPlan').textContent = `Up to ${count} ${what} in the next 24 hours, one every ${EVERY_TEXT(n)}. ${via === 'call' ? "WhatsApp decides how many calls a business may start in a day and refuses the rest: Maya then pauses the schedule. " : ''}It also pauses by itself after 2 unanswered calls in a row, and when they have not written to Maya in the last 24 hours. Every check shows in Activity. You can stop it any time.`;
  }
  function renderSchedule(s) {
    const live = Boolean(s && s.status === 'running');
    $('schedLine').textContent = !s ? 'No schedule is running.' : s.status === 'running' ? `Running: a check-in by ${s.via === 'call' ? 'call' : s.via === 'voice' ? 'voice note' : 'text'} every ${EVERY_TEXT(s.everyMin)}. ${s.fired} sent so far of about ${s.planned}. Next about ${clock(s.next)}. Ends ${t(s.until)}.` : `${s.status === 'paused' ? 'Paused' : 'Ended'}: ${s.note || ''}`.trim();
    $('schedStart').disabled = live; $('schedStop').disabled = !live;
  }
  $('schedEvery').addEventListener('change', schedPlan); $('schedCustom').addEventListener('input', schedPlan); $('schedVia').addEventListener('click', schedPlan); schedPlan();
  $('schedStart').addEventListener('click', async () => {
    $('schedStart').disabled = true;
    try {
      const r = await waCall(`/api/whatsapp/${id}/welfare-schedule`, 'POST', { everyMin: everyMin(), via: schedSeg.get() || 'call' });
      if (!r.ok) { $('schedLine').textContent = r.j.error || 'Could not start the schedule.'; $('schedStart').disabled = false; return; }
      renderSchedule(r.j.schedule); load();
    } catch (e) { $('schedLine').textContent = `Could not reach the server: ${e.message}. Nothing was scheduled.`; $('schedStart').disabled = false; }
  });
  $('schedStop').addEventListener('click', async () => { $('schedStop').disabled = true; await waCall(`/api/whatsapp/${id}/welfare-schedule`, 'DELETE').catch(() => {}); loadWa(); });

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
      if (r.deliver) head.append(el('span', 'pill pill-plain', ACT_CHAN[r.deliver] || r.deliver));   // this reminder's own pick
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
    renderActivity(v.activity); renderSchedule(v.welfareSchedule);
    $('waLink').hidden = Boolean(v.linked && v.optIn);
    $('waSend').hidden = !(v.linked && v.optIn);
    $('waNote').hidden = !v.linked;
    $('waTest').hidden = !(v.linked && v.optIn && v.configured);
    $('waSendHead').hidden = $('waSend').hidden;
    $('waCap').textContent = capText(v.calls);
    if (v.testCall && !waTesting) $('waTestLine').textContent = `Last test call: ${TEST_STATE[v.testCall.state] || v.testCall.state} (${t(v.testCall.at)}).`;
    const canFree = Boolean(v.linked && v.optIn && v.windowOpen);
    for (const b of $('waSend').querySelectorAll ? $('waSend').querySelectorAll('button[data-kind]') : []) b.disabled = b.dataset && b.dataset.kind === 'call' ? false : !canFree;   // a call is not a free-text send: the window does not decide it (the call limits do)   // outside the 24 h window WhatsApp refuses free text and voice, so they cannot be pressed
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
      waSay(useTemplate ? `Invitation sent.${had ? ' Your own words were not sent: WhatsApp only allows the standard invitation until they write back.' : ''}` : waSubmitKind === 'call' ? (r.j.placed === false ? `Nothing rang. ${capText(r.j.calls)} It was sent as a text instead.` : 'WhatsApp took the call: their phone should ring now.') : 'Sent.');
      loadWa();
    } catch (e) { waSay(`Could not reach the server: ${e.message}. Nothing was sent.`, true); }
    finally { waBusy = false; $('waInvite').disabled = false; }
  }
  // "Call them now (test)": the server places ONE call and says a fixed sentence; this only shows what the server says really happened, polling its label for a minute.
  const TEST_STATE = { starting: 'starting', requested: 'asked WhatsApp to ring them', ringing: 'ringing', answered: 'answered', rejected: 'they rejected it', 'no answer': 'no answer, hung up', completed: 'answered, sentence said, hung up', finished: 'answered, the call finished and Maya hung up', ended: 'ended', failed: 'failed (see the server log)', paused: "WhatsApp refused it (its call limit): nothing rang" };
  const TEST_DONE = ['rejected', 'no answer', 'completed', 'finished', 'ended', 'failed', 'paused'];
  let waTesting = false;
  // The call limits, said exactly: which one is reached and when it clears. (Calls free up one at a time as each answered call turns 24 hours old.)
  function capText(c) {
    if (!c) return '';
    const m = c.meta ? `WhatsApp refused the last call at ${t(c.meta.at)} (error ${c.meta.code}): its limit on calls a business can start.${c.meta.note ? ` WhatsApp says: ${c.meta.note}.` : ''} Maya does not count that limit herself: she tries each call and WhatsApp decides when one is allowed again. ` : '';
    if (c.blocked === 'meta') return `${m}Until then a reminder sent with this button goes as a WhatsApp message.`;
    if (c.blocked === 'misses') return `Calls are paused: the last ${c.maxMisses} calls to them were not answered. They start again when they write to Maya or call her. Until then a reminder sent with this button goes as a WhatsApp message.`;
    return `${m}${c.maxMisses} calls in a row that nobody answers pause calls (now ${c.misses} of ${c.maxMisses}).`;
  }
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
    waTesting = true; for (const b of ['waTestCall', 'waRemCall', 'waWelfareCall']) $(b).disabled = true; $('waTestLine').textContent = 'Placing the call...';
    try {
      const r = await waCall(`/api/whatsapp/${id}/${path}`, 'POST', body);
      if (!r.ok) { $('waTestLine').textContent = `${r.j.error || 'Could not place the call.'} Nothing rang.`; return; }
      if (r.j.sent) { $('waTestLine').textContent = `Sent as a ${r.j.via === 'voice' ? 'voice note' : 'text'}. No call was placed.`; load(); return; }
      if (r.j.placed === false) { $('waTestLine').textContent = `Nothing rang. ${capText(r.j.calls)} A WhatsApp message was sent instead.`; load(); return; }
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
    finally { waTesting = false; for (const b of ['waTestCall', 'waRemCall', 'waWelfareCall']) $(b).disabled = false; }
  }
  $('waTestCall').addEventListener('click', () => runCall('test-call'));
  $('waWelfareCall').addEventListener('click', () => runCall('welfare-call', { via: welfareSeg.get() || 'call' }));   // Step 1: a welfare check call, no reminder
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
    api(`/api/care/${id}/reminders`, 'POST', { task: $('task').value, dueAt: new Date($('at').value).getTime(), repeat: $('repeat').value, ...(deliverSeg.get() ? { deliver: deliverSeg.get() } : {}) })
      .then(() => { $('task').value = ''; deliverSeg.set(null); showErr(''); load(); }).catch((x) => showErr(x.message));
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
