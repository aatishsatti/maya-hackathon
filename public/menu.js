// The senior's menu on the web, the same as in the app: one sheet over the chat with My Reminders (their own only), My Profile, Help / About Maya and Sign out.
// It talks to the senior-safe routes only (GET /api/senior/<id>/menu, DELETE /api/senior/<id>/reminders/<rid>): never the family's reminders, schedules or dashboard.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const sheet = $('menuSheet'), bodyEl = $('menuBody'), btn = $('menuBtn');
  const pid = () => window.mayaProfile && window.mayaProfile.id;
  let data = null, loading = false, error = '', page = 'home', open = null, stopping = false;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function when(ms) {
    if (ms == null) return 'No time set';
    const t = new Date(ms), now = new Date();
    const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const h = t.getHours() % 12 || 12, time = `${h}:${String(t.getMinutes()).padStart(2, '0')} ${t.getHours() < 12 ? 'AM' : 'PM'}`;
    const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 && days < 7 ? WD[t.getDay()] : `${WD[t.getDay()]} ${t.getDate()} ${MO[t.getMonth()]}`;
    return `${day} at ${time}`;
  }
  function repeatText(r) {
    const n = (one, many) => (r.every <= 1 ? `Every ${one}` : `Every ${r.every} ${many}`);
    return r.repeat === 'hourly' ? n('hour', 'hours') : r.repeat === 'daily' ? n('day', 'days') : r.repeat === 'weekly' ? n('week', 'weeks') : 'Just once';
  }
  const whenLine = (r) => (r.waitUntil != null ? `Waiting until morning · ${when(r.waitUntil)}` : r.dueAt == null && r.going ? 'Just sent to you' : when(r.dueAt));   // sent, and waiting for the person: not "No time set"
  const channelText = (r) => (r.channel === 'whatsapp' ? 'On WhatsApp' : r.channel === 'app' ? 'In the Maya app' : r.channel === 'both' ? 'In the Maya app and on WhatsApp' : 'In the Maya app or WhatsApp');
  const howText = (r) => (r.deliver === 'call' ? 'A phone call' : r.deliver === 'text' ? 'A message' : r.deliver === 'voice' ? 'A voice note' : 'Maya decides');
  const MODE = { cautious: 'Cautious: Maya keeps a closer eye and tells your family gently if something seems wrong.', ultra: 'Extra careful: Maya tells your family every time she cannot reach you.', standard: 'Standard: Maya tells your family only when something really needs them.' };

  async function load() {
    const id = pid(); if (!id) return;
    loading = true; error = ''; render();
    try {
      const r = await fetch(`/api/senior/${id}/menu`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
      data = j;
    } catch (ex) { error = ex.message || 'Cannot reach Maya. Please check the internet connection and try again.'; }
    loading = false; render();
  }

  const title = (text, back) => {
    const row = el('div', 'menu-title');
    if (back) { const b = el('button', 'menu-back', ''); b.type = 'button'; b.setAttribute('aria-label', 'Back'); b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.400-1.400L7.800 13H20z"/></svg>'; b.addEventListener('click', () => { page = page === 'reminder' ? 'reminders' : 'home'; render(); }); row.append(b); }
    const h = el('h2', null, text); h.id = 'menuTitle'; row.append(h); return row;
  };
  const row = (iconPath, name, sub, onClick, danger) => {
    const b = el('button', `tile${danger ? ' danger' : ''}`); b.type = 'button';
    const ti = el('span', 'ti'); ti.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPath}"/></svg>`;
    const tt = el('span', 'tt'); tt.append(el('b', null, name), el('small', null, sub));
    const ch = el('span', 'chev'); ch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6-1.400-1.400L12.200 12 7.600 7.400z"/></svg>';
    b.append(ti, tt, ch); b.addEventListener('click', onClick); return b;
  };
  const fact = (label, value) => { const d = el('div', 'menu-fact'); d.append(el('small', null, label), el('p', null, value)); return d; };
  const errLine = () => (error ? el('p', 'menu-err', error) : null);

  function render() {
    const parts = [];
    if (page === 'home') {
      parts.push(title('Menu'),
        row('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.5 5v5.250l4.500 2.700-.750 1.230L11 13V7h1.500Z', 'My Reminders', 'What Maya reminds you about', () => { page = 'reminders'; render(); if (!data) load(); else load(); }),
        row('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.300 0-8 1.650-8 5v1h16v-1c0-3.350-4.700-5-8-5Z', 'My Profile', 'Your name and details', () => { page = 'profile'; render(); load(); }),
        row('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 17h-2v-2h2v2Zm2.070-7.750-.900.920A3.500 3.500 0 0 0 13 15h-2v-.500c0-1 .400-1.900 1.170-2.600l1.240-1.260A2 2 0 1 0 10 9H8a4 4 0 1 1 7.070 2.250Z', 'Help / About Maya', 'Who Maya is, and how to call', () => { page = 'help'; render(); }),
        row('M10 17l1.400-1.400L8.800 13H20v-2H8.800l2.600-2.600L10 7l-5 5 5 5ZM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5Z', 'Sign out', 'This browser forgets you', signOutAsk, true));
    } else if (page === 'reminders') {
      parts.push(title('My Reminders', true), errLine());
      if (loading) parts.push(el('p', 'menu-soft', 'Loading...'));
      else if (error) { const b = el('button', 'menu-link', 'Try again'); b.type = 'button'; b.addEventListener('click', load); parts.push(b); }
      else if (!data || !data.reminders.length) parts.push(el('p', 'menu-soft', 'You have no reminders yet. Tell Maya, for example: "Remind me to take my tablets at 8 tonight."'));
      else for (const r of data.reminders) parts.push(row('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.5 5v5.250l4.500 2.700-.750 1.230L11 13V7h1.500Z', r.task, `${whenLine(r)} · ${repeatText(r)}`, () => { open = r; page = 'reminder'; error = ''; render(); }));
    } else if (page === 'reminder' && open) {
      parts.push(title('Reminder', true), errLine(),
        fact('What', open.task),
        fact('When', open.going ? (open.dueAt == null ? 'Just sent to you' : 'Going out now') : open.waitUntil != null ? `Waiting until morning. It is quiet hours, so Maya will remind you at ${when(open.waitUntil)}.` : when(open.dueAt)),
        fact('How often', repeatText(open)),
        fact('How it reaches you', `${howText(open)}. ${channelText(open)}.`));
      const stop = el('button', 'menu-stop', open.going ? 'Going out now' : 'Stop this reminder'); stop.type = 'button'; stop.disabled = stopping || open.going;
      stop.addEventListener('click', () => stopAsk(open)); parts.push(stop);
    } else if (page === 'profile') {
      parts.push(title('My Profile', true), errLine(),
        fact('Name', (data && data.name) || (window.mayaProfile && window.mayaProfile.name) || 'Not available'),
        fact('Your time zone', (data && data.tz) || 'Not set yet'),
        fact('How Maya looks after you', loading ? 'Loading...' : (data && MODE[data.mode]) || 'Not available right now'),
        el('p', 'menu-soft', 'To change any of these, ask your family.'));
    } else if (page === 'help') {
      parts.push(title('Help / About Maya', true),
        el('p', 'menu-lead', 'Maya is your friendly companion, made by the Maya team.'),
        el('p', 'menu-soft', 'To talk to Maya, tap the blue phone button at the top right of the chat. To write to her, use the box at the bottom.'));
    }
    bodyEl.replaceChildren(...parts.filter(Boolean));
  }

  function confirmBox(titleText, text, yesLabel, noLabel, onYes) {
    const wrap = el('div', 'menu-confirm'); wrap.setAttribute('role', 'alertdialog');
    const card = el('div', 'menu-confirm-card');
    const yes = el('button', 'menu-yes', yesLabel), no = el('button', 'menu-no', noLabel); yes.type = 'button'; no.type = 'button';
    card.append(el('h3', null, titleText), el('p', null, text), no, yes); wrap.append(card);
    no.addEventListener('click', () => wrap.remove()); yes.addEventListener('click', () => { wrap.remove(); onYes(); });
    sheet.append(wrap); no.focus();
  }
  function stopAsk(r) {
    confirmBox('Stop this reminder?', `Maya will no longer remind you: ${r.task}`, 'Stop it', 'Keep it', async () => {
      stopping = true; error = ''; render();
      try {
        const res = await fetch(`/api/senior/${pid()}/reminders/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Something went wrong. Please try again.'); }
        data.reminders = data.reminders.filter((x) => x.id !== r.id); page = 'reminders';
      } catch (ex) { error = ex.message; }
      stopping = false; render();
    });
  }
  function signOutAsk() {
    confirmBox('Sign out?', 'This browser will forget you. Your reminders and your chat with Maya are kept. To come back, tap Enter code, or open the link your family sent you.', 'Sign out', 'Stay', () => {
      close(); if (window.mayaProfile && window.mayaProfile.signOut) window.mayaProfile.signOut();
    });
  }

  function openMenu() { if (!pid()) return; page = 'home'; open = null; error = ''; data = null; sheet.hidden = false; render(); document.body.classList.add('menu-open'); const f = bodyEl.querySelector('button'); if (f) f.focus(); }
  function close() { sheet.hidden = true; document.body.classList.remove('menu-open'); const c = sheet.querySelector('.menu-confirm'); if (c) c.remove(); btn.focus(); }
  btn.addEventListener('click', openMenu);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  window.addEventListener('maya-profile', () => { if (!pid() && !sheet.hidden) close(); });
})();
