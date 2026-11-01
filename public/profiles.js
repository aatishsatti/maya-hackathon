// Family setup: pick (or add) a person before a call. Name + gender only; the call screen stays one big button.
(function () {
  const $ = (id) => document.getElementById(id);
  const picker = $('picker');
  const callScreen = $('callScreen');
  const list = $('profileList');
  const form = $('addForm');
  const err = $('pickError');
  let profiles = [];
  const api = { id: null, name: null, setLive() {} };
  window.mayaProfile = api;

  const store = {
    get() { try { return localStorage.getItem('mayaProfile'); } catch { return null; } },
    set(v) { try { localStorage.setItem('mayaProfile', v); } catch { /* private window */ } },
  };

  function choose(p) {
    api.id = p.id; api.name = p.name;
    store.set(p.id);
        $('titleChat').textContent = `Maya and ${p.name}`;
    picker.hidden = true; callScreen.hidden = false;
    window.dispatchEvent(new Event('maya-profile'));
  }
  function showPicker() {
    if (window.mayaEndCall) window.mayaEndCall(); // a call in progress ends cleanly before the picker shows
    api.id = null; api.name = null;
    window.dispatchEvent(new Event('maya-profile'));
    callScreen.hidden = true; picker.hidden = false;
    form.hidden = true; $('addBtn').hidden = false; err.hidden = true;
    list.replaceChildren(...profiles.map((p) => {
      const row = document.createElement('div');
      row.className = 'profile-row';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pick-btn'; b.textContent = p.name;
      b.addEventListener('click', () => choose(p));
      const d = document.createElement('button');
      d.type = 'button'; d.className = 'del-btn'; d.textContent = 'Delete'; d.setAttribute('aria-label', `Delete ${p.name}`);
      d.addEventListener('click', async () => {
        if (!confirm(`Delete ${p.name} and everything Maya remembers about them?`)) return;
        try {
          const r = await fetch(`/api/profiles/${p.id}`, { method: 'DELETE' });
          if (!r.ok) throw new Error('Could not delete');
          profiles = profiles.filter((x) => x.id !== p.id);
          if (store.get() === p.id) store.set('');
          showPicker();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
      row.append(b, d);
      return row;
    }));
    if (!profiles.length) { form.hidden = false; $('addBtn').hidden = true; }
  }

  $('addBtn').addEventListener('click', () => { form.hidden = false; $('addBtn').hidden = true; $('nameIn').focus(); });
  $('cancelBtn').addEventListener('click', () => { if (profiles.length) showPicker(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const save = $('saveBtn');
    if (save.disabled) return; // already saving: a second click must not create a second profile
    const gender = form.querySelector('input[name=gender]:checked');
    const name = $('nameIn').value.trim();
    const dup = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (dup) { err.textContent = `${dup.name} already exists, pick that one.`; err.hidden = false; return; }
    save.disabled = true; save.textContent = 'Saving...';
    try {
      const r = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, gender: gender && gender.value }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Could not save');
      profiles.push(body.profile);
      form.reset();
      choose(body.profile);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    save.disabled = false; save.textContent = 'Save';
  });

  // The senior door: this phone already knows who it is (the family's link set it), so it opens straight into the chat: no list, no login. Without a link there is
  // only a plain line asking for one (the family adds people from the family page, after logging in).
  const noLink = () => { picker.hidden = false; callScreen.hidden = true; $('profileList').replaceChildren(); $('addBtn').hidden = true; $('addForm').hidden = true; document.querySelector('.pick-title').textContent = 'Please open the Maya link your family sent you.'; };
  const mine = store.get();
  (mine ? fetch(`/api/senior/${mine}`).then((r) => (r.ok ? r.json() : null)) : Promise.resolve(null)).then((one) => {
    if (one && one.profile) { profiles = [one.profile]; choose(one.profile); return null; }
    return fetch('/api/profiles').then((r) => (r.ok ? r.json() : null)).then((b) => {   // only a server without family login still lists people (local development)
      if (!b) { noLink(); return; }
      profiles = b.profiles || [];
      const saved = profiles.find((x) => x.id === mine);
      if (saved) choose(saved); else showPicker();
    });
  }).catch(() => { err.textContent = 'Could not load. Please try again.'; err.hidden = false; picker.hidden = false; });
})();
