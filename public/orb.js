// Maya's presence on the call page (and a small quiet one on the family page): a sphere of fine particles in trust blue and teal, turning slowly.
// The same orb as the phone app (app/lib/widgets/orb.dart), drawn on a canvas in code (no image, no video).
// EVERY particle moves, all the time, each at its own rhythm. How far and how fast they move follows the SOUND itself, frame by frame: app.js reads the loudness of
// the person's voice (microphone) and of Maya's voice (playback) and hands it to draw() on every frame, on top of a resting level set by who is speaking:
//   Maya speaking  - the whole surface swells and ripples
//   you speaking   - the surface answers just as strongly (a touch smaller)
//   thinking       - a steady shimmer
//   listening      - a quiet breathing (the particles still stir, so the page is never dead)
//   connecting     - the faintest stir
// Nothing is drawn outside the particles (no glow, no rings, no shadow). Cool colours only: teal at the top, through cyan-blue, to trust blue below.
const MayaParticles = {
  COUNT: 3400,
  // teal at the top, through cyan-blue, to trust blue below (cool only)
  RAMP: ['#2BD1BE', '#35B6E8', '#4A8BEF', '#5A6FE6'],
  ALPHAS: [0.34, 0.68, 0.96],   // depth: back (dim), middle, front (bright)
  WIDTHS: [1.2, 1.7, 2.2],
  // the resting movement (0 is still, 1 is the full swell) for who is speaking; the live sound adds to it
  rest(state, you) {
    if (you) return 0.34;
    switch (state) {
      case 'speaking': return 0.30;
      case 'thinking': return 0.30;
      case 'listening': return 0.16;
      default: return 0.10;   // connecting / idle: the faintest stir
    }
  },
  // the amount of movement wanted this frame, from the resting level and the live loudness (0..1)
  target(rest, heard) { return Math.min(1, rest + Math.max(0, Math.min(1, heard || 0)) * 0.85); },
  // quick to rise, slower to settle; k is how many 60 Hz frames passed
  ease(eff, target, frames = 1) { const a = target > eff ? 0.55 : 0.14; return eff + (target - eff) * (1 - Math.pow(1 - a, frames)); },
  // a fixed cloud: one point per band from the top to the bottom, turned about the vertical axis by the golden angle, each with its own rhythm
  cloud(n = this.COUNT) {
    const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), ph1 = new Float32Array(n), f1 = new Float32Array(n), tint = new Uint8Array(n);
    let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };   // a fixed sequence: the same orb every time
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const yy = 1 - (i / (n - 1)) * 2, rr = Math.sqrt(1 - yy * yy), th = golden * i;
      x[i] = Math.cos(th) * rr; y[i] = yy; z[i] = Math.sin(th) * rr;
      ph1[i] = rnd() * Math.PI * 2; f1[i] = 0.9 + rnd() * 1.9; tint[i] = Math.floor(rnd() * 256);
    }
    return { n, x, y, z, ph1, f1, tint };
  },
  // Paint one frame into a ctx of CSS size w x h. t = phase (seconds, runs faster when louder), level = smoothed movement 0..1.
  paint(ctx, w, h, cloud, t, level, you, buckets) {
    const { n } = cloud, cx = w / 2, cy = h / 2;
    const base = Math.min(w, h) / 2 * 0.80 * (1 + 0.035 * Math.sin(t * 0.9) + 0.09 * level);   // the whole body breathes and swells with the sound; room is left for the particles to rise
    const ay = t * 0.16, ax = 0.42;                                                              // slow turn, a little tilt
    const cyy = Math.cos(ay), syy = Math.sin(ay), cxx = Math.cos(ax), sxx = Math.sin(ax);
    const swell = 0.03 + 0.20 * level;                                                           // how far a particle may leave the surface: the louder, the further
    const bx = buckets, bc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const x0 = cloud.x[i], y0 = cloud.y[i], z0 = cloud.z[i];
      // slow waves run over the whole surface (neighbours move together, as one body), and each particle adds a small rhythm of its own
      const wave = 0.5 * Math.sin(6.4 * x0 + 4.6 * y0 + t * (1.6 + 1.4 * level)) + 0.35 * Math.sin(5.6 * y0 - 6.8 * z0 + t * (2.2 + 1.2 * level) + 1.0) + 0.25 * Math.sin(7.0 * z0 + 4.2 * x0 - t * (1.4 + 1.6 * level) + 2.1);
      const own = Math.sin(cloud.f1[i] * t * (you ? 1.3 : 1.0) + cloud.ph1[i]);
      const wv = 0.72 * wave + 0.28 * own;   // -1 .. 1
      const r = 1 + swell * (0.35 + 0.65 * Math.abs(wv)) * (wv >= 0 ? 1.0 : -0.5);
      const px = x0 * r, py = y0 * r, pz = z0 * r;
      const rx = px * cyy + pz * syy, rz = -px * syy + pz * cyy;   // turn about the vertical axis, then tilt
      const ry = py * cxx - rz * sxx, rz2 = py * sxx + rz * cxx;
      const depth = rz2 < -0.25 ? 0 : (rz2 < 0.35 ? 1 : 2);
      const k = Math.min(0.999, Math.max(0, (ry * 0.55 + rx * 0.25) * 0.5 + 0.5 + (cloud.tint[i] - 128) / 1400));
      const b = Math.floor(k * 4) * 3 + depth, at = bc[b];
      bx[b][at] = cx + rx * base; bx[b][at + 1] = cy + ry * base; bc[b] = at + 2;
    }
    ctx.clearRect(0, 0, w, h);
    const scale = Math.min(1.5, Math.max(0.6, Math.min(w, h) / 240));
    for (let b = 0; b < 12; b++) {
      if (!bc[b]) continue;
      const d = b % 3, px = this.WIDTHS[d] * scale, half = px / 2;
      ctx.globalAlpha = this.ALPHAS[d]; ctx.fillStyle = this.RAMP[Math.floor(b / 3)];
      ctx.beginPath();
      for (let j = 0; j < bc[b]; j += 2) { ctx.moveTo(bx[b][j] + half, bx[b][j + 1]); ctx.arc(bx[b][j], bx[b][j + 1], half, 0, 6.2832); }   // one round dot per particle, one fill per colour
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  // Put an orb on a canvas. read() -> { state, you } is asked on every frame. Returns { draw(ts, heard) } and, with auto, runs by itself (the family page).
  mount(canvas, read, { auto = false } = {}) {
    const ctx = canvas.getContext('2d'), cloud = this.cloud();
    const buckets = Array.from({ length: 12 }, () => new Float32Array(cloud.n * 2));
    let eff = 0.2, phase = 0, last = 0, w = 0, h = 0;
    const fit = () => {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const self = {
      draw: (ts, heard) => {
        if (!w || !h) fit();
        const dt = last ? Math.min(0.1, (ts - last) / 1000) : 1 / 60; last = ts;
        const s = read(), target = this.target(this.rest(s.state, s.you), heard);
        eff = this.ease(eff, target, dt * 60);
        phase += dt * (1 + 2.4 * eff);
        this.paint(ctx, w, h, cloud, phase, eff, s.you, buckets);
      },
      fit,
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { fit(); self.draw(last || performance.now(), 0); }).observe(canvas);
    if (auto && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) { const loop = (ts) => { requestAnimationFrame(loop); self.draw(ts, 0); }; requestAnimationFrame(loop); }
    else requestAnimationFrame((ts) => self.draw(ts, 0));   // a still picture for someone who asked for less motion
    return self;
  },
};

if (typeof module !== 'undefined') module.exports = { MayaParticles };

(() => {
  'use strict';
  if (typeof document === 'undefined') return;
  const fam = document.getElementById('famOrb');   // the family page: a small quiet orb beside the name, always gently moving
  if (fam) { const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block'; fam.append(cv); MayaParticles.mount(cv, () => ({ state: 'listening', you: false }), { auto: true }); }
  const orb = document.getElementById('orb');
  if (!orb) return;   // the family page has no call orb
  const canvas = orb.querySelector('canvas');
  if (!canvas) return;
  const statusEl = document.getElementById('status');
  // you = the person's words are arriving right now ("I hear you." in the status), shown as the orb answering them
  const read = () => ({ state: orb.dataset.state, you: orb.dataset.state === 'listening' && Boolean(statusEl) && statusEl.textContent === 'I hear you.' });
  const inst = MayaParticles.mount(canvas, read);
  window.mayaOrb = { draw: (ts, level) => inst.draw(ts, level) };   // app.js calls this on every frame with the live loudness
})();
