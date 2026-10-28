// The orb's physics and mood rules (pure maths in public/orb.js). No browser here; the browser checks drive the real thing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MayaOrbMath: M } = require('../public/orb.js');

function run(target, from, p, seconds, fps = 60) {
  const st = { x: from, v: 0 }, out = [];
  for (let i = 0; i < seconds * fps; i++) { M.step(st, target, 1 / fps, p); out.push(st.x); }
  return out;
}

test('spring: release springs back with one tiny overshoot, then settles (no snap, no shake)', () => {
  const xs = run(0, 100, M.SPRING, 2);
  const lowest = Math.min(...xs);
  assert.ok(lowest < 0 && lowest > -12, `one small overshoot: ${lowest.toFixed(2)}`);           // about 7% of the pull
  const afterLowest = xs.slice(xs.indexOf(lowest));
  assert.ok(Math.max(...afterLowest) < 0.6, `a second bounce stays under a pixel: ${Math.max(...afterLowest).toFixed(2)}`); // from a 100 px pull
  assert.ok(Math.abs(xs[xs.length - 1]) < 0.01, 'settled');
  assert.ok(xs.findIndex((x) => Math.abs(x) < 1) / 60 < 1.1, 'settles within about a second');
  assert.ok(xs[1] < 100 && xs[0] > xs[5], 'moves smoothly from the first frame (no snap)');
});

test('spring: same motion at 30, 60 and 144 fps (stable, frame-rate independent)', () => {
  const at = (fps) => run(0, 100, M.SPRING, 0.5, fps).pop();
  assert.ok(Math.abs(at(30) - at(60)) < 0.6 && Math.abs(at(144) - at(60)) < 0.6);
  assert.ok(Number.isFinite(run(0, 100, M.SPRING, 1, 5).pop()), 'a very slow frame rate does not blow up');
});

test('spring: following a finger has only a tiny lag and does not overshoot much', () => {
  const xs = run(60, 0, M.FOLLOW, 1);
  assert.ok(xs[2] > 0 && xs[2] < 60, 'lags a little');
  assert.ok(Math.max(...xs) < 60 * 1.12, 'little overshoot');
  assert.ok(Math.abs(xs.pop() - 60) < 0.5);
});

test('spring: gliding between big and small settles without a big bounce', () => {
  const xs = run(1, 3.2, M.GLIDE, 1.5);
  assert.ok(Math.min(...xs) > 0.9 && Math.abs(xs.pop() - 1) < 0.01);
});

test('pull: the threshold is 80 px or 40 percent of the orb, whichever is larger, in any direction', () => {
  const S = 273;
  assert.equal(M.travel(30, 40), 50);
  assert.equal(M.shouldMinimize(30, S), false);
  assert.equal(M.shouldMinimize(M.pullThreshold(S) - 1, S), false);
  assert.equal(M.shouldMinimize(M.pullThreshold(S), S), true);
  assert.equal(M.pullThreshold(150), 80, 'a small orb still needs a deliberate pull');
  assert.equal(M.pullThreshold(273), Math.max(80, 0.4 * 273));
  assert.ok(M.pullThreshold(340) > M.pullThreshold(190), 'scales with the orb');
  assert.equal(M.shouldMinimize(M.travel(60, 60), 150), true, 'sideways and down together counts');
});

test('inner energy: louder = quicker and bigger flow, quiet = slow, silence = slow breathing, never negative or runaway', () => {
  assert.equal(M.energy(0), 0);
  assert.ok(M.energy(0.1) < M.energy(0.3) && M.energy(0.3) < M.energy(0.5));
  assert.equal(M.energy(5), 1, 'capped');
  assert.ok(M.flowRate(1) > 3 * M.flowRate(0), 'loud flows several times quicker than silent');
  assert.ok(M.flowRate(0) > 0.15 && M.flowRate(0) < 0.5, 'silence still breathes slowly');
  assert.ok(M.flowRate(0.5, 1) > M.flowRate(0.5, 0.5), 'the swell rate adds a little');
});

