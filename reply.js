// Streaming reply plumbing: Spark tokens -> sentence chunks (with an optional leading voice tag)
// -> the voice, so the first sentence is spoken while Spark is still writing the rest.
const { sparkStream } = require('./brain');
const { parseFeel } = require('./emotion');
const { withoutLead } = require('./lead');

// Spark text arrives in pieces. A ReplyStream keeps everything received so far, so a reply
// started early (a guess) can be picked up later: new readers get the past text, then the live rest.
class ReplyStream {
  constructor() { this.text = ''; this.done = false; this.error = null; this.waiters = []; }
  push(d) { this.text += d; this.wake(); }
  finish() { this.done = true; this.wake(); }
  fail(e) { this.error = e; this.done = true; this.wake(); }
  wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  async *chunks() {
    let i = 0;
    for (;;) {
      if (i < this.text.length) { const s = this.text.slice(i); i = this.text.length; yield s; continue; }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise((r) => this.waiters.push(r));
    }
  }
}

function startReply(history, roster, signal) {
  const rs = new ReplyStream();
  sparkStream(history, roster, signal, (d) => rs.push(d)).then(() => rs.finish(), (e) => rs.fail(e));
  return rs;
}

// A finished reply made of fixed text (the greeting).
function fixedReply(text) { const rs = new ReplyStream(); rs.push(text); rs.finish(); return rs; }

// Maya's own markup, all optional and all at the start except whispers:
//   [[feel: emotion=sad intensity=3 intent=share]]  Spark's private read of the person (see emotion.js)
//   [[name: B=Ravi]]                                a name the person just told Maya
// Whispers are switched off for now (live ear test): [[whisper: ...]] is spoken as plain words.
// For happy/excited deliveries the code itself makes the first short phrase [excited]. Everything
// else is plain speech. Punctuation limits (exclamations, ellipses), sentence count and one question per reply
// are enforced here from the mapped delivery, whatever Spark wrote.
const NAME_TAG = /^\s*\[\[name:\s*([A-Za-z0-9])\s*=\s*([^\]]{1,40}?)\s*\]\]\s*/i;
const FEEL_TAG = /^\s*\[\[feel:\s*([^\]]{1,120}?)\s*\]\]\s*/i;
const MAX_EXCITED_WORDS = 8;   // the opening phrase only
// Delivery moments (global, sparing): Spark may put [[soft]], [[warm]] or [[bright]] before ONE short sentence at a
// natural moment; code grants it only within the reply's budget (delivery.moments) and never on pieces close together.
// Each is one whole piece (a sentence), never per-sentence-by-default. Tags that map to audio are in call.js.
const TONE_MARK = /\[\[\s*(soft|warm|bright)\s*\]\]/gi;
const MOMENT_GAP = 4;  // at least this many pieces between two moments
const MIN_CHUNK = 25; // shorter pieces are joined to the next sentence so the voice does not stutter

function plain(text) {
  return text.replace(/\[[^\]]*\]/g, ' ').replace(/\[[^\]]*$/, ' ').replace(/\s+/g, ' ').trim();
}

