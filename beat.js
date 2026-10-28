// Conversation beats (conversation brain, step 4). Pure rules: no network, no Spark call, no stored state.
// CODE ONLY DECIDES AND LIMITS. It never writes or supplies a sentence: Spark phrases every word, from the principle in note().
//
// Light chat on one subject runs in beats. Spark says in her private tag whether this turn continues the subject of her last reply
// (topic=same) or starts another (topic=new). From that, code counts the replies she has given on the current subject:
//   beat 1  acknowledge  respond to what they said (a tiny question is still allowed by the existing ask rules)
//   beat 2  connect      tie it to something specific they said; no question
//   beat 3+ close        a short wrap-up, no question, room left for them to lead
// Beats never apply to a heavy or careful moment (sad, lonely, grieving, anxious, angry, pain, any concern, safety, health, scam),
// nor to a turn where the person asks, requests, recalls, wants a story, checks, or says goodbye: answering is the job there.
// A missing or invalid topic counts as "new": the failure mode is more talk, never a cut-off.

const HEAVY = new Set(['sad', 'lonely', 'grief', 'anxious', 'frustrated', 'angry', 'crisis']);
const FREE_INTENTS = new Set(['ask', 'request', 'story', 'recall', 'check', 'farewell']);

// count: replies already given on the current subject (committed after each reply). Returns { type, n } where n is the count to
// commit once this reply is spoken. type: 'acknowledge' | 'connect' | 'close' | 'free'.
function plan({ count = 0, topic, emotion, intent, concern, pain, special } = {}) {
  const same = String(topic || '').toLowerCase() === 'same';
  const base = same ? Math.max(0, Number(count) || 0) : 0;
  const c = String(concern || 'none').toLowerCase();
  if (special || pain || (c !== 'none' && c !== '') || HEAVY.has(String(emotion || '').toLowerCase())) return { type: 'free', n: 0 };
  if (FREE_INTENTS.has(String(intent || '').toLowerCase())) return { type: 'free', n: base };
  const n = base + 1;
  return { type: n === 1 ? 'acknowledge' : n === 2 ? 'connect' : 'close', n };
}

// Hard limits code enforces on the reply, whatever Spark wrote.
function limits(type) {
  if (type === 'connect') return { noQuestion: true, maxSentences: 2 };
  if (type === 'close') return { noQuestion: true, maxSentences: 1 };
  return { noQuestion: false, maxSentences: Infinity };
}

// The principle Spark is given before she writes, from the count of replies already given. Principles only, no sentence to copy.
function note(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  if (n === 1) return 'You have already answered once on this subject. If they are still on it, connect to something specific they said, as a statement, with no question. If they have moved to a new subject, treat this as the first reply on it.';
  return 'You have already given two replies on this subject. If they are still on it, do not stretch it: close gently with one short statement, no question, and leave them room to lead. If they have moved to a new subject, treat this as the first reply on it.';
}

module.exports = { HEAVY, FREE_INTENTS, plan, limits, note };
