// Repeat detector (conversation brain, step 1). Pure rules: no network, no state, no Spark call.
// CODE ONLY BLOCKS AND MEASURES. It never writes, suggests or supplies a sentence: Spark phrases every reply.
// The patterns below stay in this file. They are never sent to Spark and never used as output; Spark is only told,
// in plain principles (see call.js replyNote), to avoid reusing the same KIND of acknowledgement.
//
// Two kinds of repeat are caught:
//  1. A polite-phrase FAMILY (a kind of stock acknowledgement, any wording of it) used in either of her last 2 replies, or twice among her last 5.
//  2. A run of 4 or more words in a row that also appears in any of her last 3 replies.
// repeatRate() is the same test applied to a whole run of replies, so tests and the before/after check share one number.

const FAMILY_WINDOW = 2;   // a family used in this many latest replies may not be used again
const FAMILY_SPREAD = 5;   // ...and a family used FAMILY_SPREAD_MAX times among this many latest replies is blocked too (a crutch spread thin)
const FAMILY_SPREAD_MAX = 2;
const PHRASE_WINDOW = 3;   // replies searched for a shared run of words
const PHRASE_RUN = 4;      // words in a row that count as a repeated phrase

// Each family is a kind of stock acknowledgement. Matching is on the meaning-bearing words, not on one exact sentence.
const FAMILIES = [
  ['hear-you', /\bi (?:can )?(?:hear|understand)\b|\bi get (?:it|that|how)\b/],
  ['sounds-like', /\bthat (?:sounds|must (?:be|feel|have been)|seems)\b|\bit sounds\b/],
  ['sorry', /\b(?:i'?m |i am )?(?:so |really |very )?sorry (?:to hear|about that|that)\b|\bthat'?s (?:so |really )?sad\b/],
  ['thanks-sharing', /\bthank(?:s| you) for (?:sharing|telling|letting)\b/],
  ['here-for-you', /\bi'?m (?:right |always |still )?(?:here|beside|with) (?:with |for |by )?you\b|\bi'?m here\b|\byou'?re not alone\b|\byou are not alone\b/],
  ['its-okay', /\b(?:it'?s|that'?s|it is|that is) (?:okay|ok|alright|all right|fine) to\b|\bit'?s (?:okay|ok|alright|all right)\b/],
  ['understandable', /\b(?:that'?s|that is|it'?s) (?:completely |totally |perfectly |very )?(?:understandable|natural|normal|valid)\b/],
  ['how-lovely', /\bthat'?s (?:so |really |very )?(?:lovely|wonderful|nice|great|beautiful|sweet)\b|\bhow (?:lovely|wonderful|nice|sweet)\b/],
  ['let-me-think', /\blet me think\b/],
];

// What Spark is told when a family is blocked: the KIND, in plain words that describe a move, never a sentence to say or avoid verbatim.
const KIND_DESC = {
  'hear-you': 'telling them you hear or understand them',
  'sounds-like': 'remarking on how their situation sounds or seems',
  'sorry': 'saying you are sorry to hear it',
  'thanks-sharing': 'thanking them for sharing or telling you',
  'here-for-you': 'reassuring them that you are here with them or that they are not alone',
  'its-okay': 'telling them it is okay to feel or do something',
  'understandable': 'calling their reaction understandable or natural',
  'how-lovely': 'praising what they said as lovely, wonderful or nice',
  'let-me-think': 'saying you need to think',
};

const norm = (t) => String(t || '').toLowerCase().replace(/[‘’]/g, "'");
const words = (t) => norm(t).match(/[\p{L}\p{N}']+/gu) || [];

// Ids of the polite-phrase families present in a text.
function familiesOf(text) {
  const t = norm(text);
  return FAMILIES.filter(([, re]) => re.test(t)).map(([id]) => id);
}

// True when the text shares PHRASE_RUN or more words in a row with the other text.
function sharesRun(text, other, run = PHRASE_RUN) {
  const a = words(text), b = words(other);
  if (a.length < run || b.length < run) return false;
  const seen = new Set();
  for (let i = 0; i + run <= b.length; i++) seen.add(b.slice(i, i + run).join(' '));
  for (let i = 0; i + run <= a.length; i++) if (seen.has(a.slice(i, i + run).join(' '))) return true;
  return false;
}

// Families that may not appear in her next reply: those used in her last FAMILY_WINDOW replies, or twice among her last FAMILY_SPREAD. `recent` is oldest first.
function blockedFamilies(recent) {
  const out = new Set();
  for (const r of (recent || []).slice(-FAMILY_WINDOW)) for (const id of familiesOf(r)) out.add(id);
  const tally = {};
  for (const r of (recent || []).slice(-FAMILY_SPREAD)) for (const id of familiesOf(r)) tally[id] = (tally[id] || 0) + 1;
  for (const [id, n] of Object.entries(tally)) if (n >= FAMILY_SPREAD_MAX) out.add(id);
  return [...out];
}

// The same blocked families as plain-word descriptions (see KIND_DESC), for the note Spark gets. Spark picks every word herself.
function blockedKinds(recent) {
  return blockedFamilies(recent).map((id) => KIND_DESC[id]).filter(Boolean);
}

// What is wrong with a candidate reply, given her recent replies (oldest first). { families:[ids], phrase:bool, repeat:bool }.
function violations(text, recent) {
  const blocked = new Set(blockedFamilies(recent));
  const families = familiesOf(text).filter((id) => blocked.has(id));
  const phrase = (recent || []).slice(-PHRASE_WINDOW).some((r) => sharesRun(text, r));
  return { families, phrase, repeat: families.length > 0 || phrase };
}

// Share (0 to 1) of replies, after the first, that repeat an earlier one by the rules above. 0 = never repeats.
function repeatRate(replies) {
  const list = (replies || []).map((r) => String(r || '')).filter((r) => r.trim());
  if (list.length < 2) return 0;
  let bad = 0;
  for (let i = 1; i < list.length; i++) if (violations(list[i], list.slice(0, i)).repeat) bad += 1;
  return bad / (list.length - 1);
}

module.exports = { FAMILY_WINDOW, FAMILY_SPREAD, FAMILY_SPREAD_MAX, PHRASE_WINDOW, PHRASE_RUN, familiesOf, sharesRun, blockedFamilies, blockedKinds, violations, repeatRate };
