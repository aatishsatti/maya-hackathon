// Meta usage ledger: COUNTS ONLY. It answers "which Meta model did how much work, for what, how fast", for the evaluation page and the write-up.
// It never sees or stores a message, a transcript, audio, a key, a name or any personal data: record() copies a fixed set of numbers and a
// purpose label out of whatever it is given and drops everything else, so even a careless call site cannot leak anything into it.
// OFF unless MAYA_META_LEDGER=1 (read at call time): with it off every function here is a no-op and costs nothing.
const PURPOSES = new Set([
  'live-reply',            // Spark: what Maya says
  'memory-filing',         // Spark: filing a finished call into memory
  'vision-describe',       // Spark vision: describing a photo for her
  'scam-photo',            // Spark vision: is this photo a scam
  'scam-text',             // Spark: is what they typed or said a scam
  'transcribe-call',       // Transcribe: one finished turn of a live call (realtime)
  'transcribe-voice-note', // Transcribe: one recorded voice note
]);
// Why a call failed, as a CATEGORY only (never the message, which could contain anything): lets the usage table tell a real Meta failure from
// a stream that Maya's own code cancelled on purpose (for example when it rewrote a reply).
const ERRORS = new Set(['aborted', 'timeout', 'empty', 'http-429', 'http-5xx', 'http-4xx', 'other']);
function classify(e) {
  if (!e) return 'other';
  const msg = String((e && e.message) || '');
  if (e.name === 'AbortError' || /\babort/i.test(msg)) return 'aborted';
  if (e.name === 'TimeoutError' || /time(d)? ?out/i.test(msg)) return 'timeout';
  if (e.empty) return 'empty';
  const m = /HTTP (\d{3})/.exec(msg);
  if (m) return m[1] === '429' ? 'http-429' : m[1][0] === '5' ? 'http-5xx' : 'http-4xx';
  return 'other';
}
const MAX_ROWS = 5000;     // a long-running server never grows without bound: the oldest rows go first
const rows = [];

const enabled = () => process.env.MAYA_META_LEDGER === '1';
const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

// e: { purpose, model, ok, error (a category from ERRORS), ms, firstMs, usage:{prompt_tokens|input_tokens, completion_tokens|output_tokens}, audioMs }. Anything else is ignored.
function record(e) {
  if (!enabled() || !e || typeof e !== 'object') return false;
  const u = e.usage && typeof e.usage === 'object' ? e.usage : {};
  rows.push({
    purpose: PURPOSES.has(e.purpose) ? e.purpose : 'other',
    model: typeof e.model === 'string' ? e.model.replace(/[^\w.\-]/g, '').slice(0, 40) : '',
    ok: e.ok !== false,
    error: e.ok === false ? (ERRORS.has(e.error) ? e.error : 'other') : null,
    ms: num(e.ms), firstMs: num(e.firstMs),
    tokensIn: num(u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens),
    tokensOut: num(u.completion_tokens !== undefined ? u.completion_tokens : u.output_tokens),
    audioMs: num(e.audioMs),
  });
  if (rows.length > MAX_ROWS) rows.shift();
  return true;
}

const NOOP = Object.freeze({ first() {}, done() {} });
// For a call that has a start and an end: const m = meta.begin('live-reply', model); ...; m.first() on the first token; m.done(ok, { usage, audioMs }).
function begin(purpose, model) {
  if (!enabled()) return NOOP;
  const t0 = Date.now();
  let first = null;
  return {
    first() { if (first === null) first = Date.now() - t0; },
    done(ok, extra = {}) { record({ purpose, model, ok, error: ok ? null : classify(extra.err), ms: Date.now() - t0, firstMs: first, usage: extra.usage, audioMs: extra.audioMs }); },
  };
}

// One line per purpose and model: how many calls, how many failed, how fast, how many tokens, how much audio.
function summary() {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.purpose}|${r.model}`;
    const s = by.get(k) || { purpose: r.purpose, model: r.model, calls: 0, failed: 0, failedBy: {}, msList: [], firstList: [], tokensIn: 0, tokensOut: 0, audioMs: 0 };
    s.calls += 1; if (!r.ok) { s.failed += 1; s.failedBy[r.error || 'other'] = (s.failedBy[r.error || 'other'] || 0) + 1; }
    if (r.ms !== null) s.msList.push(r.ms);
    if (r.firstMs !== null) s.firstList.push(r.firstMs);
    s.tokensIn += r.tokensIn || 0; s.tokensOut += r.tokensOut || 0; s.audioMs += r.audioMs || 0;
    by.set(k, s);
  }
  const avg = (l) => (l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null);
  const med = (l) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return s[s.length >> 1]; };
  return [...by.values()].map((s) => ({ purpose: s.purpose, model: s.model, calls: s.calls, failed: s.failed, failedBy: s.failedBy, avgMs: avg(s.msList), medianMs: med(s.msList), avgFirstMs: avg(s.firstList), tokensIn: s.tokensIn, tokensOut: s.tokensOut, audioMs: s.audioMs }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose));
}
const snapshot = () => rows.map((r) => ({ ...r }));
const reset = () => { rows.length = 0; };

module.exports = { classify, ERRORS, PURPOSES, MAX_ROWS, enabled, record, begin, summary, snapshot, reset };
