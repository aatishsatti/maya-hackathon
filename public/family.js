// Family dashboard (Feature 3 data, restyled). Shows who, when and how many tries; never transcripts, audio, topics or location.
// Status words are the same everywhere: Sent, Delivered, Seen/Played, Replied, Hasn't replied yet, Not replied yet.
(() => {
  'use strict';
  // An element the page no longer has (the old test buttons are gone from the dashboard) is a detached stand-in, so nothing here ever throws on it.
  const $ = (id) => document.getElementById(id) || document.createElement('input');
  let id = null;
  let timer = null;
  const store = { get() { try { return localStorage.getItem('mayaFamilySenior'); } catch { return null; } }, set(v) { try { localStorage.setItem('mayaFamilySenior', v); } catch { /* ignore */ } } };

  const t = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'not seen yet');
  const SRC = { maya: 'a call with Maya', app: 'the app', whatsapp: 'WhatsApp' };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  async function api(path, method, body) {
    const r = await fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.replace('/login.html'); throw new Error('Please log in.'); }   // the family door: not signed in    const j = await r.json().catch(() => ({}));
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
  let lastView = null, lastSched = null;   // what the summary is built from
  const later = (fn) => { try { Promise.resolve().then(fn); } catch (e) { /* no promises here */ } };
  async function loadTrend() {
    const mine = id;
    try { const tr = await api(`/api/care/${mine}/trend`); if (mine === id) $('trend').replaceChildren(trendCard(tr, lastName)); }
    catch { if (mine === id) $('trend').replaceChildren(el('div', 'empty', 'Not available right now.')); }   // never breaks the rest of the page
  }

  function list(node, items, empty) { node.replaceChildren(...(items.length ? items : [el('div', 'empty', empty)])); }

  // Reminder state -> short pill. Done and Missed are the two the family cares about; the full sentence stays below it.
  // ---- Activity: counts, a paged list grouped by day, filtered by type. Everything shown comes from the server's activity list (the family's own reminder words, never the person's). ----
  const ACT_TYPE = { reminder: 'Reminder', welfare: 'Check-in', call: 'Call with Maya', chat: 'Chat' };
  const ACT_WHERE = { app: 'App', whatsapp: 'WhatsApp', both: 'App + WhatsApp' };
  const ACT_CHAN = { call: 'Call', text: 'Text', voice: 'Voice note' };
  const ACT_PILL = { scheduled: 'pill-plain', sent: 'pill-info', delivered: 'pill-info', read: 'pill-info', answered: 'pill-ok', noreply: 'pill-wait', completed: 'pill-ok', unreached: 'pill-miss', missed: 'pill-miss', paused: 'pill-wait', failed: 'pill-miss' };
  const ACT_ICON = { reminder: '\u25F7', welfare: '\u2661', message: '\u2709', call: '\u260E', chat: '\u270E' };   // plain type glyphs in a circle: a clock, a heart, an envelope (no pictures, no markup insertion)
  const ACT_FILTERS = [['all', 'All'], ['reminder', 'Reminders'], ['welfare', 'Check-ins'], ['call', 'Calls']];
  const ACT_CARDS = [['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['answered', 'Answered'], ['missed', 'Missed']];
  const ACT_PAGE = 8;
  const act = { entries: [], summary: null, filter: 'all', page: 0 };
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayGroup(at, now = new Date()) { const s = dayStart(now), day = 86400000; return at >= s + day ? 'Upcoming' : at >= s ? 'Today' : at >= s - day ? 'Yesterday' : 'Earlier'; }
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dateTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });   // always a date AND a time: "Tue 3 Nov, 9:00 am"
  const clockOf = (e, group) => (group === 'Earlier' || group === 'Upcoming' ? new Date(e.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : clock(e.at));
  function actRow(e, group) {
    const row = el('div', 'act-row'), icon = el('span', 'act-icon', ACT_ICON[e.type] || '');
    const main = el('div', 'act-main'), pills = el('div', 'act-pills');
    if (e.where) pills.append(el('span', 'pill pill-plain', ACT_WHERE[e.where] || e.where));
    pills.append(el('span', 'pill pill-plain', ACT_CHAN[e.channel] || e.channel), el('span', `pill ${ACT_PILL[e.status] || 'pill-plain'}`, e.label));
    main.append(el('div', 'act-title', e.words || ACT_TYPE[e.type] || 'Activity'), pills);
    if (e.words) main.children[0].title = ACT_TYPE[e.type] || '';
    if (e.note) main.append(el('div', 'act-note', e.note));
    row.append(icon, main, el('div', 'act-time', clockOf(e, group)));
    return row;
  }
  function renderActivity(a) {
    later(renderSummary);
    if (a) { act.entries = a.entries || []; act.summary = a.summary || null; }
    $('actSummary').replaceChildren(...ACT_CARDS.map(([k, label]) => { const c = el('div', 'act-card'); c.append(el('b', '', String(act.summary ? act.summary[k] || 0 : 0)), el('span', '', label)); return c; }));
    $('actFilters').replaceChildren(...ACT_FILTERS.map(([k, label]) => { const b = el('button', `chip${act.filter === k ? ' on' : ''}`, label); b.type = 'button'; b.setAttribute && b.setAttribute('aria-pressed', String(act.filter === k)); b.addEventListener('click', () => { act.filter = k; act.page = 0; renderActivity(); }); return b; }));
    const rows = act.entries.filter((e) => act.filter === 'all' || e.type === act.filter || (act.filter === 'call' && e.type === 'chat')), pages = Math.max(1, Math.ceil(rows.length / ACT_PAGE));
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
    node.addEventListener('click', (e) => { const b = e.target && e.target.closest ? e.target.closest('button') : null; if (!b) return; if (cur() === b && node.dataset.clearable) set(null); else set(b.dataset.v); later(renderSummary); });
    return { get: () => (cur() ? cur().dataset.v : null), set };
  }
  // ---- quiet hours (where THEY are): nothing is sent, texted or rung at night, so a time that falls in them is warned about (and still accepted: it is held, never dropped) ----
  let quiet = null;   // { start, end, tz } from the server; unknown time zone: nothing is held, so nothing is warned about
  const hh = (n) => String(n).padStart(2, '0');
  const inQuietAt = (ms) => { if (!quiet || !quiet.tz || !Number.isFinite(ms)) return false; try { const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: quiet.tz }).format(new Date(ms))); return quiet.start > quiet.end ? (h >= quiet.start || h < quiet.end) : (h >= quiet.start && h < quiet.end); } catch { return false; } };
  function remQuietWarn() { const on = inQuietAt(new Date($('at').value).getTime()); $('remQuietWarn').hidden = !on; $('remQuietWarn').textContent = on ? `That time is in their quiet hours (${hh(quiet.start)}:00 to ${hh(quiet.end)}:00). The reminder is kept and will be held until ${hh(quiet.end)}:00: nothing is sent, texted or rung at night.` : ''; }
  let pendingAdds = [], showAllRem = false;
  const channelSeg = seg($('channelPick')), deliverSeg = seg($('deliverPick')), welfareSeg = seg($('waWelfareVia')), schedSeg = seg($('schedVia')), welfareWhere = seg($('waWelfareWhere')), schedWhere = seg($('schedWhere'));
  let whereFor = null;
  const WHERE_TEXT = { app: 'in the Maya app', whatsapp: 'on WhatsApp', both: 'on WhatsApp and in the app' };
  const whereText = (s) => (s && WHERE_TEXT[s.channel] ? ` ${WHERE_TEXT[s.channel]}` : '');
  // ---- scheduled check-ins: every hour / 2 h / 3 h / custom, by call, text or voice note, for 24 hours; the server runs it and pauses it by itself when a check cannot go out ----
  const UNIT_MIN = { hours: 60, days: 1440, weeks: 10080 };
  // The list offers day-based presets only. The custom interval sits under Advanced and is used only when a number is typed there.
  const everyMin = () => { const c = $('schedCustom').value.trim(); return c !== '' ? Number(c) * (UNIT_MIN[$('schedUnit').value] || NaN) : Number($('schedEvery').value); };
  const EVERY_TEXT = (n) => (n === 60 ? 'hour' : n === 1440 ? 'day' : n === 10080 ? 'week' : n % 10080 === 0 ? `${n / 10080} weeks` : n % 1440 === 0 ? `${n / 1440} days` : n % 60 === 0 ? `${n / 60} hours` : `${n} minutes`);
  function schedPlan() {
    const n = everyMin(), via = schedSeg.get() || 'call';
    $('schedCustomWarn').className = n < 1440 ? 'hint warn' : 'hint';
    if (!Number.isInteger(n) || n < 5 || n > 120960) { $('schedPlan').textContent = 'Choose a number of hours, days or weeks (up to 12 weeks).'; return; }
    const long = n >= 1440, count = Math.max(1, Math.floor((long ? 90 * 1440 : 24 * 60) / n)), what = via === 'call' ? 'calls' : via === 'voice' ? 'voice notes' : 'texts';
    $('schedPlan').textContent = `Up to ${count} ${what} in the next ${long ? '90 days' : '24 hours'}, one every ${EVERY_TEXT(n)}.${long ? ' It keeps going until you stop it.' : ''} ${quiet && quiet.tz ? `A check that falls between ${hh(quiet.start)}:00 and ${hh(quiet.end)}:00 (their night) is held until ${hh(quiet.end)}:00. ` : ''}${via === 'call' ? "WhatsApp decides how many calls a business may start in a day and refuses the rest: Maya then pauses the schedule. " : ''}${via === 'call' ? '' : 'WhatsApp only allows a text or a voice note inside 24 hours after they last wrote: when that window is closed at a check, Maya calls instead for that round, and tries the text or voice note again first the next time. '}It pauses by itself after 2 unanswered calls in a row or when WhatsApp refuses a call, and says why. Every check shows in Activity. You can stop it any time.`;
  }
  function renderSchedule(s) {
    lastSched = s || null; later(renderSummary);
    const live = Boolean(s && s.status === 'running');
    $('schedLine').textContent = !s ? 'No schedule is running.' : s.status === 'running' && s.held ? `Held for quiet hours: the next check is ${dateTime(s.next)}. Running: a check-in by ${s.via === 'call' ? 'call' : s.via === 'voice' ? 'voice note' : 'text'}${whereText(s)} every ${EVERY_TEXT(s.everyMin)}, ${s.fired} sent so far of about ${s.planned}. Ends ${t(s.until)}.` : s.status === 'running' ? `Running: a check-in by ${s.via === 'call' ? 'call' : s.via === 'voice' ? 'voice note' : 'text'}${whereText(s)} every ${EVERY_TEXT(s.everyMin)}. ${s.fired} sent so far of about ${s.planned}. Next check: ${dateTime(s.next)}. Ends ${t(s.until)}.` : `${s.status === 'paused' ? 'Paused' : 'Ended'}: ${s.note || ''}`.trim();
    // Running / Paused / Stopped + the next check at the top; Running shows Stop only, Paused shows Restart only, otherwise Start only.
    const st = !s ? 'Stopped' : s.status === 'running' ? 'Running' : s.status === 'paused' ? 'Paused' : 'Stopped';
    $('schedState').textContent = st; $('schedNext').textContent = live ? (s.held ? `· Next check: ${dateTime(s.next)} (held for quiet hours)` : `· Next check: ${dateTime(s.next)}`) : s ? `· since ${dateTime(s.statusAt || s.startedAt)}${s.note ? `. ${s.note}` : ''}` : '';
    $('schedStart').hidden = live; $('schedStop').hidden = !live; $('schedStart').textContent = st === 'Paused' ? 'Restart' : 'Start'; $('schedStart').disabled = false; $('schedStop').disabled = false;
  }
  $('at').addEventListener('input', remQuietWarn); $('at').addEventListener('change', remQuietWarn);
  $('schedEvery').addEventListener('change', () => { $('schedCustom').value = ''; schedPlan(); }); $('schedCustom').addEventListener('input', schedPlan); $('schedUnit').addEventListener('change', schedPlan); $('schedVia').addEventListener('click', schedPlan); schedPlan();
  $('schedStart').addEventListener('click', async () => {
    $('schedStart').disabled = true;
    try {
      const r = await waCall(`/api/whatsapp/${id}/welfare-schedule`, 'POST', { everyMin: everyMin(), via: schedSeg.get() || 'call', channel: schedWhere.get() || 'whatsapp' });
      if (!r.ok) { $('schedLine').textContent = r.j.error || 'Could not start the schedule.'; $('schedStart').disabled = false; return; }
      renderSchedule(r.j.schedule); load();
    } catch (e) { $('schedLine').textContent = `Could not reach the server: ${e.message}. Nothing was scheduled.`; $('schedStart').disabled = false; }
  });
  $('schedStop').addEventListener('click', async () => { $('schedStop').disabled = true; await waCall(`/api/whatsapp/${id}/welfare-schedule`, 'DELETE').catch(() => {}); loadWa(); });

  // ---- section navigation: the jump links scroll to their section (a hidden target falls back to the WhatsApp panel and a folded panel opens), and every panel can be folded; what is folded is remembered on this device ----
  const FOLD_KEY = 'maya-folded';
  const folded = () => { try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch { return []; } };
  const rememberFold = (panelId, on) => { try { const s = new Set(folded()); if (on) s.add(panelId); else s.delete(panelId); localStorage.setItem(FOLD_KEY, JSON.stringify([...s])); } catch { /* no storage: it simply is not remembered */ } };
  function foldable(panels) {
    for (const panel of panels) {
      const head = panel.querySelector ? panel.querySelector('.sec-head') : null; if (!head || !panel.id) continue;
      const btn = el('button', 'fold', 'Hide'); btn.type = 'button'; btn.setAttribute('aria-expanded', 'true');
      const set = (on) => { panel.classList[on ? 'add' : 'remove']('collapsed'); btn.textContent = on ? 'Show' : 'Hide'; btn.setAttribute('aria-expanded', String(!on)); rememberFold(panel.id, on); };
      btn.addEventListener('click', () => set(!panel.classList.contains('collapsed')));
      head.append(btn); if (folded().includes(panel.id)) set(true);
    }
  }
  function jump(targetId) {
    let target = document.getElementById(targetId); const visible = (x) => Boolean(x) && (x.offsetParent === undefined || x.offsetParent !== null) && !x.hidden;
    if (!visible(target)) target = document.getElementById('waPanel');
    const panel = target && target.closest ? target.closest('.panel') : null; if (panel && panel.classList.contains('collapsed')) { const b = panel.querySelector('.fold'); if (b) b.click(); }
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (document.querySelectorAll) {
    for (const a of [...document.querySelectorAll('#tabs .tab')]) a.addEventListener('click', (e) => { e.preventDefault(); jump(String(a.getAttribute('href')).slice(1)); });
    if (typeof IntersectionObserver === 'function') {   // the tab of the section in view is marked
      const tabs = [...document.querySelectorAll('#tabs .tab')], seen = new Map();
      const io = new IntersectionObserver((rows) => { for (const r of rows) seen.set(r.target.id, r.isIntersecting ? r.intersectionRatio : 0); const top = [...seen.entries()].sort((x, y) => y[1] - x[1])[0]; for (const a of tabs) a.setAttribute('aria-current', String(Boolean(top && top[1] > 0 && a.getAttribute('href') === `#${top[0]}`))); }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
      for (const a of tabs) { const t = document.getElementById(String(a.getAttribute('href')).slice(1)); if (t) io.observe(t); }
    }
  }

  const REM_PILL = { done: ['pill-ok', 'Answered'], missed: ['pill-miss', 'Missed'], no_reply: ['pill-wait', "Hasn't replied yet"], unanswered: ['pill-miss', "Couldn't reach"], declined: ['pill-wait', 'Declined'], calling: ['pill-info', 'Calling'], answered: ['pill-info', 'Picked up'],
    wa_sending: ['pill-info', 'Sending'], wa_sent: ['pill-info', 'Sent'], wa_delivered: ['pill-info', 'Delivered'], wa_read: ['pill-wait', 'Read'], wa_missed: ['pill-miss', 'Missed'], app_sending: ['pill-info', 'Sending'], app_sent: ['pill-info', 'Sent'], app_delivered: ['pill-info', 'Delivered'], app_read: ['pill-wait', 'Seen'], app_missed: ['pill-miss', 'Missed'], app_failed: ['pill-miss', 'Not sent'], app_unseen: ['pill-miss', 'Not seen'], wa_unseen: ['pill-miss', 'Not seen'], wa_failed: ['pill-miss', 'Not sent'] };
  // Message status -> pill. The words are the server's own: Sent, Delivered, Seen, Played, Replied, Hasn't replied yet.
  const NOTE_PILL = (label) => (/^Replied/.test(label) ? 'pill-ok' : /^Hasn't/.test(label) ? 'pill-wait' : /^(Seen|Played)/.test(label) ? 'pill-info' : 'pill-plain');

  function render(v) {
    $('body').hidden = false; lastView = v;
    lastName = v.name || 'them'; quiet = v.quiet || null; remQuietWarn(); schedPlan();
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
    // The list: what is coming (and what is being delivered right now) first, soonest at the top; finished ones below, newest first, and only the latest five until "Show earlier" is pressed.
    // A reminder that was just added is shown at once (the server confirmed it) and is replaced by the server's own copy as soon as the list is read again.
    const have = new Set(v.reminders.map((x) => x.id)), fresh = pendingAdds.filter((x) => Date.now() - x.addedAt < 10000 && !have.has(x.id));
    const all = [...v.reminders, ...fresh];
    const upcoming = all.filter((r) => r.active || r.dueAt != null).sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1) || (a.dueAt || 0) - (b.dueAt || 0));
    const finished = all.filter((r) => !r.active && r.dueAt == null).sort((a, b) => ((b.last && b.last.at) || 0) - ((a.last && a.last.at) || 0));
    const shown = [...upcoming, ...(showAllRem ? finished : finished.slice(0, 5))];
    const reminderItem = (r) => {
      const c = el('div', 'item');
      const cur = r.active || r.last;
      const head = el('div', 'item-head'); head.append(el('span', 'grow', r.task));
      if (r.deliver) head.append(el('span', 'pill pill-plain', ACT_CHAN[r.deliver] || r.deliver));   // this reminder's own pick
      if (r.channel) head.append(el('span', 'pill pill-plain', ACT_WHERE[r.channel] || r.channel));
      if (r.by === 'senior') head.append(el('span', 'pill pill-plain', 'Set by talking'));   // they asked Maya for it themselves, on a call or in a chat
      if (r.held || r.waitUntil) head.append(el('span', 'pill pill-wait', 'Waiting until morning'));   // quiet hours: held, or due at night
      const tag = cur && REM_PILL[cur.state];
      if (tag) head.append(el('span', `pill ${tag[0]}`, tag[1]));
      c.className = 'item tap'; if (c.setAttribute) { c.setAttribute('role', 'button'); c.setAttribute('tabindex', '0'); c.setAttribute('aria-label', `Edit ${r.task}`); }
      head.append(el('span', 'edit-hint', 'Edit'));
      c.addEventListener('click', () => openEdit(r)); if (c.addEventListener) c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(r); } });
      c.append(head);
      if (r.waitUntil) c.append(el('div', 'meta', `Waiting until morning (quiet hours): goes at ${t(r.waitUntil)}${r.repeat !== 'none' ? ` · repeats ${r.every === 2 ? `every 2 ${r.repeat === 'weekly' ? 'weeks' : 'days'}` : r.repeat}` : ''}`));
      else if (r.dueAt) c.append(el('div', 'meta', `Next: ${t(r.dueAt)}${r.repeat !== 'none' ? ` · repeats ${r.every === 2 ? `every 2 ${r.repeat === 'weekly' ? 'weeks' : 'days'}` : r.repeat}` : ''}`));
      if (cur) c.append(el('div', 'detail', `${r.active ? 'Now' : 'Last'} (${t(cur.dueAt)}): ${cur.label}${cur.attempts ? ` · ${cur.attempts} ${cur.attempts === 1 ? 'try' : 'tries'}` : ''}`));
      return c;
    };
    const rem = shown.map(reminderItem);
    if (finished.length > 5) { const b = el('button', 'btn', showAllRem ? 'Show fewer finished reminders' : `Show ${finished.length - 5} earlier finished reminders`); b.type = 'button'; b.addEventListener('click', () => { showAllRem = !showAllRem; load(); }); rem.push(b); }
    list($('reminders'), rem, 'No reminders yet.');
    fillRemPick(v.reminders);
    lastRules = v.whatsappRules || lastRules;   // Meta's rules in plain words, from the server: the family reads them before picking WhatsApp
    { const tzq = v.quiet || {}, SRC = { device: "from their phone", ip: "from their internet connection", phone: "from their phone number's country", manual: 'set by you' };
      $('tzRow').hidden = Boolean(tzq.tz); $('tzKnown').hidden = !tzq.tz; if (tzq.tz) $('tzKnown').textContent = `Time zone: ${tzq.tz} (found ${SRC[tzq.tzSource] || 'automatically'}).`; }
    if (v.delivery && document.activeElement !== $('deliv')) $('deliv').value = v.delivery.reminders;
    if (v.delivery && document.activeElement !== $('delivChan')) $('delivChan').value = v.delivery.channel || 'whatsapp';
    if (v.delivery && whereFor !== id) { whereFor = id; const ch = v.delivery.channel || 'whatsapp'; welfareWhere.set(ch); schedWhere.set(ch); }   // the welfare pickers start at the person's own default, like a reminder's
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
  async function waCall(path, method, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.replace('/login.html'); throw new Error('Please log in.'); }   // the family door: not signed in    const j = await r.json().catch(() => ({}));
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
    waWindowClosed = Boolean(v.linked && v.optIn && !v.windowOpen); later(renderSummary);
    $('waNote').hidden = !v.linked;
    $('waTest').hidden = !(v.linked && v.optIn && v.configured);
    $('waCap').textContent = capText(v.calls);
    if (v.testCall && !waTesting) $('waTestLine').textContent = `Last test call: ${TEST_STATE[v.testCall.state] || v.testCall.state} (${t(v.testCall.at)}).`;
    $('waState').textContent = !v.linked ? 'Not linked' : !v.optIn ? 'Opted out' : v.windowOpen ? 'Can message' : 'Waiting for them to write';
    $('waState').className = `pill ${v.linked && v.optIn && v.windowOpen ? 'pill-ok' : 'pill-plain'}`;
    const last = v.lastSent ? ` Last: ${v.lastSent.kind} ${t(v.lastSent.at)}, ${WA_STATUS[v.lastSent.status] || v.lastSent.status}${v.lastSent.error ? ` (code ${v.lastSent.error.code})` : ''}.` : '';
    $('waLine').textContent = !v.configured ? 'WhatsApp is not set up on this server yet.'
      : !v.linked ? 'Link their number once they have agreed to hear from Maya on WhatsApp.'
      : !v.optIn ? `They stopped messages from Maya (number ending ${v.phoneEnd}).`
      : v.windowOpen ? `Number ending ${v.phoneEnd}. They wrote in the last 24 hours, so texts and voice notes can go.${last}`
      : `Number ending ${v.phoneEnd}. They have not written in the last 24 hours, so a reminder goes as WhatsApp's approved message and a text or voice note check-in is covered by a call.${last}`;
  }
  $('waLink').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await waCall(`/api/whatsapp/${id}/link`, 'POST', { phone: $('waPhone').value, optIn: $('waOpt').checked });
    if (!r.ok) return showErr(r.j.error || 'Could not link.');
    showErr(''); $('waPhone').value = ''; $('waOpt').checked = false; loadWa();
  });
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
    waTesting = true; for (const b of ['waWelfareCall']) $(b).disabled = true; $('waTestLine').textContent = 'Placing the call...';
    try {
      const r = await waCall(`/api/whatsapp/${id}/${path}`, 'POST', body);
      if (!r.ok) { $('waTestLine').textContent = `${r.j.error || 'Could not place the call.'} Nothing rang.`; load(); return; }
      if (r.j.channel) {   // the welfare channel (App / WhatsApp / Both): the server says in one line what happened and where
        if (r.j.summary) { $('waTestLine').textContent = r.j.summary; load(); return; }
        r.j = r.j.result || {};
      }
      if (r.j.calledInstead) { $('waTestLine').textContent = 'The 24 hour window is closed, so a text or voice note cannot go: Maya is calling instead. Their phone should ring now.'; load(); return; }
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
    finally { waTesting = false; for (const b of ['waWelfareCall']) $(b).disabled = false; }
  }
  $('waWelfareCall').addEventListener('click', () => runCall('welfare-call', { via: welfareSeg.get() || 'call', channel: welfareWhere.get() || 'whatsapp' }));   // Step 1: a welfare check call, no reminder

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
  try { if (typeof Intl.supportedValuesOf === 'function') $('tzList').replaceChildren(...Intl.supportedValuesOf('timeZone').map((z) => { const o = el('option', '', ''); o.value = z; return o; })); } catch (e) { /* the box still takes a typed name */ }
  $('tzSave').addEventListener('click', () => api(`/api/care/${id}/timezone`, 'POST', { tz: $('tzIn').value.trim() }).then(() => { showErr(''); load(); }).catch((x) => showErr(x.message)));
  $('delivChan').addEventListener('change', () => api(`/api/care/${id}/delivery`, 'POST', { channel: $('delivChan').value }).then(() => { later(renderSummary); showErr(''); load(); }).catch((x) => showErr(x.message)));
  $('deliv').addEventListener('change', () => api(`/api/care/${id}/delivery`, 'POST', { reminders: $('deliv').value }).then(() => { showErr(''); load(); }).catch((x) => showErr(x.message)));
  $('remForm').addEventListener('submit', (e) => {
    e.preventDefault();
    api(`/api/care/${id}/reminders`, 'POST', { task: $('task').value, dueAt: new Date($('at').value).getTime(), repeat: $('repeat').value.replace(/2$/, ''), ...($('repeat').value.endsWith('2') ? { every: 2 } : {}), ...(deliverSeg.get() ? { deliver: deliverSeg.get() } : {}), ...(channelSeg.get() ? { channel: channelSeg.get() } : {}) })
      .then((j) => { if (j && j.reminder) pendingAdds.push({ ...j.reminder, addedAt: Date.now() }); $('task').value = ''; deliverSeg.set(null); channelSeg.set(null); showErr(''); load(); }).catch((x) => showErr(x.message));
  });

  // Live push from the server (only reaches this page while it is open; there is no phone push provider yet).
  const es = new EventSource('/api/care/events');
  es.addEventListener('notify', (e) => {
    const d = JSON.parse(e.data);
    if (window.Notification && Notification.permission === 'granted') new Notification('Maya', { body: d.text });
    if (d.id === id) load();
  });
  es.addEventListener('familyCall', (e) => { const d = JSON.parse(e.data); if (d.id === id) showRing(d); });
  es.addEventListener('refresh', (e) => { if (JSON.parse(e.data).id === id) load(); });
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});

  // ---- The summary: three facts and the latest rows. Everything else opens in a sheet on a tap. ----
  let lastRules = [];
  function renderSummary() {
    try { renderSummaryNow(); } catch (e) { /* the summary is a convenience: it never stops the page */ }
  }
  function renderSummaryNow() {
    const v = lastView; if (!v) return;
    $('skel').hidden = true; renderEsc(v);
    $('checkLocked').hidden = !$('waTest').hidden;   // check-ins need their WhatsApp linked first: say so instead of showing an empty sheet
    const active = (a) => (a || []).filter((f) => f.status === 'active');
    const sc = v.scams || [], alerts = [...active(v.alerts), ...active(sc.filter((x) => x.level === 'alert'))], flags = [...active(v.flags), ...active(sc.filter((x) => x.level !== 'alert'))];
    const need = alerts.length + flags.length > 0;
    $('sumStatus').className = `metric${alerts.length ? ' alert' : need ? ' flag' : ''}`;
    $('sumStatusWord').textContent = need ? 'Needs attention' : 'OK';
    $('sumStatusSub').textContent = alerts.length ? `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'} open` : need ? `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'} open` : 'Nothing needs you';
    $('sumLine').textContent = ($('presence').textContent || '').replace(/\s+/g, ' ').trim();
    const al = $('sumAlerts');
    al.hidden = !need;   // an alert box exists only when there is an alert
    if (need) { al.className = `banner ${alerts.length ? 'alert' : 'flag'}`; al.textContent = alerts.length ? `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}${flags.length ? ` and ${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}` : ''}. Read ${alerts.length === 1 && !flags.length ? 'it' : 'them'}` : `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}. Read ${flags.length === 1 ? 'it' : 'them'}`; }
    // next check: a time big, the date beside it; paused / stopped say since when
    const s = lastSched, dayOf = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    let rowCheck = 'Not set';
    if (s && s.status === 'running') { $('sumNext').textContent = clock(s.next); $('sumNextSub').textContent = `${dayOf(s.next)}${s.held ? ' · held for quiet hours' : ' · running'}`; rowCheck = 'Running'; }
    else if (s && s.status === 'paused') { $('sumNext').textContent = 'Paused'; $('sumNextSub').textContent = `since ${dateTime(s.statusAt || s.startedAt)}`; rowCheck = 'Paused'; }
    else if (s) { $('sumNext').textContent = 'Stopped'; $('sumNextSub').textContent = `since ${dateTime(s.statusAt || s.startedAt)}`; rowCheck = 'Stopped'; }
    else { $('sumNext').textContent = 'Not set'; $('sumNextSub').textContent = 'Set up check-ins'; }
    const today = new Date(), same = (ms) => { const d = new Date(ms); return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate(); };
    const todays = (v.reminders || []).filter((r) => r.active || (r.dueAt != null && same(r.dueAt))).sort((x, y) => (x.dueAt || 0) - (y.dueAt || 0));
    $('sumRem').textContent = String(todays.length);
    const nextR = todays.find((r) => r.dueAt != null && r.dueAt > Date.now());
    $('sumRemSub').textContent = todays.length ? (nextR ? `Next ${clock(nextR.dueAt)} · ${nextR.task}` : 'All done for today') : 'Add a reminder';
    $('rowCheck').textContent = rowCheck; $('rowRem').textContent = todays.length ? `${todays.length} today` : '';
    $('rowAct').textContent = ''; $('rowFam').textContent = people.length > 1 ? String(people.length) : ''; $('rowSet').textContent = v.modes && v.modes[v.mode] ? v.modes[v.mode].label : '';
    lastRules = v.whatsappRules || lastRules;
    // conditional information: only what the family is doing right now
    const sel = (() => { try { return deliverChan(); } catch (e) { return null; } })();
    $('waInfoBtn').hidden = !sel;
    $('waWindowNote').hidden = !(sel && waWindowClosed);
    if (sel && waWindowClosed) $('waWindowNote').textContent = "Their 24-hour WhatsApp window is closed. A text goes as WhatsApp's approved reminder message, and a voice note goes to the Maya app instead. Calls are not affected.";
    $('schedBlock').hidden = !s;   // the check-in status space exists only while there is a schedule to show
    $('schedHead').hidden = false;
    const rows = act.entries.slice(0, 4), out = []; let last = null;
    for (const e of rows) { const g = dayGroup(e.at); if (g !== last) { out.push(el('div', 'act-day', g)); last = g; } out.push(actRow(e, g)); }
    list($('sumAct'), out, 'Nothing yet. Reminders, check-ins and messages will show here.');
  }
  // Does the family's choice involve WhatsApp right now? (the channel picked on the add form, else the default channel setting)
  let waWindowClosed = false;
  function deliverChan() {
    const c = channelSeg.get(), d = $('delivChan').value;
    const pick = c || d;
    return pick === 'whatsapp' || pick === 'both' ? pick : null;
  }
  // ---- information on demand: a button opens a sheet; nothing is explained on the page until it is asked for ----
  const INFO = {
    wa: () => ({ title: 'How WhatsApp reminders work', body: [['ul', lastRules.length ? lastRules : ['Rules from WhatsApp are not available right now. Please try again in a moment.']]] }),
    checkin: () => ({ title: 'How check-ins work', body: [
      ['p', 'A check-in is Maya asking how they are. As a call she talks with them (WhatsApp needs their call permission). As a text or a voice note she sends the same short message.'],
      ['p', 'Maya app has no WhatsApp limits. If WhatsApp cannot deliver, the app covers it and Activity says why. Both sends a text and a voice note to both places, and a call goes where they were last active first.'],
      ['p', 'A custom interval shorter than a day may pause for flooding: WhatsApp and Maya stop a phone from getting too many messages in a day.'],
      ...($('waCap').textContent ? [['p', $('waCap').textContent]] : [])] }),
  };
  function fillInfo(topic) {
    const i = (INFO[topic] || INFO.wa)(), box = $('infoBody');
    $('mInfoT').textContent = i.title;
    box.replaceChildren(...i.body.map(([k, x]) => { if (k === 'ul') { const u = el('ul'); for (const t2 of x) u.append(el('li', '', t2)); return u; } return el('p', '', x); }));
  }
  // ---- sheets: one spring for everything (the same material), interruptible: tap again mid-move and it carries on from where it is ----
  const SPRING = { k: 420, c: 36 };   // stiffness, damping: settles in about 0.35 s with a hair of overshoot
  const calm = () => Boolean(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const phoneW = () => Boolean(window.matchMedia && matchMedia('(max-width: 640px)').matches);
  const sheets = new Map();   // modal -> { p, v, to, raf, origin }
  function paint(m, st) {
    const card = m.querySelector('.modal-card'), p = st.p, h = card.offsetHeight || 400;
    m.style.opacity = String(Math.max(0, Math.min(1, p)));
    if (phoneW()) card.style.transform = `translate3d(0, ${(1 - p) * h}px, 0)`;
    else card.style.transform = `translate3d(0, ${(1 - p) * 24}px, 0) scale(${0.97 + 0.03 * p})`;
  }
  function drive(m, to) {
    let st = sheets.get(m); if (!st) { st = { p: 0, v: 0, to: 0, raf: 0 }; sheets.set(m, st); }
    st.to = to; cancelAnimationFrame(st.raf);
    if (calm() || typeof requestAnimationFrame !== 'function') { st.p = to; st.v = 0; paint(m, st); if (to === 0) m.hidden = true; return; }
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000); last = now;
      for (let n = 0; n < 4; n++) { const h = dt / 4, a = -SPRING.k * (st.p - st.to) - SPRING.c * st.v; st.v += a * h; st.p += st.v * h; }   // semi-implicit Euler: stable at any frame rate
      paint(m, st);
      if (Math.abs(st.p - st.to) < 0.002 && Math.abs(st.v) < 0.02) { st.p = st.to; st.v = 0; paint(m, st); if (st.to === 0) m.hidden = true; return; }
      st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }
  const stack = [];
  function openModal(mid, from, topic) {
    const m = document.getElementById(mid); if (!m) return;
    if (mid === 'mInfo') fillInfo(topic);
    if (!stack.includes(m)) stack.push(m);
    m.hidden = false; document.body.classList.add('modal-open');
    const card = m.querySelector('.modal-card');
    if (from && from.getBoundingClientRect && !phoneW()) { const r = from.getBoundingClientRect(), c = card.getBoundingClientRect(); card.style.transformOrigin = `${Math.round(r.left + r.width / 2 - c.left)}px ${Math.round(r.top + r.height / 2 - c.top)}px`; }   // it grows from what was tapped
    m.querySelector('.modal-body').scrollTop = 0;
    if (!sheets.get(m)) paint(m, { p: 0 });
    drive(m, 1);
    const c = m.querySelector('[data-close]'); if (c) c.focus({ preventScroll: true });
    if (mid === 'mFamily') loadFamily();
  }
  function closeTop() {
    const m = stack.pop(); if (!m) return;
    drive(m, 0);
    if (!stack.length) document.body.classList.remove('modal-open');
    const back = stack[stack.length - 1]; if (back) { const c = back.querySelector('[data-close]'); if (c) c.focus({ preventScroll: true }); }
  }
  if (document.addEventListener) {
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target : null; if (!t) return;
      const o = t.closest('[data-open]'); if (o) { openModal(o.getAttribute('data-open'), o); return; }
      const i = t.closest('[data-info]'); if (i) { openModal('mInfo', i, i.getAttribute('data-info')); return; }
      if (t.closest('[data-close]') || (t.classList && t.classList.contains('modal'))) closeTop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTop(); });
    // on a phone a sheet is dragged down to dismiss; letting go with speed (or past a third) closes it, otherwise the spring takes it back
    let drag = null;
    document.addEventListener('pointerdown', (e) => {
      if (!phoneW() || !e.target.closest) return; const head = e.target.closest('.modal-head, .grab'); if (!head || e.target.closest('button')) return;
      const m = head.closest('.modal'), st = sheets.get(m); if (!st) return;
      cancelAnimationFrame(st.raf); drag = { m, st, y0: e.clientY, p0: st.p, t: performance.now(), y: e.clientY, h: m.querySelector('.modal-card').offsetHeight || 400 };
    });
    document.addEventListener('pointermove', (e) => { if (!drag) return; const dy = Math.max(0, e.clientY - drag.y0); drag.v = (e.clientY - drag.y) / Math.max(1, performance.now() - drag.t) * 1000 / drag.h; drag.y = e.clientY; drag.t = performance.now(); drag.st.p = Math.max(0, drag.p0 - dy / drag.h); drag.st.v = -(drag.v || 0); paint(drag.m, drag.st); });
    const end = () => { if (!drag) return; const { m, st } = drag; drag = null; if (st.p < 0.66 || st.v < -1.2) { stack.splice(stack.indexOf(m), 1); drive(m, 0); if (!stack.length) document.body.classList.remove('modal-open'); } else drive(m, 1); };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  }
  // Family Members: the people on this family's account; a tap looks at them.
  async function loadFamily() {
    const box = $('famList');
    try {
      const ses = await fetch('/api/family/session').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const me = ses && ses.username ? await fetch('/api/family/me').then((r) => (r.ok ? r.json() : null)) : null;
      const ps = me ? me.seniors : people;
      box.replaceChildren(...(ps || []).map((p) => { const b = el('button', `btn big${p.id === id ? ' on' : ''}`, p.name); b.type = 'button'; b.addEventListener('click', () => { $('who').value = p.id; pick(p.id); closeModal(); }); return b; }));
      showLink();
    } catch { box.replaceChildren(el('div', 'empty', 'Could not load the family.')); }
  }
  const logout = () => fetch('/api/family/logout', { method: 'POST' }).finally(() => location.replace('/login.html'));
  if ($('logoutBtn2').addEventListener) $('logoutBtn2').addEventListener('click', logout);
  if ($('logoutTop').addEventListener) $('logoutTop').addEventListener('click', logout);
  // The link and the code for the person on screen: Copy link, Copy code, and Share (the phone's own share sheet where the browser has one).
  function showLink() {
    const p = (people || []).find((x) => x.id === id); $('linkBox').hidden = !p; if (!p) return;
    const url = `${location.origin}/s/${p.id}`;
    $('linkTitle').textContent = `${p.name}'s link and code`; $('linkUrl').value = url; $('linkCode').value = p.id; $('linkNote').textContent = '';
    const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); $('linkNote').textContent = `${what} copied.`; } catch { $('linkNote').textContent = 'Select it and copy it by hand.'; } };
    $('linkCopy').onclick = () => copy(url, 'The link'); $('codeCopy').onclick = () => copy(p.id, 'The code');
    $('linkShare').hidden = !navigator.share;
    $('linkShare').onclick = () => navigator.share({ title: 'Maya', text: `Open Maya on your phone: ${url} (or type the code ${p.id})`, url }).catch(() => {});
  }


  // ---- edit a reminder: a tap on it opens its sheet (change it, or stop it after a confirm) ----
  let editing = null;
  const localInput = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  function openEdit(r) {
    editing = r; const eDeliver = seg($('editDeliver')), eChannel = seg($('editChannel')); editSegs = { eDeliver, eChannel };
    $('editTask').value = r.task || ''; $('editAt').value = localInput(r.dueAt || Date.now() + 3600000);
    $('editRepeat').value = r.repeat === 'none' ? 'none' : `${r.repeat}${r.every === 2 ? '2' : ''}`;
    if (![...$('editRepeat').children].some((o) => o.value === $('editRepeat').value)) { const o = el('option', null, `Every ${r.every || 1} ${r.repeat === 'hourly' ? 'hours' : r.repeat === 'weekly' ? 'weeks' : 'days'} (set by talking)`); o.value = $('editRepeat').value; $('editRepeat').append(o); }
    eDeliver.set(r.deliver || null); eChannel.set(r.channel || null);
    $('editErr').hidden = true; $('editStopAsk').hidden = true; $('editStop').hidden = false;
    openModal('mEdit', null);
  }
  let editSegs = null;
  if ($('editForm').addEventListener) {
    $('editForm').addEventListener('submit', async (e) => {
      e.preventDefault(); if (!editing) return;
      const rep = $('editRepeat').value, body = { task: $('editTask').value, dueAt: new Date($('editAt').value).getTime(), repeat: rep.replace(/2$/, ''), ...(rep.endsWith('2') ? { every: 2 } : {}), ...(editSegs && editSegs.eDeliver.get() ? { deliver: editSegs.eDeliver.get() } : {}), ...(editSegs && editSegs.eChannel.get() ? { channel: editSegs.eChannel.get() } : {}) };
      try { await api(`/api/care/${id}/reminders/${editing.id}`, 'POST', body); closeTop(); load(); } catch (ex) { $('editErr').textContent = ex.message; $('editErr').hidden = false; }
    });
    $('editStop').addEventListener('click', () => { $('editStopAsk').hidden = false; $('editStop').hidden = true; });   // stopping is destructive: asked once more
    $('editStopNo').addEventListener('click', () => { $('editStopAsk').hidden = true; $('editStop').hidden = false; });
    $('editStopYes').addEventListener('click', async () => { if (!editing) return; try { await api(`/api/care/${id}/reminders/${editing.id}`, 'DELETE'); pendingAdds = pendingAdds.filter((x) => x.id !== editing.id); closeTop(); load(); } catch (ex) { $('editErr').textContent = ex.message; $('editErr').hidden = false; } });
  }

  // ---- upload a schedule: a photo, a PDF, typed words or a voice note -> Maya reads it -> the family ticks what they want -> only those are set ----
  let schedSource = 'photo', recorder = null, recTimer = null, foundItems = [];
  const SRC_UI = { photo: ['Choose a photo', 'image/*'], pdf: ['Choose a PDF', 'application/pdf,.pdf'] };
  const schedMsg = (m, err) => { $('schedErr').textContent = err ? m : ''; $('schedErr').hidden = !err; };
  function schedSources() {
    for (const b of $('schedSrc').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === schedSource));
    $('schedChoose').hidden = !SRC_UI[schedSource]; $('schedTypeBox').hidden = schedSource !== 'text'; $('schedVoiceBox').hidden = schedSource !== 'voice';
    if (SRC_UI[schedSource]) { $('schedChoose').textContent = SRC_UI[schedSource][0]; $('schedFile').accept = SRC_UI[schedSource][1]; }
  }
  async function schedSend(promise) {
    schedMsg('', false); $('schedFound').hidden = true; $('schedDone').hidden = true; $('schedBusy').hidden = false;
    try { showFound((await promise).items || []); } catch (ex) { schedMsg(ex.message, true); }
    $('schedBusy').hidden = true;
  }
  function showFound(items) {
    foundItems = items;
    if (!items.length) { schedMsg('Maya could not find anything with a clear time in that. You can type the schedule instead.', true); return; }
    $('schedItems').replaceChildren(...items.map((it) => { const l = el('label', 'check-row'), c = el('input'); c.type = 'checkbox'; c.value = it.id; c.addEventListener('change', syncSet); const w = el('div'); w.append(el('b', '', it.task), el('span', '', it.when)); l.append(c, w); return l; }));
    $('schedFound').hidden = false; syncSet();
  }
  const ticked = () => [...$('schedItems').querySelectorAll('input')].filter((x) => x.checked).map((x) => x.value);
  function syncSet() { const n = ticked().length; $('schedSet').disabled = n === 0; $('schedSet').textContent = n ? `Set ${n} ${n === 1 ? 'reminder' : 'reminders'}` : 'Tick the ones you want'; }
  if ($('schedSrc').addEventListener) {
    $('schedSrc').addEventListener('click', (e) => { const b = e.target && e.target.closest ? e.target.closest('button') : null; if (!b) return; schedSource = b.dataset.v; schedSources(); });
    $('schedChoose').addEventListener('click', () => { $('schedFile').value = ''; $('schedFile').click(); });
    $('schedFile').addEventListener('change', () => {
      const file = $('schedFile').files && $('schedFile').files[0]; if (!file) return;
      schedSend(fetch(`/api/care/${id}/schedule/${schedSource === 'pdf' ? 'pdf' : 'image'}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }).then(async (r) => { const j = await r.json().catch(() => ({})); if (r.status === 401) { location.replace('/login.html'); throw new Error('Please log in.'); } if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`); return j; }));
    });
    $('schedRead').addEventListener('click', () => { const text = $('schedText').value.trim(); if (!text) { schedMsg('Type the schedule first.', true); return; } schedSend(api(`/api/care/${id}/schedule/text`, 'POST', { text })); });
    $('schedRec').addEventListener('click', async () => {
      if (recorder) { clearInterval(recTimer); const r = recorder; recorder = null; $('schedRec').textContent = 'Start recording'; $('schedRecTime').textContent = ''; schedSend(r.stop().then((wav) => fetch(`/api/care/${id}/schedule/voice`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }).then(async (x) => { const j = await x.json().catch(() => ({})); if (!x.ok) throw new Error(j.error || `Request failed (${x.status})`); return j; }))); return; }
      try { recorder = await window.mayaChat.startRecording(); } catch { schedMsg('Maya could not use the microphone. Please allow microphone access and try again.', true); return; }
      const t0 = Date.now(); $('schedRec').textContent = 'Stop and read it'; recTimer = setInterval(() => { $('schedRecTime').textContent = `Recording ${Math.floor((Date.now() - t0) / 1000)} s`; }, 500);
    });
    $('schedSet').addEventListener('click', async () => {
      $('schedSet').disabled = true;
      try {
        const r = await api(`/api/care/${id}/schedule/set`, 'POST', { ids: ticked() });
        $('schedFound').hidden = true; $('schedDone').hidden = false;
        $('schedDone').textContent = `${r.set.length ? `Set ${r.set.length === 1 ? '1 reminder' : `${r.set.length} reminders`}: ${r.set.join('; ')}. ` : 'Nothing was set. '}${r.failed.length ? `Could not set: ${r.failed.join('; ')}. ` : ''}${r.skipped.length ? `Not set (not ticked): ${r.skipped.join('; ')}.` : ''}`.trim();
        load();
      } catch (ex) { schedMsg(ex.message, true); $('schedSet').disabled = false; }
    });
  }
  try { schedSources(); } catch (e) { /* a page without the upload sheet */ }

  // ---- the family is rung: a sheet with Decline (red, left) and Accept (green, right); the summary then says what happened until it is marked Seen ----
  let ringing = null;
  function showRing(d) { ringing = d; $('ringText').textContent = d.text; openModal('mRing', null); }
  async function ringAct(act) { const d = ringing; if (d) { try { await api(`/api/care/${d.id}/escalation/${d.episodeId}/${act}`, 'POST', {}); } catch (e) { showErr(e.message); } } closeTop(); ringing = null; load(); }
  if ($('ringAccept').addEventListener) { $('ringAccept').addEventListener('click', () => ringAct('accepted')); $('ringDecline').addEventListener('click', () => ringAct('declined')); }
  const ESC_STATUS = { ringing: ['Ringing', 'pill-info'], no_answer: ['No answer', 'pill-wait'], accepted: ['You answered', 'pill-ok'], declined: ['Declined', 'pill-plain'], seen: ['Seen', 'pill-ok'] };
  function renderEsc(v) {
    const e = (v.escalations || []).find((x) => x.status !== 'seen' && Date.now() - x.startedAt < 3 * 86400000);
    $('sumEsc').hidden = !e; if (!e) return;
    $('sumEscText').textContent = `Maya rang the family: ${e.text.replace(/^This is Maya\. /, '')} (${dateTime(e.startedAt)})`;
    const st = ESC_STATUS[e.status] || [e.status, 'pill-plain']; $('sumEscStatus').textContent = st[0]; $('sumEscStatus').className = `pill ${st[1]}`;
    $('sumEscSeen').onclick = async () => { try { await api(`/api/care/${id}/escalation/${e.id}/seen`, 'POST', {}); load(); } catch (x) { showErr(x.message); } };
  }

  api('/api/profiles').then((b) => {
    const ps = b.profiles || [];
    people = ps;
    if (!ps.length) { location.replace('/login.html#add'); return; }   // a new family: add the first family member
    $('who').replaceChildren(...ps.map((p) => { const o = el('option', null, p.name); o.value = p.id; return o; }));
    const saved = ps.find((p) => p.id === store.get());
    $('who').value = (saved || ps[0]).id;
    pick($('who').value);
  }).catch((e) => showErr(e.message));
})();
