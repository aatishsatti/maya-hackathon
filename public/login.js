// The family door on the web: log in or sign up (a username and a password), add a family member, get their link, open the dashboard. Same credentials as the app.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let mode = 'login';
  const err = (m) => { $('err').textContent = m || ''; $('err').hidden = !m; };
  async function api(path, method, body) {
    const r = await fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  }
  const show = (id) => { for (const s of ['enter', 'add', 'done']) $(s).hidden = s !== id; err(''); };
  function setMode(m) {
    mode = m; $('tabLogin').setAttribute('aria-selected', String(m === 'login')); $('tabSignup').setAttribute('aria-selected', String(m === 'signup'));
    $('authBtn').textContent = m === 'login' ? 'Log in' : 'Sign up'; $('passHint').hidden = m === 'login';
    $('pass').setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password'); err('');
  }
  $('tabLogin').addEventListener('click', () => setMode('login'));
  $('tabSignup').addEventListener('click', () => setMode('signup'));

  // time zones: the browser's own list when it has one, else just this device's zone
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = (Intl.supportedValuesOf && Intl.supportedValuesOf('timeZone')) || [mine];
  for (const z of zones) { const o = document.createElement('option'); o.value = z; o.textContent = z.replace(/_/g, ' '); if (z === mine) o.selected = true; $('sTz').append(o); }

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault(); err(''); $('authBtn').disabled = true;
    try {
      await api(`/api/family/${mode}`, 'POST', { username: $('user').value, password: $('pass').value });
      const me = await api('/api/family/me');
      if (mode === 'signup' || !me.seniors.length) { $('addTitle').textContent = mode === 'signup' ? 'Welcome. Add your first family member' : 'Add a family member'; show('add'); }
      else location.replace('/family.html');
    } catch (ex) { err(ex.message); }
    $('authBtn').disabled = false;
  });
  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault(); err('');
    try {
      const r = await api('/api/family/seniors', 'POST', { name: $('sName').value, phone: $('sPhone').value.trim() || undefined, tz: $('sTz').value, mode: $('sMode').value, consent: $('sConsent').checked });
      $('doneTitle').textContent = `${r.profile.name} is added`; $('seniorLink').value = r.link;
      $('waNote').hidden = !r.whatsapp; $('waNote').textContent = r.whatsapp ? `WhatsApp was not linked: ${r.whatsapp}` : '';
      $('seniorCode').value = r.profile.id; $('shareBtn').hidden = !navigator.share; localStorage.setItem('mayaFamilySenior', r.profile.id); show('done');
    } catch (ex) { err(ex.message); }
  });
  $('copyBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('seniorLink').value); $('copyBtn').textContent = 'Copied'; } catch { $('seniorLink').select(); } });
  $('copyCode').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('seniorCode').value); $('copyCode').textContent = 'Copied'; } catch { $('seniorCode').select(); } });
  $('shareBtn').addEventListener('click', () => navigator.share({ title: 'Maya', text: `Open Maya on your phone: ${$('seniorLink').value} (or type the code ${$('seniorCode').value})`, url: $('seniorLink').value }).catch(() => {}));
  if (location.hash === '#signup') setMode('signup');
  $('another').addEventListener('click', () => { $('addForm').reset(); $('sTz').value = mine; show('add'); });
  $('toDash').addEventListener('click', () => location.replace('/family.html'));
  // Already logged in: straight to the dashboard (or to adding the first family member).
  api('/api/family/session').then((s) => (s.username ? api('/api/family/me') : null)).then((me) => { if (!me) return; if (location.hash === '#add') show('add'); else if (me.seniors.length) location.replace('/family.html'); else show('add'); }).catch(() => {});
})();
