// Background checks: when Maya needs to look something up (a web address, an e-mail, a company in a screenshot) she says she is looking into it and the reply goes out at
// once; the official check (official.js) and the web check (web.js, Tavily) run here, detached, and the finished FACTS are stored on the profile (care.checkStart /
// checkDone) and handed to her on the person's next turn, once (care.checkFacts). The reply is never blocked; a lookup that fails or never finishes is "cannot verify",
// never a guess. Delivered in the app chat or on the next call; a WhatsApp voice note (app closed) and a mobile full-screen call are not built yet, and a locked
// call is never faked in the web app: the result simply waits on the profile until they next talk.
// Phone numbers: never searched and never passed on: web.js strips digit runs from every query, and nothing here stores the person's words, a number or a link.
const official = () => require('./official');
const web = () => require('./web');
const care = () => require('./care');
const LIMIT_MS = 45000;
const inflight = new Set();   // for tests: await idle()
const idle = async () => { while (inflight.size) await Promise.allSettled([...inflight]); };

// The fact Spark gets for THIS reply: what she should say now (principles; every word hers).
const startedNote = () => 'BACKGROUND CHECK STARTED (a fact from the app): the app is now looking into this in the background (the web address, e-mail or company in what they showed or said); it takes a little while and you will be able to tell them when it has finished. In your own words, say briefly and naturally that you are looking into it and will tell them when you have looked. Do NOT give or guess any result now, and do not say it is safe or a scam because of this lookup. Everything else in the scam check still applies: do not pay or share anything yet.';

async function work(words, { official: officialFn, web: webFn, skipOfficial = false }) {
  const parts = [];
  if (!skipOfficial) {
    const o = await Promise.resolve().then(() => officialFn(words, { explicit: true })).catch(() => ({ named: true, found: false, name: null, reason: 'lookup-failed' }));
    if (o && (o.found || o.reason === 'lookup-failed' || o.reason === 'not-in-allow-list')) parts.push(official().note(o));
  }
  const w = await Promise.resolve().then(() => webFn(words, { scam: true })).catch(() => ({ topics: [{ kind: 'link', label: 'a web address or e-mail they showed', failed: 'error', results: [] }] }));
  const wn = web().note(w);
  if (wn) parts.push(wn);
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
