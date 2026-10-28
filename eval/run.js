#!/usr/bin/env node
// Maya evaluation: runs the suites against REAL Meta Spark (text only: no voice, no ElevenLabs), scores them, checks the guard rails, compares with
// docs/eval/baseline.json and prints the Meta usage table. Each suite runs in its own child process on throwaway data folders (never your real data).
//   node eval/run.js [--suites conversation,memory,trends,scam,hearing] [--runs 2] [--out file] [--no-compare] [--update-baseline]
// Exit code 1 when a guard rail fails or a number has regressed from the baseline.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = ['conversation', 'memory', 'trends', 'scam', 'hearing'];
const BASELINE = path.join(ROOT, 'docs', 'eval', 'baseline.json');

function parseArgs(argv) {
  const a = { suites: SUITES, runs: 2, out: path.join(ROOT, 'eval-results', 'latest.json'), compare: true, updateBaseline: false, child: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--suites') a.suites = String(argv[++i] || '').split(',').filter((s) => SUITES.includes(s));
    else if (k === '--runs') a.runs = Math.max(1, Math.min(6, Number(argv[++i]) || 2));
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--no-compare') a.compare = false;
    else if (k === '--update-baseline') a.updateBaseline = true;
    else if (k === '--child') a.child = argv[++i];
    else if (k === '--limit') a.limit = Math.max(1, Number(argv[++i]) || 1);
  }
  return a;
}

// A child prints one line "EVAL_RESULT {json}"; everything else it prints is ignored.
function parseChild(stdout) {
  const line = String(stdout || '').split('\n').reverse().find((l) => l.startsWith('EVAL_RESULT '));
  if (!line) return null;
  try { return JSON.parse(line.slice('EVAL_RESULT '.length)); } catch { return null; }
}

// Merges usage tables (ledger summaries) from several suites into one: per purpose and model, calls and failures add up, speed is weighted by calls.
function mergeUsage(tables) {
  const by = new Map();
  for (const rows of tables) for (const r of rows || []) {
    const k = `${r.purpose}|${r.model}`, s = by.get(k) || { purpose: r.purpose, model: r.model, calls: 0, failed: 0, failedBy: {}, msSum: 0, msN: 0, tokensIn: 0, tokensOut: 0, audioMs: 0 };
    for (const [e, n] of Object.entries(r.failedBy || {})) s.failedBy[e] = (s.failedBy[e] || 0) + n;
    s.calls += r.calls; s.failed += r.failed; s.tokensIn += r.tokensIn; s.tokensOut += r.tokensOut; s.audioMs += r.audioMs;
    if (r.avgMs !== null && r.avgMs !== undefined) { s.msSum += r.avgMs * r.calls; s.msN += r.calls; }
    by.set(k, s);
  }
  return [...by.values()].map((s) => ({ purpose: s.purpose, model: s.model, calls: s.calls, failed: s.failed, failedBy: s.failedBy, avgMs: s.msN ? Math.round(s.msSum / s.msN) : null, tokensIn: s.tokensIn, tokensOut: s.tokensOut, audioMs: s.audioMs })).sort((a, b) => a.purpose.localeCompare(b.purpose));
}

// Numbers about the Meta calls themselves, from the merged usage table: real errors (not counting replies Maya cancelled on purpose), how many live
// replies were cancelled and rewritten, and how big a live reply request is.
function usageMetrics(usage) {
  const calls = usage.reduce((a, u) => a + u.calls, 0), failed = usage.reduce((a, u) => a + u.failed, 0), cancelled = usage.reduce((a, u) => a + ((u.failedBy || {}).aborted || 0), 0);
  const live = usage.find((u) => u.purpose === 'live-reply');
  return { realFailureRate: calls ? (failed - cancelled) / calls : null, liveCancelledShare: live && live.calls ? ((live.failedBy || {}).aborted || 0) / live.calls : null, liveTokensInPerCall: live && live.calls ? Math.round(live.tokensIn / live.calls) : null };
}

// The reasoning-setting comparison, from the scam suite's metrics: one row per setting.
function reasoningRows(m) {
  const out = [];
  for (const s of ['low', 'minimal']) if (m && m[`${s}_warned`] !== undefined) out.push({ setting: s, warned: m[`${s}_warned`], falseWarn: m[`${s}_falseWarn`], pause: m[`${s}_pauseInProgress`], avgMs: m[`${s}_avgMs`], p90Ms: m[`${s}_p90Ms`], tokensIn: m[`${s}_tokensIn`], tokensOut: m[`${s}_tokensOut`] });
  return out;
}

