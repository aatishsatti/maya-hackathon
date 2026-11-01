'use strict';
// Where a welfare check goes: the Maya app, WhatsApp, or both. The same three choices as a reminder's channel.
//
//   app       the app only. Text: a notice. Voice note: Maya's voice in the chat. Call: one ring of the app (an open app rings; a closed one gets a push).
//   whatsapp  WhatsApp only (whatsapp.js placeWelfare, every one of its limits). If WhatsApp cannot deliver it (a closed window, a limit, the daily cap, an error) the SAME check goes to the Maya app and its
//             entry in Activity says why; the family never sees a bare "Paused".
//   both      Text and voice note go on both, each with its own delivery check (two entries, like a reminder). A call is ONE ring at a time, never two at once: the app first when it is open, otherwise
//             where they were last active; the other one is tried when the first cannot ring, or once more when nobody answered.
//
// Quiet hours, WhatsApp's own call limit (138012), the 2-unanswered pause and the 10-a-day cap all still apply (they live in care.js / whatsapp.js and are not copied here).
// Nothing the senior says is kept; an entry holds a channel, a way, a state, a time and (when something failed) the reason.
const CHANNELS = ['app', 'whatsapp', 'both'];
const VIAS = ['call', 'text', 'voice'];
const say = (via) => (via === 'call' ? 'call' : via === 'voice' ? 'voice note' : 'text');

// A short plain reason from whatever WhatsApp threw.
function whyOf(e) {
  if (e && e.cap) return `WhatsApp's daily limit was reached (${e.cap.count} / ${e.cap.max} messages in 24 hours).`;
  return String((e && e.message) || 'WhatsApp could not deliver it.').replace(/\s+/g, ' ').replace(/ Nothing was (sent|placed)\.?$/, '').slice(0, 200);
}

function parse({ via = 'call', channel } = {}) {
  if (!VIAS.includes(via)) throw Object.assign(new Error('Choose a call, a text or a voice note.'), { status: 400 });
  if (!CHANNELS.includes(channel)) throw Object.assign(new Error('Choose where it goes: the Maya app, WhatsApp or both.'), { status: 400 });
  return { via, channel };
}

// The app half of a check that WhatsApp could not carry out: text and voice always have somewhere to go; a call needs a ring that is possible right now.
async function toApp(id, via, { fellBackFrom, why, alsoTried } = {}) {
  const care = require('./care');
  if (via === 'call') {
    const r = care.welfareAppRing(id, { fellBackFrom, why, alsoTried });
    if (!r.ok) { care.welfareFailed(id, 'app', 'call', `${why ? `${why} ` : ''}The app could not be rung either: ${r.why}`.trim()); throw Object.assign(new Error(`${r.why} Nothing rang.`), { status: 409 }); }
    return { where: 'app', via: 'call', ringing: true };
  }
  await care.welfareAppSend(id, via, { fellBackFrom, why });
  return { where: 'app', via };
}

async function viaWhatsApp(id, via, extra) {
  const wa = require('./whatsapp');
  return via === 'call' ? wa.placeWelfareCall(id, extra) : wa.placeWelfare(id, via);
}

async function run(id, opts) {
  const { via, channel } = parse(opts);
  const care = require('./care'), wa = require('./whatsapp');
  const t0 = Date.now();
  if (channel === 'app') {
    const r = await toApp(id, via);
    return { channel, via, delivered: [r], summary: via === 'call' ? 'The Maya app is ringing.' : `Sent to the Maya app as a ${say(via)}.` };
  }
  if (channel === 'whatsapp') {
    try {
      const r = await viaWhatsApp(id, via);
      return { channel, via, delivered: [{ where: 'whatsapp', via: r && r.calledInstead ? 'call' : via }], result: r, summary: null };
    } catch (e) {
      const why = whyOf(e);
      care.welfareDropSince(id, t0);   // the Paused / failed row of this attempt: the app entry below carries the reason instead
      const r = await toApp(id, via, { fellBackFrom: 'whatsapp', why }).catch((e2) => { throw Object.assign(new Error(`${why} ${e2.message}`), { status: e2.status || e.status || 502 }); });
      return { channel, via, delivered: [r], fellBack: { from: 'whatsapp', why }, summary: `WhatsApp could not deliver it: ${why} ${via === 'call' ? 'The Maya app is ringing instead.' : `It went to the Maya app as a ${say(via)} instead.`}` };
    }
  }
  // both
  if (via !== 'call') {
    const delivered = [], notes = [];
    try { const r = await viaWhatsApp(id, via); delivered.push({ where: 'whatsapp', via: r && r.calledInstead ? 'call' : via, result: r }); }
    catch (e) { care.welfareDropSince(id, t0); const why = whyOf(e); care.welfareFailed(id, 'whatsapp', via, why); notes.push(`WhatsApp could not deliver it: ${why}`); }
    delivered.push(await toApp(id, via));
    return { channel, via, delivered, summary: `${delivered.length === 2 ? `Sent on WhatsApp and to the Maya app as a ${say(via)}.` : `Sent to the Maya app as a ${say(via)}.`}${notes.length ? ` ${notes.join(' ')}` : ''}` };
  }
  return bothCall(id, t0);
}

