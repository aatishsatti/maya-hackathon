// Web search is stripped: Maya does NOT call any external web search API (no third-party search service, no generated answers,
// no background web lookup). Medicine matters are still refused before anything else via medical.js;
// for daily-life news, links, or public fact questions, Spark answers from its own general knowledge only
// with honest "I haven't checked online" wording, never inventing a web fact or claiming web verification.
const MEDICAL = require('./medical');

const HOURLY_CAP = 0;
const cache = new Map();
const spent = [];
function purgeMedical() { cache.clear(); return 0; }

const DISTRESS_RE = /\b(?:kill\s+myself|end\s+my\s+life|want\s+to\s+die|suicid\w*|chest\s+pain|can'?t\s+breathe|trouble\s+breathing|stroke|heart\s+attack|fell\s+down| bleeding\s+badly)\b/i;
const CODE_PASTE_RE = /(?:```|\b(?:function|const|let|var|import|export|SELECT\s+.+\s+FROM|CREATE\s+TABLE|class\s+\w+\s*\{)\b|[{}();]{4,})/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+|\b[a-z0-9][a-z0-9-]{1,62}\.(?:com|org|gov|edu|net|co\.uk|uk|io|ai|app|info|biz|me|us|ca|au|de|fr|in)(?:\/[^\s<>"')]*)?/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi;
const NEWS_RE = /\b(?:news|headlines?|latest|current\s+events?|what(?:'s|\s+is)\s+happening|what\s+happened\s+(?:in|with|today|recently)|election|score|weather\s+forecast|stock\s+market|who\s+won)\b/i;
const CLAIM_RE = /\b(?:is\s+it\s+true|did\s+they\s+really|i\s+heard\s+that|someone\s+told\s+me\s+that|read\s+that|rumou?r|fact\s+check|look\s+up|search\s+for|check\s+online|google)\b/i;
const FOLLOWUP_RE = /^\s*(?:is\s+that\s+true|are\s+you\s+sure|really|how\s+do\s+you\s+know|where\s+did\s+you\s+hear\s+that|can\s+you\s+check(?:\s+that)?|check\s+that|look\s+that\s+up)\s*[?.!]*\s*$/i;

function safeQuery(raw) {
  let s = String(raw || '').replace(/https?:\/\/[^\s]+/gi, (u) => {
    try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return ''; }
  });
  s = s.replace(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi, '$1');
  s = s.replace(/\b\d[\d\s().-]{4,}\d\b/g, ' ');
  s = s.replace(/\b\d{4,}\b/g, ' ');
  s = s.replace(/[^\p{L}\p{N}\s.'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 140);
}

function realHosts(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(EMAIL_RE)) {
    const h = String(m[1] || '').toLowerCase().replace(/^www\./, '').replace(/[.,;!?)]+$/, '');
    if (h && !out.includes(h)) out.push(h);
  }
  for (const m of s.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;!?)]+$/, '');
    let h = raw;
    try { h = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname; } catch { h = raw.split('/')[0]; }
    h = String(h || '').toLowerCase().replace(/^www\./, '');
    if (h && h.includes('.') && !out.includes(h)) out.push(h);
  }
  return out;
}

function researchNeed(words, ctx = {}) {
  const raw = String(words || '').trim();
  if (!raw) return { needed: false, reason: 'empty' };
  const med = MEDICAL.classify(raw, { prior: ctx.prior || null });
  if (med) return { needed: false, reason: 'medical', refuse: med };
  if (DISTRESS_RE.test(raw)) return { needed: false, reason: 'distress' };
  if (CODE_PASTE_RE.test(raw)) return { needed: false, reason: 'code' };
  const effective = FOLLOWUP_RE.test(raw) && ctx.prevUser ? `${ctx.prevUser} ${raw}` : raw;
  const medEff = MEDICAL.classify(effective, { prior: ctx.prior || null });
  if (medEff) return { needed: false, reason: 'medical', refuse: medEff };
  const hosts = realHosts(effective);
  if (hosts.length) return { needed: true, kind: 'link', query: safeQuery(hosts[0]), label: `the address ${hosts[0]}` };
  if (NEWS_RE.test(effective)) return { needed: true, kind: 'news', query: safeQuery(effective), label: 'what they asked about' };
  if (CLAIM_RE.test(effective)) return { needed: true, kind: 'claim', query: safeQuery(effective), label: 'what they asked to check' };
  return { needed: false, reason: 'ordinary' };
}

function decide(words, opts = {}) {
  const r = researchNeed(words, opts.ctx || {});
  if (r.refuse) return { decision: 'refuse', reason: 'medical', refuse: r.refuse };
  if (!r.needed) return { decision: 'none', reason: r.reason };
  return { decision: 'search', kind: r.kind, query: r.query, label: r.label };
}

function extract(words, opts = {}) {
  const raw = String(words || '').trim();
  if (!raw || MEDICAL.classify(raw)) return [];
  const hosts = realHosts(raw);
  const out = hosts.map((h) => ({ kind: 'link', query: safeQuery(h), label: `the address ${h}` }));
  if (opts.company && typeof opts.company === 'string') {
    const q = safeQuery(opts.company);
    if (q) out.push({ kind: 'company', query: q, label: `the company "${q}"` });
  }
  if (!out.length) {
    const r = researchNeed(raw, opts.ctx || {});
    if (r.needed) out.push({ kind: r.kind, query: r.query, label: r.label });
  }
  return out.slice(0, 2);
}

const tierOf = () => 3;
const questionKey = (kind, query, scope = '') => `${String(scope || '')}:${String(kind || '')}:${safeQuery(query).toLowerCase()}`;
const judge = () => ({ candidates: [], accepted: [], status: 'unverified' });
async function search() { return { results: [], failed: 'disabled' }; }

async function lookup(words, opts = {}) {
  const d = decide(words, opts);
  if (d.decision === 'refuse') return { decision: 'refuse', refuse: d.refuse, topics: [] };
  const topics = extract(words, opts);
  if (!topics.length) return null;
  return {
    decision: 'search',
    topics: topics.map((tp) => ({ ...tp, failed: 'disabled', status: 'unverified', results: [] })),
  };
}

function note(res) {
  if (!res || !Array.isArray(res.topics) || !res.topics.length) return '';
  return "ONLINE CHECK NOT AVAILABLE (a fact from the app): you cannot search the web or check online. Answer from your own general everyday knowledge only if helpful, and say honestly in your own words that you haven't checked online (and cannot verify current news, links, companies or prizes online). Never invent a web fact or current news detail, and never claim web verification.";
}

const sources = () => [];
const boundSources = () => [];

module.exports = { sources, boundSources, judge, questionKey, tierOf, extract, researchNeed, decide, realHosts, search, lookup, note, safeQuery, cache, spent, HOURLY_CAP, purgeMedical };
