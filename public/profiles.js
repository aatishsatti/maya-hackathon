// Family setup: pick (or add) a person before a call. Name + gender only; the call screen stays one big button.
(function () {
  const $ = (id) => document.getElementById(id);
  const picker = $('picker');
  const callScreen = $('callScreen');
  const list = $('profileList');
  const form = $('addForm');
  const err = $('pickError');
  let profiles = [];
  const api = { id: null, name: null, setLive(live) { $('switchBtn').hidden = live; } };
  window.mayaProfile = api;

  const store = {
    get() { try { return localStorage.getItem('mayaProfile'); } catch { return null; } },
    set(v) { try { localStorage.setItem('mayaProfile', v); } catch { /* private window */ } },
  };

  function choose(p) {
    api.id = p.id; api.name = p.name;
    store.set(p.id);
    $('switchBtn').textContent = `Talking with ${p.name}. Change`;
    picker.hidden = true; callScreen.hidden = false;
  }
  function showPicker() {
    if (window.mayaEndCall) window.mayaEndCall(); // a call in progress ends cleanly before the picker shows
    api.id = null; api.name = null;
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
  $('switchBtn').addEventListener('click', showPicker);
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

  fetch('/api/profiles').then((r) => r.json()).then((b) => {
    profiles = b.profiles || [];
    const saved = profiles.find((p) => p.id === store.get());
    if (saved) choose(saved); else showPicker();
  }).catch(() => { err.textContent = 'Could not load profiles.'; err.hidden = false; picker.hidden = false; });
})();
