// The README's testing section and the pre-push example: they must describe commands that really exist, and the example must never spend Meta calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const hook = fs.readFileSync(path.join(ROOT, 'scripts', 'pre-push.example.sh'), 'utf8');

test('the README documents the commands that exist in package.json, and nothing it names is missing', () => {
  assert.match(readme, /## Tests and evaluation/);
  for (const c of ['npm test', 'npm run eval', 'npm run eval:offline', 'node eval/page.js', 'node eval/baseline.js']) assert.ok(readme.includes(c), c);
  assert.equal(pkg.scripts.test, 'node --test test/*.test.js'); assert.equal(pkg.scripts.eval, 'node eval/run.js'); assert.equal(pkg.scripts['eval:offline'], 'node eval/run.js --suites trends');
  for (const f of ['eval/run.js', 'eval/page.js', 'eval/baseline.js', 'docs/eval/baseline.json', 'docs/meta-models.html', 'docs/scam-results.md', 'scripts/pre-push.example.sh']) assert.ok(readme.includes(f), `the README mentions ${f}`);
  for (const f of ['eval/run.js', 'eval/page.js', 'eval/baseline.js', 'scripts/pre-push.example.sh']) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
});

test('the README says what the evaluation costs and never touches: Meta only, never ElevenLabs, dev half only, throwaway data', () => {
  const section = readme.slice(readme.indexOf('## Tests and evaluation'), readme.indexOf('## Status'));
  assert.match(section, /Neither ever calls ElevenLabs/); assert.match(section, /About 700 Meta calls and about 5 minutes/); assert.match(section, /throwaway data folders, never on your real data/);
  assert.match(section, /Routine runs use only the \*\*dev\*\* half/); assert.match(section, /never to hide a regression/); assert.match(section, /copy `scripts\/pre-push\.example\.sh` to `\.git\/hooks\/pre-push` yourself/);
});

test('the pre-push example is only an example: it installs nothing, runs only offline checks, and never the Meta evaluation', () => {
  assert.match(hook, /^#!\/bin\/sh/); assert.match(hook, /THIS IS AN EXAMPLE: nothing installs it for you/); assert.match(hook, /set -e/);
  const code = hook.replace(/^#.*$/gm, '');
  assert.match(code, /npm test/); assert.match(code, /node eval\/run\.js --suites trends/);
  assert.doesNotMatch(code, /npm run eval(?!:)|eval\/run\.js(?! --suites trends)|ELEVEN|fetch|curl|\.git\/hooks|cp /, 'no Meta evaluation, no network, no copying itself into place');
  assert.ok((fs.statSync(path.join(ROOT, 'scripts', 'pre-push.example.sh')).mode & 0o111) !== 0, 'executable once copied');
  assert.equal(fs.existsSync(path.join(ROOT, '.git', 'hooks', 'pre-push')), false, 'nothing has been installed in this repository');
});
