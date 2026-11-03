// Background checks: official-site allow-list check only (official.js); general web search is stripped.
// Phone numbers: never searched and never passed on; nothing here stores the person's words, a number or a link.
const official = () => require('./official');
const care = () => require('./care');
const LIMIT_MS = 45000;
const inflight = new Set();   // for tests: await idle()
const idle = async () => { while (inflight.size) await Promise.allSettled([...inflight]); };

// The fact Spark gets for THIS reply: what she should say now (principles; every word hers).
const startedNote = () => 'BACKGROUND CHECK STARTED (a fact from the app): the app is now looking into this in the background (the company in what they showed or said); it takes a little while and you will be able to tell them when it has finished. In your own words, say briefly and naturally that you are looking into it and will tell them when you have looked. Do NOT give or guess any result now, and do not say it is safe or a scam because of this lookup. Everything else in the scam check still applies: do not pay or share anything yet.';

async function work(words, { official: officialFn, skipOfficial = false } = {}) {
  const parts = [];
  if (!skipOfficial && typeof officialFn === 'function') {
    const o = await Promise.resolve().then(() => officialFn(words, { explicit: true })).catch(() => ({ named: true, found: false, name: null, reason: 'lookup-failed' }));
    if (o && (o.found || o.reason === 'lookup-failed' || o.reason === 'not-in-allow-list')) parts.push(official().note(o));
  }
  return parts.length ? parts.join(' ') : 'BACKGROUND CHECK (a fact from the app): nothing in what they showed could be looked up, so NOTHING was verified: say plainly that you cannot verify it.';
}

// start(profileId, words, deps) -> the stored check (pending); returns at once. words are used here and never stored.
function start(profileId, words, deps) {
  const c = care().checkStart(profileId);
  if (!c) return null;
  const p = (async () => {
    let note;
    try { note = await Promise.race([work(words, deps), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), LIMIT_MS).unref())]); }
    catch (e) { console.error('background check failed:', e.message); note = 'BACKGROUND CHECK (a fact from the app): the lookup failed, so NOTHING was verified. Say plainly that you could not verify it; do not guess and never invent a result.'; }
    care().checkDone(profileId, c.id, note);
  })().finally(() => inflight.delete(p));
  inflight.add(p);
  return c;
}

module.exports = { start, startedNote, idle, work };
