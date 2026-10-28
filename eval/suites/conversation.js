// Conversation suite (#1): repeat rate, question rate, length, the beat limits, the private tags (topic / personal) and the "nobody knows" worry.
// Real Meta Spark through the real Call path; the voice is stubbed. Every number comes from eval/score.js.
const C = require('./common');
const score = require('../score');
const inputs = require('../inputs/conversation.json');
const SEEDED_WORRY_RUNS = 5, COLD_WORRY_RUNS = 3;   // per run of the suite

async function run({ runs = 2, limit = null } = {}) {
  const S = C.stack(); C.watchTags(S);
  const chatJobs = [];
  for (let r = 0; r < runs; r++) inputs.chats.forEach((chat, ci) => chatJobs.push({ r, ci, lines: limit ? chat.slice(0, limit) : chat }));
  const chats = await C.pool(4, chatJobs, async (job) => {
    const id = S.memory.createProfile(C.nextName('Cora'), 'female').id; const c = C.makeCall(S, id);
    const turns = [];
    try { for (const [text, want, wantP] of job.lines) { const t = await C.turn(S, c, text); turns.push({ user: text, want, wantP, maya: t.maya, tag: (c.__evalTags || []).at(-1) || null }); } } finally { c.end(); }
    return { turns };
  });
  // The worry: with the five-turn lead-up (the demo context), and cold.
  const worryJobs = [];
  for (let r = 0; r < runs; r++) { for (let i = 0; i < (limit ? 1 : SEEDED_WORRY_RUNS); i++) worryJobs.push({ seeded: true }); for (let i = 0; i < (limit ? 1 : COLD_WORRY_RUNS); i++) worryJobs.push({ seeded: false }); }
  const worry = await C.pool(4, worryJobs, async (job) => {
    const id = S.memory.createProfile(C.nextName('Cora'), 'female').id; const c = C.makeCall(S, id);
    try {
      if (job.seeded) { for (const [u, m] of inputs.worry.lead) c.history.push({ role: 'user', content: `${c.profile.name}: ${u}` }, { role: 'assistant', content: m }); c.replyCount = inputs.worry.lead.length; }
      const t = await C.turn(S, c, inputs.worry.line);
      return { seeded: job.seeded, maya: t.maya, action: score.worryAction(t.maya) };
    } finally { c.end(); }
  });
  const metrics = score.conversationMetrics(chats);
  metrics.worryAction = score.frac(worry.filter((w) => w.action).length, worry.length);
  metrics.worrySeededAction = score.frac(worry.filter((w) => w.seeded && w.action).length, worry.filter((w) => w.seeded).length);
  metrics.worryColdAction = score.frac(worry.filter((w) => !w.seeded && w.action).length, worry.filter((w) => !w.seeded).length);
  return { metrics, details: { chats, worry } };
}
module.exports = { name: 'conversation', run };
