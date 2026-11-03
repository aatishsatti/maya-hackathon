// THE MEDICINE BOUNDARY. Maya never gives medicine information: not whether to take, combine, stop, change or dose a medicine, not what it does, what its effects, benefits or risks are, not "in general",
// not as a sourced finding, not as a news item or a fact-check, and not as advice followed by a disclaimer. The answer is always a refusal that sends the person to their doctor or pharmacist.
// This file is the ONLY place that recognises medicine, and it recognises it for ONE purpose: to choose that refusal (and to keep the research code away). It never grants permission to research anything.
//
//   classify(text, ctx)   -> null | { reason }   the routing decision, made BEFORE any research, cache or claim/news processing. It is not a failed search: nothing was attempted.
//   mentions(text)        -> boolean             a medicinal subject is present (feeds the one-turn refusal-routing context only)
//   note(decision, recent)-> string              the constraints Spark writes under. Constraints and the decision, never a sentence to copy.
//   violates(reply)       -> null | { why }      the check every refusal passes before it is shown or spoken (retries and fallbacks too)
//   FALLBACK              a plain line for the case where Spark's wording broke the boundary twice. It is NOT a successful refusal and is never recorded as one.
//
// Recognition is layered, because a drug-name list alone is never enough: (1) named medicines / brands / drug-shaped words, (2) medicinal vocabulary (medicine, tablets, mg, prescription ...),
// (3) a clinical question about use / effect / safety / benefit, (4) treatment claims about a condition, (5) an unknown word in a clearly medicinal request, (6) a continuing fragment after a medical turn.
// Finite phrasing tests do not prove universal understanding: what the rules cannot resolve is simply NOT eligible for research (web.js is default-deny).
const norm = (t) => String(t || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

const DRUGS = new Set(('ibuprofen aspirin acetaminophen paracetamol naproxen diclofenac warfarin apixaban rivaroxaban clopidogrel heparin metformin insulin glipizide lisinopril enalapril ramipril losartan valsartan amlodipine atenolol metoprolol bisoprolol propranolol furosemide hydrochlorothiazide spironolactone digoxin amiodarone atorvastatin simvastatin rosuvastatin pravastatin omeprazole pantoprazole esomeprazole ranitidine famotidine levothyroxine prednisone prednisolone dexamethasone amoxicillin penicillin ciprofloxacin doxycycline azithromycin clarithromycin erythromycin metronidazole fluconazole sertraline fluoxetine citalopram escitalopram paroxetine venlafaxine amitriptyline mirtazapine trazodone diazepam lorazepam alprazolam zolpidem temazepam gabapentin pregabalin tramadol codeine morphine oxycodone hydrocodone donepezil memantine levodopa carbidopa sildenafil tadalafil allopurinol colchicine tamsulosin finasteride oxybutynin montelukast cetirizine loratadine fexofenadine diphenhydramine benadryl tylenol advil motrin aleve nurofen panadol zyrtec claritin lipitor coumadin plavix xarelto eliquis nexium prilosec zoloft prozac xanax valium ambien viagra cialis lasix synthroid glucophage ozempic ' +
  'melatonin magnesium ginkgo ginseng turmeric curcumin St-johns-wort').toLowerCase().split(' '));
const SUFFIX = /(?:pril|sartan|statin|olol|dipine|azole|prazole|tidine|formin|gliptin|gliflozin|parin|xaban|setron|mycin|cillin|cycline|oxetine|azepam|profen|barbital|afil|thiazide|floxacin|triptan|caine|codone|phine|oxin|zepam|dronate|mab|nib)$/i;
const MEDWORD = /\b(?:medicines?|medications?|meds|pills?|tablets?|capsules?|drugs?|antibiotics?|painkillers?|pain relief|supplements?|vitamins?|remed(?:y|ies)|herbal|prescriptions?|prescribed|inhalers?|ointments?|creams?|syrups?|injections?|jabs?|vaccines?|vaccinations?|doses?|dosage|overdose|statins?|nsaids?|steroids?|insulin|antidepressants?|blood thinners?|sleeping (?:pills?|tablets?)|antacids?|laxatives?|\d+\s?(?:mg|mcg|ml|iu))\b/i;
const CONDITION = /\b(?:arthritis|diabet\w*|cancer|tumou?rs?|cholesterol|blood pressure|hypertension|heart (?:disease|attack|failure|problems?)|stroke|dementia|alzheimer\w*|parkinson\w*|asthma|copd|infections?|flu|covid|colds?|coughs?|fevers?|migraines?|headaches?|depression|anxiety|insomnia|osteoporosis|gout|kidney (?:disease|stones?|problems?)|liver (?:disease|problems?)|thyroid|an?aemia|eczema|psoriasis|ulcers?|reflux|indigestion|constipation|pain|inflammation|allerg\w+|viruses|bacteria|sleeplessness|memory loss|joint pain)\b/i;
const TREAT = /\b(?:cure[sd]?|cures|treat(?:s|ed|ing|ment)?|prevent(?:s|ed|ing)?|heal(?:s|ed|ing)?|fix(?:es|ed)?|helps?(?: with| for)?|good for|remedy for|relie(?:f|ve|ves|ved)|reduc(?:e|es|ed)|lower(?:s|ed|ing)?|boost(?:s|ed)?|clears? up|works? (?:for|on|against)|effective (?:for|against)|stops?)\b/i;
const NEWSY = /\b(?:news|latest|updates?|reports?|stud(?:y|ies)|research|trials?|recall(?:ed|s)?|approved|approval|breakthrough|discover\w+|scientists?|experts?)\b/i;
const REMINDER = /\b(?:remind(?:er|ers|ing)?|alarm|timer|set (?:a |an )?(?:reminder|alarm)|schedule)\b/i;
const SCAMCUE = /\b(?:scam|scammer|phishing|fraud\w*|fake|suspicious|legit|text message|e-?mail|sender|link|click|card details|bank details|asking (?:me )?(?:to )?pay|asks? for (?:my )?(?:card|bank|payment|money))\b/i;
const QUESTIONISH = /\?|^(?:\W*(?:and |but |so |also |ok(?:ay)? |well |oh |hey |maya )*)?(?:is|are|was|were|can|could|should|shall|will|would|does|do|did|may|might|what|whats|how|why|which|when|where|whether|am i|is it|tell me|explain|advise|recommend|suggest|let me know|i wonder|i was wondering|i need to know|i want to know)\b/i;
const CLAIMISH = /\bi\s+(?:heard|read|saw|was told)\b|\b(?:is|was) (?:it|that|this) true\b|\bpeople say\b|\bthey say\b|\bon the (?:news|radio|telly|tv)\b|\bnews (?:says|said|report\w*)\b|\bis it a (?:myth|rumou?r|hoax)\b|\bfact[- ]check\b|\bnot medical advice\b|\bjust (?:asking|curious|wondering)\b/i;
// A clinical conclusion about a medicine: its use, effect, safety, benefit, risk, interaction or dose, or an action on it.
const STRONG = /\b(?:(?:ok|okay|fine|alright|safe|good|bad) (?:with|for|to|if|when)|best|better|recommend\w*|which (?:one|medicine|medication|tablet|pill|painkiller|drug)|what should i (?:take|use)|hurt\w*|damag\w*|upsets?|what (?:happens|would happen|will happen)|what if i|safe|safely|safety|unsafe|dangerous|danger|harm\w*|risk\w*|toxic|poison\w*|side[- ]effects?|effects?|affects?|interact\w*|interferes?|overdos\w*|dos(?:e|es|age)|how (?:much|many|often|long)|allowed|recommended|supposed to|bad for|good for|benefits?|beneficial|works?|working|helps?|cures?|treats?|prevents?|relie\w+|lowers?|raises?|thins?|used for|for\?|what is it for|ok to|okay to|fine to|alright to|alternatives?|instead of|better than|stop(?:ping)? (?:it|them|my|the|taking)|quit(?:ting)?|come off|coming off|wean\w*|withdraw\w*|addictive|dependen\w*|expired|out of date|missed? (?:a |my |the )?dose|double (?:up|the)|too much|not enough)\b/i;
const CONSUME = /\b(?:take|taking|took|taken|use|using|used|have|having|swallow\w*|drink|mix|mixing|combine|combining|start|starting|stop|stopping|skip|skipping|switch\w*|chang\w+|increas\w+|reduc\w+|continu\w+|keep taking|give|giving)\b/i;
const MODALQ = /\b(?:can|could|should|shall|may|might|am i (?:allowed|supposed)|do i need|need to|have to|ought)\b\s+(?:i|we|he|she|they|you)?/i;
const FRAGMENT_OPEN = /^\W*(?:and|also|but|or|so|then|what about|how about|what if|with|plus|instead|together with|combined with|mixed with|alongside)\b/i;
const PRONOUN_Q = /^\W*(?:and |but |so |also |ok(?:ay)? )*(?:is|are|was|will|would|can|could|should|does|do|did)\s+(?:it|that|this|they|these|those|them)\b/i;
const OTHER = new Set('walk walks bath shower nap trip swim run exercise break rest day holiday seat chance look picture photo moment minute second step turn lift ride drive rain sun sunshine breath bite sip bus train taxi car plane flight taxi stairs garden park shop shops shopping dog cat'.split(' '));
const GENERIC = new Set('it this that them these those they he she one ones thing things something anything everything nothing stuff time times day days way me my mine you your yours i we us our the a an some any more less much many lot lots bit little again also too'.split(' '));

const sentences = (t) => norm(t).split(/(?<=[.!?])\s+/).filter(Boolean);
// a named medicine, a drug-shaped word, or a medicinal word
// a misspelled medicine ("ibuprofin", "paracetmol", "warfrin") is still a medicine: small edit distance from a known name (never for short words)
function near(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n] <= (Math.max(m, n) >= 9 ? 2 : 1);
}
const FUZZY = [...DRUGS].filter((w) => w.length >= 7);
const fuzzyDrug = (w) => w.length >= 7 && FUZZY.some((k) => near(w, k));
function drugIn(s) {
  const words = (norm(s).toLowerCase().match(/[a-z][a-z-]{2,}/g) || []);
  return words.some((w) => DRUGS.has(w) || DRUGS.has(w.replace(/s$/, '')) || (SUFFIX.test(w) && w.length >= 7) || fuzzyDrug(w));
}
const medicinal = (s) => drugIn(s) || MEDWORD.test(s);
// the word after take / use / mix / combine in a question: an unknown name in a clearly clinical request is treated as a medicine; "a walk", "the bus", "my time" are not
function unknownObject(s) {
  const m = /\b(?:take|taking|use|using|mix|mixing|combine|combining|swallow|drink|have|try)\s+(?!a\b|an\b|the\b|my\b|some\b|any\b|your\b|our\b|his\b|her\b|their\b|this\b|that\b|these\b|those\b|it\b|them\b|one\b)([A-Za-z][A-Za-z-]{3,})/.exec(s);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return OTHER.has(w) || GENERIC.has(w) ? null : w;
}