// 'Both' + Call: one ring at a time. Where the first goes: the app when it is open now; otherwise where they were last active; if only one of the two can ring, that one.
async function bothCall(id, t0) {
  const care = require('./care'), wa = require('./whatsapp');
  const route = wa.welfareRoute(id), p = care.get(id), la = (p && p.lastActivity) || {};
  const appWhy = care.welfareAppRingBlock(id), appOk = !appWhy;
  const waWhy = !route.linked ? 'WhatsApp is not linked for them.' : !route.permission ? 'They have not allowed WhatsApp calls from Maya.' : !route.windowOpen ? 'They have not written to Maya in the last 24 hours.' : route.blocked ? 'Calls on WhatsApp are paused (2 calls in a row were not answered).' : null, waOk = !waWhy;
  if (!appOk && !waOk) {
    care.welfareFailed(id, 'app', 'call', appWhy); care.welfareFailed(id, 'whatsapp', 'call', waWhy);
    throw Object.assign(new Error(`Nothing could ring. The app: ${appWhy} WhatsApp: ${waWhy}`), { status: 409 });
  }
  let first = appOk && waOk ? (care.appOpen(id) ? 'app' : (la.whatsapp || 0) > (la.app || 0) ? 'whatsapp' : 'app') : appOk ? 'app' : 'whatsapp';
  const other = first === 'app' ? 'whatsapp' : 'app', otherOk = other === 'app' ? appOk : waOk;
  const tried = { channel: first, result: 'unanswered' };
  // the other platform's one try, after the first ring has ended (never two at once)
  const second = () => (other === 'app'
    ? Promise.resolve().then(() => care.welfareAppRing(id, { alsoTried: tried }))
    : viaWhatsApp(id, 'call', { alsoTried: tried }).catch((e) => { care.welfareFailed(id, 'whatsapp', 'call', whyOf(e)); }));
  if (first === 'app') {
    const r = care.welfareAppRing(id, { onUnanswered: otherOk ? () => { second(); } : null });
    if (r.ok) return { channel: 'both', via: 'call', delivered: [{ where: 'app', via: 'call', ringing: true }], summary: 'The Maya app is ringing. If nobody answers, WhatsApp is tried once.' };
    // the app could not start: WhatsApp takes it
    if (!otherOk) { care.welfareFailed(id, 'app', 'call', r.why); throw Object.assign(new Error(`${r.why} Nothing rang.`), { status: 409 }); }
    const w = await viaWhatsApp(id, 'call', { alsoTried: undefined }).catch((e) => { care.welfareDropSince(id, t0); care.welfareFailed(id, 'whatsapp', 'call', whyOf(e)); throw e; });
    return { channel: 'both', via: 'call', delivered: [{ where: 'whatsapp', via: 'call', result: w }], summary: `The app could not ring (${r.why}) so WhatsApp is ringing.` };
  }
  // WhatsApp first; if nobody answers, the app gets its one ring
  try {
    const w = await viaWhatsApp(id, 'call', { onEnd: (st) => { if (st === 'unreached' && otherOk) second(); } });
    return { channel: 'both', via: 'call', delivered: [{ where: 'whatsapp', via: 'call', result: w }], summary: 'WhatsApp is ringing. If nobody answers, the Maya app is tried once.' };
  } catch (e) {
    care.welfareDropSince(id, t0);
    const why = whyOf(e);
    if (!appOk) { care.welfareFailed(id, 'whatsapp', 'call', why); throw e; }
    const r = care.welfareAppRing(id, { fellBackFrom: 'whatsapp', why });
    if (!r.ok) { care.welfareFailed(id, 'whatsapp', 'call', why); throw e; }
    return { channel: 'both', via: 'call', delivered: [{ where: 'app', via: 'call', ringing: true }], fellBack: { from: 'whatsapp', why }, summary: `WhatsApp could not ring: ${why} The Maya app is ringing instead.` };
  }
}

module.exports = { run, CHANNELS, VIAS, whyOf, parse };
