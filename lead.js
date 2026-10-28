// Instant first voice and routine prediction: the pure rules (no network, no state), so they can be tested alone.
//
// LEAD-IN: when the person has finished, Maya can say one very short true line at once (a clip of her own voice, rendered once
// by ElevenLabs and kept in memory) while Spark writes the real reply. It is only an acknowledgement or "I am thinking": it never
// claims to know, promise or answer anything, never states a fact about the person, and it is never used for anything but a
// plain, routine remark. No clip is ever faked: if the clips are not ready or the topic is not routine, nothing extra is said.
// PREDICTION: only for routine topics. A guess is used only when what was really heard matches it exactly (see prethinkClass for
// the pre-call guess); otherwise it is thrown away and the full Spark reply is spoken.
const { selfHarmText } = require('./emotion');

const LEAD = {
  // Long enough to cover a good part of the second or two Spark needs, so there is little silence before the real reply.
  statement: ["Mm-hm, I'm listening.", 'I see, thanks for telling me.', 'Okay, I hear you.', "Right, I'm following.", "Mm-hm, I'm listening. Just a moment."],
  question: ['Hmm, let me think about that.', 'Let me think about that for a moment.', 'Let me think about that. One moment.'],
};
const ALL = [...LEAD.statement, ...LEAD.question];

// Anything about pain, health, safety, distress, family alerts, reminders, money or scams is NOT routine: Maya just answers it
// properly (no lead-in, no early guess). A miss here only costs a missed speed-up, never a wrong reply, because a guess is checked
// against the final words and a lead-in says nothing of substance.
const SENSITIVE = new RegExp(String.raw`\b(pain\w*|hurt\w*|ache\w*|aching|sore|fell|fall|fallen|falling|dizz\w*|faint\w*|chest|breath\w*|bleed\w*|blood|doctor\w*|nurse|hospital|ambulance|emergency|medic\w*|pill\w*|tablet\w*|dose|dying|die|died|dead|death|funeral|passed away|grief|griev\w*|lonely|alone|sad|cry\w*|tears|scared|afraid|frighten\w*|terrified|worried|worry|worrying|anxious|anxiety|panic\w*|angry|furious|hate|depress\w*|help|alert\w*|scam\w*|stole\w*|steal\w*|money|bank|password|remind\w*|timer|alarm|stroke|heart attack|can'?t (move|walk|stand|breathe|get up)|(tell|call|text|message|let) (my|the|them|someone)\b)`, 'i');

const tokens = (t) => String(t || '').toLowerCase().match(/[\p{L}\p{N}'’]+/gu) || [];
function isRoutine(text) {
  const n = tokens(text).length;
  return n >= 2 && n <= 45 && !selfHarmText(text) && !SENSITIVE.test(String(text));
}
const QUESTION_WORD = /^(?:(?:hello|hi|hey|good (?:morning|afternoon|evening)),?\s*(?:maya,?\s*)?)?(?:what|how|why|who|where|when|which|do|does|did|can|could|would|will|should|is|are|have|has)\b/i;
const isQuestionText = (t) => /\?\s*$/.test(String(t).trim()) || QUESTION_WORD.test(String(t).trim());

// A line for this turn: from the question or statement pool, never one of the last two used. null = say nothing extra.
// fit = { budgetMs, durOf(line) }: when given, only lines that finish within the budget are used (the longest few of them, so the
// silence before her real reply is as short as it can be without ever holding that reply back); if none fits, the shortest is used.
function chooseLead(text, recent = [], rnd = Math.random, fit = null) {
  let pool = (isQuestionText(text) ? LEAD.question : LEAD.statement).filter((l) => !recent.includes(l));
  if (!pool.length) return null;
  if (fit && typeof fit.durOf === 'function') {
    const known = pool.filter((l) => Number.isFinite(fit.durOf(l)));
    if (known.length) {
      const ok = known.filter((l) => fit.durOf(l) <= fit.budgetMs);
      if (!ok.length) return known.reduce((a, b) => (fit.durOf(b) < fit.durOf(a) ? b : a));
      const longest = Math.max(...ok.map(fit.durOf));
      pool = ok.filter((l) => fit.durOf(l) >= longest - 400);
    }
  }
  return pool[Math.floor(rnd() * pool.length)];
}

// If Spark opens its reply with the same acknowledgement that was just spoken, it is taken off (so it is never said twice).
const LEAD_OPEN = /^\s*(?:(?:mm-?hm+|mhm+|i see|okay|ok|right)\s*[,.!;:]*\s*(?:i'?m listening|i'?m following|i hear you|thank(?:s| you) for telling me(?: that)?)?|(?:hmm,?\s+)?let me think(?:\s+about that)?(?:\s+for a moment)?)\s*[,.!;:]*\s*(?:(?:just a|one) moment\s*[,.!;:]*\s*)?/i;
function withoutLead(text) {
  const m = LEAD_OPEN.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : text;
}
// Does a reply still begin with a lead-in line (used by tests and the live checks)?
const startsWithLead = (text) => LEAD_OPEN.test(String(text || ''));

// Pre-call guesses: Spark writes a reply BEFORE the person has spoken, for the one routine thing a greeting most often gets back.
// It is spoken only for the first turn, from the first voice, when the final words match the class below word for word
// (a bare "I'm fine, thank you" or "Hello Maya"), with no question, no extra clause and nothing sensitive. Anything else drops it.
const PRETHINK = {
  fine: {
    sample: "I'm doing fine, thank you.",
    re: /^(?:(?:i'?m|i am|doing|feeling|pretty|very|quite|just)\s+){0,3}(?:fine|good|well|okay|ok|alright|all right|great|not bad|so so|can'?t complain)(?:,?\s*(?:thank you|thanks))?[.!]?$/i,
  },
  hello: {
    sample: 'Hello Maya.',
    re: /^(?:hello|hi|hey|good (?:morning|afternoon|evening))(?:,?\s*maya)?[.!]?$/i,
  },
};
function prethinkClass(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || !isRoutine(t) && tokens(t).length > 1) return null;
  for (const [k, c] of Object.entries(PRETHINK)) if (c.re.test(t)) return k;
  return null;
}

module.exports = { LEAD, ALL, isRoutine, isQuestionText, chooseLead, withoutLead, startsWithLead, PRETHINK, prethinkClass };