// classify(text, ctx): null = not a medicine matter. ctx.prior = the one-turn refusal-routing context ({at}) or null. Per-sentence, with a subject carried over only to a short pronoun question ("is it safe?").
function classify(text, ctx = {}) {
  const sents = sentences(text); let subjectSeen = false;
  for (const s of sents) {
    const reminder = REMINDER.test(s), scammy = SCAMCUE.test(s), strong = STRONG.test(s), question = QUESTIONISH.test(s);
    const subj = medicinal(s);
    // (6) a continuing fragment right after a medical turn: "and with aspirin?" / "is it safe?" / "what about the other one?"
    if (ctx.prior && ((FRAGMENT_OPEN.test(s) && s.split(/\s+/).length <= 9) || PRONOUN_Q.test(s)) && !scammy && !reminder) return { reason: 'continues the medicine question just before it' };
    if (subj) subjectSeen = subjectSeen || true;
    if (reminder && !strong) continue;                                    // "remind me to take my pills at noon": the reminder path, no medicine content evaluated
    // (4) treatment / medicine claims: "I heard that X cures Y", "does honey help a cough", "is it true that this tablet lowers cholesterol"
    if (TREAT.test(s) && (subj || CONDITION.test(s)) && (CLAIMISH.test(s) || question) && !(scammy && !strong)) { if (subj || /\b(?:honey|garlic|turmeric|ginger|lemon|vinegar|tea|oil|herb\w*|natural|remedy|supplement|vitamin)\b/i.test(s)) return { reason: 'a treatment or medicine claim or question' }; }
    // news / research wording about a medicine is the same matter: "what is the latest news about ibuprofen"
    if (subj && question && NEWSY.test(s) && !(scammy && !strong)) return { reason: 'news or research about a medicine' };
    // (3) a clinical question about a medicine: use / effect / safety / benefit / risk / dose / stopping / changing
    if (subj && question && (strong || (CONSUME.test(s) && MODALQ.test(s))) && !(scammy && !strong)) return { reason: 'a question about the use, effects, safety, benefits or risks of a medicine' };
    // pronoun question in the same message: "I take ibuprofen. Is it safe?"
    if (subjectSeen && !subj && PRONOUN_Q.test(s) && (strong || CONSUME.test(s)) && s.split(/\s+/).length <= 9) return { reason: 'a question about a medicine named just before it' };
    // (5) an unknown word in a clearly clinical request: "is it safe to take xyzzyfen?"
    if (question && strong && CONSUME.test(s) && !scammy) { const u = unknownObject(s); if (u) return { reason: 'an unrecognised substance in a clinical question' }; }
    // clinical claim wrapped as hearsay about a medicine: "I read that ibuprofen thins the blood"
    if (subj && CLAIMISH.test(s) && strong) return { reason: 'a claim about a medicine presented as news or hearsay' };
  }
  return null;
}
// is a medicinal subject present (for the one-turn routing context only; never a research permission)
const mentions = (text) => sentences(text).some((s) => medicinal(s) && !REMINDER.test(s));
// A search query must never carry medicine content, whatever produced it.
const touchesMedicine = (q) => medicinal(String(q || '')) || Boolean(classify(String(q || '')));

