// datadirs.js: a data folder that cannot be created or written must stop Maya at once with a plain message (variable name, folder name, error code; never a path, never a stack trace),
// and the start-up lines say how many folders are inside the app and how many are on a separate disk. Real child processes, temp folders, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspect, failMessage, DIRS } = require('../datadirs');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirsIn = (tmp) => ({ MAYA_DATA_DIR: path.join(tmp, 'profiles'), MAYA_CARE_DIR: path.join(tmp, 'care'), MAYA_WA_DIR: path.join(tmp, 'wa'), MAYA_MEDIA_DIR: path.join(tmp, 'media') });
const sameDevice = (a, b) => fs.statSync(a).dev === fs.statSync(b).dev;
function boot(mode, dirs, extra = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, META_MODE: mode, PORT: String(port), ...dirs, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  return { port, child, out: () => out.join(''), exited: new Promise((res) => child.on('exit', (code) => res(code))) };
}
async function up(port) { for (let i = 0; i < 60; i++) { try { return await fetch(`http://localhost:${port}/api/config`); } catch { await sleep(150); } } throw new Error('server did not start'); }
const keys = { META_API_KEY: 'k', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' };

test('inspect: creates the four folders, counts which are inside the app and which are on a separate filesystem, and says which one failed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-dd-')); const env = dirsIn(tmp);
  const ok = inspect(env, root); assert.equal(ok.failed, null); assert.equal(ok.inside, 0); assert.equal(ok.of, 4); for (const d of Object.values(env)) assert.ok(fs.statSync(d).isDirectory(), 'created');
  assert.equal(ok.separate, sameDevice(tmp, root) ? 0 : 4, 'a separate filesystem is counted, the same one is not');
  const inApp = inspect({ MAYA_DATA_DIR: '', MAYA_CARE_DIR: '', MAYA_WA_DIR: '', MAYA_MEDIA_DIR: '' }, tmp);   // empty = the defaults, under the "app" folder (here a temp folder)
  assert.equal(inApp.inside, 4); assert.equal(inApp.separate, 0, 'inside the app folder is never a separate disk'); assert.equal(inApp.failed, null);
  const file = path.join(tmp, 'a-file'); fs.writeFileSync(file, 'x');
  const bad = inspect({ ...env, MAYA_CARE_DIR: path.join(file, 'care') }, root); assert.deepEqual(bad.failed, { key: 'MAYA_CARE_DIR', code: 'ENOTDIR', name: 'care' });
  assert.deepEqual(Object.keys(DIRS), ['MAYA_DATA_DIR', 'MAYA_CARE_DIR', 'MAYA_WA_DIR', 'MAYA_MEDIA_DIR']);
});

test('failMessage: names the variable, the folder (last name only) and the code, asks about the disk, and carries no path', () => {
  const m = failMessage({ key: 'MAYA_DATA_DIR', code: 'EACCES', name: 'profiles' });
  assert.match(m, /^FATAL: the data folder for MAYA_DATA_DIR \("profiles"\) cannot be created or written to \(EACCES\)\. Is the persistent disk attached, and does MAYA_DATA_DIR point inside its mount path \(render\.yaml uses \/var\/data\)\? Maya did not start/);
  assert.doesNotMatch(m, /node:fs|\bat Object\./);
});

test('a real start with a folder that cannot be created: exit 1, a plain message, no stack trace, no path, and the server never listens', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-ddfail-')); const file = path.join(tmp, 'not-a-folder'); fs.writeFileSync(file, 'x');
  const s = boot('mock', { ...dirsIn(tmp), MAYA_DATA_DIR: path.join(file, 'profiles') });
  try {
    const code = await Promise.race([s.exited, sleep(15000).then(() => 'timeout')]); assert.equal(code, 1);
    const out = s.out(); assert.match(out, /FATAL: the data folder for MAYA_DATA_DIR \("profiles"\) cannot be created or written to \(ENOTDIR\)\. Is the persistent disk attached/);
    assert.doesNotMatch(out, /node:fs|at Object\.|at Module\.|mkdirSync/, 'no raw stack trace'); assert.ok(!out.includes(tmp), 'no path is printed'); assert.doesNotMatch(out, /Maya running/, 'it never listened');
    assert.ok(!fs.existsSync(path.join(tmp, 'care')), 'and it created nothing else after the failure was found');
  } finally { s.child.kill('SIGKILL'); }
});

test('a real start where the folder exists but cannot be WRITTEN to (a disk mounted read-only for this user): the same plain refusal (EACCES)', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root can write anywhere' : false }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-ddro-')); const ro = path.join(tmp, 'mounted'); fs.mkdirSync(ro); fs.mkdirSync(path.join(ro, 'care')); fs.chmodSync(path.join(ro, 'care'), 0o500);
  const s = boot('mock', { ...dirsIn(tmp), MAYA_CARE_DIR: path.join(ro, 'care') });
  try {
    const code = await Promise.race([s.exited, sleep(15000).then(() => 'timeout')]); assert.equal(code, 1);
    assert.match(s.out(), /FATAL: the data folder for MAYA_CARE_DIR \("care"\) cannot be created or written to \(EACCES\)/); assert.doesNotMatch(s.out(), /Maya running|node:fs/);
  } finally { fs.chmodSync(path.join(ro, 'care'), 0o700); s.child.kill('SIGKILL'); }
});

test('real mode start-up lines: counts of inside / separate, the inside warning, and the new "same filesystem, not a separate disk" warning; mock mode prints none of it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-ddrep-')); const sep = sameDevice(tmp, root) ? 0 : 4;
  const disk = boot('real', dirsIn(tmp), keys);
  try { await up(disk.port); await sleep(200); } finally { disk.child.kill('SIGKILL'); }
  assert.match(disk.out(), new RegExp(`data directories \\{"insideTheAppFolder":0,"onSeparateDisk":${sep},"of":4\\}`));
  if (sep === 0) assert.match(disk.out(), /WARNING: 4 of 4 data folders are on the same filesystem as the app, not on a separate disk\. Unless this is a development machine, the persistent disk is not mounted/);
  else assert.doesNotMatch(disk.out(), /WARNING/);
  const inside = boot('real', { MAYA_DATA_DIR: '', MAYA_CARE_DIR: '', MAYA_WA_DIR: '', MAYA_MEDIA_DIR: '' }, keys);
  try { await up(inside.port); await sleep(200); } finally { inside.child.kill('SIGKILL'); }
  assert.match(inside.out(), /data directories \{"insideTheAppFolder":4,"onSeparateDisk":0,"of":4\}/); assert.match(inside.out(), /WARNING: 4 of 4 data folders are inside the app folder, which is wiped on every deploy and restart\./);
  assert.doesNotMatch(disk.out() + inside.out(), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no path is printed');
  const mock = boot('mock', dirsIn(fs.mkdtempSync(path.join(os.tmpdir(), 'maya-ddmock-'))));
  try { await up(mock.port); await sleep(100); } finally { mock.child.kill('SIGKILL'); }
  assert.doesNotMatch(mock.out(), /data directories|WARNING/);
});
