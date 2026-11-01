// Who this browser is. There is NO list of people and NO way to add one here: the family adds people from the family page (after logging in), and the senior's phone learns who it is
// from the family's link (/s/<id>, which saves the id before coming here) or from the code typed on the start screen. A browser that knows nobody shows the start screen:
// Log in / Sign up (the family) and Enter code (the senior). A browser that knows a senior goes straight to the chat, with no login.
(function () {
  const $ = (id) => document.getElementById(id);
  const start = $('start'), callScreen = $('callScreen'), err = $('startError');
  const api = { id: null, name: null, setLive() {}, signOut: null };
  window.mayaProfile = api;

  const store = {
    get() { try { return localStorage.getItem('mayaProfile'); } catch { return null; } },
    set(v) { try { if (v) localStorage.setItem('mayaProfile', v); else localStorage.removeItem('mayaProfile'); } catch { /* private window */ } },
  };
  const say = (m) => { err.textContent = m || ''; err.hidden = !m; };

  function choose(p) {
    api.id = p.id; api.name = p.name;
    store.set(p.id);
    $('titleChat').textContent = `Maya and ${p.name}`;
    start.hidden = true; callScreen.hidden = false;
    window.dispatchEvent(new Event('maya-profile'));
  }
  function showStart() {
    if (window.mayaEndCall) window.mayaEndCall();   // a call in progress ends cleanly first
    api.id = null; api.name = null;
    window.dispatchEvent(new Event('maya-profile'));
    callScreen.hidden = true; start.hidden = false;
    $('codeForm').hidden = true; $('codeIn').value = ''; say('');
  }
  // Sign out: this browser forgets the senior link and goes back to the start screen. The person's profile and chat on the server are untouched; the link or the code brings it all back.
  api.signOut = () => { store.set(''); showStart(); };

  // The id out of what a person typed or pasted: "a1b2c3d4", "/s/a1b2c3d4" or the whole link. null when it is not one.
  const codeFrom = (text) => { const m = /^(?:https?:\/\/[^\s/]+\/s\/|\/s\/|s\/)?([a-f0-9]{8})$/.exec(String(text).trim().toLowerCase().replace(/\/+$/, '')); return m ? m[1] : null; };
  async function openId(id) {
    const r = await fetch(`/api/senior/${id}`);
    const b = r.ok ? await r.json().catch(() => null) : null;
    if (!b || !b.profile) throw new Error('Maya does not know that code. Please check it with your family.');
    choose(b.profile);
  }
  $('doorCode').addEventListener('click', () => { $('codeForm').hidden = false; $('codeIn').focus(); });
  $('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault(); say('');
    const id = codeFrom($('codeIn').value);
    if (!id) { say('That code does not look right. It is the last part of the link your family sent you.'); return; }
    $('codeGo').disabled = true;
    try { await openId(id); } catch (ex) { say(ex.message); }
    $('codeGo').disabled = false;
  });

  const mine = store.get();
  if (!mine) { showStart(); return; }
  fetch(`/api/senior/${mine}`).then((r) => (r.ok ? r.json() : null)).then((one) => {
    if (one && one.profile) { choose(one.profile); return; }
    store.set(''); showStart();   // the saved link is not one Maya knows any more
  }).catch(() => { start.hidden = false; say('Could not load. Please check the internet and try again.'); });
})();