// ---- the one-turn refusal-routing context: ONLY "the last turn was a medicine matter", at what time. No substances, no relationship, no evidence, no plan. ----
const CTX_MS = 10 * 60000;
const fresh = (c) => (c && Date.now() - c.at < CTX_MS ? c : null);

const REFERRAL = /\b(?:doctor|pharmacist|gp|physician|nurse|prescriber|healthcare (?:provider|professional)|health care (?:provider|professional)|clinic|surgery)\b/i;
const REFUSAL_MARK = /\b(?:can'?t|cannot|can not|not able|unable|don'?t|do not|won'?t|isn'?t|not something|not the right|leave that|best left|rather not|shouldn'?t|not in a position|no way for me)\b/i;
const HARD = [
  [/\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|g|ml|iu|units?|milligrams?|grams?)\b/i, 'a dose'],
  [/\b(?:once|twice|three times|\d+ times)\s+(?:a|per|each|every)\s+(?:day|week|hour|night|morning)\b|\bevery\s+\d+\s+hours?\b|\bdaily dose\b/i, 'dosing instructions'],
  [/\b(?:it'?s|that'?s|it is|that is|they(?:'re| are)|this is|these are|those are)\s+(?:generally |usually |typically |perfectly |completely |quite |really |very |probably |likely )?(?:safe|fine|ok(?:ay)?|no problem|harmless|dangerous|risky|harmful|unsafe|not safe|a bad idea|a good idea|not a problem)\b/i, 'a safety verdict'],
  [/\b(?:should|would|will|can) (?:be |probably be |likely be )?(?:fine|ok(?:ay)?|safe)\b|\bno need to worry\b|\bnothing to worry\b|\bdon'?t worry about\b|\bnot to worry\b|\bsafe for you\b/i, 'reassurance'],
  [/\byou (?:can|could|may|should|shouldn'?t|must|mustn'?t|need to|ought to|had better|might want to)\s+(?:safely\s+|also\s+|just\s+|probably\s+)?(?:take|use|mix|combine|have|stop|skip|avoid|double|increase|reduce|continue|keep taking|start|try (?:taking|using))\b|\bgo ahead and (?:take|use)\b/i, 'a recommendation'],
  [/\b(?:best|better) (?:avoided|not to take|to avoid|to stop|to wait)\b|\bavoid(?:ing)? (?:it|them|that|taking|combining|mixing|using)\b|\bstay away from\b/i, 'advice to avoid'],
  [/\b(?:can|may|might|could|will|would|does|do|often|sometimes|usually|generally)\s+(?:also\s+)?(?:raise|increase|reduce|lower|cause|lead to|interact|affect|thin|damage|harm|upset|worsen|interfere|cure|treat|prevent|relieve|boost)\b/i, 'a clinical finding'],
  [/\b(?:alternativ\w+|natural(?:ly)?|herbal|home remed\w+|safer option|better option|instead try|try (?:taking|using)|switch(?:ing)? to)\b/i, 'an alternative'],
  [/\b(?:studies|research|evidence|trials|experts|doctors say|guidelines)\s+(?:show|says?|suggest|indicate|found|recommend)\b|\baccording to\b/i, 'an outside source'],
  [/\b(?:in general|generally|typically|as a rule|for most people|for many people)\b[^.?!]*\b(?:safe|fine|ok(?:ay)?|risk\w*|avoid|dangerous|harmless|effective|works?|helps?)\b/i, 'a general finding'],
];
const SOFT = [/\b(?:side[- ]effects?|interactions?|contraindicat\w*|overdos\w*|dosage|doses?|bleeding|toxic\w*|risks?)\b/i, /\b(?:recommend\w*|advice|advise)\b/i, /\b(?:searched|googled|looked (?:it |that |this )?up|looked online|checked (?:online|the web|the internet|sources|the news|the latest)|verified|double[- ]?checked|my search)\b/i];
const FALLBACK = "I'm not able to help with questions about medicines. Please ask your doctor or pharmacist.";
// violates(reply, { requireReferral }): null = fine to release. A refusal that states ANY clinical content, reassurance, recommendation, alternative or outside source, or claims a search, or has no referral, does not pass. Retries, fallbacks and spoken pieces all go through this.
function violates(reply, { requireReferral = true } = {}) {
  const t = norm(reply).replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { why: 'empty' };
  for (const [re, why] of HARD) if (re.test(t)) return { why };
  for (const s of sentences(t)) if (!REFUSAL_MARK.test(s)) for (const re of SOFT) if (re.test(s)) return { why: 'clinical or search wording outside a plain refusal' };
  if (requireReferral && !REFERRAL.test(t)) return { why: 'no referral to a doctor or pharmacist' };
  return null;
}

const note = (decision, recent = []) => `MEDICINE MATTER (a decision made by the app, not by you; reason: ${decision.reason}; NOTHING was searched or checked, because Maya does not give information about medicines). Your whole reply is a short refusal in your own warm words: say that you cannot help with medicine questions (what to take, stop, combine or change, doses, what a medicine does, its benefits or risks), and tell them directly to ask their doctor or pharmacist (or whoever prescribed it). Hard rules for your wording: state NO clinical fact or tendency, not even "in general" or "usually"; NO recommendation, no "you could/should", no reassurance ("it should be fine", "no need to worry"), no warning about what is dangerous, no alternative or natural remedy, no dose or number, no "studies show"; never advice followed by "but I'm not a doctor". Do not say or imply that you searched, looked up, checked or verified anything. One or two short sentences, kind, not cold; do not lecture; ask no medical question. This overrides any other instruction about asking a question.${recent.length ? ` Your recent refusals began: ${recent.map((r) => `"${r}"`).join(', ')}. Open and phrase this one differently, in fresh words.` : ''}`;
const RETRY = 'Write the whole reply again from the start as a short, warm refusal that states no clinical content at all and sends them to their doctor or pharmacist.';

module.exports = { classify, mentions, touchesMedicine, violates, note, RETRY, FALLBACK, fresh, CTX_MS, REFERRAL, drugIn, medicinal };