const pc = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const fmtVal = (k, v) => (v === null || v === undefined ? 'n/a' : /(avgMs|p90Ms|tokens|thatSounds|replies|avgWords|medianDelay|scams|normal)/i.test(k) ? String(Math.round(v * 10) / 10) : pc(v));
const pad = (s, n) => String(s).padEnd(n);
function tables({ metrics, checks, cmp, usage, reasoning }) {
  const L = [];
  L.push('GUARD RAILS'); for (const c of checks) L.push(`  ${pad(c.status, 8)} ${c.text}`);
  if (cmp && cmp.length) { L.push('', 'VERSUS BASELINE'); for (const r of cmp.filter((x) => x.status !== 'n/a')) L.push(`  ${pad(r.status, 10)} ${pad(r.key, 34)} was ${fmtVal(r.key, r.was)}  now ${fmtVal(r.key, r.now)}`); }
  L.push('', 'META MODELS DOING THE WORK (this run)', `  ${pad('job', 24)} ${pad('model', 24)} ${pad('calls', 6)} ${pad('cancelled', 10)} ${pad('failed', 7)} ${pad('avg ms', 8)} ${pad('tokens in', 10)} tokens out`);
  for (const u of usage) { const cancelled = (u.failedBy || {}).aborted || 0; L.push(`  ${pad(u.purpose, 24)} ${pad(u.model, 24)} ${pad(u.calls, 6)} ${pad(cancelled, 10)} ${pad(u.failed - cancelled, 7)} ${pad(u.avgMs ?? 'n/a', 8)} ${pad(u.tokensIn, 10)} ${u.tokensOut}`); }
  L.push('  (cancelled = stopped on purpose by Maya, e.g. when a reply is rewritten; failed = a real error from Meta or the network)');
  if (reasoning && reasoning.length) { L.push('', 'SCAM CHECK ON TALK: REASONING SETTING (dev half; minimal is live since 2026-10-28, low is the earlier setting)', `  ${pad('setting', 9)} ${pad('warned', 8)} ${pad('false warn', 11)} ${pad('pause', 7)} ${pad('avg ms', 8)} ${pad('p90 ms', 8)} ${pad('tok in', 7)} tok out`); for (const r of reasoning) L.push(`  ${pad(r.setting, 9)} ${pad(pc(r.warned), 8)} ${pad(pc(r.falseWarn), 11)} ${pad(pc(r.pause), 7)} ${pad(r.avgMs, 8)} ${pad(r.p90Ms, 8)} ${pad(r.tokensIn, 7)} ${r.tokensOut}`); }
  return L.join('\n');
}

async function childMain(a) {
  // Throwaway data folders ALWAYS (never the real data), real Meta key from .env, the usage ledger on.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `maya-eval-${a.child}-`));
  process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles'); process.env.MAYA_CARE_DIR = path.join(tmp, 'care'); process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }
  process.env.MAYA_META_LEDGER = '1';
  const suite = require(path.join(__dirname, 'suites', a.child));
  const t0 = Date.now();
  const res = await suite.run({ runs: a.runs, limit: a.limit });
  const meta = require(path.join(ROOT, 'meta'));
  process.stdout.write(`EVAL_RESULT ${JSON.stringify({ suite: suite.name, metrics: res.metrics, details: res.details, usage: meta.summary(), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(0);
}

function runChild(name, a) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [__filename, '--child', name, '--runs', String(a.runs), ...(a.limit ? ['--limit', String(a.limit)] : [])], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d.toString().slice(-2000); });
    p.on('close', (code) => { const r = parseChild(out); resolve(r || { suite: name, error: `suite ${name} produced no result (exit ${code}): ${err.slice(-400)}` }); });
  });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.child) return childMain(a);
  const score = require('./score'); const rules = require('./rules');
  console.log(`Maya eval: suites ${a.suites.join(', ')} | ${a.runs} runs each | Meta text only (no voice, no ElevenLabs) | held-out scam half untouched`);
  const t0 = Date.now();
  const results = await Promise.all(a.suites.map((s) => runChild(s, a)));
  const failedSuites = results.filter((r) => r.error);
  for (const r of failedSuites) console.error(`ERROR: ${r.error}`);
  const ok = results.filter((r) => !r.error);
  const usage = mergeUsage(ok.map((r) => r.usage));
  const metrics = score.flatten({ ...Object.fromEntries(ok.map((r) => [r.suite, r.metrics])), meta: usageMetrics(usage) });
  const checks = score.runChecks(metrics, rules.CHECKS);
  let baseline = null, spread = null;
  try { const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); baseline = b.metrics; spread = b.spread || null; } catch { /* none yet */ }
  const cmp = a.compare && baseline ? score.compare(metrics, baseline, rules.RULES, spread) : [];
  const scamM = (ok.find((r) => r.suite === 'scam') || {}).metrics;
  console.log(tables({ metrics, checks, cmp, usage, reasoning: reasoningRows(scamM) }));
  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, JSON.stringify({ when: new Date().toISOString(), runs: a.runs, seconds: Math.round((Date.now() - t0) / 1000), metrics, checks, compare: cmp, usage, suites: ok }, null, 1));
  if (a.updateBaseline) { fs.mkdirSync(path.dirname(BASELINE), { recursive: true }); fs.writeFileSync(BASELINE, JSON.stringify({ about: 'Single-run baseline of the Maya evaluation (rates 0..1), written by `node eval/run.js --update-baseline`. Prefer `node eval/baseline.js <several runs> --write`, which also records the run-to-run spread.', when: new Date().toISOString(), runs: a.runs, metrics, spread: {} }, null, 1)); console.log(`baseline written: ${path.relative(ROOT, BASELINE)}`); }
  console.log(`\nresults: ${path.relative(ROOT, a.out)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  const bad = checks.some((c) => c.status === 'FAIL') || cmp.some((r) => r.status === 'REGRESSED') || failedSuites.length > 0;
  process.exit(bad ? 1 : 0);
}

module.exports = { usageMetrics, parseArgs, parseChild, mergeUsage, reasoningRows, tables, SUITES };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