test('moods: who gets which colour (Maya orange, person blue-green, thinking lilac, resting dim dot)', () => {
  const m = (o) => M.mood({ quietMs: 0, who: 'none', ...o });
  assert.equal(m({ state: 'speaking', who: 'maya' }), 'maya');
  assert.equal(m({ state: 'listening', who: 'senior' }), 'senior');
  assert.equal(m({ state: 'thinking' }), 'thinking');
  assert.equal(m({ state: 'listening' }), 'warm');
  assert.equal(m({ state: 'listening', quietMs: 5999 }), 'warm');
  assert.equal(m({ state: 'listening', quietMs: 6000 }), 'rest');
  assert.equal(m({ state: 'listening', who: 'senior', quietMs: 60000 }), 'senior', 'someone talking is never "resting"');
  const warm = M.MOODS.maya.mid, teal = M.MOODS.senior.mid, lilac = M.MOODS.thinking.mid;
  assert.ok(warm[0] > 230 && warm[2] < 90, 'Maya is orange');
  assert.ok(teal[2] > teal[0] + 80 && teal[1] > teal[0] + 60, 'the person is blue-green');
  assert.ok(lilac[2] > lilac[1] + 40 && lilac[0] > lilac[1] + 20, 'thinking is lilac');
  assert.ok(M.MOODS.rest.size < 0.3 * M.MOODS.maya.size, 'resting is a small dim dot');
});

test('orb.js: nothing is drawn outside the dome (no shadow, no blur, no outer glow, no rings beyond the shell)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'orb.js'), 'utf8');
  assert.ok(!/shadowBlur|shadowColor|\.filter\s*=|ctx\.filter/.test(src));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const orbCss = css.slice(css.indexOf('/* ---------------------------------------------------------------------------------------------------------\n   Orb.'), css.indexOf('.status {'));
  assert.ok(!/box-shadow|drop-shadow|outline/.test(orbCss));
});

test('orb.js: no video, no image files as the orb; reference pictures are not app assets', () => {
  const pub = fs.readdirSync(path.join(__dirname, '..', 'public'));
  assert.ok(!pub.some((f) => /\.(mp4|webm|mov|png|jpe?g|gif|webp)$/i.test(f)), pub.join(','));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<video/.test(html));
  assert.ok(!/id="orb"[^]*?<\/div>/.exec(html)[0].includes('<img'), 'the orb box holds no picture');
});

test('orb.js: the shape never moves (no morph, stretch, squash, lean, size breathing; one fixed outline path)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'orb.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').replace(/\/\/.*$/gm, '');
  assert.ok(!/stretch|squash|rubber|morph|wobble|\blean\b|breathe\s*[=*]|g\.transform\(/.test(code), 'no deformation code is left');
  assert.equal((code.match(/g\.scale\(/g) || []).length, 2, 'only the dome unit scale and a glow blob (inside the clip) use scale');
  assert.ok(/const SHAPE = \(\(\) =>/.test(code), 'one outline, built once');
  assert.ok(!/function silhouette/.test(code));
});

test('index/css: no words on a call by default; icon strip has at most mute, expand, cut (+ Aa); no big buttons in the strip', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.ok(/body:not\(\[data-captions='on'\]\) \.status/.test(css));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const strip = html.slice(html.indexOf('id="callControls"'), html.indexOf('</section>', html.indexOf('id="callControls"')));
  assert.equal((strip.match(/<button /g) || []).length, 4, 'mute, expand, cut, Aa');
  assert.ok(!/>\s*(Mute|Cut Call|Unmute)\s*</.test(strip), 'icons, not words');
});

test('widget: always clamped inside the screen with an 8px margin; first sits bottom-right above the composer', () => {
  const c = (x, y) => M.clampWidget(x, y, 150, 100, 390, 844);
  assert.deepEqual(c(-500, -500), { x: 8, y: 8 }, 'top-left stop');
  assert.deepEqual(c(9999, 9999), { x: 390 - 150 - 8, y: 844 - 100 - 8 }, 'bottom-right stop');
  assert.deepEqual(c(100, 300), { x: 100, y: 300 }, 'inside: untouched');
  assert.deepEqual(M.clampWidget(0, 0, 500, 500, 360, 300), { x: 8, y: 8 }, 'too big for the screen: sits at the margin, never negative');
  const d = M.defaultWidget(150, 100, 390, 844, 700);
  assert.deepEqual(d, { x: 390 - 150 - 12, y: 700 - 100 - 8 }, 'bottom-right, 8 px above the composer');
  assert.ok(d.x + 150 <= 390 - 8 && d.y + 100 <= 844 - 8);
  assert.deepEqual(M.defaultWidget(150, 100, 390, 844, 0), M.clampWidget(390 - 162, 844 - 108, 150, 100, 390, 844), 'no composer: bottom of the screen');
});

test('widget: almost no movement is a tap (expands); more is a drag (never expands, mutes or cuts)', () => {
  assert.equal(M.isTap(0), true);
  assert.equal(M.isTap(M.TAP_PX), true);
  assert.equal(M.isTap(M.TAP_PX + 0.5), false);
  assert.equal(M.TAP_PX, 8);
});
