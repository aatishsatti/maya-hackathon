// Emotion layer. Spark estimates the person's feeling privately in the SAME call that writes the
// reply (a first-line tag), from the transcript and recent talk only. Code, not Spark, decides what
// that changes. mapEmotionToDelivery is deterministic: it validates and clamps whatever Spark
// said, falls back to neutral defaults on anything invalid or missing, and only ever returns the
// small set of knobs below. Spark cannot pass any API parameter through it.
//
// Delivery on eleven_v4_turbo is wording, punctuation, sentence length and audio tags only.
// The v4 family ignores speed and style (ElevenLabs v4 docs), so nothing here touches voice
// settings: stability, similarity, speaker boost and speed stay identical on every request,
// which keeps one consistent voice across all emotions.
const EMOTIONS = ['neutral', 'happy', 'excited', 'sad', 'lonely', 'grief', 'anxious', 'frustrated', 'angry', 'crisis', 'unclear'];
const INTENTS = ['share', 'ask', 'request', 'chat', 'ack', 'farewell', 'story', 'recall', 'check', 'unclear'];
const HEARTFELT = new Set(['sad', 'lonely', 'grief']);   // heavy feelings: soft wording, no exclamations, no cheer straight after
const SETTLING = new Set(['anxious', 'frustrated', 'angry']);

// "emotion=sad intensity=3 intent=share" -> { emotion, intensity, intent } (raw strings, unvalidated)
function parseFeel(text) {
  const out = {};
  for (const m of String(text || '').matchAll(/(\w+)\s*=\s*([\w-]+)/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// prev: the previous turn's delivery (one turn of carry-over only; never a permanent label).
function mapEmotionToDelivery(emotion, intensity, prev) {
  let e = String(emotion || '').toLowerCase();
  if (!EMOTIONS.includes(e) || e === 'unclear') e = 'neutral';
  let n = Number.parseInt(intensity, 10);
  if (!Number.isFinite(n) || e === 'neutral' && !EMOTIONS.includes(String(emotion || '').toLowerCase())) n = 1; // invalid or missing: neutral defaults
  n = clamp(n, 1, 5);

  // whisperPieces is 0 for every emotion: whispers are switched off for now (kept as a field so a
  // later feature can turn them back on in one place). excitedOpening: only the first short phrase is delivered with excitement (code enforces it,
  // whatever Spark wrote); the rest of the reply is normal voice. 
  // openingTone: the person is clearly heavy-hearted (words only, intensity 3+): the reply's first phrase is soft.
  // moments: how many delivery moments (tagged pieces) a whole reply may hold; call.js lifts it to 3 for a story/recall.
  const d = { emotion: e, intensity: n, whisperPieces: 0, excitedOpening: false, openingTone: null, moments: 1, maxSentences: 4, maxExclaim: 1, escalate: false, noBright: false };
  if (e === 'crisis') d.escalate = true;                     // handled by the safety path, never a sadness reply
  if (HEARTFELT.has(e)) {
    d.noBright = true; d.maxSentences = 3;
    d.maxExclaim = 0;           // sad stays soft through wording: gentle, short, no exclamations
    d.whisperPieces = 0;        // whispers are removed for now
    if (n >= 3) d.openingTone = 'soft';
  } else if (SETTLING.has(e)) {
    d.noBright = true;
    d.maxExclaim = 0;
    d.maxSentences = 2;
    if (n >= 3) d.openingTone = 'soft';
  } else if (e === 'happy' || e === 'excited') {
    // Cheerful trial: the opening phrase of a happy reply is the gentle [happy] tone (not [excited]) from intensity 2; real excitement
    // (intensity 4+, emotion excited) keeps the excited opening. Gain for [happy] stays 0.62 (call.js TONES).
    if (n >= 2) d.openingTone = 'bright';
    d.excitedOpening = e === 'excited' && n >= 4;
  } else if (e === 'neutral') {
    d.maxExclaim = 1;
  }
  // Context override: right after heavy news, a bare "Okay" must not get a bright reply or a whisper.
  if (prev && (HEARTFELT.has(prev.emotion) || SETTLING.has(prev.emotion)) && prev.intensity >= 3) {
    if (e === 'neutral' || (d.excitedOpening && n <= 2) || (d.openingTone === 'bright' && n <= 3)) {
      d.maxExclaim = 0;
      d.whisperPieces = 0;
      d.excitedOpening = false;
      if (d.openingTone === 'bright') d.openingTone = null;
      d.noBright = true;
    }
  }
  return d;
}

// Deterministic safety check on the person's own words, independent of what Spark says. Clear self-directed ways of dying count too ("going to hang myself"):
// without them the alert depended on Spark's crisis tag alone.
const SELF_HARM = /\b(kill myself|killing myself|end my life|end it all|want to die|wanna die|wish i (was|were) dead|suicid\w*|take my own life|taking my own life|hurt myself|harm myself|(do not|don['’]?t|dont|no longer|not) (want|wish) to (live|be here|be alive|exist|wake up)|wish i (wasn['’]?t|was not|weren['’]?t|were not) (here|alive|born)|no reason to live|better off without me|(hang|hanging|shoot|shooting|drown|drowning|poison|poisoning|stab|stabbing|suffocate|suffocating|smother|starve|starving|overdose|overdosing)( on)? (myself|my self)|(going to|want to|wanna|plan to|planning to|about to|will|gonna|i['’]ll|i['’]m going to) overdose|(slit|slash|cut|cutting|slitting) (my )?(wrists?|throat|veins)|take (all )?my (pills|tablets) (to|and) (die|end)|jump(ing)? (off|from|in front of) [^.?!]{0,25}(bridge|building|roof|balcony|train|window|cliff))\b/i;
function selfHarmText(text) { return SELF_HARM.test(String(text || '')); }

module.exports = { mapEmotionToDelivery, parseFeel, selfHarmText, EMOTIONS, INTENTS };
