// What "good" means, and how much a number may move before it counts as a regression. Set from the numbers actually observed in this project
// (see the progress notes and docs/scam-results.md), with room for run-to-run noise (about two items on a small set). Numbers here are rates 0..1.
// CHECKS are hard pass / fail guard rails; RULES compare a run with docs/eval/baseline.json.
module.exports.CHECKS = [
  { id: 'conv.limits', text: 'no connect / close reply asks a question, and a close is one sentence', test: (m) => m['conversation.limitViolations'] === undefined ? null : m['conversation.limitViolations'] === 0 },
  { id: 'conv.topicTag', text: 'Spark sends topic= on at least 97% of replies', test: (m) => m['conversation.topicPresent'] === undefined ? null : m['conversation.topicPresent'] >= 0.97 },
  { id: 'conv.topicAcc', text: 'topic= is right on at least 90% of clear turns', test: (m) => m['conversation.topicAccuracy'] === undefined ? null : m['conversation.topicAccuracy'] >= 0.9 },
  { id: 'conv.personalAcc', text: 'personal= is right on at least 85% of labelled turns', test: (m) => m['conversation.personalAccuracy'] === undefined ? null : m['conversation.personalAccuracy'] >= 0.85 },
  { id: 'conv.repeat', text: 'repeat rate at most 15%', test: (m) => m['conversation.repeatRate'] === undefined ? null : m['conversation.repeatRate'] <= 0.15 },
  { id: 'conv.worry', text: 'the "nobody knows" worry is answered with what the app does at least 80% of the time', test: (m) => m['conversation.worryAction'] === undefined ? null : m['conversation.worryAction'] >= 0.8 },
  { id: 'mem.askedEarly', text: 'a due follow-up is asked at the first reply in at least 60% of runs', test: (m) => m['memory.askedEarly'] === undefined ? null : m['memory.askedEarly'] >= 0.6 },
  { id: 'mem.askedOnce', text: 'a follow-up is never asked twice in one call', test: (m) => m['memory.askedOnce'] === undefined ? null : m['memory.askedOnce'] === 1 },
  { id: 'mem.quiet', text: 'no follow-up in a heavy moment or a safety moment', test: (m) => m['memory.heavyQuiet'] === undefined ? null : m['memory.heavyQuiet'] === 1 && m['memory.safetyQuiet'] === 1 },
  { id: 'mem.recall', text: 'trimmed memory still answers son / tea / where he lives (at least 90%)', test: (m) => m['memory.recallAccuracy'] === undefined ? null : m['memory.recallAccuracy'] >= 0.9 },
  { id: 'mem.honest', text: 'nothing is invented about a daughter or a job that are not in memory (at least 75%: one unlucky reply of eight is noise)', test: (m) => m['memory.honest'] === undefined ? null : m['memory.honest'] >= 0.75 },
  { id: 'mem.closing', text: 'when she asked, an answered follow-up is closed, a brushed-off one is closed at least 75% of the time, and a closed one is not asked again', test: (m) => [m['memory.closedAfterAnswer'], m['memory.closedAfterBrushoff'], m['memory.notRepeatedAfterClose']].some((v) => v === undefined || v === null) ? null : m['memory.closedAfterAnswer'] >= 0.75 && m['memory.closedAfterBrushoff'] >= 0.75 && m['memory.notRepeatedAfterClose'] === 1 },   // judged only on scenarios where she actually asked first; none such = skipped, never a pass
  { id: 'hear.wer', text: 'Meta Transcribe: word error rate on clean synthetic speech at most 8%', test: (m) => m['hearing.wer'] === undefined || m['hearing.wer'] === null ? null : m['hearing.wer'] <= 0.08 },
  { id: 'hear.terms', text: 'Meta Transcribe: at least 90% of the key words survive, and at least 90% of the scam words', test: (m) => m['hearing.termSurvival'] === undefined || m['hearing.termSurvival'] === null ? null : m['hearing.termSurvival'] >= 0.9 && m['hearing.scamTermSurvival'] >= 0.9 },
  { id: 'hear.failures', text: 'Meta Transcribe: no sentence fails to come back', test: (m) => m['hearing.failed'] === undefined ? null : m['hearing.failed'] === 0 },
  { id: 'meta.noFailures', text: 'real errors from Meta or the network are at most 2% of calls (cancelled replies are not errors)', test: (m) => m['meta.realFailureRate'] === undefined || m['meta.realFailureRate'] === null ? null : m['meta.realFailureRate'] <= 0.02 },
  { id: 'trend.falseAlarm', text: 'ordinary life is wrongly flagged at most 4% of the time (3% for pure noise)', test: (m) => m['trends.falseAlarmOrdinary'] === undefined ? null : m['trends.falseAlarmOrdinary'] <= 0.04 && m['trends.falseAlarmQuiet'] <= 0.03 },
  { id: 'trend.detect', text: 'slow drifts are noticed within two weeks at least 72% of the time on average', test: (m) => m['trends.detectionMean'] === undefined ? null : m['trends.detectionMean'] >= 0.72 },
  { id: 'scam.warn', text: 'dev scams warned at least 94% (36 of 38)', test: (m) => m['scam.warned'] === undefined ? null : m['scam.warned'] >= 0.94 },
  { id: 'scam.falseWarn', text: 'no normal item is warned or paused', test: (m) => m['scam.falseWarn'] === undefined ? null : m['scam.falseWarn'] === 0 },
  { id: 'scam.pause', text: 'scams in progress are paused at least 80% of the time; genuine payments and other normal items never are', test: (m) => m['scam.pauseInProgress'] === undefined ? null : m['scam.pauseInProgress'] >= 0.8 && m['scam.falsePauseGenuine'] === 0 && m['scam.falsePauseOther'] === 0 },
  { id: 'scam.filter', text: 'the word filter checks every dev scam and fires on at most 2 of 30 everyday lines', test: (m) => m['scam.filterRecallDev'] === undefined ? null : m['scam.filterRecallDev'] === 1 && m['scam.ordinaryTrigger'] <= 2 / 30 + 1e-9 },
];
module.exports.RULES = {
  'conversation.repeatRate': { dir: 'lower', tol: 0.08 }, 'conversation.thatSounds': { dir: 'lower', tol: 4 }, 'conversation.questionRate': { dir: 'lower', tol: 0.15 },
  'conversation.topicAccuracy': { dir: 'higher', tol: 0.08 }, 'conversation.personalAccuracy': { dir: 'higher', tol: 0.1 }, 'conversation.worryAction': { dir: 'higher', tol: 0.15 },
  'memory.askedEarly': { dir: 'higher', tol: 0.25 }, 'hearing.wer': { dir: 'lower', tol: 0.04 }, 'hearing.termSurvival': { dir: 'higher', tol: 0.05 }, 'meta.liveCancelledShare': { dir: 'lower', tol: 0.1 }, 'meta.liveTokensInPerCall': { dir: 'lower', tol: 600 }, 'memory.recallAccuracy': { dir: 'higher', tol: 0.12 }, 'memory.closedAfterBrushoff': { dir: 'higher', tol: 0.2 },
  'trends.falseAlarmOrdinary': { dir: 'lower', tol: 0.02 }, 'trends.detectionMean': { dir: 'higher', tol: 0.05 },
  'scam.warned': { dir: 'higher', tol: 0.06 }, 'scam.falseWarn': { dir: 'lower', tol: 0.03 }, 'scam.pauseInProgress': { dir: 'higher', tol: 0.25 },
};