class ChunkSplitter {
  // onFeel(rawFeelObjectOrNull) must return the mapped delivery; onPiece(text, kind) gets speech (kind: 'excited' or null).
  constructor({ onName, onFeel, onPiece, stripInterjection = false, stripGreeting = false, stripLead = false }) {
    this.buf = '';
    this.headDone = false;
    this.delivery = null;
    this.halted = false;     // set when the mapped delivery says escalate: nothing more is emitted
    this.pieceCount = 0;
    this.excitedDone = false;
    this.moments = 0;
    this.lastMomentAt = -Infinity;
    this.sentences = 0;
    this.exclaims = 0;
    this.asked = false;
    this.onName = onName;
    this.onFeel = onFeel;
    this.onPiece = onPiece;
    this.stripLead = stripLead;                 // a short acknowledgement was just spoken: a reply may not open with it again
    this.stripGreeting = stripGreeting;         // the call is already under way: a reply may not open with a greeting
    this.stripInterjection = stripInterjection; // the previous reply opened with an interjection: this one may not
  }
  feed(d) { this.buf += d; this.step(false); }
  end() { this.step(true); }
  step(final) {
    if (this.halted) return;
    if (!this.headDone) {
      for (;;) {
        this.buf = this.buf.trimStart();
        let m = FEEL_TAG.exec(this.buf);
        if (m) { this.delivery = this.onFeel(parseFeel(m[1])); this.buf = this.buf.slice(m[0].length); if (this.delivery.escalate) { this.halted = true; return; } continue; }
        m = NAME_TAG.exec(this.buf);
        if (m) { this.onName(m[1].toUpperCase(), m[2].trim()); this.buf = this.buf.slice(m[0].length); continue; }
        if (!final && this.buf.startsWith('[[') && !this.buf.includes(']]') && this.buf.length < 120) return;
        if (!final && this.buf === '') return;
        break;
      }
      this.headDone = true;
      if (!this.delivery) this.delivery = this.onFeel(null); // Spark gave no usable read: neutral defaults
    }
    // Speed: the very first piece of a reply goes to the voice at its first SENTENCE end (two or more words), not after the whole
    // reply; the rest streams behind it. A comma is a cut point only for an opening interjection ("Oh dear,", "Oh,"): a piece
    // boundary inside a sentence is heard as a pause followed by a rush. A very long sentence with no end in sight (30+ words)
    // is cut at its last comma so the voice is never left waiting.
    if (this.pieceCount === 0 && this.buf.trim()) {
      const sentence = /[.!?\u2026]["')\]]*\s/.exec(this.buf);
      const interj = /^\s*(?:oh dear|oh|well|ah|hmm|um)\s*,\s/i.exec(this.buf);
      let cut = -1;
      if (interj) cut = interj[0].length;
      else if (sentence && this.buf.slice(0, sentence.index).trim().split(/\s+/).length >= 2) cut = sentence.index + sentence[0].length;
      else if (this.buf.trimStart().split(/\s+/).length > 30) { const c = this.buf.lastIndexOf(', '); if (c > 0) cut = c + 2; }
      if (cut > 0) {
        const piece = this.buf.slice(0, cut);
        if ((piece.match(/\[/g) || []).length === (piece.match(/\]/g) || []).length) { this.buf = this.buf.slice(cut); this.emit(piece); }
      }
    }
    const re = /[.!?\u2026]+["')\]]*\s+/g;
    let m;
    while ((m = re.exec(this.buf))) {
      const piece = this.buf.slice(0, m.index + m[0].length);
      const opens = (piece.match(/\[/g) || []).length;
      const closes = (piece.match(/\]/g) || []).length;
      if (piece.trim().length >= MIN_CHUNK && opens === closes) {
        this.buf = this.buf.slice(piece.length);
        this.emit(piece);
        re.lastIndex = 0;
      }
    }
    if (final) { const rest = this.buf; this.buf = ''; this.emit(rest); }
  }
  // Punctuation limits from the mapped delivery.
  shape(text) {
    let t = text.replace(/\u2026|\.{2,}/g, '.');
    t = t.replace(/!/g, () => (this.exclaims < this.delivery.maxExclaim ? (this.exclaims++, '!') : '.'));
    t = t.replace(/\b(so sorry|sorry|oh)\b([,.!]?\s+)\1\b/gi, '$1'); // no "sorry, sorry" stutter
    return t.replace(/\.{2,}/g, '.').replace(/([!?])\./g, '$1').replace(/\s+/g, ' ').trim();
  }
  emit(raw) {
    const d = this.delivery;
    const flat = plain(raw);
    if (!flat) return;
    const ends = (flat.match(/[.!?]+(\s|$)/g) || []).length; // clause pieces ('Oh dear,') are not sentences
    if (this.sentences >= d.maxSentences) return;             // enough said: keep it short
    if (isQuestion(flat)) { if (this.asked || (d.noQuestion && this.sentences > 0)) return; this.asked = true; } // one question at a time, and none right after one she just asked
    this.sentences += ends;

    // Whispers are off. If Spark writes [[whisper: words]] anyway, the words are spoken normally.
    let said = raw.replace(/\[\[whisper:\s*([^\]]*)\]\]/gi, '$1');
    if (this.pieceCount === 0 && this.stripGreeting) said = withoutGreeting(said);
    if (this.pieceCount === 0 && this.stripLead) said = withoutLead(said);
    if (this.pieceCount === 0) said = openingInterjection(said, this.stripInterjection);
    let tone = null;
    said = said.replace(TONE_MARK, (_, k) => { tone = tone || k.toLowerCase(); return ' '; });
    if (tone === 'bright' && d.noBright) tone = null; // never bright over a sad, anxious or grieving moment, or in a safety reply
    const parts = [{ t: said, k: null }];

    let live = [];
    const firstSpoken = parts.findIndex((p) => plain(p.t));
    parts.forEach((p, i) => {
      let t = plain(p.t);
      if (!t) return;
      if (d.excitedOpening && !this.excitedDone && i === firstSpoken && this.pieceCount === 0 && p.k === null) {
        // Happy news: just the opening phrase is excited, with the reply's single exclamation; the rest is normal.
        this.excitedDone = true;
        this.moments += 1; this.lastMomentAt = this.pieceCount;
        const { phrase, rest } = openingPhrase(t);
        this.exclaims = d.maxExclaim;
        live.push({ t: phrase.replace(/[,.;:!?\s]+$/, '') + '!', k: 'excited' });
        t = rest;
      }
      t = this.shape(t);
      let k = p.k;
      if (t && k === null) {
        // Heavy-hearted person: the very first phrase is soft (once). Otherwise Spark's own marker, if the budget allows.
        const want = (this.pieceCount === 0 && d.openingTone && !this.moments) ? d.openingTone : tone;
        if (want && this.moments < d.moments && this.pieceCount + live.length - this.lastMomentAt >= MOMENT_GAP) {
          k = want; this.moments += 1; this.lastMomentAt = this.pieceCount + live.length;
        }
      }
      if (t) live.push({ t, k });
    });
    live.forEach((p) => {
      const text = p.t;
      this.pieceCount += 1;
      this.onPiece(text, p.k, plain(this.buf).slice(0, 200)); // third argument: text that follows, for next_text
    });
  }
}

// A greeting belongs to the start of a call only. If Spark opens a later line with one, it is dropped.
const GREETING_OPEN = /^\s*(?:hello|hi|hey|good (?:morning|afternoon|evening|night))(?: there| again)?\b[,.!]?\s*/i;
function withoutGreeting(text) {
  const m = GREETING_OPEN.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : text;
}

// At most one interjection may open a reply ("Oh, well, oh" becomes "Oh,"), and none at all if the
// previous reply already opened with one. "Yes" is never touched: it may be the answer.
const INTERJ = /^\s*(?:oh dear|oh|well|ah|hmm|um)\b[,.!]?\s*/i;
function openingInterjection(text, strip) {
  const first = INTERJ.exec(text);
  if (!first) return text;
  let rest = text.slice(first[0].length);
  for (let m = INTERJ.exec(rest); m; m = INTERJ.exec(rest)) rest = rest.slice(m[0].length);
  if (!rest.trim()) return text;
  return strip ? rest.trim()[0].toUpperCase() + rest.trim().slice(1) : first[0] + rest;
}

// First short phrase of a reply: the first sentence if it is short, else up to its last comma
// within the first eight words, else its first five words.
function openingPhrase(text) {
  const end = text.search(/[.!?](\s|$)/);
  const first = end >= 0 ? text.slice(0, end + 1) : text;
  if (first.split(/\s+/).length <= MAX_EXCITED_WORDS) return cut(text, first.length);
  const head = first.split(/\s+/).slice(0, MAX_EXCITED_WORDS).join(' ');
  const comma = head.lastIndexOf(',');
  if (comma > 6) return cut(text, comma + 1);
  return cut(text, first.split(/\s+/).slice(0, 5).join(' ').length);
}
function cut(text, n) {
  const rest = text.slice(n).trim();
  return { phrase: text.slice(0, n).trim(), rest: rest ? rest[0].toUpperCase() + rest.slice(1) : '' };
}

// Spoken words of a finished reply: the private tags and any whisper markup removed.
function stripTags(full) {
  let t = full.trimStart();
  for (;;) {
    const m = FEEL_TAG.exec(t) || NAME_TAG.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return plain(t.replace(TONE_MARK, ' ').replace(/\[\[whisper:\s*([^\]]*)\]\]/gi, '$1'));
}

// Spark sometimes leaves the "?" off a question ("Are you safe right now, is someone near you"), so a sentence that opens like
// a question counts as one too.
// "Do not send it" and "Have a rest" are orders, not questions: do/don't only count when not negated, have/has only before a subject ("Have you...").
const QUESTION_OPEN = /(^|[.!]\s+)(are|is|do(?! not\b)(?!n['\u2019]t\b)|does|did|can|could|would|will|what|how|why|who|where|when|(?:have|has)(?=\s+(?:you|i|we|they|he|she|there|it)\b)|shall|should|isn't|aren't)\b/i;
const isQuestion = (t) => /\?/.test(t) || QUESTION_OPEN.test(String(t).trim());

module.exports = { isQuestion, ReplyStream, startReply, fixedReply, ChunkSplitter, plain, stripTags };
