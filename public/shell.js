// The senior page has two places: the CHAT (the whole app: she opens Maya and is in the conversation) and the CALL page on top of it. A call set aside to the chat keeps
// running and a "Back to call" bar shows at the top of the chat. This file only moves between them and shows the words of the call; the call itself is app.js, the chat is chat-ui.js,
// a ring is inbox.js. There is no home page, no Family button and no settings here: the family has its own door (login).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const cs = () => window.mayaCallState;

  function apply() {
    const c = cs(), live = Boolean(c && c.live), full = live && c.view === 'full';
    const was = body.dataset.page;
    body.dataset.page = full ? 'call' : 'chat';
    $('backBarChat').hidden = !(live && !full);   // a call set aside: one tap back to it
    if (was !== body.dataset.page) window.dispatchEvent(new Event('maya-page'));
  }
  // The call page's "Go back to chat" does NOT end the call: it opens the chat with the call still live ("Back to call" bar).
  $('backToChat').addEventListener('click', () => { const c = cs(); if (c && c.live) c.minimize(); apply(); });
  $('backBarChat').addEventListener('click', () => { const c = cs(); if (c && c.live) c.expand(); });
  window.addEventListener('maya-callstate', apply);
  window.addEventListener('maya-profile', apply);

  // ---- the words of the call: what Maya just said, large; what you just said, smaller ----
  const caption = $('caption'), mayaLine = $('mayaLine'), youLine = $('youLine');
  function words() {
    const t = caption.textContent || '';
    if (!t) { mayaLine.textContent = ''; youLine.textContent = ''; return; }
    const m = /^Maya(?: \([^)]*\))?: ([\s\S]*)$/.exec(t), y = /^You: ([\s\S]*)$/.exec(t);
    if (m) mayaLine.textContent = m[1]; else if (y) youLine.textContent = y[1]; else mayaLine.textContent = t;
  }
  new MutationObserver(words).observe(caption, { childList: true, characterData: true, subtree: true });
  window.addEventListener('maya-callstate', () => { const c = cs(); if (c && c.live && c.view === 'full' && !caption.textContent) { mayaLine.textContent = ''; youLine.textContent = ''; } });

  apply();
})();
