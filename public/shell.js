// The senior page's three places and how you move between them (same as the phone app): HOME (the big Call button, a way into the chat, the Family link),
// CHAT, and the CALL page. A call that is set aside to the chat keeps running; a "Back to call" bar then sits at the top of home and chat. This file only
// moves between places and shows the words of the call; the call itself is app.js, the chat is chat-ui.js, a ring is inbox.js.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const cs = () => window.mayaCallState;
  let nav = 'home';          // home | chat: where the person is when no call page is up
  let unread = false;

  // ---- which place is showing ----
  function apply() {
    const c = cs(), live = Boolean(c && c.live), full = live && c.view === 'full';
    const page = full ? 'call' : nav;
    const was = body.dataset.page;
    body.dataset.page = page;
    for (const id of ['backBarHome', 'backBarChat']) $(id).hidden = !(live && !full);   // a call set aside: one tap back to it
    const dot = $('unreadDot'); dot.hidden = !unread;
    $('chatEntry').setAttribute('aria-label', unread ? 'Chat with Maya, new message' : 'Chat with Maya');
    if (was !== page) window.dispatchEvent(new Event('maya-page'));
  }
  function go(where, push) {
    nav = where;
    if (where === 'chat') { unread = false; if (push && !(history.state && history.state.maya === 'chat')) { try { history.pushState({ maya: 'chat' }, ''); } catch { /* no history here */ } } }
    apply();
  }
  window.addEventListener('popstate', () => { if (nav === 'chat') go('home'); });   // the browser's back button leaves the chat, like the phone's

  $('chatEntry').addEventListener('click', () => go('chat', true));
  $('chatBack').addEventListener('click', () => { if (history.state && history.state.maya === 'chat') history.back(); else go('home'); });
  // The call page's "Go back to chat" does NOT end the call: it opens the chat with the call still live ("Back to call" bar).
  $('backToChat').addEventListener('click', () => { const c = cs(); nav = 'chat'; unread = false; if (c && c.live) c.minimize(); apply(); });
  for (const id of ['backBarHome', 'backBarChat']) $(id).addEventListener('click', () => { const c = cs(); if (c && c.live) c.expand(); });
  window.addEventListener('maya-callstate', apply);
  window.addEventListener('maya-profile', () => { nav = 'home'; unread = false; apply(); });

  // Maya wrote while the person was not looking at the chat: a dot on "Chat with Maya".
  window.addEventListener('maya-chat-message', () => { if (body.dataset.page !== 'chat') { unread = true; apply(); } });
  window.addEventListener('maya-notice', () => { if (body.dataset.page !== 'chat') { unread = true; apply(); } });

  // ---- the words of the call: what Maya just said, large; what you just said, smaller ----
  const caption = $('caption'), mayaLine = $('mayaLine'), youLine = $('youLine'), status = $('status');
  function words() {
    const t = caption.textContent || '';
    if (!t) { mayaLine.textContent = ''; youLine.textContent = ''; return; }
    const m = /^Maya(?: \([^)]*\))?: ([\s\S]*)$/.exec(t), y = /^You: ([\s\S]*)$/.exec(t);
    if (m) mayaLine.textContent = m[1]; else if (y) youLine.textContent = y[1]; else mayaLine.textContent = t;
  }
  new MutationObserver(words).observe(caption, { childList: true, characterData: true, subtree: true });
  // a new call starts clean
  window.addEventListener('maya-callstate', () => { const c = cs(); if (c && c.live && c.view === 'full' && !caption.textContent) { mayaLine.textContent = ''; youLine.textContent = ''; } });

  // An error from a call that could not start must be seen wherever the person is (the chat shows #error itself).
  const err = $('error');
  new MutationObserver(() => { if (!err.hidden && err.textContent && body.dataset.page === 'home') { let h = $('homeError'); if (!h) { h = document.createElement('p'); h.id = 'homeError'; h.className = 'error'; h.setAttribute('role', 'alert'); $('pageHome').querySelector('.home-mid').after(h); } h.textContent = err.textContent; h.hidden = false; } else { const h = $('homeError'); if (h) h.hidden = true; } }).observe(err, { attributes: true, childList: true, characterData: true, subtree: true });

  apply();
})();
