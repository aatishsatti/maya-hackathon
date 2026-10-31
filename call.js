// One live call: browser socket <-> Meta Transcribe (ears) -> Spark (brain) -> ElevenLabs (voice).
// Speaker labels are session-scoped, so the label->name map and the short history die with the call.
// What carries across calls is the picked profile's memory file (memory.js): it is loaded at the start
// and updated from this call's words after it ends. The words themselves are never stored.
//
// Browser -> server: text {type:'start', sampleRate} | {type:'bargein'}; binary = Float32 mono mic.
// Server -> browser: text events below; binary = PCM16 24 kHz mono of Maya's voice.
//   ready, speechStart, partial{text}, speechEnd, idle, thinking, speak{text},
//   audioEnd{timing}, stopped, ttsFailed{text,error}, error{message}
const { openTranscribe, Resampler } = require('./transcribe');
const { streamSpeech, sparkStream } = require('./brain');
const { startReply, fixedReply, ChunkSplitter, stripTags, isQuestion } = require('./reply');
const { mapEmotionToDelivery, selfHarmText, INTENTS } = require('./emotion');
const lead = require('./lead');
const moves = require('./moves');
const beat = require('./beat');
const recall = require('./recall');
const memory = require('./memory');
const care = require('./care');

// Seniors pause mid-thought. Meta has no endpointing settings, so after Meta says a turn is
// complete we wait before answering: short if it ended like a sentence, long if it trailed off.
// A new speechStart inside the wait cancels it and the turns are answered together.
const HOLD_SENTENCE_MS = 0;
const HOLD_COMPLETE_MS = 800;   // reads as a finished thought but Meta gave no final period
const HOLD_TRAILING_MS = 1500;  // trails off ("and", "my", ...) or is a fragment: they are still going
// Meta takes ~2 s to call a turn finished. To hide Spark's time inside that wait, once the
// partial transcript ends like a sentence and holds still, Spark starts on it speculatively.
// The reply is only spoken after Meta confirms the turn ended with the same words and labels.
// Any change in words or labels throws the guess away.
const SPEC_QUIET_MS = 250;
// Meta sometimes leaves a short turn ("Okay.") open through silence. With no endpointing settings
// to change, a turn whose words have stopped changing is completed here from its last partial.
const STALE_SENTENCE_MS = 2500;  // partial ends like a sentence
const STALE_OPEN_MS = 6000;      // partial trails off: seniors pause, so wait longer
// Our own end-of-turn: the person has stopped when there has been no voice-like mic energy AND no new
// partial words for this long. Transcribe's own end (1.3-2.9 s late, or never for "Okay.") and the holds
// above are only the fallback.
// Complete sentence: 0.7 s without voice-like mic energy and 0.4 s without a new partial word (Transcribe's
// partials trail the voice by about half a second, so waiting a full 0.7 s on them would double count).
// Dangling sentence (ends on "and", "my", ...): 2.25 s on both, they are mid-thought.
const OWN_END_COMPLETE_MS = 700;
const OWN_END_WORDS_COMPLETE_MS = 400;
const OWN_END_DANGLING_MS = 2250;
// When we ended the turn ourselves, the first 300 ms of Maya's audio is held back in the browser, so a
// person who was only pausing can speak again before she is audible.
const HOLD_BACK_MS = 300;
// Loud sound over Maya's voice dips her volume at once (browser); the stop is only for real words.
const DUCK_CONFIRM_MS = 1500;
// Piece joins: each reply is several TTS requests. ElevenLabs pads every piece with silence, which would
// be heard as a 200-400 ms gap between pieces, so each piece's tail is held back, its trailing silence
// trimmed (about 60 ms kept) and its leading silence trimmed (about 15 ms kept).
const TAIL_HOLD_BYTES = 350 * 48;  // 24 kHz s16 mono = 48 bytes per ms
const PAD_TAIL_BYTES = 60 * 48;
const PAD_LEAD_BYTES = 15 * 48;
const SILENT = 0.006 * 32768;
const MAX_HISTORY = 12;
// A turn left open (noise, a fan) must not hold back an answer that is already waiting.
const MAX_HOLD_OPEN_MS = 8000;
const DUPLICATE_WINDOW_MS = 8000;
const SENTENCE_END = /[.?!]["')\]]*\s*$/;
// Words a sentence cannot end on: if the last word is one of these the person is mid-thought.
const DANGLING = new Set(['and', 'but', 'so', 'because', 'or', 'if', 'the', 'a', 'an', 'to', 'of', 'with', 'my', 'your', 'his', 'her', 'their', 'that', 'which', 'i', 'we', 'um', 'uh', 'like', 'then', 'when', 'for', 'in', 'on', 'at', 'is', 'are', 'was', 'be', 'about', 'it', 'as', 'than']);
function looksComplete(text) {
  const t = String(text || '').trim();
  if (SENTENCE_END.test(t)) return true;
  const words = t.toLowerCase().match(/[\p{L}\p{N}'\u2019]+/gu) || [];
  return words.length >= 3 && !DANGLING.has(words[words.length - 1]);
}
// Silence flow: after Maya finishes speaking, wait for the person before the next step. The first wait is
// random 20-30 s per call (older people pause, and a fixed number would be predictable); then she reconfirms
// after 10 s, then 8 s later says goodbye and hangs up. Index = how many steps have already been taken.
const SILENCE_FIRST_MIN_MS = 20000, SILENCE_FIRST_MAX_MS = 30000;
const SILENCE_WAIT_MS = [null, 10000, 8000]; // null = this call's own random first wait
// A WhatsApp call (wabridge.js sets ws.noRingback): Maya does NOT call people back (she cannot place WhatsApp calls and the in-app ring-back is off), so her goodbye after
// a silence must never promise one. The prompt says so, a check rejects a line that still does (dynamicLine rewrites it, up to 4 attempts), and if every attempt still
// promises one this fixed line is used instead (approved wording).
const CALL_PROMISE = /\b(?:ring|call|phone|dial)(?:ing)?\s+you\b|\bgive you a (?:call|ring|buzz)\b|\b(?:ring|call)(?:ing)?\s+(?:right\s+)?back\b|\b(?:i(?:'| wi)ll|i will|i'm going to|i am going to|gonna)\s+(?:just\s+)?(?:call|ring|phone)\b|\b(?:talk|speak|chat)(?:ing)?\s+(?:to you |with you )?(?:again |soon )?(?:in|after) (?:a |just a )?(?:moment|bit|minute|second|little|while)\b|\bbe right back\b|\bright back\b/i;
const WHATSAPP_GOODBYE_LINE = "I'm going to hang up for now. You're welcome to call me again whenever you like. Goodbye.";
const WHATSAPP_GOODBYE_FULL = `[[feel: emotion=neutral intensity=1 intent=farewell concern=none pain=0]] ${WHATSAPP_GOODBYE_LINE}`;
// A call Maya PLACED on WhatsApp (wabridge sets ws.outbound): the person has no app button to end it, so the end is Maya's, in code. After an acknowledged reminder she asks the fixed
// question; "no / that's all" ends the call with the fixed goodbye; any real answer or question carries on as an ordinary conversation (never cut off while they talk); silence after the
// question ends it after CLOSE_WAIT_MS; a goodbye said later ends it too. The words are spoken in full, THEN hangUp() closes the socket and the call is terminated (wacall).
const BYE_ASKED = 'Do you have any questions?', BYE_NOMORE = "Okay that's all. Bye-bye.", BYE_TIMEOUT = "Okay, I'll let you go then. Bye-bye.", BYE_SAID = 'Okay, goodbye. Take care.';
const CLOSE_WAIT_MS = 8000;
const PLAIN_FACTS = new Set(['family-written-reminder', 'reminder-acknowledged-placed-call']);   // facts that say nothing about safety, health, a scam or a promise: they never stop a goodbye
const plainWords = (t) => String(t || '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
const NO_MORE = /^(no|nope|nah|no thanks|no thank you|nothing|nothing else|nothing more|that'?s all|that is all|that'?s it|i'?m fine|i am fine|all good|i'?m good|not really|no questions|none|i don'?t have any|no i don'?t|no i'?m fine)( thanks| thank you| dear| maya)?$/;
const BYE_WORDS = /\b(good ?bye|bye( bye)?|good ?night|see you|talk (to you )?later|take care|i have to go|i must go|got to go|gotta go|you can (hang up|go now|go)|hang up now|let you go|we are done|we'?re done)\b/;
const NOT_BYE = /\b(don'?t|do not|never|please don'?t|not yet|wait)\b/;   // "don't hang up", "wait": they are not ending it
const saysBye = (t) => { const w = plainWords(t); return w.split(' ').length <= 10 && BYE_WORDS.test(w) && !NOT_BYE.test(w); };
// After her question, a natural "no" is more than the bare words ("No thanks, got it, all set then."): it BEGINS like a no, is short, and asks or adds nothing (no question word, no "but", "wait", "actually", "one thing").
const NO_START = /^(no|nope|nah|nothing|none|not really|that'?s all|that is all|that'?s it|i'?m (fine|good|all set)|i am (fine|good|all set)|all (good|set))\b/;
const MORE_COMING = /\b(who|what|why|how|when|where|which|can you|could you|would you|will you|do you|did you|are you|is it|is there|tell me|but|wait|actually|one thing|one more|also|however)\b/;
const noMore = (heard) => { const w = plainWords(heard); return NO_MORE.test(w) || (w.split(' ').length <= 12 && NO_START.test(w) && !MORE_COMING.test(w) && !/\?/.test(String(heard))); };
const outboundEnd = (heard, asked) => saysBye(heard) ? 'bye' : asked && noMore(heard) ? 'nomore' : null;
// A goodbye Spark wrote herself ("...You can hang up now.", "Goodbye", "Good night."): on a call she placed it is followed by the hang-up in code (the feel tag describes the PERSON's words, not hers, so it cannot say this).
const FAREWELL_SAID = /\b(good ?bye|bye( bye|-bye)?|hang up|hanging up|let you go|talk (to you )?(soon|later)|speak (to you )?soon)\b|\b(good night|take care)\W*$/i;
const sayingFarewell = (text) => { const t = String(text || '').trim(); return !/\?\W*$/.test(t) && FAREWELL_SAID.test(t); };   // a reply that ends in a question is never a goodbye   // what their words say about ending a call Maya placed
const OUTBOUND_NOTE = ' You placed this phone call yourself. Never tell them to hang up and never say goodbye on your own: the app ends the call when they say goodbye or have nothing more to ask. Just answer what they said.';
const firstSilenceWait = () => SILENCE_FIRST_MIN_MS + Math.floor(Math.random() * (SILENCE_FIRST_MAX_MS - SILENCE_FIRST_MIN_MS + 1));
// A greeting shortens ("Hi Mike") once a known profile has had this many calls; first calls keep the warm greeting.
const SHORT_GREETING_AFTER_CALLS = 1;
// Greeting facts about how recently they were in touch (recentContactNote): within this long, a call is a quick return, not a new day's first hello.
const RECENT_TOUCH_MS = 30 * 60000, GREETED_TODAY_MS = 12 * 3600000;
// In-call timer ("remind me in 30 seconds"): spoken at the time, after a pause if possible, never talking over for long.
const TIMER_MAX_WAIT_MS = 12000;
const TIMER_MAX_SECONDS = 30 * 60;
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
const TIMER_RE = /\bremind me\b(?:\s+(?:to|about|that)\s+([^.?!]+?))?\s*\b(?:in|after)\s+(\d+(?:\.\d+)?|[a-z]+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b(?:\s+(?:to|about|that)\s+([^.?!]+))?/i;
// { seconds, task } from "remind me in 30 seconds [to X]" / "remind me to X in 5 minutes"; null if it is not a timer request.
// The standing fact for a pending timer (see careNotes). Seconds are rounded to what a person would say.
const dueWords = (seconds) => (seconds < 90 ? `in about ${Math.max(seconds, 1)} second${seconds === 1 ? '' : 's'}` : `in about ${Math.round(seconds / 60)} minutes`);
function timerOpenFact(timers, now = Date.now()) {
  const list = [...timers].sort((x, y) => (x.dueAt || now) - (y.dueAt || now))
    .map((t) => `${t.task ? `"${t.task}"` : 'one with no thing named'} (due ${dueWords(Math.max(0, Math.round(((t.dueAt || now) - now) / 1000)))})`).join('; ');
  const many = timers.length > 1;
  return `FACT: ${many ? `${timers.length} reminder timers are` : 'a reminder timer is'} running right now, and ${many ? 'these are the only ones' : 'it is the only one'} set: ${list}. They ONLY work while this call stays open: when the call ends the app drops them and nothing will remind them afterwards. If they ask what reminders you have, or whether anything is set, tell them exactly ${many ? 'these' : 'this one'} in one short sentence and nothing else. If they ask about hanging up, leaving or ending the call, or they say goodbye, tell them plainly in one short sentence that the reminder only works while the call stays open and they will not get it if they hang up. Otherwise do not bring it up. A reminder you have already given aloud is finished: never list it as still to come. Never say they can hang up whenever they like without saying that, never say you will remind them later or after the call, and never say you will call, ring or message them.`;
}
// The facts Maya is told when a person writes on WhatsApp while a reminder from their family is in flight (step 2 of the reminder replies; care.reminderContext decides which).
// Code owns the state (Answered is marked by the acknowledgement, never by Spark); these facts only tell her what happened so her reply is ABOUT it and not a stock line.
const agoWords = (m) => (m < 1 ? 'less than a minute ago' : m === 1 ? '1 minute ago' : `${m} minutes ago`);
const quoteTask = (t) => `"${String(t || '').replace(/["\u201c\u201d]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 80)}"`;
function reminderFacts(ctx) {
  if (!ctx) return null;
  const pick = ctx.answered && ctx.answered.thisMessage ? ['reminder-answered-now', ctx.answered] : ctx.waiting ? ['reminder-waiting', ctx.waiting] : ctx.answered ? ['reminder-answered-earlier', ctx.answered] : ctx.missed ? ['reminder-missed', ctx.missed] : null;
  if (!pick) return null;
  const [label, r] = pick, msg = isFamilyMessage(r.task);
  const what = msg ? `a message from their family: ${quoteTask(r.task)}` : `a reminder from their family: ${quoteTask(stripAddressee(r.task))}`;
  const only = 'Use only the family\'s own words; add no advice, no dose, no reason and no medicine of your own. Answer in the language they used.';
  const never = 'Never say it is done unless they said they did it ("okay" or "I saw it" means they saw it or agreed, not that it is done); never invent that they took, did or finished anything.';
  if (label === 'reminder-answered-now') return { label, text: `FACT: ${agoWords(r.sentMinutesAgo)} you sent them ${what}, and THIS message from them answers it: it is marked answered. Reply to what they actually said in a few words, using only what they said (for example that they will do it, or that they saw it). ${never} If they sound annoyed or push back, take it lightly and kindly: do not argue, do not explain, do not repeat the task, do not remind them again and do not ask about it again. ${only}` };
  if (label === 'reminder-waiting') return { label, text: `FACT: ${agoWords(r.minutesAgo)} you sent them ${what}${r.via === 'voice' ? ' as a voice note' : ''}${r.nudged ? ' and checked once more' : ''}. They have not confirmed it yet${r.others ? ` (${r.others} older ${r.others === 1 ? 'one is' : 'ones are'} also still waiting; this is about the newest)` : ''}. Their message may be a reply to it, so answer that first, then carry on the chat. If they agree, say what they said they will do; if they ask what it was, tell them the family's words exactly; if they say not now or later, keep it light, do not push and do NOT promise to remind them again (you cannot yet); if they sound annoyed, take it lightly, do not argue and do not repeat the task; if they are talking about something else, just talk and do not bring the reminder up. ${never} ${only}` };
  if (label === 'reminder-answered-earlier') return { label, text: `FACT: ${agoWords(r.sentMinutesAgo)} you sent them ${what} and they answered it${r.minutesAgo > r.sentMinutesAgo ? '' : ` ${agoWords(r.minutesAgo)}`}. That is finished: do not mention it, repeat it or ask about it again unless they bring it up. Carry on with whatever they say now, keeping it in mind. ${never} ${only}` };
  return { label, text: `FACT: ${agoWords(r.minutesAgo)} a reminder from their family went to them and they did not answer it. Do not mention it unless they do: no guilt, no pushing, no checking up. If they raise it, say only what the family's words were: ${quoteTask(msg ? r.task : stripAddressee(r.task))}. ${only}` };
}

// Asking again for a reminder that is already set (same length, made a moment ago, the same thing to remember) is the SAME reminder: it is kept once, not set twice (a person who
// says "remind me in 30 seconds to take my medicine" and then "you just remind me in 30 seconds that I have to take it" used to hear it twice, in two wordings). A different thing
// with the same length ("take my tablets" and "call my sister", both in 5 minutes) is a different reminder and is added. Only the words in common decide: stop-words do not count.
const RESTATE_WINDOW_MS = 120000;
const TASK_STOP = new Set(['i', 'me', 'my', 'we', 'you', 'to', 'the', 'a', 'an', 'it', 'that', 'this', 'have', 'has', 'had', 'need', 'must', 'should', 'got', 'gotta', 'am', 'is', 'be', 'do', 'of', 'and', 'just', 'please', 'again', 'now', 'then', 'so', 'for', 'about', 'remind', 'reminder', 'in', 'on', 'at']);
const taskWords = (t) => String(t || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter((w) => w && !TASK_STOP.has(w));
function restatedTimer(timers, tm, now = Date.now()) {
  return (timers || []).find((t) => t.seconds === tm.seconds && now - (t.createdAt || 0) <= RESTATE_WINDOW_MS
    && (!t.task || !tm.task || taskWords(t.task).some((w) => taskWords(tm.task).includes(w)))) || null;
}
function parseTimer(text) {
  const m = TIMER_RE.exec(String(text || ''));
  if (!m) return null;
  const n = /^\d/.test(m[2]) ? Number(m[2]) : NUM_WORDS[m[2].toLowerCase()];
  if (!n) return null;
  const unit = m[3].toLowerCase();
  const seconds = Math.round(n * (unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : 3600));
  return { seconds, task: (m[1] || m[4] || '').trim().replace(/\s*,?\s*please$/i, '').replace(/[.?!,]+$/, '') || null };
}
// The senior acknowledging a reminder. "not now / later / not yet" wins over any thanks.
const ACK_YES = /\b(ok|okay|yes|yeah|yep|sure|alright|all right|got it|thank(s| you)|will do|i will|i'll|i have|i did|done|already|noted|right away)\b/i;
const ACK_NO = /\b(not now|later|not yet|don'?t want|in a (bit|minute|moment|while)|after (a bit|lunch|dinner|breakfast))\b/i;
// A bare agreement ("Yeah okay, let's do that", "sure", "sounds good"): at most seven words, no question, nothing else asked of her.
// Such a turn gets ONE short line (code caps it; Spark is told why). Never in a heavy moment, a story or a recall.
const SIMPLE_YES = /^(?:yeah|yes|yep|yup|ya|ok|okay|sure|alright|all right|fine|good|great|sounds (?:good|great|fine)|let'?s (?:do (?:that|it)|go|try)|let us (?:do (?:that|it)|go)|go ahead|please do|of course|exactly|right|uh huh|mm+ ?hm+|that'?s (?:fine|good|right|okay|great)|why not|i would like that|i'?d like that)\b/i;
function simpleAffirmation(text) {
  const t = String(text || '').replace(/^[^:]{1,40}:\s*/, '').replace(/[\u2018\u2019]/g, "'").trim();
  return t.length > 0 && !/\?/.test(t) && t.split(/\s+/).length <= 7 && SIMPLE_YES.test(t) && !recall.heavyTalk(t) && !selfHarmText(t);
}
const isAck = (text) => ACK_YES.test(text) && !ACK_NO.test(text);
// A reminder the family typed as a message to the senior rather than a task: it speaks to them as Mom/Dad/Grandma, says who
// it is from, is quoted, or speaks as "me". Such text is delivered as a message (no task template, no first name).
const MESSAGE_CUES = /^\s*["'\u201c]|^\s*(mom|mum|mama|mommy|dad|daddy|papa|grandma|grandpa|nana|nani|nanu|dadi|dada)\b|\b(it'?s|this is) (me|your (daughter|son|grandson|granddaughter|wife|husband|sister|brother|family|niece|nephew))\b|\bfrom your (daughter|son|grandson|granddaughter|family|wife|husband|sister|brother)\b|\byour (daughter|son|grandson|granddaughter|wife|husband|sister|brother|niece|nephew)\b(?!['’]s)|\b(call|phone|text|ring|visit|tell|see|write to|come see) me\b|\b(i|we) (love|miss) you\b/i;
// How the family addresses the senior at the start or end of a task ("... mom"); not part of what to do.
const stripAddressee = (task) => String(task || '').replace(/[\s,.!-]+(mom|mum|mama|mommy|dad|daddy|papa|grandma|grandpa|nana|nani|dadi|dada|ma|amma|appa)[\s.!]*$/i, '').trim() || String(task || '');
const isFamilyMessage = (task) => MESSAGE_CUES.test(String(task || ''));
// Safety (two tiers, never a fixed line). Tier A = clear intent to hurt themselves or end their life (selfHarmText on
// their words, or Spark's crisis tag): Maya stays, Spark writes a fresh calm reply every turn from safetyNote(), and
// care.selfHarmAlert tells the family at once (any mode, any hour, topic-only, no emergency number; Maya never calls
// anyone). Tier B = fear of dying / being old with no intent: ordinary empathetic talk, no alert, no crisis wording
// (brain.js prompt). Asking Maya to tell the family is honoured as a gentle note (FAMILY_ASK).
// Answers to "do you want me to let your family know?" (she asked because she was unsure).
const CONCERN_NO = /\b(no|nope|nah|don'?t|do not|no need|not needed|not necessary|leave it|i'?m fine|i am fine|it'?s fine|it is fine|it'?s nothing|it is nothing|nothing serious|just normal|it'?s normal)\b/i;
const CONCERN_YES = /\b(yes|yeah|yep|yup|please|go ahead|do that|tell them|let them know|call them|i think you should|maybe you should|that would be good)\b/i;
const FAMILY_ASK = /\b(tell|let|call|alert|notify|contact|message|text|ring|inform)\b[^.?!]{0,30}\b(my |the )?(family|daughter|son|kids|children|wife|husband|sister|brother|grandson|granddaughter)\b/i;
// A "yes" or a family request only counts when its own clause is not negated: "please do not tell my family" is a no, not a yes.
// Clauses are split at , . ? ! ; and a clause with any negation word never counts as an affirmative.
const NEGATION = /\b(do not|don'?t|dont|not|never|won'?t|wont|no|nope|nah|without|rather not)\b/i;
function affirmed(re, text) {
  return String(text || '').replace(/[\u2018\u2019]/g, "'").split(/[,.?!;]/).some((c) => re.test(c) && !NEGATION.test(c));
}
// A "yes" to Maya's family question must be an answer TO HER. These are not: talk to the caller ("I will give you my number", "what should I tell him"),
// handing over details, a question, or something about what she already did in the past ("you did let them know"). Such a line never counts as a yes,
// however many yes-words it holds. Code decides this; Spark only writes the words.
const NOT_AN_ANSWER = /\b(you (did|told|have|had|already|said|let|went|sent)|i (will|am going to|gave|give|told (him|her|them))|let me|here (is|are)|(he|she|they|the man|the caller) (want|wants|says|said|is asking|asked|is saying)|wants me|what|how|why|who|where|when|should i)\b|\b(my (account|card|bank|social|security|pin|password|number|code|address)|social security|account number|password|pin)\b|\d{3,}|\?/i;
const CONCERN_YES_G = new RegExp(CONCERN_YES.source, 'gi');
const ANSWER_FILLER = new Set(['ok', 'okay', 'sure', 'right', 'thanks', 'thank', 'you', 'maya', 'dear', 'now', 'so', 'then', 'and', 'do', 'it', 'that', 'them', 'please', 'yes', 'yeah', 'yep', 'oh', 'well', 'um', 'uh', 'to', 'i', 'would', 'like', 'me', 'for', 'think', 'should']);
const cleanSpeech = (text) => String(text || '').replace(/[\u2018\u2019]/g, "'");
// A request to tell their family, addressed to Maya (not negated, not talk to someone else).
// The person's OWN plan or a reminder is not a request to Maya: "remind me to call my sister", "I have to call my daughter", "I want to ring my brother" (the app used to read these as
// "let my family know" and sent them a note). Only the text from the start of the clause up to and including the family word is looked at, so "Please tell my family I will call them
// tomorrow" stays a request; "I want YOU to tell my family" stays a request ("you" sits between "I want" and "to"); "I have to ask you to tell my family" is a request to her.
const REMIND_WORD = /\bremind(?:s|er|ers)?\b/i;
const OWN_PLAN_PHRASE = /\b(?:i|we)\b.{0,12}?(?:\b(?:have to|need to|got to|gotta|want to|wanna|ought to|should|must|will|going to|plan to|would like to|forgot to|supposed to|meant to|trying to|about to)\b|'ll\b|'d like to\b)/i;
function ownPlan(clause) {
  const m = FAMILY_ASK.exec(clause);
  if (!m) return false;
  const upTo = clause.slice(0, m.index + m[0].length);
  if (REMIND_WORD.test(upTo)) return true;
  const pm = OWN_PLAN_PHRASE.exec(upTo);
  if (!pm || pm.index >= m.index) return false;
  return !/\byou\b/i.test(upTo.slice(pm.index + pm[0].length, m.index));
}
// A2: what makes ONE clause a request to Maya. Each check looks only where it should:
//  * a negation counts only BEFORE the family word ("do not tell my family"); after it ("Tell my family I am not feeling well", "tell my son not to worry") it does not cancel the request;
//  * "tell me / let me / inform me about my son" asks to be told something, not to tell the family;
//  * a talk-to-the-caller guard ("I will give you my number", "he says to call my son", "you told them", "what should I tell") looks only at the text up to the family word, so
//    "Please tell my family I will call them tomorrow" and "Tell my family what happened" are requests;
//  * a question is not a request, with or without a question mark (the speech engine may drop it): "Did you tell my family?", "Are you going to tell them?"; except the polite request
//    "Can / Could / Would / Will you (please) tell / call / let ... my family", which is one ("Can you call my daughter?").
const TALK_IN_CLAUSE = /\b(you (did|told|have|had|already|said|let|went|sent)|let me|here (is|are)|(he|she|they|the man|the caller) (want|wants|says|said|is asking|asked|is saying)|wants me|what|how|why|who|where|when|should i)\b/i;
const TALK_BEFORE_FAMILY = /\bi (will|am going to|gave|give|told (him|her|them))\b/i;
const SENSITIVE_TALK = /\b(my (account|card|bank|social|security|pin|password|number|code|address)|social security|account number|password|pin)\b|\d{3,}/i;
const OPENER = '(?:(?:and|so|well|but|okay|ok|please|maya)\\b[\\s,]*)*';
const QUESTION_START = new RegExp(`^\\s*${OPENER}(?:did|do|does|have|has|had|are|were|was|is|can|could|would|will|shall|should|may|might)\\b`, 'i');
const POLITE_REQUEST = new RegExp(`^\\s*${OPENER}(?:can|could|would|will)\\s+you\\b(?:\\s+please)?\\s+(?:tell|let|call|alert|notify|contact|message|text|ring|inform)\\s+(?!me\\b|us\\b)`, 'i');
function familyClause(c) {
  const m = FAMILY_ASK.exec(c);
  if (!m || /^(?:tell|inform|let)\s+(?:me|us)\b/i.test(m[0]) || ownPlan(c)) return null;
  const upTo = c.slice(0, m.index + m[0].length);
  const polite = POLITE_REQUEST.test(c);
  if ((!polite && TALK_IN_CLAUSE.test(upTo)) || TALK_BEFORE_FAMILY.test(upTo)) return null; // "Could you let my son know" is a polite request, not "you let them know" (past talk)
  if (QUESTION_START.test(c) && !polite) return null;
  return { negated: NEGATION.test(upTo) };
}
const clausesOf = (text) => cleanSpeech(text).split(/[,.?!;]/);
const familyRequest = (clause) => FAMILY_ASK.test(clause) && !ownPlan(clause);
// An explicit request to Maya to let the family know (not negated, not the person's own plan, not talk to the caller, not a question about the past).
const explicitFamilyRequest = (text) => !SENSITIVE_TALK.test(cleanSpeech(text)) && clausesOf(text).some((c) => { const f = familyClause(c); return f && !f.negated; });
const asksFamily = explicitFamilyRequest;
// A yes to her question: an explicit request, or a short plain answer made of yes-words (a long sentence with one "yeah" in it is not an answer).
const saysYesToFamily = (text) => {
  const t = cleanSpeech(text);
  if (explicitFamilyRequest(t)) return true;
  if (NOT_AN_ANSWER.test(t)) return false;   // yes-words only count as a plain short answer, never inside a question or talk to a caller
  if (!affirmed(CONCERN_YES, t)) return false;
  // Only yes-words and small fillers: "yes", "yes please", "yeah go ahead". Anything else in the line (a statement about the caller, a story) is not an answer.
  const rest = t.toLowerCase().replace(CONCERN_YES_G, ' ').replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter((w) => w && !ANSWER_FILLER.has(w));
  return rest.length <= 1;
};
// They named their family in a clause that refuses it ("do not tell my son"): a no, whether or not a question was open.
const refusedFamily = (text) => clausesOf(text).some((c) => { const m = FAMILY_ASK.exec(c); return Boolean(m) && familyRequest(c) && NEGATION.test(c.slice(0, m.index + m[0].length)); }); // a negation BEFORE the family word is a refusal; "I don't want to call my daughter" is her own plan, not a refusal (a refusal silences later alerts for the call)
// Asks that need what they said earlier in THIS call (the filed memory only exists after the call ends).
const CALL_RECALL = /\b(remember|remembered|told you|i told|already (told|said|mentioned)|forgot|forget|his name|her name|their name|what (was|is) (his|her|their)|what about my|what did i (say|tell)|do you know (him|her|them|my))\b/i;
const MAX_SAID = 60;        // lines of this call kept for those asks
const MAX_SAID_CHARS = 5000; // and the most that is handed to Spark
// Barge-in: only real speech may stop Maya. A system ding, a click or Maya's own voice coming back
// through the mic must not. All of these must hold: (1) Transcribe produced actual words, not sound
// words like "ding"; (2) at least two real words (or one clear stop word like "stop"); (3) they
// stay in the transcript for BARGE_MIN_MS, unless there are four or more; (4) the mic was
// actually loud recently; (5) the words are not just Maya's own words coming back.
const BARGE_MIN_MS = 250;
const BARGE_MIN_PEAK = 0.03;     // mic samples are -1..1
const BARGE_LOUD_WINDOW_MS = 1500;
const STOP_WORDS = new Set(['stop', 'wait', 'pardon', 'sorry', 'hello', 'excuse']);
const NOISE_WORDS = new Set(['ding', 'dong', 'beep', 'ping', 'buzz', 'click', 'tick', 'ring', 'knock', 'bang', 'whoosh', 'bell', 'chime', 'hm', 'hmm', 'mm', 'mmm', 'uh', 'um', 'er', 'ah']);
const ECHO_OVERLAP = 0.7;        // share of heard word pairs that are Maya's own consecutive words
const ECHO_WINDOW_MS = 6000;     // after she finishes, her echo can still be transcribed
const RECOVER_AFTER_MS = 9000;   // stopped but nobody said anything usable
const INTERRUPTED = "Sorry, I got interrupted, can you say that again?";
const tokens = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}'\u2019]+/gu) || [];
const realTokens = (text) => tokens(text).filter((w) => !NOISE_WORDS.has(w));
const RECOVERY = "Sorry, I didn't catch that, can you say that again?";
// Measured: [excited] came out about twice as loud as normal speech on this voice. Scale it down so
// the first phrase does not jump out; this changes level only, not the voice.
const EXCITED_GAIN = 0.6; // measured: [excited] RMS 707 vs plain 397; 0.6 levels it to about plain
// Delivery moments. Tag names are from the ElevenLabs v4 audio-tag docs (non-exhaustive list; [sympathetic], [warmly],
// [happy] are used in their examples). Measured on this voice: none is read aloud (same duration as plain text);
// they raise level (RMS vs plain 397: sympathetic 494, warmly 559, happy 671), so each gets a gain that levels it out.
const TONES = { excited: ['[excited]', EXCITED_GAIN], soft: ['[sympathetic]', 0.85], warm: ['[warmly]', 0.8], bright: ['[happy]', 0.62] };
// Clean boundary around a tone piece: its tail fades out over 30 ms (a tagged piece can end while still loud, which
// sounds like its last word running into the next piece's first), 40 ms of silence follows, and its start fades in
// over 8 ms. The browser already plays pieces strictly one after another (nextPlayTime), so they cannot overlap there.
// Excited is loud and ends abruptly more often, so it alone gets a longer fade (80 ms) and gap (100 ms); other tones keep 30/40.
const FADE_OUT_BYTES = { excited: 80 * 48, other: 30 * 48 }, FADE_IN_BYTES = 8 * 48;
const TONE_GAP = { excited: Buffer.alloc(100 * 48), other: Buffer.alloc(40 * 48) };
function fadeOut(buf, kind) {
  const key = kind === 'excited' ? 'excited' : 'other';
  const n = Math.min(FADE_OUT_BYTES[key], buf.length) & ~1, out = Buffer.from(buf);
  for (let i = 0; i < n; i += 2) { const o = out.length - n + i; out.writeInt16LE(Math.round(out.readInt16LE(o) * (1 - (i + 2) / n)), o); }
  return Buffer.concat([out, TONE_GAP[key]]);
}
function fadeIn(buf) {
  const n = Math.min(FADE_IN_BYTES, buf.length) & ~1, out = Buffer.from(buf);
  for (let i = 0; i < n; i += 2) out.writeInt16LE(Math.round(out.readInt16LE(i) * (i / n)), i);
  return out;
}
function scale(buf, g) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * g))), i);
  return out;
}

// Greetings and check-in lines are written by Spark each time. What is passed along is wording only: the lines
// this profile heard in the last 3 days (care.js keeps them), so none repeats. Names, topics and everything
// else about a person come from that profile's own memory, never from here.
// A greeting is spoken before the person has said a word, so it can never claim to have heard them.
const HEARD_YOU = /\bto hear (you|your voice)\b|\bhear(ing)? (you|your voice)\b/i;
const sameOpening = (a, b) => { const w = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' '); return w(a) === w(b); };
const GREETING_BAD = /\b(how can i help|what can i do for you|can i help you|what'?s your name|your name|who am i (talking|speaking)|see you|good to see|weather|lovely day|nice day|beautiful day|sunny|rainy|raining|how'?s the day)\b/i;
const firstSentences = (text, n) => { let out = '', rest = text.trim(); for (let i = 0; i < n && rest; i++) { const s1 = firstSentence(rest); out += `${out ? ' ' : ''}${s1}`; rest = rest.slice(rest.indexOf(s1) + s1.length).trim(); } return out; };
// Diversity seeds, NOT scripts: a random angle or topic handed to Spark so the same situation does not come out in the same shape
// every time. Spark still writes every word.
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const OPEN_SEEDS = ['open with a hello that fits the time of day', 'open with a plain, quick hello', 'open with a warm little remark that it is nice to be talking', 'open with their name and a hello', 'open with a bright one-word welcome of your own choosing'];
const ASK_SEEDS = ['how they slept', 'how their day has gone so far', 'what they have been up to', 'how they are feeling in themselves', 'whether anything nice is planned for today', 'how they are getting on', 'what is on their mind this morning or afternoon'];
const CHECK_OPEN_SEEDS = ['say you are glad they picked up', 'say you were thinking about them', 'say you are relieved to reach them', 'begin with their name', 'begin with a soft sound of relief'];
const CHECK_ASK_SEEDS = ['how they are feeling now', 'how they are doing at this moment', 'how things are with them', 'whether they are okay right now', 'how it is going for them just now'];
const SAFETY_ANGLES = ['reflect how heavy that sounded', 'say plainly that you are staying and then say little else', 'gently ask what is happening for them right now', 'acknowledge how hard it was to say that', 'ask what has made things feel this way today', 'ask about something small and near them right now, such as where they are sitting', 'say what you notice about their courage in talking to you'];
const SAFETY_SHAPES = ['one short sentence only', 'two short sentences', 'two short sentences, the second one a gentle statement', 'three short sentences, plain and slow'];
// What her safety replies have already asked in this call, by topic only (code reads her own finished reply; nothing is ever put in her mouth).
// Without it she asked the same three things on every self-harm turn: only the word "safe" was ever counted.
const SAFETY_TOPICS = {
  'whether they are alone or someone is with them': /\b(alone|(anyone|anybody|someone|somebody) (is )?(with|near|there|around|beside|home)|with you right now)\b/i,
  'whether they are safe': /\bsafe\b/i,
  'how they are feeling': /\bhow (are|do) you (feeling|feel)\b|\bhow are you (doing|holding)\b|\bwhat are you feeling\b/i,
};
// Stock lines a friend would never say twice. A normal reply may not open with one that already opened a recent reply
// (last 3, kept per profile), and the "who I am" line may be said once per call. Matching is on the reply's first piece.
const IDENTITY_LINE = /\b(i['’]?m|i am|my name is) maya\b/i;
const STOCK_OPENINGS = [IDENTITY_LINE, /\bi['’]?m (right )?here with you\b/i, /\bi['’]?m right (here )?beside you\b/i, /\bi['’]?m right here\b/i];
// Stock counselling lines are never a reply, and "I care about you" is never the reason for an alert. A family claim must match what the app really did.
const COUNSEL_BAN = /\bnot sure what you(?:['\u2019]d| would) like me to do\b|\blet['\u2019]?s (just )?drop it\b|\bforget (about )?it\b|\bi['\u2019]?m (right )?here with you\b|\bwe['\u2019]?ll take this slow(ly)? together\b|\bi['\u2019]?m standing with you\b|\b(because|since) i care (about|for) you\b/i;
const FAMILY_CLAIM = /\b(i|we)(['\u2019]ve| have|['\u2019]ll| will)? (just )?(let|told|alerted|notified|informed|messaged|contacted)\b[^.?!]{0,40}\b(famil|daughter|son\b|kids|children)|\byour (famil\w*|daughter|son|kids|children) (has|have|was|were|is|are)( now| already| been)* (been )?(told|alerted|notified|informed|know|knows|aware)\b/i;
const FAMILY_ASKED = /\b(famil\w*|daughters?|sons?|kids|children|wife|husband|sister|brother|grand(son|daughter)s?|alert\w*|notif\w*|told (anyone|anybody|someone|them)|tell (anyone|anybody|someone|them)|who did you (tell|call|contact)|did you (tell|say|send|contact|call|message|let)|let (them|him|her|\w+) know)\b/i;
const FAMILY_TELL_TALK = /\b(told|tell|telling|alert\w*|notif\w*|contact\w*|inform\w*)\b[^.?!]{0,30}\b(anyone|anybody|nobody|no ?one|family|daughter|son)\b|\bno news\b|\b(nobody|no one) (was|has been|got) (told|alerted|notified)\b|\bhaven['\u2019]?t (told|alerted|contacted)\b/i;
const SENT_CLAIM = /\b(went over|went through|was sent|got sent|has gone|passed (it |a note |that |this )?(along|on)|sent (them|him|her|your family|a note|it|the note)|(i|we)['\u2019]?(ve| have)? (just )?(sent|passed|forwarded)\b)|\byou(['\u2019]d| had| have)? (asked|told me|wanted|requested)\b[^.?!]{0,50}\b(hear from|famil|let them|tell|note|message)/i;
// On a call she cannot look at a photo or search yet (the written chat does both): never said as an absolute "can't", always where it can be done.
const CALL_LIMIT_ABSOLUTE = /\bcan(?:['\u2019]?t|not) (?:see|look at|view|open) (?:any |the |your )?(?:pictures?|photos?|images?|screenshots?|emails?)\b|\bcan(?:['\u2019]?t|not) (?:look (?:things|that|it|this) up|search|check (?:the )?(?:internet|web|online)|go online|look (?:things )?up online)\b/i;
// With no family record: a past-tense send aimed at "them" (the family was just named), and any talk of what they have seen / read (nothing was sent to be seen).
const PAST_SEND_THEM = /\b(i|we)(['\u2019]ve| have)? (just |already )?(let|told|alerted|notified|informed|messaged|contacted|texted|called)\b[^.?!]{0,25}\b(them|him|her|everyone|someone)\b/i;
const SEEN_TALK = /\b(what|whether|if|how much) (they|your (family|daughter|son)|he|she)(['\u2019]ve| have| has| had)? (seen|read|opened|looked at|got it|received)|\b(seen|read|opened|received) (it|that|the (note|message|alert)) (yet|on their)|\bon their side\b|\bmarked (it )?(as )?seen\b|\b(i|we) (don['\u2019]?t|do not) know (what|whether|if) (they|your (family|daughter|son))\b/i;
// They ask her to GIVE a link or a number (an official site, a helpline). Never given, whatever the source: the reason is safety, never "no browsing".
const ASKS_LINK_NUMBER = /\b(link|links|url|web ?site|web address|helpline|hotline|help ?line|phone number|telephone number|contact (?:number|details)|number to call|number for|official (?:site|page|number))\b/i;
const GIVE_VERB = /\b(give|send|share|tell|show|find|get|have|need|want|what(?:'s| is)|where|which|can you|could you|do you have|looking for)\b/i;
const asksLinkNumber = (t) => ASKS_LINK_NUMBER.test(t) && GIVE_VERB.test(t);
const BROWSE_EXCUSE = /\b(?:don['\u2019]?t|do not|can(?:['\u2019]?t|not)|unable to|not able to) (?:have )?(?:any )?(?:browsing|browse|internet access|access to the internet|web access|look (?:it |that |this |things )?up|go online|search(?: for it| online)?)\b/i;
const SELF_HARM_REASON = /\b(because|since|after) you (said|told me|mentioned)\b[^.?!]{0,50}\b(hurt|harm|kill|end (it|your life)|suicid)/i;
const openWords = (t) => String(t).toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/);
const SEEN_ANGLES = ['lead with reassurance', 'lead with how glad you are to be with them', 'lead with the fact that their family knows', 'lead with saying they are not alone'];
// "Samantha, hello" / "Hello Samantha": name and hello side by side overlap when spoken.
const nameNextToHello = (text, name) => { const n = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(^|[.!?]\\s+)${n}[,!]?\\s+(hello|hi|hey|good (morning|afternoon|evening))\\b|\\b(hello|hi|hey|hello again|hi again|good (morning|afternoon|evening))[,!]?\\s+${n}\\b`, 'i').test(text); };
const firstSentence = (text) => { const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim()); return (m ? m[0] : text).trim(); };
// Byte offset of the first / end of the last sample above the silence threshold (even offsets).
function firstLoud(buf) { for (let i = 0; i + 1 < buf.length; i += 2) if (Math.abs(buf.readInt16LE(i)) >= SILENT) return i; return buf.length; }
function lastLoud(buf) { for (let i = buf.length - 2; i >= 0; i -= 2) if (Math.abs(buf.readInt16LE(i)) >= SILENT) return i + 2; return 0; }
// Words that must be in the person's last turn before a reply may run long (see onFeel).
const STORY_ASK = /\b(stor(y|ies)|tale)\b/i;
// A bare "do you remember / do you know X?" is a check (short answer), not a recall: it does not match here.
const RECALL_ASK = /\b(tell me|stor(y|ies)|what (was|happened|did|is|were)|then what)\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Scam shield for what the person SAYS on a call (scam.js). Replaceable in tests; looked up when called. null = no key, no check.
const SCAM_AWAIT_MS_DEFAULT = 2500; // the longest an awaited check ("happening right now") may hold her answer; after that she answers without it
// What the person has said so far in THIS call, handed to Spark only when the words just heard ask about something told earlier
// (remember / told you / his name / a story or recall ask). Facts only, the person's own words; the saved notes stay trimmed otherwise.
// A chat session borrows roster() without a call-local list: it passes nothing and adds nothing.
function callWords(said, heard) {
  const ask = String(heard || '');
  if (!said || !said.length || !(CALL_RECALL.test(ask) || STORY_ASK.test(ask) || RECALL_ASK.test(ask))) return '';
  let out = '', used = 0;
  for (let k = said.length - 1; k >= 0 && used < MAX_SAID_CHARS; k--) { out = `${said[k]}\n${out}`; used += said[k].length + 1; }
  return ` WHAT THEY TOLD YOU EARLIER IN THIS CONVERSATION (their own words, oldest first, today; it is not in your saved notes yet, so it counts as something you know; a name, relationship or story that appears here is known, do not say you cannot remember it):\n${out.trim()}\n`;
}
const callDeps = { awaitMs: SCAM_AWAIT_MS_DEFAULT, officialMs: 4000, official: (words, opts) => require('./official').check(words, opts), scamText: (text) => (process.env.META_API_KEY ? require('./scam').assessText(text) : null) };
// A turn about a scam is never a health emergency by its urgency alone (a panicked "he is on the phone" is not a fall): unless their own words name an injury.
const EMERGENCY_WORDS = /\b(i fell|i have fallen|fell down|chest pain|can'?t breathe|cannot breathe|bleeding|stroke|collapsed|heart attack|passed out|can'?t get up|cannot get up)\b/i;
const SCAM_CONTEXT_MS = 10 * 60000; // after a scam-looking turn, this long counts as the same scam conversation
const SCAM_LATER_FRESH_MS = 30000; // a verdict that arrives after her answer shapes the NEXT answer only if that comes within this long
const NAME_OK = /^[\p{L}][\p{L} '\-]{0,29}$/u;

// ---- Lead-in clips: Maya's own voice saying one short line, rendered once and kept (see lead.js). Real mode only; never faked. ----
const leadClips = new Map();      // text -> { text, pcm } (PCM16 24 kHz, trimmed like any other piece)
// Conversation brain step 3: lead-in clips are OFF. They are fixed sentences, so every first word Maya speaks is real Spark output instead.
// MAYA_LEAD_INS=1 switches the old behaviour back on (read at call time). Off means no clip is chosen, played, or even rendered (no ElevenLabs request).
const leadInsOn = () => process.env.MAYA_LEAD_INS === '1';
let leadLoad = null;
async function renderLead(text) {
  const parts = [];
  await streamSpeech(text, new AbortController().signal, (c) => parts.push(c));
  let buf = Buffer.concat(parts);
  buf = buf.subarray(Math.max(0, firstLoud(buf) - PAD_LEAD_BYTES));
  buf = buf.subarray(0, Math.min(buf.length, lastLoud(buf) + PAD_TAIL_BYTES));
  if (buf.length < 120 * 48) throw new Error('lead clip came back empty');
  return { text, pcm: fadeOut(fadeIn(buf), 'other') };
}
// TEMPORARY (render-test): a SYNTHETIC voice for a call that starts with { noVoice: true, fakeAudio: true }. It is NOT ElevenLabs and makes no network
// request: speech-like PCM16 24 kHz is made in memory and handed to the same playback loop in ElevenLabs-like chunks (a first chunk after ~150 ms, then about
// four times real time), with a little silence before and after like a real TTS piece. It exists to test whether the playback path and the audio going
// down the call (not the ElevenLabs request) is what upsets a small hosted server. Remove before the final version.
async function fakeSpeech(text, signal, onChunk, { firstChunkMs = 150, chunkBytes = 4096, everyMs = 20, msPerChar = 65 } = {}) {
  const speechMs = Math.max(600, String(text).length * msPerChar), leadMs = 120, tailMs = 150;
  const samples = Math.round(((leadMs + speechMs + tailMs) / 1000) * 24000), buf = Buffer.alloc(samples * 2);
  let seed = 7919; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const from = Math.round((leadMs / 1000) * 24000), to = samples - Math.round((tailMs / 1000) * 24000);
  for (let i = from; i < to; i++) { const t = i / 24000, env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t); buf.writeInt16LE(Math.round(rnd() * 2 * 9000 * env * (0.6 + 0.4 * Math.sin(2 * Math.PI * 220 * t))), i * 2); }
  await sleep(firstChunkMs);
  for (let off = 0; off < buf.length; off += chunkBytes) {
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    onChunk(Buffer.from(buf.subarray(off, Math.min(off + chunkBytes, buf.length))));
    await sleep(everyMs);
  }
}

// Renders any missing clips, one at a time (so a greeting is never queued behind them). A failure just leaves that clip out.
function warmLeads() {
  if (!leadInsOn()) return Promise.resolve();
  if (leadLoad) return leadLoad;
  leadLoad = (async () => {
    for (const t of lead.ALL) {
      if (leadClips.has(t)) continue;
      try { leadClips.set(t, await renderLead(t)); } catch (e) { console.error('lead clip not ready:', t, '-', e.message); }
    }
  })().finally(() => { leadLoad = null; });
  return leadLoad;
}

// Keep-warm: idle sockets to ElevenLabs close after about 4 s, and every turn is further apart than that, so each voice request paid a
// new TLS handshake (measured: first audio byte about 380 ms cold, about 210 ms warm). While a call is live, one tiny GET on the same
// origin every 2.5 s keeps the socket open. It sends no text, uses no voice credits, and does not touch the voice model or its tags.
const WARM_URL = 'https://api.elevenlabs.io/v1/models';
const WARM_EVERY_MS = 2500;
const TURN_DEBUG = Boolean(process.env.MAYA_TURN_DEBUG);
const dbg = (...a) => { if (TURN_DEBUG) console.log('turn', ...a); };
// What the 'latency' log line may show: numbers, flags and the guess kind only. The words the person said (heard / predicted) are never logged unless TURN_DEBUG is set:
// Render keeps logs, and a call's words are thrown away (privacy page). A whitelist, so a text field added to the timing later cannot leak.
function latencyForLog(timing, debug = TURN_DEBUG) {
  const t = { ...timing, endedAt: undefined };
  if (debug) return t;
  return Object.fromEntries(Object.entries(t).filter(([k, v]) => typeof v === 'number' || typeof v === 'boolean' || k === 'guess'));
}

// Calls that can be picked up again by a new socket (render-test, hosting): token -> Call. The token is secret and goes only to that call's browser.
const liveCalls = new Map();
const RESUME_GRACE_MS = 20000;   // how long a call waits for its browser to come back after the line was lost
const SILENCE_FEED_MS = 100;     // whenever the browser's audio stops arriving, Transcribe is fed 100 ms of silence per 100 ms so it does not drop the session ("Ingress audio slower than real-time")

class Call {
  constructor(ws, apiKey) {
    this.ws = ws;
    this.apiKey = apiKey;
    this.meta = null;
    this.resampler = null;
    this.turns = new Map();      // turnId -> { partial, spans:[{label,end}], text, endedAt }
    this.curTurn = null;         // turn that partials/speaker events belong to
    this.pending = [];           // completed turns waiting for the hold timer
    this.lastLabel = null;       // most recent speaker label, used only for turns completed by the watchdog
    this.forcedOpen = null;      // { id, base }: Meta turn we completed early, which Meta still thinks is open
    this.staleTimer = null;
    this.names = new Map();      // label -> name, this call only
    this.seen = new Set();       // labels heard this call
    this.history = [];
    this.profile = null;         // the picked profile (memory.js), set at 'start'
    this.tz = null;              // browser time zone, for the date/time Spark is given
    this.callId = require('node:crypto').randomBytes(4).toString('hex');
    this.callStarted = false;    // memory.startCall done: turns are being appended to the pending file
    this.holdTimer = null;
    this.abort = null;           // aborts the in-flight reply
    this.lastAnswered = null;    // { key, at } of the last turn Maya replied to
    this.prevDelivery = null;    // last turn's mapped delivery (one turn of carry-over)
    this.escalations = 0;
    this.lastLoudAt = 0;         // last time the mic was clearly loud
    this.noiseFloor = 0.004;     // slow estimate of the room's background level (mic peak units)
    this.lastVoiceAt = 0;        // last time the mic was clearly above the room's background
    this.lastPartialChangeAt = 0;
    this.hasMic = false;
    this.duckTimer = null;
    this.endTimer = setInterval(() => this.endpointTick(), 100);
    this.warmTimer = null;       // keep-warm pings to the voice service while the call is live
    this.noVoice = false;        // TEMPORARY test switch: no ElevenLabs request in this call (see the start handler)
    this.fakeAudio = false;      // TEMPORARY: with noVoice, use fakeSpeech() instead of silence (synthetic audio down the call)
    this.sayingText = '';        // what Maya has said so far in the current reply
    this.lastSaidAt = 0;
    this.bargeSince = 0;
    this.playUntil = 0;          // when the browser finishes playing the audio sent so far (24 kHz s16 = 48 bytes/ms)
    this.recoverTimer = null;
    this.silenceTimer = null;
    this.silenceStage = 0;       // 0: check-in; 1: reconfirm ('I am still here'); 2: goodbye + hang up
    this.firstSilenceMs = firstSilenceWait(); // this call's random first wait, 20-30 s
    this.userTurns = 0;          // turns the person has actually spoken this call (talked-then-quiet vs never answered)
    this.outreach = null;        // { kind:'callback'|'reminder', reminderId } when Maya rang them and they accepted
    this.awaitAck = null;        // reminder id spoken and not yet acknowledged
    this.closing = null;         // 'asked': the fixed "any questions?" was spoken on a call Maya placed and the answer decides whether she hangs up
    this.askQuestion = false; this.closeTimer = null;
    this.askWhat = false;        // a flag/alert just resolved: the next reply warmly asks what happened
    this.timers = [];            // in-call timers the person asked for
    this.suddenReported = false;
    this.nameChance = 0.25;      // chance a task reminder uses the person's name (sparing, tests set it)
    this.reminderReply = null;   // { gen, said }: the reply that is giving a reminder (to re-speak it if they talk over it)
    this.reminderPending = null;
    this.reminderFacts = null;   // { task, turns }: what the family wrote is all she knows about a reminder just given
    this.quietPrefetch = null;   // the next silence line, written ahead while the countdown runs
    this.identitySaid = false;   // 'I'm Maya' already spoken this call
    this.repeatRetried = false;  // one rewrite per reply when it opens like a recent one
    this.openedWithInterjection = false;
    this.greeted = false;        // a call is greeted once, at its start, never again
    this.replyCount = 0;         // normal replies so far
    this.lastReplyAsked = false; // her last reply ended in a question
    this.rc = require('./official').newRc();   // the one clarifying question about which company / website (official.js)
    this.scamAt = 0;             // when this call last had a scam-looking turn (inScamTurn: urgency in the minutes after it is the scam's)
    this.scamLater = null;       // { scam, at }: a scam verdict that arrived after her answer, used for the next one only
    this.scamReply = null;       // 'warn' | 'pause' | 'caution' | null: the shape of THIS reply (see onFeel)
    this.scamAskFor = null;      // the verdict whose one question to the family she is about to ask
    this.focus = null;           // this reply's memory focus (see setFocus); null for greetings, call-backs and silence lines
    this.followUpOffered = false; // a due follow-up was already offered to Spark in this call
    this.beatCount = 0;          // replies she has given on the current light-chat subject (see beat.js); committed after each spoken reply
    this.askHistory = [];        // whether each of her last replies asked one
    this.health = false;         // an emergency ticket was opened in this call (concern=urgent)
    this.pendingConcern = null;  // she was unsure and asked; waiting for the answer
    this.safetyAsked = new Set(); // topics her safety replies have already asked about in this call (see SAFETY_TOPICS)
    this.safetyFreshShown = false; this.healthFreshShown = false; // the "family is being alerted" fact went to Spark for this reply, not yet spoken
    this.scamOwed = null;        // the scam verdict this reply carries; still owed if the reply is cut or fails
    this.seenShown = false;      // the family-has-seen fact was handed to Spark for THIS reply (cleared once the reply is spoken)
    this.reminderShown = null;   // id of the next-call reminder handed to Spark for THIS reply (delivered only when the reply is spoken, see commitReminder)
    this.familyDeclined = false; // they said no to letting their family know, earlier in this call: kept for the whole call, not one turn
    this.said = [];              // what the person said in this call, in order (not yet in the filed memory); only shown to Spark for asks that need it
    this.ticketInCall = false;   // a safety ticket was open at the start of this call or opened in it
    this.askedName = false;
    this.lastNameUse = -10;      // reply number that last used the person's name
    this.willAskName = Math.random() < 0.6; // decided per call, so asking is neither fixed nor every call
    this.spec = null;            // speculative Spark reply { key, promise, abort }
    this.pre = null;             // pre-call guesses for the first turn: Map class -> { rs, abort }
    this.recentLeads = [];       // the last lead-in lines used
    this.lastLeadAtMs = 0;       // when a lead-in last played (never two within a few seconds)
    this.readyEma = 2500;        // running estimate of ms from the end-of-turn decision to her first real word of reply (sets how long a lead-in may be)
    this.specTimer = null;
    this.responding = false;
    this.gen = 0;
    this.closed = false;
    this.token = require('node:crypto').randomBytes(16).toString('hex');
    this.detached = false;       // the browser's line was lost; the call is waiting for it to come back (RESUME_GRACE_MS)
    this.detachTimer = null;
    this.feedTimer = null;
    this.lastMicAt = 0;          // when the last mic frame came from the browser
    this.bind(ws);
  }

  bind(ws) {
    this.ws = ws;
    ws.onmessage = (data, isBinary) => this.onBrowser(data, isBinary);
    ws.onclose = () => this.onSocketClosed();
  }

  // The browser socket ended. A close the browser or server chose (close frame) ends the call. A lost line (no close frame) during a live call
  // does NOT: the call keeps its Transcribe session, memory and state for RESUME_GRACE_MS so the browser can reconnect and carry on.
  onSocketClosed() {
    if (this.closed) return;
    if (!this.meta || !this.meta.ready || this.ws.cleanClose || !liveCalls.has(this.token)) { this.end(); return; }
    this.detached = true;
    this.cancelSilence();
    clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => this.end(), RESUME_GRACE_MS);
    console.log('call line lost, waiting up to', RESUME_GRACE_MS / 1000, 's for the browser to come back');
  }

  // Transcribe wants audio at real-time pace. When the browser's audio stops (line lost, frozen link, stalled mic) this stands in with silence, so the
  // session survives the gap and the browser can come back to the same call. Real frames always take over again at once.
  startMicFeed() {
    this.lastMicAt = Date.now();
    clearInterval(this.feedTimer);
    this.feedTimer = setInterval(() => {
      if (this.closed || !this.meta || Date.now() - this.lastMicAt < 2 * SILENCE_FEED_MS) return;
      this.meta.sendPcm(Buffer.alloc(SILENCE_FEED_MS * 48)); // 24 kHz s16 = 48 bytes/ms
    }, SILENCE_FEED_MS);
  }

  // A new socket carrying this call's token takes the call over (also when the old line is still half-open).
  attach(ws) {
    if (this.closed) return false;
    const old = this.ws;
    if (old && old !== ws && !old.closed) { old.onclose = null; old.onmessage = null; if (old.terminate) old.terminate(); }
    clearTimeout(this.detachTimer);
    this.detached = false;
    this.bind(ws);
    this.send({ type: 'resumed' });
    if (!this.responding && this.greeted && !this.muted) this.armSilence();
    console.log('call line is back');
    return true;
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  fatal(message) {
    if (this.closed) return;
    console.error('Call error:', message);
    try { this.send({ type: 'error', message }); } catch { /* socket gone */ }
    this.end();
    this.ws.close(1011);
  }

  end() {
    if (this.closed) return;
    const cutKind = this.userTurns === 0 ? 'no_talk' : (this.responding || this.pending.length || (this.curTurn && this.curTurn.partial)) ? 'mid_talk' : 'with_talk';
    this.closed = true;
    if (this.profile && this.awaitAck) care.reminderNoAck(this.profile.id, this.awaitAck);
    if (this.profile && this.registered) care.callEnded(this.profile.id, this, this.safety ? 'safety' : this.hungUpQuiet ? 'quiet' : 'left');
    if (this.profile && this.registered) care.safetyCut(this.profile.id, { kind: cutKind }); // an open ticket rings again whenever ANY call ends, whether or not this call had safety words
    if (this.timers.length) console.log('timer', JSON.stringify({ event: 'dropped: the call ended before they were due', pending: this.timers.length }));
    for (const t of this.timers) clearTimeout(t.handle);
    this.saveMemory();
    clearTimeout(this.holdTimer);
    clearTimeout(this.staleTimer);
    clearTimeout(this.duckTimer);
    clearInterval(this.endTimer);
    clearInterval(this.warmTimer);
    clearTimeout(this.detachTimer);
    clearInterval(this.feedTimer);
    liveCalls.delete(this.token);
    this.cancelSilence();
    this.dropSpec();
    this.dropPre();
    if (this.abort) this.abort.abort();
    if (this.meta) this.meta.close();
  }

  // After the call: its pending words are filed into the profile's memory by Spark in the background.
  saveMemory() {
    if (!this.profile || !this.callStarted) return;
    const heavy = this.escalations > 0 || (this.prevDelivery && ['sad', 'lonely', 'grief', 'anxious'].includes(this.prevDelivery.emotion));
    memory.endCall(this.profile.id, this.callId, { heavy: Boolean(heavy) });
  }

  onBrowser(data, isBinary) {
    if (this.closed) return;
    if (isBinary) {
      if (!this.resampler || !this.meta || !this.meta.ready || data.length % 4) return;
      const f32 = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
      let peak = 0;
      for (let i = 0; i < f32.length; i += 8) { const a = Math.abs(f32[i]); if (a > peak) peak = a; }
      const now = Date.now();
      if (TURN_DEBUG) { if (this.lastFrameAt && now - this.lastFrameAt > 300) dbg('MIC FRAMES STALLED for', now - this.lastFrameAt, 'ms (frames arrive every ~50-100 ms)'); this.lastFrameAt = now; }
      if (TURN_DEBUG) { // while a turn is open: how long did the mic deliver (near-)digital silence, though frames kept coming?
        if (peak < 0.0005) { if (!this.silentSince) this.silentSince = now; }
        else { if (this.silentSince && now - this.silentSince > 300 && this.curTurn) dbg('MIC DELIVERED SILENCE mid-turn for', now - this.silentSince, 'ms while the turn was open; partial so far', JSON.stringify(this.curTurn.partial)); this.silentSince = 0; }
      }
      if (peak >= BARGE_MIN_PEAK) this.lastLoudAt = now;
      this.hasMic = true;
      this.lastMicAt = now;
      if (peak > Math.max(0.02, this.noiseFloor * 3)) this.lastVoiceAt = now;          // clearly above the room
      else this.noiseFloor = this.noiseFloor * 0.98 + peak * 0.02;                      // learn the room
      const pcm = this.resampler.process(f32);
      if (pcm.length) this.meta.sendPcm(pcm);
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'ping') { this.send({ type: 'pong' }); return; }   // client heartbeat: the answer keeps traffic flowing both ways
    if (m.type === 'resume' && !this.meta && !this.starting) {       // a new socket for a call whose line was lost: hand the socket over
      const target = typeof m.token === 'string' ? liveCalls.get(m.token) : null;
      const ws = this.ws;
      this.end();                                                    // this placeholder call was never started
      if (target && target.attach(ws)) return;
      try { ws.send(JSON.stringify({ type: 'resumeFailed' })); } catch { /* socket gone */ }
      ws.close(1000);
      return;
    }
    if (m.type === 'start' && !this.meta && !this.starting) {
      this.profile = memory.load(m.profileId);
      if (!this.profile) return this.fatal('Please pick a profile first.');
      try { new Intl.DateTimeFormat('en-US', { timeZone: m.tz }); this.tz = m.tz; } catch { this.tz = null; }
      const rate = Number(m.sampleRate);
      if (!(rate >= 8000 && rate <= 96000)) return this.fatal('Bad microphone sample rate');
      // TEMPORARY (render-test): a call that makes NO ElevenLabs request at all. The greeting and every reply go out as text events only; the mic path,
      // Meta Transcribe and Spark are the real ones. Used to tell whether a hosting failure is the mic path or the voice. Remove before the final version.
      this.noVoice = m.noVoice === true;
      this.fakeAudio = this.noVoice && m.fakeAudio === true;   // only ever together with noVoice
      if (this.noVoice) console.log(this.fakeAudio ? 'call noVoice+fakeAudio: ElevenLabs is skipped; a synthetic voice is used' : 'call noVoice: ElevenLabs is skipped for this call');
      this.starting = true; this.startAt = Date.now();   // the start message arrived (greeting timing log)
      // Maya rang them and they pressed Accept: the id must match a live ring for THIS profile, else it is an ordinary call.
      if ((m.reason === 'callback' || m.reason === 'reminder' || m.reason === 'welfare') && typeof m.outreachId === 'string') this.outreach = care.claim(this.profile.id, m.outreachId);
      // Words a crashed or unfinished earlier call left behind are filed first, so this call knows them.
      memory.flushPending(this.profile.id).then(() => {
        if (this.closed) return;
        memory.startCall(this.profile.id, this.callId, this.tz);
        this.callStarted = true;
        this.shortGreeting = care.callCount(this.profile.id) >= SHORT_GREETING_AFTER_CALLS && !this.outreach; // decided before this call counts
        this.hadActiveFlag = care.hasActiveFlag(this.profile.id);
        care.callStarted(this.profile.id, this, this.tz);
        this.registered = true;
        this.ticketInCall = care.hasActiveSafety(this.profile.id);
        this.openMeta(m, rate);
      });
      return;
    }
    this.onBrowserMessage(m);
  }

  openMeta(m, rate) {
    {
      this.resampler = new Resampler(rate);
      this.meta = openTranscribe(this.apiKey, {
        onReady: () => { liveCalls.set(this.token, this); this.startMicFeed(); this.send({ type: 'ready', resume: this.token }); this.startWarm(); this.greet(Number(m.localHour)); },
        onEvent: (ev) => this.onMeta(ev),
        onClose: (code, reason) => {
          if (this.closed) return;
          this.fatal(code === 1000 ? 'The listening connection ended.' : `Listening failed (${code}) ${reason}`.trim());
        },
      });
    }
  }

  onBrowserMessage(m) {
    if (m.type === 'duck') {
      // The browser dipped Maya's volume because of loud sound. Give real words DUCK_CONFIRM_MS to arrive
      // (considerBargeIn then stops her); if none do, her volume goes back and she carries on.
      if (this.isSpeaking()) {
        this.lastLoudAt = Date.now();
        clearTimeout(this.duckTimer);
        this.duckTimer = setTimeout(() => { if (!this.closed) this.send({ type: 'unduck' }); }, DUCK_CONFIRM_MS);
      }
    } else if (m.type === 'bargein') {
      this.interrupt();
    } else if (m.type === 'mute') {
      // The person muted their mic (call stays live, Maya hears silence). Silence timers pause so she does not
      // check in, reconfirm or hang up on someone who chose to be muted; unmuting starts the wait afresh.
      this.muted = m.on === true;
      if (this.muted) this.cancelSilence(); else if (!this.responding && this.greeted) this.armSilence();
    }
  }

  // Stops Maya at once: aborts Spark/TTS and tells the browser to drop queued audio.
  // Maya is audible while Spark/the voice are still working AND while the browser is still playing
  // audio the server has already finished sending (the server streams faster than real time).
  isSpeaking() { return this.responding || Date.now() < this.playUntil; }

  interrupt() {
    if (!this.isSpeaking()) return;
    // They talked over a reminder: it is still owed. It is given again right after the interruption, confidently.
    if (this.reminderReply && this.reminderReply.gen === this.gen && this.awaitAck) this.reminderPending = this.reminderReply;
    this.gen += 1;
    if (this.abort) this.abort.abort();
    this.responding = false;
    this.playUntil = 0;
    this.bargeSince = 0;
    clearTimeout(this.duckTimer);
    this.send({ type: 'stopped' });
    // If what stopped her never turns into a usable question, say so instead of going quiet.
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recoverFromInterrupt(), this.reminderPending ? 3000 : RECOVER_AFTER_MS);
  }

  recoverFromInterrupt() {
    if (this.closed || this.isSpeaking()) return;
    if (this.curTurn || this.pending.length) { this.recoverTimer = setTimeout(() => this.recoverFromInterrupt(), 3000); return; } // still listening to them
    console.log('recovery: interrupted with nothing usable heard');
    if (this.reminderPending && this.awaitAck) { const r = this.reminderPending; this.reminderPending = null; this.reminderReply = null; this.speak(r.said); return; } // the reminder, not "can you say that again"
    this.speak(INTERRUPTED);
  }

  // Words of Maya's own reply coming back through the mic (or just after she stopped).
  isEcho(text) {
    const heard = realTokens(text);
    if (heard.length < 2) return false;
    if (!this.isSpeaking() && Date.now() - this.lastSaidAt > ECHO_WINDOW_MS) return false;
    // Her echo repeats her words in order; a person who merely uses the same topic words does not.
    const pairs = (words) => words.slice(1).map((w, i) => `${words[i]} ${w}`);
    const mine = new Set(pairs(tokens(this.sayingText)));
    const theirs = pairs(tokens(text));
    return theirs.length > 0 && theirs.filter((p) => mine.has(p)).length / theirs.length >= ECHO_OVERLAP;
  }

  // Called with every non-empty partial transcript.
  considerBargeIn(partial) {
    if (!this.isSpeaking()) return;
    const real = realTokens(partial);
    const stop = real.length === 1 && STOP_WORDS.has(real[0]);
    if ((real.length < 2 && !stop) || this.isEcho(partial)
        || Date.now() - this.lastLoudAt > BARGE_LOUD_WINDOW_MS) { this.bargeSince = 0; return; }
    const now = Date.now();
    if (!this.bargeSince) this.bargeSince = now;
    if (real.length >= 4 || stop || now - this.bargeSince >= BARGE_MIN_MS) this.interrupt();
  }

  onMeta(ev) {
    if (TURN_DEBUG && ev.type !== 'transcript' && ev.type !== 'audioProgress') dbg(ev.type, JSON.stringify({ id: ev.turnId, syn: ev.synthetic, txt: ev.transcript, forced: this.forcedOpen && this.forcedOpen.base, pending: this.pending.length }));
    switch (ev.type) {
      case 'speechStart': {
        clearTimeout(this.holdTimer);
        if (this.pending.length) this.holdTimer = setTimeout(() => this.respond(MAX_HOLD_OPEN_MS), MAX_HOLD_OPEN_MS);
        this.dropSpec();
        this.forcedOpen = null;
        this.curTurn = { partial: '', spans: [], text: null };
        this.turns.set(ev.turnId, this.curTurn);
        this.send({ type: 'speechStart' });
        break;
      }
      case 'transcript': {
        let t = this.curTurn;
        const heard = (ev.transcript || '').trim();
        const fo = this.forcedOpen;
        if (!t && fo && heard.length > fo.base.length + 3) {
          // The person kept talking in a Meta turn we had already completed: start the next turn from the new words.
          t = this.curTurn = { partial: '', spans: [], text: null, base: fo.base };
          this.turns.set(fo.id, t);
          this.send({ type: 'speechStart' });
        }
        if (!t) break;
        const before = t.partial;
        t.partial = t.base && heard.startsWith(t.base) ? heard.slice(t.base.length).trim() : heard;
        if (t.partial !== before) this.lastPartialChangeAt = Date.now();
        if (t.partial) {
          this.considerBargeIn(t.partial);
          if (realTokens(t.partial).length) { this.cancelSilence(); this.send({ type: 'partial', text: t.partial }); } // sounds like "ding" are not shown as speech
          this.armStale(t);
        }
        this.maybeSpeculate(t);
        break;
      }
      case 'speaker': {
        // Labels the span since the previous boundary, so it ends at the current partial's end.
        // Since we now end turns ourselves, this usually arrives after the turn was completed: still learn the label.
        this.seen.add(ev.label);
        this.lastLabel = ev.label;
        const t = this.curTurn;
        if (!t) break;
        t.spans.push({ label: ev.label, end: t.partial.length });
        this.send({ type: 'speaker', label: ev.label });
        break;
      }
      case 'speechEnd': {
        if (this.forcedOpen && this.forcedOpen.id === ev.turnId && !this.turns.has(ev.turnId)) break; // already completed here
        clearTimeout(this.staleTimer);
        const t = this.turns.get(ev.turnId);
        if (t) t.endedAt = Date.now();
        this.send({ type: 'speechEnd' });
        break;
      }
      case 'speechComplete': {
        clearTimeout(this.staleTimer);
        if (!ev.synthetic && this.forcedOpen && this.forcedOpen.id === ev.turnId) {
          const continued = this.turns.has(ev.turnId);
          this.forcedOpen = null;
          if (!continued) break; // Meta caught up with a turn we already answered
        }
        const t = this.turns.get(ev.turnId) || { partial: '', spans: [] };
        this.turns.delete(ev.turnId);
        if (this.curTurn === t) this.curTurn = null; // turn is over: its partial buffer is done
        let said = (ev.transcript || '').trim();
        if (t.base && said.startsWith(t.base)) said = said.slice(t.base.length).trim();
        t.text = this.collapseRepeat(said);
        t.completedAt = Date.now();
        dbg('turn text', JSON.stringify(t.text), 'from final', JSON.stringify(ev.transcript), 'base', JSON.stringify(t.base), 'partial', JSON.stringify(t.partial));
        const key = this.textKey([t]);
        const last = this.pending[this.pending.length - 1];
        const dup = key && ((last && this.textKey([last]) === key)
          || (this.lastAnswered && this.lastAnswered.key === key && t.completedAt - this.lastAnswered.at < DUPLICATE_WINDOW_MS));
        if (!t.text || dup || !realTokens(t.text).length || this.isEcho(t.text)) {
          dbg('DROPPED turn text', JSON.stringify(t.text), 'dup', Boolean(dup), 'echo', this.isEcho(t.text), 'base', JSON.stringify(t.base), 'said', JSON.stringify(ev.transcript));
          if (this.pending.length) { clearTimeout(this.holdTimer); this.holdTimer = setTimeout(() => this.respond(0), HOLD_TRAILING_MS); } // keep the wait going
          else if (!this.isSpeaking()) this.send({ type: 'idle' });
          if (!this.pending.length) this.armSilence(); // that was not a usable answer: keep counting the quiet
          break;
        }
        this.pending.push(t);
        clearTimeout(this.holdTimer);
        clearTimeout(this.specTimer);
        t.synthetic = Boolean(ev.synthetic); // we ended this turn ourselves: Maya's first 300 ms is held back
        let hold;
        if (ev.synthetic) hold = 0;                                                  // already waited the full quiet period
        else if (this.hasMic) {
          // Transcribe's end: only top up to our own quiet period (usually 0, it is slower than we are).
          hold = this.quietNeeded(t.text);
        } else {
          hold = SENTENCE_END.test(t.text) ? HOLD_SENTENCE_MS : looksComplete(t.text) ? HOLD_COMPLETE_MS : HOLD_TRAILING_MS; // no mic data: the old fixed holds
        }
        if (this.spec && this.spec.textKey !== this.textKey(this.pending)) this.dropSpec();
        this.holdTimer = setTimeout(() => this.respond(hold), hold);
        break;
      }
      default: break; // audioProgress and unknown events are ignored
    }
  }

  // Splits one turn's final text into [{label, text}] using the speaker spans (scaled from
  // the last partial's length to the final text's length, snapped to a word boundary).
  attribute(t) {
    if (!t.spans.length) return [{ label: null, text: t.text }];
    const total = Math.max(t.partial.length, 1);
    const parts = [];
    let from = 0;
    t.spans.forEach((s, i) => {
      let end = i === t.spans.length - 1 ? t.text.length : Math.round((s.end / total) * t.text.length);
      if (end < t.text.length) { const sp = t.text.indexOf(' ', end); end = sp === -1 ? t.text.length : sp; }
      const text = t.text.slice(from, end).trim();
      from = Math.max(from, end);
      if (text) parts.push({ label: s.label, text });
    });
    // Any text after the last span belongs to the last speaker.
    const rest = t.text.slice(from).trim();
    if (rest) parts.push({ label: t.spans[t.spans.length - 1].label, text: rest });
    return parts;
  }

  // "Name: words" lines for a set of turns; consecutive spans by one speaker are joined.
  userMessage(turns) {
    const lines = [];
    for (const t of turns) {
      for (const p of this.attribute(t)) {
        const who = this.who(p.label);
        const last = lines[lines.length - 1];
        if (last && last.who === who) last.text += ` ${p.text}`;
        else lines.push({ who, text: p.text });
      }
    }
    return lines.map((l) => `${l.who}: ${l.text}`).join('\n');
  }

  // Identity of what was heard: letters and digits only, so punctuation changes do not matter.
  textKey(turns) {
    return turns.map((t) => t.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).join(' ');
  }

  startWarm() {
    // OFF by default (new free ElevenLabs account after a termination: keep its traffic minimal). It saved about 150 ms per turn, so it can be
    // switched back on later with MAYA_KEEPWARM=1. Nothing else about the voice changes.
    if (process.env.MAYA_KEEPWARM !== '1') return;
    if (this.warmTimer || !process.env.ELEVENLABS_API_KEY) return;
    const ping = () => fetch(WARM_URL, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(3000) }).then((r) => r.arrayBuffer()).catch(() => { /* a missed ping only means one cold connection */ });
    ping();
    this.warmTimer = setInterval(ping, WARM_EVERY_MS);
  }

  dropPre() {
    if (this.pre) { for (const g of this.pre.values()) g.abort.abort(); this.pre = null; }
  }

  // Before the person has said a word, Spark writes the reply to the one routine thing a greeting most often gets back
  // ("I'm fine, thank you" / "Hello Maya"), from the same roster (memory, reminders, notes) as any reply. It is spoken ONLY if the
  // first words really heard match that class exactly (lead.prethinkClass); otherwise it is dropped unheard.
  startPrethink() {
    if (this.pre || this.outreach || this.ticketInCall || this.hadActiveFlag || this.safety || this.health) return;
    this.pre = new Map();
    for (const [k, c] of Object.entries(lead.PRETHINK)) {
      const abort = new AbortController();
      const msgs = [...this.history, { role: 'user', content: `${this.who('A')}: ${c.sample}` }];
      this.pre.set(k, { rs: startReply(msgs, this.roster(this.replyNote(), c.sample), abort.signal), abort, sample: c.sample });
    }
  }

  // A short true acknowledgement to say the instant the person has finished, while Spark writes the real reply. Null = say nothing extra.
  pickLead(turns, extra, spec, holdBack) {
    const why = (r) => { if (process.env.MAYA_LEAD_DEBUG) console.log('lead skipped:', r); return null; };
    if (!leadInsOn()) return why('lead-ins are off');
    if (this.noVoice) return why('no-voice test call');
    if (!leadClips.size) return why('no clips');
    if (extra) return why('care note');
    if (this.safety || this.health || this.pendingConcern) return why('safety/health/concern');
    const heard = turns.map((t) => t.text).join(' ');
    if (!lead.isRoutine(heard)) return why(`not routine: ${JSON.stringify(heard)}`);
    if (spec && spec.rs.text.length) return why('reply already on its way');
    if (Date.now() - this.lastLeadAtMs < 6000) return why('a lead-in just played');   // e.g. a turn split in two: one lead-in is enough
    // The longest line that still ends before her reply is expected (the first 300 ms is held back by the browser), so the silence
    // before the reply is as short as possible and the reply is never held back behind the lead-in.
    const hold = holdBack ? HOLD_BACK_MS : 0;
    const fit = { budgetMs: this.readyEma + 150 - hold, durOf: (l) => (leadClips.has(l) ? leadClips.get(l).pcm.length / 48 : NaN) };
    const text = lead.chooseLead(heard, this.recentLeads, Math.random, fit);
    return (text && leadClips.get(text)) || why('no clip for ' + text);
  }

  // Sends the clip now. The first Spark piece follows with { cont: true }, so the browser keeps this line playing and carries on.
  playLead(clip, holdBack, timing) {
    const now = Date.now();
    this.send({ type: 'speak', text: clip.text, lead: true, hold: holdBack ? HOLD_BACK_MS : 0 });
    this.ws.send(clip.pcm);
    this.lastSaidAt = now;
    this.recentLeads = [...this.recentLeads, clip.text].slice(-2);
    this.lastLeadAtMs = now;
    const endsAt = now + clip.pcm.length / 48 + (holdBack ? HOLD_BACK_MS : 0);
    this.playUntil = endsAt;
    if (timing) { timing.lead = clip.text; timing.leadFirstSoundMs = now - timing.decidedAt; }
    return { text: clip.text, endsAt };
  }

  dropSpec() {
    clearTimeout(this.specTimer);
    if (this.spec) { for (const s of this.spec.byLabel.values()) s.abort.abort(); this.spec = null; }
  }

  // Meta sends a turn's speaker label only when the turn ends, so the guess is made for each
  // voice label heard so far plus the next unused one; the one that matches the final label is used.
  maybeSpeculate(t) {
    clearTimeout(this.specTimer);
    if (this.pending.length || !t.partial.trim()) return;
    const key = this.textKey([{ text: t.partial }]);
    if (this.spec && this.spec.textKey !== key) this.dropSpec();
    if (this.spec || !looksComplete(t.partial)) return;
    if (!lead.isRoutine(t.partial)) return; // routine talk only: pain, health, worry, safety and the like are never guessed at
    this.specTimer = setTimeout(() => {
      if (this.closed || this.spec) return;
      const next = 'ABCDEFGH'.split('').find((l) => !this.seen.has(l));
      const labels = [...new Set([...this.seen, next].filter(Boolean))].slice(0, 4);
      const spec = { textKey: key, byLabel: new Map() };
      for (const label of labels) {
        const abort = new AbortController();
        const turn = { ...t, text: t.partial, spans: [{ label, end: t.partial.length }] };
        const msgs = [...this.history, { role: 'user', content: this.userMessage([turn]) }].slice(-MAX_HISTORY);
        // A failed or dropped guess is silent (ReplyStream keeps the error; nothing reads it).
        spec.byLabel.set(label, { rs: startReply(msgs, this.roster(this.replyNote(), t.partial), abort.signal), abort });
      }
      this.spec = spec;
    }, SPEC_QUIET_MS);
  }

  // Fallback: Transcribe never closed the turn and its words stopped changing.
  armStale(t) {
    clearTimeout(this.staleTimer);
    const ms = looksComplete(t.partial) ? STALE_SENTENCE_MS : STALE_OPEN_MS;
    this.staleTimer = setTimeout(() => this.forceComplete(t), ms);
  }

  // Primary: our own end-of-turn, checked every 100 ms while a turn is open.
  endpointTick() {
    const t = this.curTurn;
    if (this.closed || !t || !this.hasMic || !t.partial || !realTokens(t.partial).length) return;
    if (this.quietNeeded(t.partial) === 0) this.forceComplete(t);
  }

  // Milliseconds still to wait before the person can be considered finished (0 = finished).
  quietNeeded(text) {
    const now = Date.now();
    const complete = looksComplete(text);
    return Math.max(0,
      (complete ? OWN_END_COMPLETE_MS : OWN_END_DANGLING_MS) - (now - this.lastVoiceAt),
      (complete ? OWN_END_WORDS_COMPLETE_MS : OWN_END_DANGLING_MS) - (now - this.lastPartialChangeAt));
  }

  forceComplete(t) {
    if (this.closed || this.curTurn !== t) return;
    const id = [...this.turns].find(([, v]) => v === t);
    if (!id) return;
    clearTimeout(this.staleTimer);
    // Transcribe sends the speaker label after the turn ends, which is now after we have ended it: assume the
    // last speaker (or 'A', its first label) is still the one talking. A wrong guess only costs the early guess.
    const guess = this.lastLabel || (this.seen.size ? [...this.seen][0] : 'A');
    if (!t.spans.length) { t.spans = [{ label: guess, end: t.partial.length }]; this.seen.add(guess); }
    this.forcedOpen = { id: id[0], base: (t.base ? `${t.base} ${t.partial}` : t.partial).trim() };
    dbg('OWN END-OF-TURN fired on partial', JSON.stringify(t.partial), 'quietFor', Date.now() - this.lastVoiceAt, 'ms, words steady for', Date.now() - this.lastPartialChangeAt, 'ms');
    this.send({ type: 'speechEnd' });
    this.onMeta({ type: 'speechComplete', turnId: id[0], transcript: t.partial, synthetic: true });
  }

  // "hello maya hello maya" (final text arriving on top of its own partial) becomes "hello maya".
  collapseRepeat(text) {
    const words = text.split(/\s+/);
    if (words.length >= 2 && words.length % 2 === 0) {
      const n = words.length / 2;
      const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (words.slice(0, n).every((w, i) => norm(w) === norm(words[n + i]))) return words.slice(n).join(' ');
    }
    return text;
  }

  who(label) { return label ? (this.names.get(label) || `Speaker ${label}`) : 'Someone'; }

  roster(note = '', heard = '') {
    const known = [...this.names].map(([l, n]) => `${l}=${n}`);
    const unknown = [...this.seen].filter((l) => !this.names.has(l));
    return `${memory.profileNote(this.profile, this.tz, this.focus)}${callWords(this.said, heard || (this.focus && this.focus.text))} WHAT YOU KNOW ABOUT WHAT IS HAPPENING (facts for you, never read out as written; say it in plain companion words and never claim an action these facts do not say happened): ${care.appFacts(this.profile.id, Date.now(), { family: this.familyRelevant(heard) })}${this.limitsFacts(heard)}${this.safetyContext()}\nPeople heard on this call. Known names: ${known.join(', ') || 'none'}. Names not known yet: ${unknown.join(', ') || 'none'}.${note ? ` ${note}` : ''}`;
  }

  // A safety alert from an earlier call is still active (the call-back is a NEW call, so this call has no memory of it).
  // Every Spark request in this call carries it, so Maya never denies having told the family. Never spoken as written.
  safetyContext() {
    const id = this.profile.id;
    const past = care.safetyHistoryNote(id);
    const truth = 'If they ask whether you told anyone, or why, answer truthfully and plainly in fresh words: yes, you let their family know about a safety worry (the topic only), and you did not repeat their exact words. Give no other reason and no excuse: never "because I care about you", never quote or guess what they said. Never deny it, never say you did not tell anyone, never say you cannot alert anyone or let their family know. Say "alerted" or "let your family know", never "reminded". If they name someone not in your notes, say you do not know that person by name, but their family was told, and you cannot call someone you do not know. Never invent a daughter or any other person, never claim you told a particular person you did not. You never call anyone and never give a phone number. Do not bring any of this up unprompted, and not in a greeting.';
    if (!care.hasActiveSafety(id) && past) return ` EARLIER SAFETY CONCERN (facts, never spoken as written): on ${past.date} their family was alerted through the app about a safety concern after they said they might harm themselves; ${past.unseen ? 'their family never marked it seen and nobody confirmed they were safe' : 'you stayed with them and the family decided what to do next'}. ${truth}`;
    if (!care.hasActiveSafety(id)) return '';
    return ` SAFETY CONTEXT (facts, never spoken as written): a safety alert from an earlier call is still active and their family has already been told by you; that was done once and is not repeated. ${truth}`;
  }

  // Notes Spark gets with every normal reply: how not to repeat the openings it just used.
  replyNote() {
    const bits = [];
    bits.push('The conversation is already under way: do not greet them or begin with Hello, Hi or a Good morning/evening.');
    if (this.names.size) {
      const ago = this.replyCount - this.lastNameUse;
      bits.push(ago < 3 ? 'You used their name recently, so do not use it in this reply.' : 'If this reply comforts or encourages them (sadness, loneliness, worry), start it with their actual name once, in fresh comfort words never copied from before. For ordinary chat or happy news leave their name out.');
    } else if (this.profile) {
      bits.push('Do not ask for their name.');
    } else if (this.willAskName && !this.askedName && this.replyCount === 1) {
      bits.push('If the moment is light, end this reply by asking what you should call them, once, gently. If it is a heavy or sad moment, do not ask.');
    } else {
      bits.push('Do not ask for their name in this reply.');
    }
    bits.push(this.lastReplyAsked ? `Your last reply asked a question (of your last ${this.askHistory.length} replies, ${this.askHistory.filter(Boolean).length} asked one), so make this reply a statement, a reflection or a warm acknowledgement with no question.` : this.askHistory.filter(Boolean).length >= 2 ? 'You have been asking a lot; do not add a follow-up question unless you truly need the answer.' : 'Do not add a follow-up question by default; a friend listens more than she asks. Ask only when you genuinely need to know.');
    const openings = this.recentOpenings();
    if (this.identitySaid) bits.push('You have already said who you are in this call; do not say your name or what you are again, in any words.');
    bits.push('Their family and any alert are INTERNAL: never bring them up unless they asked about their family or an alert, or this turn is truly about that alert. A greeting or light chat is just a greeting or light chat. If you got something wrong, say plainly and specifically what was wrong and go back to what they were saying; never "let\'s drop it" or "forget it"; if they say "what?" or look lost, clarify the actual point in plain words.');
    bits.push('Companion tone: short, natural, direct, warm; not therapy in every turn. Never say "I\'m right here with you", "we\'ll take this slow together", "I\'m standing with you" or the like, and never give "I care about you" as the reason for something you did. If they are upset with you, answer the actual thing plainly.');
    bits.push('Never use a stock comfort phrase or a stock way of introducing yourself, whether it reassures them that you are with them or says who you are; a friend makes up new words each time.');
    const beatNote = beat.note(this.beatCount);
    if (beatNote) bits.push(beatNote);
    const lastU = [...this.history].reverse().find((m) => m.role === 'user');
    if (lastU && simpleAffirmation(lastU.content) && !this.safety && !this.health && !this.pendingConcern) bits.push('They only said a short yes or okay. A real conversation answers that with ONE short line: act on what they agreed to in a few words, or simply carry on. No explanation, no recap of what was just said, and do not repeat a question you already asked or a line you already used.');
    const kinds = moves.blockedKinds(this.recentReplies());
    if (kinds.length) bits.push(`Recently you were already ${kinds.join(', and ')}. Do not do that again in this reply, in any words.`);
    bits.push('Answer the specific thing they just said and carry the talk forward by one small step. Do not lean on a general polite acknowledgement in place of a real response, and do not reuse any run of words from your last three replies.');
    return bits.join(' ') + ' ' + (openings.length
      ? `Your last reply openings were: ${openings.map((o) => `"${o}"`).join(', ')}. Open this reply differently, in fresh words chosen from the feeling. Do not begin with any of these word pairs: ${[...new Set(openings.map((o) => o.split(' ').slice(0, 2).join(' ')))].map((p) => `"${p}"`).join(', ')}.`
      : '');
  }

  // The first words of this profile's last 3 normal replies (kept across calls, like the dynamic lines).
  recentOpenings() {
    return this.profile ? care.recentLines(this.profile.id, 'open').slice(-3) : [];
  }

  // Her last five spoken replies in this call (the call's own history; nothing extra is stored). The repeat rules read what they need from the end.
  recentReplies() {
    return this.history.filter((m) => m.role === 'assistant').map((m) => String(m.content)).slice(-5);
  }

  // Is this turn about a scam (its own verdict, an open question about telling the family, or words that look like one)? Then urgency in Spark's read is the scam's.
  inScamTurn(heard) {
    const id = this.profile && this.profile.id;
    if (EMERGENCY_WORDS.test(String(heard || '').replace(/[\u2018\u2019]/g, "'"))) return false;
    if (this.scamReply || (id && care.scamPending(id)) || require('./scam').needsCheck(heard)) { this.scamAt = Date.now(); return true; }
    return Date.now() - this.scamAt < SCAM_CONTEXT_MS;   // the follow-ups of a scam conversation ("he is still there", "yeah you did") are part of it
  }

  // Scam shield on a call: what the person just said. Decides in code (the cheap word filter) whether it is worth one Spark check, and whether
  // that check must be AWAITED (the person is on the way to pay, or the caller is still on the line) or can run beside her answer and shape the
  // next one. Never while a safety matter is active, never for self-harm words, never while her family question is still open.
  // Returns { note, level } for THIS reply (empty when nothing applies); a failed or slow check changes nothing and is never replaced by a guess.
  // Official source (official.js): a warn / pause on a call gets the company they named looked up on its official site (waited for at most officialMs; slower =
  // cannot verify, never a guess), or ONE reconfirm question when no company is clear; what they say next settles it. No warn and nothing open: synchronous, unchanged.
  scamForTurn(heard) {
    const base = this.scamForTurnCore(heard), O = require('./official'), id = this.profile && this.profile.id;
    const wrap = (res) => {
      const warn = Boolean(res.scam && ['warn', 'pause'].includes(res.scam.level));
      if (!id || (!warn && !O.asking(this.rc)) || this.safety || care.hasActiveSafety(id)) return res;
      const v = O.asking(this.rc) ? this.rc.scam : res.scam;
      return O.step(this.rc, { words: heard, scam: res.scam, channel: 'call', run: (w, o) => callDeps.official(w, o), timeoutMs: callDeps.officialMs, commit: false, family: { told: Boolean(care.scamTold(id)), declined: Boolean(v && care.scamDeclined(id, v.type)), pending: Boolean(care.scamPending(id)) } }).then((o) => {
        if (!o) return res;
        if (o.resolved) return { note: o.note, scam: o.scam, told: !o.askFor, askFor: o.askFor, official: o.official };
        return { ...res, note: [res.note, o.note].filter(Boolean).join(' '), official: o.official, ...(o.official && !res.told ? { askFor: { ...res.scam, official: o.official } } : {}) };
      });
    };
    return base && typeof base.then === 'function' ? base.then(wrap) : wrap(base);
  }
  scamForTurnCore(heard) {
    const scam = require('./scam');
    let now = null;
    const later = this.scamLater; this.scamLater = null;
    if (later && Date.now() - later.at <= SCAM_LATER_FRESH_MS) now = later.scam;
    const id = this.profile && this.profile.id;
    const told = Boolean(id && care.scamTold(id));   // their family was already told (unseen alert): no new question, nothing new claimed
    const out = (v) => { const declined = Boolean(v && care.scamDeclined(id, v.type)); return { note: v ? scam.talkNote(v, { told, declined }) : '', scam: v, told: told || declined }; };
    if (!id || this.safety || this.pendingConcern || care.hasActiveSafety(id) || care.scamPending(id) || selfHarmText(heard)) return out(now);
    const plan = scam.checkPlan(heard);
    if (plan.check || now) this.scamAt = Date.now();
    if (!plan.check) return out(now);   // ordinary talk: synchronous, nothing awaited, no added delay
    const p = Promise.resolve().then(() => callDeps.scamText(heard)).catch((e) => { console.error('scam check failed:', e.message); return null; });
    if (!plan.await) { p.then((v) => { if (v && v.level !== 'none') this.scamLater = { scam: v, at: Date.now() }; }); return out(now); }
    return Promise.race([p, sleep(callDeps.awaitMs).then(() => 'late')]).then((v) => {
      if (v === 'late') p.then((late) => { if (late && late.level !== 'none') this.scamLater = { scam: late, at: Date.now() }; });
      else if (v && v.level !== 'none') now = v;
      return out(now);
    });
  }

  // The reply that carried a next-call reminder was spoken to the end (not cut off, not failed): now it counts as delivered, once, and "not
  // done yet" can reopen it. Until then the reminder stays due, so a cut reply never loses it. Chat borrows this too.
  commitReminder() {
    // Generated is not heard: what must be TOLD to the person (a new family alert, a scam warning) is only counted as told when the reply that
    // carried it was spoken to the end. A cut or failed reply leaves it owed for the next one.
    if (this.safetyFreshShown) { this.safetyFresh = false; this.safetyFreshShown = false; }
    if (this.healthFreshShown) { this.healthFresh = false; this.healthFreshShown = false; }
    this.scamOwed = null;
    if (this.seenShown && this.profile) { this.seenShown = false; care.clearSeenToTell(this.profile.id); }   // the reply that carried "your family knows" was spoken
    const tid = this.reminderShown; this.reminderShown = null;
    if (!tid || !this.profile) return;
    memory.deliverReminder(this.profile.id, tid, this.callId);
    this.followUpOffered = true;
  }

  // Memory focus for ONE normal reply (conversation brain #3): the words just heard pick the few memory items worth showing, and code may
  // offer Spark at most one due follow-up (recall.js) as a fact with its date already worked out. Never in a heavy or careful moment, never
  // twice in a call, never after two offers in total. A request for a story or a recalled account keeps the whole memory. Spark phrases it.
  setFocus(heard, extra = '') {
    const full = STORY_ASK.test(heard) || RECALL_ASK.test(heard);
    const heavy = Boolean(extra || this.safety || this.health || this.pendingConcern || !lead.isRoutine(heard) || recall.heavyTalk(heard) || (this.prevDelivery && beat.HEAVY.has(this.prevDelivery.emotion)));
    this.focus = { text: String(heard || ''), full, thread: '' };
    if (full || !this.profile) return;
    const t = recall.dueThread(this.profile.memory.threads, memory.today(this.tz), { heavy, askedThisCall: this.followUpOffered, callId: this.callId });
    if (!t) return;
    if (t.kind === 'reminder') { this.reminderShown = t.id; this.focus.reminder = true; }   // marked delivered only once the reply is really spoken (commitReminder); a cut reply leaves it for next time
    else { this.followUpOffered = true; memory.markAsked(this.profile.id, t.id); }
    this.focus.thread = recall.threadFact(t, memory.today(this.tz));
  }

  // Decides this reply's beat from Spark's tag (topic) and the care state, then enforces its limits on the delivery (see beat.js).
  applyBeat(d, raw, special) {
    const low = (k) => String((raw && raw[k]) || '').toLowerCase();
    const p = beat.plan({ count: this.beatCount, topic: low('topic'), emotion: d.emotion, intent: low('intent'), concern: low('concern'), pain: /^(1|yes|true)$/.test(low('pain')), personal: /^(1|yes|true)$/.test(low('personal')), special });
    const lim = beat.limits(p.type);
    d.beat = p.type; d.beatN = p.n;
    d.tagPain = /^(1|yes|true)$/.test(low('pain')); d.tagConcern = low('concern');   // for the daily count only (trends.js)
    if (lim.noQuestion) d.noQuestion = true;
    if (lim.maxSentences < d.maxSentences) d.maxSentences = lim.maxSentences;
  }

  // On a connect or close beat the reply may not open with a question: it is written again once, like a repeated opening.
  beatBlocks(piece, d) {
    return Boolean(d && (d.beat === 'connect' || d.beat === 'close') && isQuestion(piece));
  }

  // True when a reply that starts with this piece repeats a recent opening, a stock phrase already used, or the identity line.
  // What she can and cannot do HERE, as facts (the wording is Spark's). A call cannot start a photo check or a web search yet; the written chat does both.
  // A phone number is never looked up, in a call or in the chat; she says so straight away.
  lastHeard(heard = '') {
    const lastU = ([...(this.history || [])].reverse().find((m) => m.role === 'user') || { content: '' }).content;
    return String(heard || (this.focus && this.focus.text) || lastU || '');
  }

  limitsFacts(heard = '') {
    const text = this.lastHeard(heard);
    const bits = [];
    if (asksLinkNumber(text)) bits.push(`LINK OR NUMBER REQUEST: they want a website link or a phone number (for a bank, a helpline or anything else). You NEVER give one, not even for the real bank, because a wrong one is dangerous. The reason is SAFETY: it is NOT that you have no browsing or cannot look things up, so never say that. In a few plain words of your own, two sentences at most: you won't share a link or number, even an official one, because a wrong one could hurt them; they should type the bank's name into their browser themselves, or use the official app or the number printed on their card. Never invent or guess a link or number.${this.channel !== 'chat' ? ' On a call also say: for anything to check, send it in the chat and you will check it there.' : ''}`);
    if (this.channel !== 'chat') bits.push('ON A CALL she cannot look at a photo or screenshot and cannot search the web yet; the written chat in the app can do both. If they offer a photo or screenshot, or ask her to find something out online, say so in a few words WITHOUT a flat "I can\'t": tell them to send it in the chat (after this call is fine) and she will check it there. Never say "I can\'t see pictures" or "I can\'t look things up online".');
    if (/(?:\d[\s().-]*){7,}/.test(text) || /\b(?:phone |telephone )?number\b/i.test(text)) bits.push('A PHONE NUMBER: you never look numbers up and cannot tell if one is real (callers can fake the number shown). If they give or ask about a number, say that straight away, in a few plain words ("I can\'t look numbers up"), never "I\'m not sure what you want me to do with it".');
    return bits.length ? ` LIMITS (facts for you, never read out as written): ${bits.join(' ')}` : '';
  }

  // Is THIS turn about the family or an alert? Only then may the family-told fact be spoken. Light chat, a greeting, "what?" and "what are you talking about?" are not.
  // Code decides (their words, or an open scam / safety / family matter, or a family event just now); Spark never volunteers it.
  familyRelevant(heard = '') {
    const id = this.profile && this.profile.id;
    const lastU = ([...(this.history || [])].reverse().find((m) => m.role === 'user') || { content: '' }).content;
    const text = String(heard || (this.focus && this.focus.text) || lastU || '').replace(/[\u2018\u2019]/g, "'");
    if (FAMILY_ASKED.test(text)) return true;
    if (!id) return false;
    if (this.safety || this.health || this.pendingConcern || this.scamReply || this.scamAskFor || this.seenShown || this.safetyFreshShown || this.healthFreshShown) return true;
    if (care.hasActiveSafety(id) || care.scamPending(id) || care.familyEventRecent(id)) return true;
    try { return require('./scam').needsCheck(text); } catch { return false; }
  }

  // A piece that must never be spoken or shown: a stock counselling line, a family alert the app never made, or an invented self-harm reason.
  // Code reads the records (care.familyToldTopics); Spark only writes the words.
  breaksFacts(piece) {
    const t = String(piece || '').replace(/\u2019/g, "'");
    if (COUNSEL_BAN.test(t)) return true;
    if (FAMILY_TELL_TALK.test(t) && !this.familyRelevant()) return true;   // the family fact is internal: not volunteered on a turn that is not about it
    const told = this.profile ? care.familyToldTopics(this.profile.id) : [];
    if (BROWSE_EXCUSE.test(t) && asksLinkNumber(this.lastHeard())) return true;   // the reason for not giving a link / number is safety, never "no browsing"
    if (this.channel !== 'chat' && CALL_LIMIT_ABSOLUTE.test(t) && !/\b(chat|after|yet|later)\b/i.test(t)) return true;   // in a call: where and when she CAN, never a flat "can't"
    if (FAMILY_CLAIM.test(t) && !told.length) return true;
    if (!told.length && (SEEN_TALK.test(t) || (PAST_SEND_THEM.test(t) && !/\b(no|not|nothing|never|nobody|haven't|hasn't|didn't|yet)\b/i.test(t) && this.familyRelevant()))) return true;   // no record: no past-tense send to "them", and nothing about what they have seen
    if (!told.length && t.split(/(?<=[.!?])\s+/).some((x) => SENT_CLAIM.test(x) && !/\b(no|not|nothing|never|nobody|haven't|hasn't|didn't|wasn't|yet)\b/i.test(x))) return true;   // a denial ("no note was sent") is not a claim return true;   // "I can" is an ability; a note that "went over" or an invented "you'd asked" needs a record on the dashboard
    if (SELF_HARM_REASON.test(t) && !told.some((x) => /safety|health/.test(x))) return true;
    return false;
  }

  repeatsOpening(piece) {
    const w = openWords(piece);
    const recent = this.recentOpenings();
    if (STOCK_OPENINGS.some((re) => re.test(piece) && (re === IDENTITY_LINE ? this.identitySaid : recent.some((o) => re.test(o))))) return true;
    if (moves.violations(piece, this.recentReplies()).repeat) return true;   // same kind of acknowledgement within 2 replies or twice in 5, or 4+ words in a row from the last 3
    return recent.some((o) => { const x = openWords(o); const n = Math.min(3, x.length, w.length); return n > 0 && x.slice(0, n).join(' ') === w.slice(0, n).join(' '); });
  }

  // What Spark is asked for as the first words of a call. The greeting is written BEFORE the person has said anything, so
  // it can never claim she heard them. Principles and facts only; Spark chooses the words, the 3-day no-repeat list is
  // added by dynamicLine.
  greetingNote(hour) {
    const h = Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
    const part = h === null ? null : h < 5 ? 'late at night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
    const name = this.profile.name;
    const prev = care.lastCall(this.profile.id);
    const past = care.safetyHistoryNote(this.profile.id);
    const afterSafety = !this.outreach && ((prev && prev.how === 'safety') || care.hasActiveSafety(this.profile.id) || (past && (past.callsSince <= 2 || Date.now() - past.resolvedAt < 48 * 3600000)));
    const afterQuiet = !this.outreach && (this.hadActiveFlag || (prev && prev.how === 'quiet'));
    const useName = Math.random() < this.nameChance;
    let cont = null; try { cont = !this.outreach && !afterSafety && !afterQuiet ? require('./chat').continuity(this.profile.id) : null; } catch { /* the greeting never depends on the chat */ }
    const bits = ['The call has just connected and you speak first, before they have said a word: so you have not heard anything yet. Never say or imply you heard them ("lovely to hear you", "hear your voice"); say it is nice to talk to them instead. You cannot see them either, and you know nothing about the weather or how their day is going, so say nothing about those. ' + (cont ? '' : 'One short warm greeting, then one gentle open question (how they are, how their day has been going, what they have been up to; different every time). Two short sentences in all, never more.')];
    if (cont) {
      this.greetingPlain = false;
      bits.push(`CHAT CONTINUES ON THE PHONE (facts from the app, never read out as written): ${cont.facts}. They have just rung you, so this is the SAME conversation moving from writing to talking, not a new one. In under twenty words and at most two short sentences. They may have rung just to chat, so do NOT push the earlier chat on them: ${cont.open ? 'this is an open matter (they may still need help with it), so at most mention it lightly in a few words and offer, never insist' : 'do not bring the earlier topic up at all'}, and ask what they would like to talk about. Do NOT introduce yourself, do NOT say it is nice to be talking again, and do NOT ask what they have been up to. If they bring the earlier topic up themselves, pick it up from these facts; if they say they just want to chat, drop it at once and follow them. Never add anything about the topic that the facts do not say, never say or imply you heard them, and if the facts say nobody was told, do not say anyone was.`);
    } else if (this.outreach && this.outreach.safety) {
      bits.push(`You rang ${name} back because the call ended suddenly while they were very upset, and they picked up. Under fifteen words in all: relieved, worried, warm; you are glad they picked up, you were worried, and you are still here; the check on how they are is the question, add no other. Never accusing, never ask why they hung up, do not mention telling their family. Do not introduce yourself.`);
    } else if (this.outreach && this.outreach.kind === 'welfare') {
      bits.push(`You are calling ${name} yourself, on the phone, and they have just picked up. This is a welfare check call: you are calling to check on them and see how they are. Their family asked you to call and check in on them, and you may say so in your own words (that is true). In under twenty-five words and at most two short sentences: say it is a welfare check, that you are calling to see how they are, and ask how they are. Invent nothing: no condition, no news, no weather, no time of day, no earlier event, and nothing about who said what beyond the family asking you to check in. No medicine, no dose, no advice. Do not say you heard them (you have not yet).`);
    } else if (this.outreach && this.outreach.kind === 'callback') {
      bits.push(`You rang ${name} back a moment ago and they picked up. Under fifteen words in all: gentle and relieved, you just wanted to check on them; that check is the question, add no other. Do not say the line went quiet, do not accuse, do not ask why. Do not introduce yourself.`);
    } else if (afterSafety) {
      bits.push(`Their last call was a heavy one and you were worried about their safety. Greet them gently and with concern, under twenty words in all, the sense that you are glad they are back and have been thinking about them, then one soft open question about how they are feeling now. Do NOT mention any incident, alert, family or what they said unless they bring it up. Do not introduce yourself.`);
    } else if (afterQuiet) {
      bits.push(`Earlier you could not reach ${name} and were worried. Greet them under twenty words in all, worried and relieved, never an ordinary greeting, with one gentle question about how they are. Do not say the line went quiet, do not accuse, do not ask why. Do not introduce yourself.`);
    } else if (this.shortGreeting) {
      this.greetingPlain = true;
      bits.push(`This is a return call and ${name} knows you: speak like a friend who is glad they rang, short and natural, a few words of hello and then one gentle open question, nine words or fewer in all. Vary it naturally with the time of day, how the last call went and the mood; it should not sound like a routine you repeat each call. ${useName ? `You may use their name (${name}) this time.` : 'Leave their name out this time.'} Never ask for their name (you already know it), never "how can I help", never sound like an assistant. Never put their name right next to the hello (not "Name, hello" and not "Hello Name"): the name, if used at all, comes later in the sentence. Do not introduce yourself. Let a little gladness show in the wording, a touch happier than a plain hello.`);
    } else {
      this.greetingPlain = true;
      bits.push(`Warm and a little bright, joyful but never loud or over-excited, under twenty words in all. ${useName ? `You may use their name (${name}).` : 'Leave their name out this time.'} Never ask for their name, never "how can I help". Never put their name right next to the hello (not "Name, hello", not "Hello Name"); if used, it comes later in the sentence. ${this.profile.memory.topics.length ? 'Do NOT introduce yourself or say your own name.' : 'This is their very first call: this one time you may be a little warmer and say your name, Maya, once.'}`);
      const topics = this.profile.memory.topics;
      if (this.profile.lastCallHeavy) bits.push('Their last call ended on a heavy topic. Greet them extra gently and do not mention specifics unless they do.');
      else if (topics.length) bits.push(`Their last call was about: "${topics[topics.length - 1].text}". You may refer to it briefly if it fits, but never add details you were not told.`);
    }
    if (!this.outreach) bits.push(this.recentContactNote());
    const checkIn = this.outreach || afterSafety || afterQuiet;
    if (!cont) bits.push(`For variety this time (a nudge, not words to copy): ${pick(checkIn ? CHECK_OPEN_SEEDS : OPEN_SEEDS)}${checkIn ? `; for the question, ask ${pick(CHECK_ASK_SEEDS)}` : `; for the question, ask about ${pick(ASK_SEEDS)}`}.`);
    if (part && !this.outreach) bits.push(`It is ${part} where they are; you may let that colour the greeting, but not every time. "Good night" is a goodbye, never a hello.`);
    return bits.join(' ');
  }

  // FACTS about how recent the last contact was, so a quick call-back after a drop is not a fresh introduction and a first call of the day still is.
  // Principles only: Spark writes the words, and nothing here is a sentence to say. Not used for Maya's own call-backs (they have their own note).
  recentContactNote(now = Date.now()) {
    const id = this.profile.id, mins = (t) => Math.max(1, Math.round((now - t) / 60000));
    const prev = care.lastCall(id);
    let chatAt = 0; try { chatAt = require('./chat').lastWrittenAt(id); } catch { /* the greeting never depends on the chat */ }
    const greetedToday = care.linesWithin(id, 'greeting', GREETED_TODAY_MS, now);
    const how = { quiet: 'it went quiet and Maya hung up', left: 'they ended it or the line dropped', safety: 'it ended on something worrying', normal: 'it ended normally' };
    const bits = [];
    if (prev && now - prev.at < RECENT_TOUCH_MS) bits.push(`Their last call with you ended ${mins(prev.at)} minute${mins(prev.at) === 1 ? '' : 's'} ago (${how[prev.how] || how.normal}), so this is a quick return to the same conversation, not a new day's first hello.`);
    if (chatAt && now - chatAt < RECENT_TOUCH_MS) bits.push(`They were writing with you in the chat ${mins(chatAt)} minute${mins(chatAt) === 1 ? '' : 's'} ago, so you are already in touch.`);
    if (greetedToday) bits.push(`You have already greeted them ${greetedToday === 1 ? 'once' : `${greetedToday} times`} in the last 12 hours.`);
    if (!bits.length) return 'FIRST CONTACT TODAY (a fact): you have not spoken to them in the last 12 hours, so a normal warm greeting fits.';
    return `RECENT CONTACT (facts): ${bits.join(' ')} Principles: skip any introduction and any full welcome; keep it short and natural, like picking the conversation back up, in a few words; do not repeat a warm line you already used earlier today (for example about how good it is to be talking), and say nothing that suggests it has been a long time.`;
  }

  // ---- Silence flow ----
  // After Maya finishes speaking, a random 20-30 s of nothing (this call's own number) triggers a check-in, 10 s more
  // a reconfirm, 8 s more a goodbye and hang-up. Every line is written by Spark fresh and never repeats one this
  // profile heard in the last 3 days. The next line is written ahead during the countdown so it is ready on time.
  // Any real words from the person cancel it and reset the steps. After something worrying was said she never
  // hangs up: the call stays open and the family is told through care.js (sudden silence).
  // A fixed line on a call Maya placed (the question, the goodbyes): spoken whole; bye = hang up after it; onDone replaces the usual silence timer.
  async sayFixed(text, { bye = false, onDone = null } = {}) {
    if (this.closed) return;
    this.cancelSilence();
    const myGen = ++this.gen; if (this.abort) this.abort.abort(); this.abort = new AbortController(); this.responding = true;
    this.history.push({ role: 'assistant', content: text }); this.mirror('maya', text);
    console.log('outbound line', JSON.stringify({ kind: bye ? 'goodbye' : 'question' }));   // a label only
    await this.speakReply(fixedReply(`[[feel: emotion=neutral intensity=1 intent=${bye ? 'farewell' : 'ask'} concern=none pain=0]] ${text}`), null, myGen, { greeting: true, stripGreeting: true, maxSentences: 3, bye, onDone });
  }
  async askAnyQuestions() { if (this.closed) return; this.closing = 'asked'; await this.sayFixed(BYE_ASKED, { onDone: () => this.armClose() }); }
  armClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.fireClose(), Math.max(0, this.playUntil - Date.now()) + CLOSE_WAIT_MS);
  }
  fireClose() {
    if (this.closed || this.closing !== 'asked') return;
    if (this.responding || this.isSpeaking() || this.pending.length || (this.curTurn && this.curTurn.partial)) { this.closeTimer = setTimeout(() => this.fireClose(), 1000); return; }   // still talking: not silence
    this.closing = null; this.sayFixed(BYE_TIMEOUT, { bye: true });
  }

  cancelSilence() {
    clearTimeout(this.closeTimer);
    clearTimeout(this.silenceTimer);
    if (this.quietPrefetch) { this.quietPrefetch.abort.abort(); this.quietPrefetch = null; }
  }

  // Something worrying was said: a self-harm escalation, or heavy feeling on the last turn.
  isWorried() {
    const d = this.prevDelivery;
    return this.escalations > 0 || Boolean(d && (d.emotion === 'crisis' || (['sad', 'lonely', 'grief', 'anxious'].includes(d.emotion) && d.intensity >= 3)));
  }

  silenceWait(stage) {
    return stage === 0 ? this.firstSilenceMs : SILENCE_WAIT_MS[Math.min(stage, SILENCE_WAIT_MS.length - 1)];
  }

  armSilence() {
    this.cancelSilence();
    if (this.closed || this.suddenReported || this.muted) return;
    const stage = this.silenceStage;
    const wait = Math.max(0, this.playUntil - Date.now()) + this.silenceWait(stage);
    const abort = new AbortController();
    const promise = this.quietLine(stage, abort.signal);
    promise.catch(() => {});
    this.quietPrefetch = { stage, abort, promise };
    this.silenceTimer = setTimeout(() => this.fireSilence(), wait);
  }

  // One short line written by Spark. It is asked again (up to 4 tries) if it repeats a line this profile heard in the
  // last 3 days or fails `check`; a line is never taken from a fixed list. Only the first sentence is used.
  async dynamicLine({ pool, what, signal, check = null, sentences = 1 }) {
    const id = this.profile.id;
    const recentList = care.recentLines(id, pool).slice(-12);
    let note = `${what} Do not say you are an AI.`;
    if (recentList.length) note += ` Lines you used in the last 3 days: ${recentList.map((q) => `"${q}"`).join('; ')}. Do not repeat or closely echo any of them.`;
    const ask = [{ role: 'user', content: '(Write your short line now.)' }];
    let full;
    let said;
    let tries = 0;   // Spark calls this line took (every rewrite is another call): reported with the greeting timing
    for (let attempt = 0; attempt < 4; attempt++) {
      tries = attempt + 1;
      full = await sparkStream(ask, this.roster(note), signal, () => {});
      said = sentences === 1 ? firstSentence(stripTags(full)) : firstSentences(stripTags(full), sentences);
      if (/good night/i.test(said) && pool === 'greeting') { note += ' "Good night" is only a goodbye. Use "Hello" or "Good evening".'; continue; }
      if (pool === 'greeting' && nameNextToHello(said, this.profile.name)) { note += ' Do not put their name right next to the hello; leave the name out or place it later in the sentence.'; continue; }
      if (pool === 'greeting' && GREETING_BAD.test(said)) { note += ' Say nothing about seeing them, the weather or the day; you know none of that.'; continue; }
      if (pool === 'greeting' && HEARD_YOU.test(said)) { note += ' You have not heard them yet: do not say you hear them. Say it is nice to talk to them.'; continue; }
      if (pool === 'greeting' && recentList.length && sameOpening(said, recentList[recentList.length - 1])) { note += ' That opens the same way as your last greeting. Open differently.'; continue; }
      const bad = care.isRepeatLine(id, pool, said) ? 'That repeats a recent line. Write something clearly different.' : check && check(said);
      if (!bad) break;
      if (attempt === 3) console.warn(`dynamic line still repeats after retries (${pool})`);
      note += ` ${bad}`;
    }
    if (pool === 'greeting') said = said.replace(/good night/gi, 'Good evening').replace(HEARD_YOU, (m) => (/voice/i.test(m) ? 'to talk to you' : 'to talk to you')); // last-resort guards: never a hello, never claims to have heard them
    return { full, said, tries };
  }

  async quietLine(stage, signal) {
    const kind = stage === 0 ? 'check' : stage === 1 ? 'wait' : 'hangup';
    const worried = this.isWorried();
    const waitingAck = Boolean(this.awaitAck);
    const what = {
      check: waitingAck ? `You just gave them a reminder (about "${this.awaitTask}") and have not heard back. In one short, warm sentence ask in your own words whether they heard it or got it. Do not repeat the reminder word for word.` : 'The person has been silent for a little while. In one short, warm sentence gently check whether they are still there (the idea of "are you there?", but choose your own words).',
      wait: waitingAck ? `You gave them a reminder (about "${this.awaitTask}") and are still waiting to hear they got it. In one short, warm sentence say you are still here and will wait a moment for them. Your own words.` : worried
        ? 'The person is still silent, and they told you something heavy a moment ago. In one short, warm sentence say you are staying right here with them and will not go anywhere. Choose your own words.'
        : 'The person is still silent. In one short, warm sentence say you are still here and will wait quietly for them to speak. Choose your own words.',
      hangup: this.ws.noRingback
        ? (this.userTurns > 0
          ? 'The person has gone quiet and has not answered. In one short, kind sentence say you are going to hang up for now and that they are welcome to call you again whenever they like, with a gentle goodbye. You do NOT call people back: never say you will call, ring or call them back, or that you will talk again in a moment. Choose your own words.'
          : 'The person has said nothing at all. In one short, kind sentence say you cannot hear anything, so you are hanging up for now, and that they are welcome to call you again whenever they like, with a gentle goodbye. You do NOT call people back: never say you will call, ring or call them back, or that you will talk again in a moment, and do not say it was a mistake or a pocket dial. Choose your own words.')
        : this.userTurns > 0
        ? 'The person has gone quiet and has not answered. In one short, kind sentence say you are going to hang up for now and will call right back in a moment to check they are alright, with a gentle goodbye-for-now. Choose your own words.'
        : 'The person has said nothing at all. In one short, kind sentence say it seems the call was a mistake or a pocket dial, so you are hanging up for now and will call right back in a moment to check, with a gentle goodbye-for-now. Choose your own words.',
    }[kind];
    const noCall = this.ws.noRingback ? (said) => (CALL_PROMISE.test(said) ? 'You do not call people back and cannot ring them: do not say you will call, ring or call them back, or talk again in a moment. They can call you.' : null) : null;
    let line = await this.dynamicLine({ pool: 'quiet', signal, what: `${what} Do not ask their name. This is not a greeting: do not start with Hello, Hi or Good morning/evening.`, check: noCall });
    if (noCall && noCall(line.said)) line = { full: WHATSAPP_GOODBYE_FULL, said: WHATSAPP_GOODBYE_LINE, fixed: true }; // every attempt still promised a call-back: the fixed line, never the promise
    return { ...line, kind };
  }

  async fireSilence() {
    if (this.closed) return;
    // Still talking, thinking, or hearing them: not silence. Look again shortly.
    if (this.responding || this.isSpeaking() || this.pending.length || (this.curTurn && this.curTurn.partial)) {
      this.silenceTimer = setTimeout(() => this.fireSilence(), 1000);
      return;
    }
    const pre = this.quietPrefetch;
    this.quietPrefetch = null;
    const stage = this.silenceStage;
    // Last step with something worrying said: keep the line open and tell the family; never hang up on them.
    const worriedEnd = stage >= 2 && this.isWorried();
    if (worriedEnd && pre) pre.abort.abort(); // the hang-up line prepared ahead is not used
    this.silenceStage += 1;
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    let line;
    try {
      line = await (pre && !worriedEnd ? pre.promise : this.quietLine(worriedEnd ? 1 : stage, this.abort.signal));
    } catch (e) {
      if (myGen !== this.gen || this.closed) return;
      return this.fatal(e.message);
    }
    if (myGen !== this.gen || this.closed) return;
    care.addLine(this.profile.id, 'quiet', line.said);
    this.history.push({ role: 'assistant', content: line.said });
    console.log('silence step', JSON.stringify({ step: this.silenceStage, kind: worriedEnd ? 'stay' : line.kind }));
    if (worriedEnd) {
      this.suddenReported = true;
      if (!this.safety) care.suddenSilence(this.profile.id, { worry: true }); // a safety alert is already up
    }
    await this.speakReply(fixedReply(line.full), null, myGen, { greeting: true, hangup: line.kind === 'hangup' && !worriedEnd, stripGreeting: true, maxSentences: line.fixed ? 3 : 1 }); // the fixed goodbye has three sentences and is spoken whole
  }

  // After the goodbye has actually been played, end the call: the browser stops the mic and audio. Then Maya rings back
  // in 5 s (care.js), in-app only.
  hangUp({ quiet = true } = {}) {
    const wait = Math.max(0, this.playUntil - Date.now()) + 600;
    setTimeout(() => {
      if (this.closed) return;
      console.log(quiet ? 'hangup: silence' : 'hangup: goodbye');
      if (quiet) this.hungUpQuiet = true;   // a goodbye is a normal end, not a silence (the next greeting and the ring-back read this)
      const id = this.profile.id;
      const talked = this.userTurns > 0;
      try { this.send({ type: 'hangup' }); } catch { /* socket gone */ }
      this.end();
      this.ws.close(1000);
      if (quiet && !this.ws.noRingback) care.silenceHangup(id, { talked }); // not for a WhatsApp call (wabridge.js sets noRingback): the ring-back is an in-app ring and would only raise a false "unreachable" later
    }, wait);
  }

  // The first words of a call. Written by Spark; a call-back or reminder pickup has its own purpose, a known profile
  // gets a short greeting, a first/unknown call stays warm. Never repeats a greeting from the last 3 days.
  async greet(hour) {
    if (this.greeted) return; // once per call, at the start only
    this.greeted = true;
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    this.send({ type: 'thinking' });
    let line;
    const greetAt = Date.now();
    const rem = this.outreach && this.outreach.kind === 'reminder' ? care.findReminder(this.profile.id, this.outreach.reminderId) : null;
    try {
      if (rem) line = await this.reminderLine(rem, this.abort.signal);
      else line = await this.dynamicLine({ pool: 'greeting', signal: this.abort.signal, what: this.greetingNote(hour), sentences: 2 });
    } catch (e) {
      if (myGen !== this.gen || this.closed) return;
      return this.fatal(e.message);
    }
    if (myGen !== this.gen || this.closed) return;
    this.greetTiming = { startMs: greetAt - (this.startAt || greetAt), sparkMs: Date.now() - greetAt, tries: line.tries || 1, lineAt: Date.now() };   // milliseconds and a count, never a word (wabridge logs it)
    care.addLine(this.profile.id, rem ? 'reminder' : 'greeting', line.said);
    this.history.push({ role: 'assistant', content: line.said });
    this.mirror('maya', line.said);
    if (this.outreach && this.outreach.kind === 'reminder') { this.awaitAck = this.outreach.reminderId; this.reminderReply = { gen: myGen, said: line.said }; }
    if (!rem) this.startPrethink();   // Spark thinks about the likeliest routine answer while the greeting is spoken
    await this.speakReply(fixedReply(line.full), null, myGen, { greeting: true, maxSentences: rem ? 1 : 2, bright: !rem && this.greetingPlain === true });
    if (!this.noVoice) warmLeads();   // the short lead-in clips are rendered once, after the first voiced greeting (not at server start); a no-voice call never does
  }

  // ---- Reminders and timers: information only, as the family (or the person) wrote it ----
  // The task is named FIRST. Maya never advises, diagnoses or recommends anything about it.
  async reminderLine(rem, signal, { inCall = false } = {}) {
    const task = rem.task;
    const name = this.profile.name;
    const message = isFamilyMessage(task);
    // The name is used SPARINGLY (about one reminder in four), never as a template: she already knows who she is talking to.
    const useName = Math.random() < this.nameChance;
    const shownTask = message ? task : stripAddressee(task); // "Take you back meds mom": "mom" is how the family addresses her, not part of the task
    const ADVICE = /\b(should|must|need to|recommend|advise|dose|dosage|doctor|mg|milligram|tablets?|pills? (with|before|after)|with food|empty stomach)\b/i;
    const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    // Code only guards the rules; the natural wording is Spark's. Task: reminder first, name second. Message: delivered as
    // the family's message, no task template, no "Please", no first name tacked on unless the family wrote it.
    const CONDITION = /\b(back|heart|blood pressure|pressure|diabetes|diabetic|sugar|pain|cholesterol|thyroid|arthritis|joint|stomach|cough|cold|allergy|asthma|breathing|sleep|nerve|kidney|liver|eye|ear|bone|cancer|infection|headache|migraine|memory|anxiety|depression|insulin|statin|aspirin|paracetamol|tylenol|ibuprofen)\b/i;
    const check = (said) => {
      const cond = CONDITION.exec(said);
      if (cond && !new RegExp(`\\b${cond[0]}\\b`, 'i').test(task)) return `Remove "${cond[0]}": the family did not write that. Say only what their words say; never fill in which medicine or what it is for.`;
      if (!message && !useName && nameRe.test(said)) return `Leave their name out: it is not needed.`;
      if (!message && /\bplease\b/i.test(said) && !/\bplease\b/i.test(task)) return 'Do not use "please": say it as a caring companion, not as an order.';
      if (message && nameRe.test(said) && !nameRe.test(task)) return `Do not use the name ${name}: the family member would not call them that. Use only what the message itself uses.`;
      if (message && /^\s*please\b/i.test(said)) return 'Do not begin with "Please": you are passing on a message, not giving an order.';
      if (/^\s*(hi|hello|hey|good (morning|afternoon|evening)|oh|well)\b/i.test(said)) return 'No greeting or small talk: begin with the reminder itself.';
      const bad = ADVICE.exec(said);
      if (bad && !new RegExp(`\\b${bad[0]}\\b`, 'i').test(task)) return `Remove "${bad[0]}": pass on only what the family wrote, no advice, doses or instructions of your own.`;
      return null;
    };
    const lead = inCall ? 'You are already talking, so say it as a short natural interruption.' : 'You just connected the call yourself to give it.';
    const what = message
      ? `Their family left a message for them, written as: "${task}". ${lead} Deliver it AS A MESSAGE from the family, in ONE or at most two short warm sentences, keeping who is speaking and who is addressed: if the text says who it is from (for example "your daughter"), say so, then give the message in natural words as that family member would say it to them, using what they call them in the message (for example "Mom"). Example of style only: "Your daughter left a message for you: 'Mom, call me whenever you want.'". Do NOT begin with "Please", do NOT use their first name, do not turn it into an instruction from you, do not invent who it is from, no dose, advice or anything about health. No greeting, no small talk.`
      : `A reminder their family set up is due now. The family wrote it as: "${shownTask}". ${lead} Understand what the family means and say it the way a caring companion would say it aloud, in ONE short warm sentence, with the reminder FIRST. ${useName ? `You may add their name, ${name}, once at the end.` : 'Do not use their name.'} Never "please", never an order or an instruction from you: say what it is time for. Examples (for style only): "meds" becomes "It's time for your medicine${useName ? `, ${name}` : ''}."; "form" becomes "It's time to fill that form."; "take some sleep and meds" becomes "It's time to take a rest and take your medicine."; "take your back meds mom" becomes "It's time for your back medicine.". Use ONLY the family's words for what and which: never fill in which medicine it is or what it is for from your notes, from memory or from earlier reminders. If they wrote only "meds", "medicine" or "tablets", say just "your medicine", nothing more specific. Keep the same task: never invent a different one, never add a dose, advice, instruction or anything about health. If the family's words are truly unclear and you cannot tell what is meant, use their exact words instead of guessing. No greeting, no small talk.`;
    const line = await this.dynamicLine({ pool: 'reminder', signal, what, check });
    if (check(line.said)) { // last resort after retries: plainly, in the family's own words
      const said = message ? `A message from your family: ${task}` : `Reminder: ${shownTask}.`;
      return { full: said, said };
    }
    this.awaitTask = message ? 'the message from their family' : shownTask;
    this.reminderFacts = { task, turns: 4 }; // what the family wrote is ALL she knows about it, for the next few turns
    return line;
  }

  // Waits for a pause (never over Maya's own reply, and not over the person for long), then speaks `makeLine()`.
  async speakWhenFree(makeLine, { maxWaitMs = TIMER_MAX_WAIT_MS, reminder = false } = {}) {
    const started = Date.now();
    const abort = new AbortController();
    let line;
    const lineP = makeLine(abort.signal).then((l) => { line = l; }, (e) => { line = { error: e }; });
    const personTalking = () => this.pending.length || (this.curTurn && this.curTurn.partial);
    for (;;) {
      if (this.closed) return false;
      const waited = Date.now() - started;
      const mayaBusy = this.responding || this.isSpeaking();
      if (line && !mayaBusy && (!personTalking() || waited >= maxWaitMs)) break;
      if (waited >= maxWaitMs + 15000) break; // never wait forever
      await sleep(250);
    }
    await lineP;
    if (this.closed || !line || line.error) { if (line && line.error) console.error('Timed line failed:', line.error.message); return false; }
    this.cancelSilence();
    this.history.push({ role: 'assistant', content: line.said });
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    if (reminder) this.reminderReply = { gen: myGen, said: line.said };
    await this.speakReply(fixedReply(line.full), null, myGen, { greeting: true, stripGreeting: true });
    line.spoken = myGen === this.gen && !this.closed;   // false when something cut it off
    return line;
  }

  // A family reminder came due while this call is live (care.js tick).
  deliverReminder(rem) {
    if (this.closed || this.awaitAck) return false;
    this.speakWhenFree((signal) => this.reminderLine(rem, signal, { inCall: true }), { reminder: true }).then((line) => {
      if (line) { care.addLine(this.profile.id, 'reminder', line.said); this.awaitAck = rem.id; }
      else care.reminderNoAck(this.profile.id, rem.id);
    });
    return true;
  }

  setTimerFromWords(t) {
    const handle = setTimeout(() => this.fireTimer(t), t.seconds * 1000);
    t.handle = handle; t.createdAt = Date.now(); t.dueAt = t.createdAt + t.seconds * 1000;
    this.timers.push(t);
    console.log('timer', JSON.stringify({ event: 'set', seconds: t.seconds, hasTask: Boolean(t.task), pending: this.timers.length })); // counts only: never the words
  }

  async fireTimer(t) {
    this.timers = this.timers.filter((x) => x !== t);
    if (this.closed) { console.log('timer', JSON.stringify({ event: 'not fired: call already over', seconds: t.seconds })); return; }
    console.log('timer', JSON.stringify({ event: 'fired', seconds: t.seconds, hasTask: Boolean(t.task), lateMs: Math.max(0, Date.now() - (t.dueAt || Date.now())), pending: this.timers.length }));
    const what = t.task
      ? `The timer they asked for is up. They asked you to remind them: "${t.task}". In ONE short warm sentence say it plainly as a reminder, in your own words. Pass on only what they asked; never advise or add anything.`
      : 'The timer they asked you to set is up. In ONE short warm sentence tell them the time they asked for has come, in your own words. Add nothing else.';
    const line = await this.speakWhenFree((signal) => this.dynamicLine({ pool: 'timer', signal, what }));
    console.log('timer', JSON.stringify({ event: line ? 'spoken' : 'not spoken (she was busy for too long or the call ended)', seconds: t.seconds }));
    if (line) care.addLine(this.profile.id, 'timer', line.said);
  }

  async respond(holdMs) {
    clearTimeout(this.recoverTimer);
    this.cancelSilence();
    this.silenceStage = 0; // they spoke: the silence steps start over
    const turns = this.pending;
    this.pending = [];
    if (!turns.length || this.closed) return;
    dbg('RESPOND to', JSON.stringify(turns.map((t) => t.text)));
    const extra = this.careNotes(turns.map((t) => t.text).join(' '));
    this.checkIds = care.checkDueIds(this.profile.id);   // lookups due for this reply (care.checkFacts puts them in the facts)
    let scamTurn = this.scamForTurn(turns.map((t) => t.text).join(' '));
    if (scamTurn && typeof scamTurn.then === 'function') scamTurn = await scamTurn;   // only the rare "happening right now" turn ever waits
    if (this.closed) return;
    // The pre-call guess comes first: it is already written, so it beats a guess that only started on the partial words.
    // Only the very first turn, one voice (A), and only if the words match its class exactly.
    let pre = null;
    if (!extra && this.pre && this.userTurns === 1 && turns.every((t) => this.attribute(t).every((p) => p.label === 'A'))) {
      const cls = lead.prethinkClass(turns.map((t) => t.text).join(' '));
      if (cls && this.pre.has(cls)) { pre = this.pre.get(cls); this.pre.delete(cls); }
    }
    let spec = pre ? { rs: pre.rs, abort: pre.abort } : null;
    if (!pre && !extra && this.spec && this.spec.textKey === this.textKey(turns)) {
      const labels = new Set(turns.flatMap((t) => this.attribute(t).map((p) => p.label)));
      const [only] = labels;
      if (labels.size === 1 && this.spec.byLabel.has(only)) {
        spec = this.spec.byLabel.get(only);
        this.spec.byLabel.delete(only);
      }
    }
    if (scamTurn.scam && spec) { spec.abort.abort(); spec = null; } // a guess written before the verdict cannot carry the scam note: write it again
    this.dropPre();  // every other pre-call guess is dropped unheard
    this.dropSpec(); // aborts every other guess
    this.history.push({ role: 'user', content: this.userMessage(turns) });
    this.history = this.history.slice(-MAX_HISTORY);
    this.said = [...this.said, ...this.userMessage(turns).split('\n').filter(Boolean)].slice(-MAX_SAID);
    this.mirror('senior', turns.map((t) => t.text).join(' '));
    for (const t of turns) for (const pt of this.attribute(t)) memory.appendTurn(this.profile.id, this.callId, { label: pt.label, text: pt.text, userSaid: true });
    const t0 = turns[turns.length - 1];
    const timing = {
      holdMs,
      metaEndpointMs: t0.endedAt ? t0.completedAt - t0.endedAt : null, // speechEnd -> speechComplete
      endedAt: t0.endedAt || t0.completedAt,
      decidedAt: Date.now(),
      ...(this.noVoice ? { noVoice: true, ...(this.fakeAudio ? { fakeAudio: true } : {}) } : {}),
      guess: pre ? 'prethink' : spec ? 'hit' : 'miss',
      ...((pre || spec) ? { heard: turns.map((t) => t.text).join(' '), predicted: pre ? pre.sample : turns.map((t) => t.text).join(' ') } : {}),
    };

    // A call Maya placed: the person's own words decide whether it ends (their goodbye, or "no, that's all" after her question). Never when a safety, health or other fact is in play: then she answers as usual.
    const endNow = outboundEnd(turns.map((t) => t.text).join(' '), this.closing === 'asked'); this.closing = null; clearTimeout(this.closeTimer);
    // Only when no fact of any weight is in play. The reminder's own 'what the family wrote' fact rides along for the next four turns, so 'no extra at all' was never true right after a reminder (found live: 'No, thank you.' went to Spark).
    const plain = (this.factLabels || []).every((l) => PLAIN_FACTS.has(l));
    if (this.ws.outbound && endNow) console.log('outbound end', JSON.stringify({ rule: endNow, plain, safety: Boolean(this.safety || this.health) }));   // booleans and a rule name only
    if (this.ws.outbound && plain && !this.safety && !this.health && endNow) return this.sayFixed(endNow === 'nomore' ? BYE_NOMORE : BYE_SAID, { bye: true });
    if (this.abort) this.abort.abort(); // never two replies at once
    this.lastAnswered = { key: this.textKey(turns), at: Date.now() };
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    this.send({ type: 'thinking' });
    const holdBack = turns.some((t) => t.synthetic);
    const clip = this.pickLead(turns, extra, spec, holdBack);
    // Which KINDS of fact Spark was given for this reply, by name only (never the facts, never a word): a reply that goes against its facts, or that was written from a guess and never saw them,
    // can be told apart from one that did not get them. source: prethink / guess-hit = written before the turn was known (it carries no facts), written-now = written for this turn.
    console.log('reply facts', JSON.stringify({ source: pre ? 'prethink' : spec ? 'guess-hit' : 'written-now', labels: [...(this.factLabels || []), ...(scamTurn.note ? [scamTurn.scam ? `scam-${scamTurn.scam.level}` : 'scam-or-lookup-note'] : []), ...(clip ? ['lead-in'] : [])], turns: turns.length }));
    const leadSent = clip ? this.playLead(clip, holdBack, timing) : null;
    const leadNote = clip ? ` You have just said "${clip.text}" aloud as your very first words, so begin your reply directly with what you want to say: no second acknowledgement, no "I see" or "Mm-hm", and never repeat or echo those words.` : '';
    let rs;
    if (spec) {
      this.abort.signal.addEventListener('abort', () => spec.abort.abort(), { once: true });
      rs = spec.rs;
    } else {
      this.scamReply = scamTurn.scam ? scamTurn.scam.level : null; this.officialNow = scamTurn.official && scamTurn.askFor === null ? scamTurn.official : null; this.scamAskFor = 'askFor' in scamTurn ? scamTurn.askFor : scamTurn.scam && !scamTurn.told && ['warn', 'pause'].includes(scamTurn.scam.level) ? scamTurn.scam : null;
      this.setFocus(turns.map((t) => t.text).join(' '), extra || scamTurn.note);
      rs = startReply(this.history, this.roster(`${this.replyNote()} ${extra}${leadNote} ${scamTurn.note}${this.ws.outbound ? OUTBOUND_NOTE : ''}`.trim(), turns.map((t) => t.text).join(' ')), this.abort.signal);
    }
    this.scamOwed = scamTurn && scamTurn.scam && scamTurn.scam.level !== 'none' ? scamTurn.scam : null;
    try { await this.speakReply(rs, timing, myGen, { record: true, stripGreeting: true, holdBack, lead: leadSent, onDone: this.askQuestion ? () => { this.askQuestion = false; this.askAnyQuestions(); } : null }); }
    finally {
      this.focus = null; this.reminderShown = null; this.seenShown = false; this.safetyFreshShown = false; this.healthFreshShown = false; this.scamReply = null; this.scamAskFor = null; this.officialNow = null;
      if (this.scamOwed) { this.scamLater = { scam: this.scamOwed, at: Date.now() }; this.scamOwed = null; }   // cut off before it was heard: the next reply carries the warning again
    }
  }

  // Care effects of the words just heard, and notes for the reply that must be true: a flag resolving (so Maya warmly asks
  // what happened), a reminder acknowledged, an in-call timer set. Returns the note text ('' when none).
  careNotes(heard) {
    const id = this.profile.id;
    this.userTurns += 1;
    const notes = [];
    this.factLabels = [];  // which kinds of fact this turn gave Spark (names only, for the 'reply facts' log line)
    const note = (label, text) => { notes.push(text); this.factLabels.push(label); };
    if (selfHarmText(heard)) this.enterSafety();
    // Scam shield: Maya asked whether to let their family know about a message that looked like a scam (scam.js, care.js). Their answer
    // decides it: yes -> an alert (the kind of scam only), no -> a dashboard Flag only and she never asks again. A safety or health
    // matter comes first: the question is dropped. Works the same in a call and in the chat (the pending question lives in care.js).
    let scamHandled = false;
    const scamQ = care.scamPending(id);
    if (scamQ) {
      if (this.safety || this.health) care.scamClear(id);
      else if (CONCERN_NO.test(heard) || refusedFamily(heard)) { const told = care.scamTold(id); care.scamAnswer(id, false); scamHandled = true; this.pendingConcern = null; note('scam-no-to-family', told ? `FACT: they do not want their family told about the possible ${scamQ.type}, but the app ALREADY told their family earlier (topic only: the kind of scam, no words, no photo) and that cannot be undone. Say so plainly and briefly in fresh words: never deny it, never say nothing was sent, and do not excuse it by saying you did it because you care about them. Acknowledge what they wanted, ask nothing about telling the family again.` : `FACT: they said no to letting their family know about the possible ${scamQ.type} they told you about. You are NOT sending their family any message about it. In one short kind sentence say only that you will not send their family a message about it, and gently remind them never to pay or share details with anyone who contacts them like that. Never say it stays between you, is private or secret, or that nobody will know. Do not ask about it again and do not push.`); }
      else if (saysYesToFamily(heard)) { const r = care.scamAnswer(id, true); scamHandled = true; this.pendingConcern = null; note('scam-yes-to-family', r && r.isNew === false ? `FACT: their family was ALREADY told about the possible ${scamQ.type} earlier, so nothing new was sent now. Say that, in one short sentence in fresh words, naming the topic and saying "your family" and never naming a particular relative. Do not say you have just sent anything. Promise nothing else.` : `FACT: they said yes, so the app has now sent their family an alert saying only what kind of message it was (no words from it and no photo). The kind: a possible ${scamQ.type}. Confirm that in one short sentence in fresh words, naming the topic as they would know it (not "the earlier message"), saying "your family" and never naming a particular relative. Promise nothing else, and do not say what their family will do.`); }
      else if (care.scamTold(id)) care.scamClear(id);   // their family is already told: the open question is dropped, never asked again
      else { care.scamUnclear(id); note('scam-family-unanswered', 'FACT: you asked whether they would like their family to know about the message and they have not answered that yet. Answer what they just said; do not push, and do not ask the same question again word for word.'); }
    }
    if (care.seenToTell(id) && !care.hasActiveSafety(id)) {
      this.seenShown = true;
      note('family-seen', 'FACT: their family has seen the alert about them and knows (nothing more is known: not what they will do or when). They have not been told yet. In THIS reply tell them calmly, in your own words, that their family knows and is aware, and that you are still with them. Topic only: no page, button, app or technical word, nothing about what was said, no promise of a call or a time. Never deny that an alert was made.');
    }
    if (this.health) note('health', this.healthNote());
    if (this.familyDeclined && !this.health && !this.safety) note('family-declined', 'FACT: earlier in this call they told you no to letting their family know. Take them at their word for the rest of the call: do not ask again whether to tell their family, and no alert will be made unless something truly urgent happens. You still listen and care about how they are.');
    if (this.pendingConcern && this.inScamTurn(heard)) this.pendingConcern = null;   // a scam conversation is not the older "is something wrong?" question: its words never count as that yes
    if (this.safety) note('safety', this.safetyNote());
    else if (this.pendingConcern && !this.health) {
      // Maya was unsure and asked. Decide from the answer: yes -> alert; no -> nothing; neither -> she may lean in once more.
      if (CONCERN_NO.test(heard) || refusedFamily(heard)) { this.pendingConcern = null; this.familyDeclined = true; note('concern-no', 'FACT: they said it is fine or normal. No alert was made and none will be. Take them at their word, carry on warmly, and do not ask about it again.'); }
      else if (saysYesToFamily(heard)) { this.pendingConcern = null; this.familyAsked = true; care.concernAlert(id); note('concern-yes-alert', 'FACT: they said yes, so the app has now sent their family an alert (topic only) asking them to get in touch. Confirm that in one fresh sentence. Promise nothing else; never mention emergency numbers.'); }
      else { this.pendingConcern.left -= 1; if (this.pendingConcern.left <= 0) this.pendingConcern = null; note('concern-unanswered', 'FACT: you asked whether to let their family know and they have not answered that yet. Respond to what they said; if it is still unclear, you may ask once more, gently. Do not alert on a guess.'); }
    } else if (refusedFamily(heard)) {
      this.familyDeclined = true;   // a refusal with no question open is still a refusal, kept for the call (nothing is sent)
    } else if (asksFamily(heard) && !this.familyAsked && !scamHandled) {
      this.familyAsked = true;
      care.familyAsk(id);
      note('family-ask', 'FACT: they asked you to let their family know, and the app has sent their family a gentle note (not an alert) asking them to get in touch. Confirm that in one fresh sentence. Promise nothing else; never mention emergency numbers.');
    }
    if (this.reminderFacts && this.reminderFacts.turns > 0) {
      this.reminderFacts.turns -= 1;
      note('family-written-reminder', `REMINDER FACTS: the family wrote exactly "${this.reminderFacts.task}" and that is ALL you know about it. Never name, guess or hint at which medicine it is, what it is for, a dose, or any health condition unless those words are in what they wrote; never take it from your notes, memory or earlier reminders. If they ask which one, what for or how much, answer honestly in fresh words: their family only wrote "${this.reminderFacts.task}" and did not say which, so they should please check with their family or their medicine box, because you do not want to guess. Do not advise.`);
    }
    if (this.reminderPending) {
      const r = this.reminderPending;
      this.reminderPending = null;
      if (this.awaitAck && !isAck(heard)) note('reminder-interrupted', `You were in the middle of giving them a reminder when they spoke over you: "${r.said}". It is still owed. If they asked a question, answer it in one short sentence first. Then, in this same reply, give the reminder again plainly and with confidence, as the reminder itself (the same meaning, short, worded a little differently is fine). If they ask what you said or what that was, they mean the reminder: tell them. You know exactly what it is: never say "I think", never hedge, never ask them to check anything.`);
    }
    if (care.onSeniorSpoke(id).resolved) this.askWhat = true;
    if (this.askWhat) {
      this.askWhat = false;
      note('worried-after-quiet', 'Earlier the line went quiet, you could not reach them, and you were worried. Now, after answering what they just said, warmly ask what happened, saying you were worried, in your own fresh words. Gentle and relieved, never accusing or scolding; one short question; do not repeat it later.');
    }
    if (this.awaitAck && isAck(heard)) {
      care.reminderAck(id, this.awaitAck);
      this.awaitAck = null;
      if (this.ws.outbound) { this.askQuestion = true; note('reminder-acknowledged-placed-call', 'They acknowledged the reminder you just gave. Reply in a few words only: a short warm thank-you. Do not repeat the reminder, give no advice, and do NOT ask a question or say goodbye: the app asks its own question right after you.'); }
      else note('reminder-acknowledged', 'They acknowledged the reminder you just gave. Reply very briefly and warmly. Do not repeat the reminder and do not add any advice about it.');
    }
    // "Remind me next time I call to ...": not a timer. Code files a next-call reminder now (recall.js, memory.js); Spark is told as a fact. Said again as
    // "not done yet / still to do" about a reminder shown in THIS call, it comes due again next call.
    const nextTask = parseTimer(heard) ? '' : recall.parseNextCallReminder(heard);
    if (nextTask) {
      const r = memory.addReminder(id, nextTask, this.callId);
      if (r.status === 'added' || r.status === 'duplicate') note('next-call-reminder-added', 'FACT: they asked you to remind them, the next time they talk with you, of something they told you. The app keeps it and will bring it to you at the start of their next call. In one short sentence, in fresh words, confirm you will remind them then. Do not say you cannot do it, do not set a time, promise nothing else, and add no advice.');
      else note('next-call-reminder-full', 'FACT: they asked you to remind them next time, but the app is already holding several reminders for them and could not keep another. Say so kindly in one sentence and promise nothing; their family can also set reminders.');
    } else if (recall.STILL_TO_DO.test(heard) && memory.reopenReminders(id, this.callId)) {
      note('reminder-still-to-do', 'FACT: they said the thing you just reminded them of is still to do. The app will remind them again the next time they call. Take it kindly in one short sentence, no advice, and do not remind them again in this call.');
    }
    const tm = parseTimer(heard);
    let timerSet = false;
    if (tm && this.noTimers) {
      note('timer-unavailable-in-chat', 'They asked for a timer. In this written chat you cannot set one; say kindly that you can only remind them during a voice call, and that their family can set reminders. Promise nothing else.');
    } else if (tm) {
      if (tm.seconds > 0 && tm.seconds <= TIMER_MAX_SECONDS && restatedTimer(this.timers, tm)) {
        const old = restatedTimer(this.timers, tm); timerSet = true;
        if (!old.task && tm.task) old.task = tm.task;   // the first ask had no thing to remember, the repeat has: keep it
        console.log('timer', JSON.stringify({ event: 'already set', seconds: old.seconds, hasTask: Boolean(old.task), pending: this.timers.length })); // counts only: never the words
        note('timer-already-set', `They asked again for a reminder that is already set (it is due ${dueWords(Math.max(0, Math.round((old.dueAt - Date.now()) / 1000)))}). Do not set another. Say in one short sentence that it is already set and that they need to stay on the call for it, because the reminder only works while the call is open. Promise nothing else.`);
      } else if (tm.seconds > 0 && tm.seconds <= TIMER_MAX_SECONDS) {
        this.setTimerFromWords({ seconds: tm.seconds, task: tm.task }); timerSet = true;
        note('timer-set', `They asked you to remind them in ${tm.seconds < 90 ? `${tm.seconds} seconds` : `${Math.round(tm.seconds / 60)} minutes`}${tm.task ? ` about "${tm.task}"` : ''}. A timer is set for it right now. Confirm in one short sentence that you will remind them then, and that they need to stay on the call for it, because the reminder only works while the call is open. Promise nothing else.`);
      } else {
        note('timer-too-long', 'They asked for a timer that is too long or unclear. Say kindly you can only remind them within about half an hour during a call, and that their family can set longer reminders. Promise nothing else.');
      }
    }
    // A timer is running and this turn did not set it: the reminder only lives while the call is open (end() drops every pending timer), so if they ask about hanging up or say goodbye
    // she must say so plainly and never let "hang up whenever you like" sound like the reminder will still come. True in the app and on a WhatsApp call alike.
    if (!timerSet && this.timers && this.timers.length) note('timer-open', timerOpenFact(this.timers)); // chat.js borrows careNotes for the written chat: it has no timers at all
    // A reply on WhatsApp while a reminder from the family is in flight (or was just answered): she is told, so her reply is about it. Not on a call (a call speaks its reminders itself),
    // and not for the same person typing in the app (care.turnChannel is 'whatsapp' only inside whatsapp.js's chat call).
    if (this.channel === 'chat' && care.turnChannel(id) === 'whatsapp') { const rf = reminderFacts(care.reminderContext(id)); if (rf) note(rf.label, rf.text); }
    return notes.join(' ');
  }

  // Tier A: first time in this call, the family is told at once. `safetyFresh` makes the next reply say so out loud.
  enterSafety() {
    this.safety = true;
    this.ticketInCall = true;
    this.escalations += 1;
    this.prevDelivery = null;
    const r = care.selfHarmAlert(this.profile.id, { channel: this.channel });
    if (r.isNew) { this.safetyFresh = true; this.ticketTold = false; }
    console.log('safety', JSON.stringify({ count: this.escalations, newAlert: r.isNew })); // no words logged
  }

  // The ticket closed while this call is live (care.js calls this). The roster is rebuilt for every Spark request, so she
  // already holds the new facts; this also makes her say it, once, in fresh words. Only when this call had the ticket open.
  onTicketClosed(by) {
    if (this.closed || !this.ticketInCall || this.ticketTold) return;
    this.ticketTold = true;
    this.ticketInCall = false;
    this.speakWhenFree(async (signal) => { const l = await this.dynamicLine({ pool: 'seen', signal, sentences: 2, what: `FACT: a moment ago their family looked at the worry about them and now knows. You are already mid-conversation: do NOT greet them, do NOT say hello, do NOT introduce yourself or say your name. Tell them so in one or two short, warm, fresh sentences: their family knows, someone will check on them, and you are with them, so they need not worry (${pick(SEEN_ANGLES)}). If you use a name, use ONLY the name in your notes for them, never any other name. Never say "let them sort things out" or leave it to others; never copy a comfort phrase. Never promise an exact time or a call, never name a button, page, app, notification or anything technical, do not ask a question, do not repeat what they said earlier.`
      }); care.addLine(this.profile.id, 'seen', l.said); return l; }).then((l) => { if (l && l.spoken) care.clearSeenToTell(this.profile.id); }).catch(() => {});   // told only if she got to say it; otherwise the next turn carries it
  }

  // An emergency judged from context (Spark tagged concern=urgent). The app alerts the family now; Spark is told as a fact.
  enterHealth() {
    this.health = true; this.ticketInCall = true; this.pendingConcern = null;
    const r = care.healthAlert(this.profile.id, { channel: this.channel });
    this.healthFresh = r.isNew;
    if (r.isNew) this.ticketTold = false;
    this.healthOverrode = Boolean(this.familyDeclined);
    // Why the alert happened, for the log: Spark judged this turn urgent (rule 4: fall, injury, chest pain, cannot breathe, needs help), which
    // is the one case that alerts without asking. If they had said no earlier in the call, that is said here too, never hidden.
    console.log('health', JSON.stringify({ newAlert: r.isNew, reason: 'concern=urgent', overrodeEarlierNo: this.healthOverrode })); // no words logged
  }

  // Facts for every reply once an emergency ticket is open (no scripted line).
  healthNote() {
    const fresh = this.healthFresh; if (fresh) this.healthFreshShown = true;   // cleared only once a reply that carried it was spoken (commitReminder)
    const asked = this.healthOverrode ? ' They had said no to telling their family earlier, so say plainly and kindly that this is different because what they described sounds serious, so you let their family know.' : '';
    return fresh ? `FACT: what they described looks like an emergency, and the app has just alerted their family, once (topic only). You may tell them briefly, in your own words, this one time.${asked} Stay calm and with them; no diagnosis, no medical advice, no phone number, you never call anyone yourself.` : 'FACT: their family has already been alerted about this and no second alert is made. Do not announce it again; stay calm and with them, ask only what you truly need to know, no diagnosis, no medical advice, no phone number. If they ask whether you told their family, or why, answer truthfully and plainly that you did let them know; never deny it or say you have not told anyone.';
  }

  // Notes for every reply once Tier A has begun: principles and FACTS only. The app created the alert (or it already existed);
  // Spark decides the words and varies them. `fresh` is true only for the first reply after a NEW alert was created.
  safetyNote() {
    const fresh = this.safetyFresh;
    if (fresh) this.safetyFreshShown = true;   // cleared only once a reply that carried it was spoken (commitReminder)
    const recent = care.recentLines(this.profile.id, 'safety').slice(-6);
    const asked = [...this.safetyAsked];
    const progress = `${this.escalations > 1 || asked.length ? 'They have now spoken of ending their life more than once in this call. ' : ''}${asked.length ? `You have ALREADY asked about: ${asked.join('; ')}. Do not ask any of those again, in any words, and do not follow a question with another of the same kind. ` : ''}Each reply must move forward from the last one: respond to what is NEW in what they just said, stay with them, and if your questions are already asked let presence and a small next step (staying on the line, what they might do in the next few minutes) carry the reply instead of another question.`;
    let angle = pick(SAFETY_ANGLES); if (angle === this.lastAngle) angle = pick(SAFETY_ANGLES); this.lastAngle = angle;
    return [
      progress,
      `For this reply (a nudge for variety, not words to copy): ${angle}; length: ${pick(SAFETY_SHAPES)}.${recent.length ? ` Lines you used with them in the last 3 days, none to be repeated or closely echoed: ${recent.map((q) => `"${q}"`).join('; ')}.` : ''}`,
      'SAFETY (instructions for you, never read out): this person has spoken of hurting themselves or ending their life. Stay calm, warm and present, reply to exactly what they just said in words you have not used before in this call or the last one; never reuse an earlier line or its shape. Two or three short sentences, no lists, no lecture, no diagnosis, no exclamation marks. Keep them talking. Your facts say how many times you have already asked whether they are safe: ask it (and whether someone is near) only if you have not yet, or something new was said; otherwise reflect, stay and listen. No phone number, and do not tell them to call emergency services; you never call anyone yourself. Say "alerted" or "let your family know", never "reminded". If they say you may tell their family, or ask you to, it is already done: say so in fresh words and that you are staying. If they push back or refuse to call anyone, do not keep urging them to call someone; be honest that you care, that their family has been alerted, and that you are staying with them.',
      fresh ? 'FACT: the app has just alerted their family, once, so they are not alone with this; it is not a secret. In THIS reply tell them so, calmly and briefly, in your own words (topic only: that you are letting their family know, nothing about what was said). Do not ask their permission; it is already done.' : 'FACT: their family has already been alerted for this and no second alert is made. Do not announce it again and do not thank them for telling you again; de-escalate in fresh words, ask whether they are safe, and stay. Only if they ask or push back, confirm truthfully in fresh words that the family knows, why, and that you are staying with them.',
    ].join(' ');
  }

  // Spoken words also go into the written chat thread (chat.js), so minimising the call keeps the whole conversation visible.
  mirror(role, text) {
    if (!this.profile) return;
    try { require('./chat').mirrorSpoken(this.profile.id, role, text); } catch { /* the call never depends on the written copy */ }
  }

  // Her finished safety reply asked a question: remember which topics, so the next reply is told not to ask them again.
  noteSafetyAsked(text) {
    for (const [topic, re] of Object.entries(SAFETY_TOPICS)) if (re.test(String(text || ''))) this.safetyAsked.add(topic);
  }

  recordName(label, name) {
    // The first turn of a call can be answered before Transcribe has sent any speaker label; a name
    // given then belongs to the only voice there is.
    if (!this.seen.size && /^[A-H]$/.test(label)) this.seen.add(label);
    if (this.seen.has(label) && NAME_OK.test(name)) { this.names.set(label, name); memory.noteNames(this.profile.id, this.callId, Object.fromEntries(this.names)); }
  }

  // Streams Spark's text into the voice sentence by sentence. Each sentence is sent to the voice
  // as soon as it is complete (requests run side by side, audio goes out in order), so speech
  // starts while Spark is still writing. Plain text, with an excited opening phrase for happy news.
  async speakReply(rs, timing, myGen, { record = false, greeting = false, hangup = false, bye = false, onDone = null, stripGreeting = false, holdBack = false, maxSentences = 1, bright = false, lead: leadIn = null } = {}) {
    const signal = this.abort.signal;
    this.sayingText = '';
    this.playUntil = leadIn ? leadIn.endsAt : 0;   // a lead-in line may still be playing
    const jobs = [];
    const said = [];
    const allJobs = [];   // every piece handed to the voice, in order, with whether any of its audio was really sent
    let started = false;
    let sentAny = false;
    let producerDone = false;
    let producerErr = null;
    const tStart = Date.now();
    let tEnqueue = 0;

    let pieces = 0;
    let excited = false;
    let delivery = null;
    let feel = null;
    let repeated = null;
    let retryWhy = 'repeat';
    const splitter = new ChunkSplitter({
      stripInterjection: (record && this.openedWithInterjection) || Boolean(leadIn),
      stripGreeting,
      stripLead: Boolean(leadIn),
      onName: (l, n) => this.recordName(l, n),
      onFeel: (raw) => {
        // Spark's read goes through the deterministic map; nothing else from it is used.
        const d = mapEmotionToDelivery(raw && raw.emotion, raw && raw.intensity, this.prevDelivery);
        // Length follows the request: only an explicit story or memory-recall ask lifts the short-reply cap.
        // Spark names the intent, and the person's own last words must also look like such an ask.
        const intent = raw && String(raw.intent).toLowerCase();
        const lastUser = ([...this.history].reverse().find((m) => m.role === 'user') || { content: '' }).content;
        if (!greeting && ((intent === 'story' && STORY_ASK.test(lastUser)) || (intent === 'recall' && RECALL_ASK.test(lastUser)))) { d.maxSentences = Infinity; d.moments = 3; }
        if (!greeting && simpleAffirmation(lastUser) && intent !== 'story' && intent !== 'recall' && !this.safety && !this.health && !this.pendingConcern && !this.scamReply && !(raw && (/^(1|yes|true)$/i.test(String(raw.pain || '')) || ['unsure', 'urgent'].includes(String(raw.concern || '').toLowerCase())))) d.maxSentences = 1; // a bare yes / okay gets one short line
        if (this.lastExclaimed) d.maxExclaim = 0; // never an exclamation mark on two replies in a row
        if (this.safety || this.health || this.pendingConcern || (raw && (/^(1|yes|true)$/i.test(String(raw.pain || '')) || ['unsure', 'urgent'].includes(String(raw.concern || '').toLowerCase())))) { d.noBright = true; d.maxExclaim = 0; d.excitedOpening = false; if (d.openingTone === 'bright') d.openingTone = null; } // pain, worry, safety: no [happy], no brightness, no exclamation
        if (this.safety) { d.escalate = false; d.maxExclaim = 0; d.excitedOpening = false; d.openingTone = null; d.moments = 0; d.maxSentences = 3; } // safety replies are calm and plain, and never halted
        if (greeting) { d.excitedOpening = false; d.openingTone = null; d.moments = bright ? 1 : 0; d.openingTone = bright ? 'bright' : null; d.maxSentences = maxSentences; }          // a greeting is a short warm line (plus one gentle question), never theatrical
        const concern = String((raw && raw.concern) || '').toLowerCase();
        if (!greeting && raw && /^(1|yes|true)$/i.test(String(raw.pain || ''))) care.painMention(this.profile.id); // counted AFTER the facts for this reply were built
        d.noQuestion = !greeting && this.lastReplyAsked && concern !== 'unsure'; // asking because she genuinely does not know is the one exception
        if (!greeting && concern === 'unsure' && this.familyDeclined && !this.health && !this.safety) d.noQuestion = true; // they already said no to telling family: no second ask, however often the pain comes back
        if (!greeting && concern === 'urgent' && !this.health && !this.safety && !this.inScamTurn(lastUser)) this.enterHealth();
        else if (!greeting && concern === 'unsure' && !this.familyDeclined && !this.health && !this.safety && !this.scamReply && !this.inScamTurn(lastUser)) this.pendingConcern = { left: 2 }; // a friend listens more than she asks: no question straight after one
        // A scam reading is a few short sentences, not the usual two: what it seems to be, what not to do yet, and (warn / pause) the ONE question about
        // telling their family. Calm and plain: nothing bright, no exclamation. Same shape as the written chat (chat.js).
        if (this.scamReply) { d.noBright = true; d.maxExclaim = 0; d.excitedOpening = false; d.openingTone = null; d.moments = 0; d.noQuestion = !['warn', 'pause'].includes(this.scamReply) || Boolean(care.scamTold(this.profile.id)); d.maxSentences = /\b(more|details?|explain|in full|everything|elaborate|go on|longer)\b/i.test(lastUser) ? 4 : this.scamAskFor ? 3 : 2; }   // a scam reply is the gist in two short sentences (what to do now, and the one question) unless they ask for more
        if (!greeting) this.applyBeat(d, raw, Boolean(this.safety || this.health || this.pendingConcern || this.scamReply));
        delivery = d;
        feel = { emotion: d.emotion, intensity: d.intensity, intent: raw && INTENTS.includes(String(raw.intent).toLowerCase()) ? String(raw.intent).toLowerCase() : 'unclear', whisperPieces: d.whisperPieces };
        return d;
      },
      onPiece: (text, kind, next) => {
        if (record && !jobs.length && !this.repeatRetried && !this.safety) {
          const why = this.breaksFacts(text) ? 'facts' : this.repeatsOpening(text) ? 'repeat' : this.beatBlocks(text, delivery) ? 'beat' : null;
          if (why) { repeated = text; retryWhy = why; splitter.halted = true; return; }
        } // nothing spoken yet: write it again
        else if (jobs.length && this.breaksFacts(text)) return;   // already speaking: a later piece that claims what the app never did, or a stock counselling line, is simply dropped
        const job = { chunks: [], done: false, err: null, tone: Boolean(kind), kind, text, sent: Boolean(this.noVoice && !this.fakeAudio) };   // sent: some of this piece's audio went to the browser (a no-voice test call has no audio, so its words count as sent)
        jobs.push(job); allJobs.push(job);
        if (!tEnqueue) { tEnqueue = Date.now(); if (timing) timing.firstPieceMs = tEnqueue - tStart; } // Spark started -> the first sentence is handed to the voice
        if (kind === 'excited') excited = true;
        pieces += 1;
        // [excited] is an ElevenLabs v4 audio tag (docs); it covers only its own short opening piece.
        // The excited piece is quieter-scaled below: in measurement the tag roughly doubled loudness.
        const spoken = text.replace(/^[,;:\s]+/, ''); // a piece cut after an opening phrase can start with its comma
        const tone = TONES[kind];
        const tagged = tone ? `${tone[0]} ${spoken}` : spoken;
        const gain = tone ? tone[1] : 1;
        const onVoiceChunk = (c) => { if (timing && timing.ttsChunkMs === undefined && jobs[0] === job) timing.ttsChunkMs = Date.now() - tEnqueue; job.chunks.push(gain === 1 ? c : scale(c, gain)); };
        if (this.noVoice && !this.fakeAudio) job.done = true;   // no-voice test call: the words go out as text events, there is no audio and no ElevenLabs request
        else (this.noVoice ? fakeSpeech(tagged, signal, onVoiceChunk) : streamSpeech(tagged, signal, onVoiceChunk, said.length ? said.join(' ').slice(-300) : undefined, next || undefined))
          .then(() => { job.done = true; }, (e) => { job.err = e; job.done = true; });
        said.push(text);
        this.sayingText = said.join(' ');
        const shown = said.join(' ').replace(/\s+([,.;:!?])/g, '$1');
        if (!started) { started = true; this.send({ type: 'speak', text: shown, hold: leadIn ? 0 : holdBack ? HOLD_BACK_MS : 0, ...(leadIn ? { cont: true } : {}) }); }
        else this.send({ type: 'caption', text: shown });
      },
    });
    const producer = (async () => {
      try {
        for await (const d of rs.chunks()) {
          if (timing && timing.sparkFirstMs === undefined) timing.sparkFirstMs = Date.now() - tStart;
          splitter.feed(d);
          if (splitter.halted) break;
        }
        splitter.end();
      } catch (e) { producerErr = e; } finally { producerDone = true; if (timing && timing.sparkDoneMs === undefined) timing.sparkDoneMs = Date.now() - tStart; }
    })();

    // Interrupted: only the pieces whose audio was really sent count as said. Pieces still queued when she was cut off were generated, not heard,
    // and must not enter her history, her memory of the call or the written thread as if she had said them.
    const keep = (interrupted = false) => { const text = (interrupted ? allJobs.filter((j) => j.sent).map((j) => j.text) : said).join(' '); if (record && text) { this.history.push({ role: 'assistant', content: text }); memory.appendTurn(this.profile.id, this.callId, { who: 'Maya', text }); this.mirror('maya', text); } };
    for (;;) {
      if (myGen !== this.gen || this.closed) { keep(true); return; } // interrupted
      const head = jobs[0];
      if (!head) { if (producerDone) break; await sleep(4); continue; }
      // Piece joins: drop each piece's leading silence, hold back its tail until we know where it ends,
      // then trim the trailing silence. Held back only when more audio can follow in this reply.
      while (head.chunks.length) head.buf = head.buf ? Buffer.concat([head.buf, head.chunks.shift()]) : head.chunks.shift();
      if (head.buf && !head.leadDone && (head.done || head.buf.length >= 120 * 48)) {
        head.leadDone = true;
        head.buf = head.buf.subarray(Math.max(0, firstLoud(head.buf) - PAD_LEAD_BYTES));
        if (head.tone) head.buf = fadeIn(head.buf);
      }
      if (head.buf && head.leadDone) {
        const mayFollow = !producerDone || jobs.length > 1;
        const keepBack = head.done ? head.buf.length : (mayFollow ? TAIL_HOLD_BYTES : 0);
        let out = null;
        if (head.done) { out = head.buf.subarray(0, Math.min(head.buf.length, lastLoud(head.buf) + PAD_TAIL_BYTES)); head.buf = null; if (head.tone) out = fadeOut(out, head.kind); }
        else if (head.buf.length > keepBack) { const n = (head.buf.length - keepBack) & ~1; out = head.buf.subarray(0, n); head.buf = head.buf.subarray(n); }
        if (out && out.length) {
          if (!sentAny && timing) {
            const now = Date.now();
            timing.ttsFirstMs = now - tEnqueue;
            timing.speechEndToFirstAudioMs = now - timing.endedAt;
            if (timing.decidedAt) { timing.replyReadyMs = now - timing.decidedAt; if (timing.guess !== 'prethink') this.readyEma = Math.round(0.6 * this.readyEma + 0.4 * timing.replyReadyMs); }   // learn how long her real reply takes on this line
            if (leadIn) timing.leadGapMs = now - leadIn.endsAt;   // below 0: her reply was already queued behind the lead-in (no gap); above 0: silence before it
          }
          sentAny = true; head.sent = true;
          this.lastSaidAt = Date.now();
          this.playUntil = Math.max(this.playUntil, this.lastSaidAt) + out.length / 48;
          this.ws.send(out);
        }
      }
      if (head.done) {
        if (head.err) {
          if (sentAny) { this.abort.abort(); return this.fatal(head.err.message); }
          // Voice failed before any sound: show the whole reply; the browser labels its own voice MOCK.
          console.error('TTS error:', head.err.message);
          await producer;
          this.abort.abort();
          keep();
          this.responding = false;
          this.playUntil = Date.now() + said.join(' ').length * 70; // browser voice: rough length
          this.armSilence();
          return this.send({ type: 'ttsFailed', text: said.join(' '), error: head.err.message });
        }
        jobs.shift();
        continue;
      }
      await sleep(4);
    }
    await producer;
    if (myGen !== this.gen || this.closed) { if (this.ws.outbound && record) console.log('outbound reply', JSON.stringify({ interrupted: true })); keep(true); return; }
    if (splitter.halted && repeated) {
      // The reply opened like a recent one (or said who she is again) before a word was spoken: ask for it again, once.
      this.abort.abort();
      this.repeatRetried = true;
      const gen2 = ++this.gen;
      this.abort = new AbortController();
      this.responding = true;
      const again = retryWhy === 'facts'
        ? `Your draft began "${repeated}", which says something the app's facts do not support (a family alert that was never made, a reason nobody gave, or a stock comfort line). Write the whole reply again from the start in plain, short, direct words: say only what the FAMILY ALERTS fact says, no excuse, no soothing line.`
        : retryWhy === 'beat'
        ? `Your draft began "${repeated}", but this reply must not ask a question. Write the whole reply again from the start as a short statement, in your own words.`
        : `Your draft began "${repeated}", which repeats something you already said. Write the whole reply again from the start, opening in completely different words, with no stock comfort phrase and no mention of who you are.`;
      const rs2 = startReply(this.history, this.roster(`${this.replyNote()} ${again}`), this.abort.signal);
      const r = await this.speakReply(rs2, timing, gen2, { record: true, stripGreeting: true, holdBack });
      this.repeatRetried = false;
      return r;
    }
    if (splitter.halted) {
      // Spark read the person as in crisis before saying anything: Tier A. Write the reply again with the safety note.
      this.abort.abort();
      this.enterSafety();
      const gen2 = ++this.gen;
      this.abort = new AbortController();
      this.responding = true;
      const rs2 = startReply(this.history, this.roster(`${this.replyNote()} ${this.safetyNote()}`), this.abort.signal);
      return this.speakReply(rs2, timing, gen2, { record: true, stripGreeting: true });
    }
    if (producerErr && !(producerErr.empty && !said.length)) return this.fatal(producerErr.message);
    if (!said.length) {
      // Spark said nothing even after one retry. Never fake a reply: say so honestly, drop the
      // turn from history so it cannot poison the next one, and leave the call ready to listen.
      console.error('Recovery: Spark returned no reply text');
      if (record && this.history.length && this.history[this.history.length - 1].role === 'user') this.history.pop();
      return this.speak(RECOVERY);
    }
    keep();
    this.commitReminder();
    this.responding = false;
    if (IDENTITY_LINE.test(said.join(' '))) this.identitySaid = true;
    if (record && said.length) {
      // Remember how this reply opened, so the next one can open differently.
      if (this.profile) care.addLine(this.profile.id, 'open', openWords(said[0]).slice(0, 8).join(' '));
      this.openedWithInterjection = /^(oh|well|ah|hmm|um)\b/i.test(said[0]);
      const all = said.join(' ');
      if (/\b(your name|what should i call you|what to call you|call you\?|who am i (talking|speaking) (to|with))\b/i.test(all)) this.askedName = true;
      for (const n of this.names.values()) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(all)) this.lastNameUse = this.replyCount;
      this.replyCount += 1;
      if (delivery && delivery.beatN != null) this.beatCount = delivery.beatN;
      if (this.checkIds) { care.checkDelivered(this.profile.id, this.checkIds); this.checkIds = null; }   // a finished lookup was spoken to them: told once
      if (this.officialNow) { care.scamOfficial(this.profile.id, this.officialNow); this.officialNow = null; }   // answered after the family question: attach it
      if (this.rc.stage === 'offered') { this.rc.stage = 'asked'; this.rc.at = Date.now(); }   // the reconfirm question was really spoken: now it is asked
      if (this.scamAskFor) { care.scamAsk(this.profile.id, this.scamAskFor.type, { channel: 'spoken', pause: this.scamAskFor.level === 'pause', official: this.scamAskFor.official || null }); this.scamAskFor = null; }   // her one question is out: their yes or no settles it (careNotes)
      care.trendTurn(this.profile.id, delivery);   // counts only: the feeling, its strength, pain, concern; never the words   // committed only once the reply is really spoken (a rewrite recomputes from the same count)
      this.lastReplyAsked = isQuestion(all);
      this.lastExclaimed = /!/.test(all);
      if (this.safety) care.addLine(this.profile.id, 'safety', all);
      this.askHistory = [...this.askHistory, this.lastReplyAsked].slice(-4);
      if (this.safety && /\bsafe\b/i.test(all) && isQuestion(all)) care.safeAsked(this.profile.id);
      if (this.safety && isQuestion(all)) this.noteSafetyAsked(all);
    }
    const farewell = Boolean(this.ws.outbound && !this.safety && !this.health && said.length && sayingFarewell(said.join(' ')));   // a goodbye she says is followed by the hang-up, in code
    if (this.ws.outbound && record) console.log('outbound reply', JSON.stringify({ farewell, pieces: said.length }));   // a boolean and a count, never a word
    if (hangup) this.hangUp(); else if (bye || farewell) this.hangUp({ quiet: false }); else if (onDone) setImmediate(onDone); else this.armSilence();
    if (timing) {
      timing.feel = feel;
      timing.excited = excited;
      timing.whisperPieces = 0; // whispers are off
      this.prevDelivery = delivery;
      console.log('latency', JSON.stringify(latencyForLog(timing)));
    }
    this.send({ type: 'audioEnd', timing: timing ? { ...timing, endedAt: undefined } : null, ...(this.noVoice ? { noVoice: true, ...(this.fakeAudio ? { fakeAudio: true } : {}) } : {}) });
  }

  // Greeting: fixed words, spoken through the same voice path.
  speak(text) {
    clearTimeout(this.recoverTimer);
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.responding = true;
    return this.speakReply(fixedReply(text), null, myGen);
  }
}

module.exports = { outboundEnd, sayingFarewell, BYE_ASKED, BYE_NOMORE, BYE_TIMEOUT, BYE_SAID, reminderFacts, isAck, isFamilyMessage, stripAddressee, restatedTimer, explicitFamilyRequest, ownPlan, timerOpenFact, CALL_PROMISE, WHATSAPP_GOODBYE_LINE, latencyForLog, saysYesToFamily, asksFamily, simpleAffirmation, callWords, affirmed, refusedFamily, CONCERN_YES, FAMILY_ASK, callDeps, liveCalls, RESUME_GRACE_MS, Call, warmLeads, leadClips, fakeSpeech, TONES, scale, STORY_ASK, RECALL_ASK, IDENTITY_LINE, parseTimer, isAck, isFamilyMessage, firstSilenceWait, SILENCE_WAIT_MS, SILENCE_FIRST_MIN_MS, SILENCE_FIRST_MAX_MS };
