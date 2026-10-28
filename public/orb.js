// The orb: a frosted dome with a warm glow flowing inside it, drawn in code on a canvas (no image, no video). app.js feeds it
// the live audio level and swell rate once per frame; this file paints it and handles the pull-away gesture.
//
// The SHAPE NEVER MOVES. The dome outline is one fixed path: no morph, no stretch, no squash, no wobble, no size breathing.
// Only the light INSIDE the glass moves: it flows, swirls, pulses, ripples and sparkles, always clipped to the dome, so nothing
// is ever drawn outside the silhouette and there are no rings beyond it.
// Mood colours: Maya speaking bright orange, listening warm, the person speaking blue-green, thinking lilac, resting a dim dot.
// Energy: a louder voice = bigger, brighter, quicker inner flow; a quieter voice = calmer, dimmer, slower; silence = a slow
// inner breathing of the glow. Flow speed is integrated into a phase, so a change of speed never makes the motion jump.
// Pull: touch (or drag) the big orb and the WHOLE orb follows the finger with a little lag (it is translated, never deformed).
// Let go past the threshold and it glides to the small place (the call stays live, the chat comes up); let go short of it and
// it springs back to the centre with one tiny overshoot. Moves between the big and small places glide on springs too.
const MayaOrbMath = {
  // Damped spring. Semi-implicit Euler in small fixed steps, so it stays stable at any frame rate.
  // zeta 0.667 = one small overshoot (about 7%), then settles.
  SPRING: { k: 110, c: 14 },        // release: ~0.5 s, one tiny overshoot
  FOLLOW: { k: 230, c: 23 },        // while a finger is down: tight but not rigid (a tiny delay)
  GLIDE: { k: 120, c: 18.6 },       // big <-> small orb position and size
  step(st, target, dt, p) {
    let n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    while (n-- > 0) { st.v += (-p.k * (st.x - target) - p.c * st.v) * h; st.x += st.v * h; }
    return st;
  },
  // Pulled this far (px of finger travel, in any direction away from where the orb sits) and let go = minimize. Less = spring back.
  // 80 px, or 40 percent of the orb's size, whichever is larger.
  pullThreshold(S) { return Math.max(80, 0.4 * S); },
  travel(dx, dy) { return Math.hypot(dx, dy); },
  shouldMinimize(d, S) { return d >= this.pullThreshold(S); },
  // The minimized call is a small floating widget (orb + buttons). A finger that moves more than TAP_PX is a drag, never a tap.
  TAP_PX: 8,
  MARGIN: 8,
  isTap(travel) { return travel <= this.TAP_PX; },
  // Keep a w x h widget fully on screen with a margin on every side (if the screen is too small for it, it sits at the margin).
  clampWidget(x, y, w, h, vw, vh, m = this.MARGIN) {
    return { x: Math.round(Math.max(m, Math.min(x, vw - w - m))), y: Math.round(Math.max(m, Math.min(y, vh - h - m))) };
  },
  // Where it first sits: bottom-right, just above the composer (composerTop), 12 px in from the right edge.
  defaultWidget(w, h, vw, vh, composerTop) {
    return this.clampWidget(vw - w - 12, (composerTop > 0 ? composerTop : vh) - h - 8, w, h, vw, vh);
  },
  THINKING_ENERGY: 0.42,   // the inner flow while Maya thinks (lilac): clearly moving, calmer than speech
  // Inner energy 0..1 from the live level (quiet = calm, loud = lively). Smooth and monotonic.
  energy(level) { return Math.max(0, Math.min(1, level * 1.7)); },
  // How fast the inner flow turns (radians per second): slow when quiet, quick when loud.
  flowRate(energy, swell) { return (0.3 + 1.9 * energy) * (0.8 + 0.2 * (swell || 0.8)); },
  // Which mood paints the orb.
  mood({ state, who, quietMs }) {
    if (state === 'speaking') return 'maya';
    if (state === 'thinking') return 'thinking';
    if (who === 'senior') return 'senior';
    if (state === 'listening' && quietMs >= 6000) return 'rest';
    if (state === 'idle') return 'rest';
    return 'warm';
  },
  MOODS: {
    warm: { core: [255, 207, 143], mid: [246, 158, 82], size: 0.86, alpha: 0.92 },
    maya: { core: [255, 214, 140], mid: [250, 128, 40], size: 1.0, alpha: 1 },
    senior: { core: [170, 238, 220], mid: [40, 176, 190], size: 0.92, alpha: 0.97 },
    thinking: { core: [230, 212, 252], mid: [156, 124, 214], size: 0.8, alpha: 0.9 },
    rest: { core: [250, 216, 164], mid: [236, 178, 112], size: 0.22, alpha: 0.62 },
  },
};
if (typeof module !== 'undefined') module.exports = { MayaOrbMath };

(() => {
  'use strict';
  if (typeof document === 'undefined') return;
  const orb = document.getElementById('orb');
  const status = document.getElementById('status');
  if (!orb || !status) return;
  const M = MayaOrbMath;
  const HEARING = 'I hear you.'; // same words as STATUS.hearing in app.js
  const reduceMotion = Boolean(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- who is talking (read by the mood and by the CSS hooks) ----
  function updateWho() {
    const state = orb.dataset.state;
    const who = state === 'speaking' ? 'maya'
      : state === 'listening' && status.textContent === HEARING ? 'senior'
      : 'none';
    if (orb.dataset.who !== who) orb.dataset.who = who;
    if (who !== 'none') lastActive = performance.now();
    still();
  }
  let lastActive = performance.now();
  new MutationObserver(updateWho).observe(status, { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateWho).observe(orb, { attributes: true, attributeFilter: ['data-state', 'data-muted'] });

  // ---- canvas: exactly the orb box (the shape never grows or stretches, so it needs no spare room) ----
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  orb.append(cv);
  const g = cv.getContext('2d');
  let S = 0, dpr = 1;
  function fit() {
    const size = orb.offsetWidth;
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (!size || (size === S && d === dpr)) return Boolean(size);
    S = size; dpr = d;
    cv.width = Math.round(S * dpr);
    cv.height = Math.round(S * dpr);
    return true;
  }

  // ---- state ----
  const cur = { core: [...M.MOODS.rest.core], mid: [...M.MOODS.rest.mid], size: M.MOODS.rest.size, alpha: M.MOODS.rest.alpha };
  const pull = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } };          // where the finger has taken the whole orb
  const glide = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, s: { x: 1, v: 0 } };
  let drag = null;               // { id, x0, y0, dx, dy }
  let armed = false;
  let t = 0, flow = 0, swirl = 0, lastTs = 0, rippleAt = -99, lastSpeaking = false, energy = 0;
  let rect = null;               // the orb's last on-screen box (for the glide)
  const dots = Array.from({ length: 34 }, (_, i) => ({ a: (i * 2.399) % (2 * Math.PI), r: 0.12 + ((i * 0.137) % 0.78), s: 0.5 + ((i * 0.31) % 1), p: i * 1.7 }));
  const BLOBS = 5;

  const mix = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

  // The one fixed outline: a dome with a very slightly settled base. Built once, never changed.
  const SHAPE = (() => {
    const N = 120, path = new Path2D();
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N;
      const down = Math.max(0, Math.sin(th));
      const r = 1 - 0.035 * down * down * down * down;
      const x = r * Math.cos(th), y = r * Math.sin(th);
      if (i) path.lineTo(x, y); else path.moveTo(x, y);
    }
    path.closePath();
    return path;
  })();

  function paint(ts, level, f, frozen) {
    if (document.body.dataset.callLayout === 'none') { lastTs = ts; return; } // not on a call: nothing to draw
    if (!fit()) return;
    const R0 = S / 2;
    const dt = frozen ? 0 : Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;
    t += dt;
    const now = performance.now();

    // mood
    const who = orb.dataset.who || 'none';
    const state = orb.dataset.state;
    if (level > 0.06 || who !== 'none' || state !== 'listening' || drag) lastActive = now;   // a touch wakes it from resting
    const mood = M.mood({ state, who, quietMs: now - lastActive });
    const tgt = M.MOODS[mood];
    const k = 1 - Math.exp(-dt / (mood === 'rest' ? 0.9 : 0.45));
    for (let i = 0; i < 3; i++) { cur.core[i] = mix(cur.core[i], tgt.core[i], k); cur.mid[i] = mix(cur.mid[i], tgt.mid[i], k); }
    cur.size = mix(cur.size, tgt.size, k); cur.alpha = mix(cur.alpha, tgt.alpha, k);

    // inner energy, eased again so the movement never snaps; flow and swirl are phases (speed changes cannot jump them)
    const wantE = mood === 'rest' ? 0 : mood === 'thinking' ? Math.max(M.energy(level), M.THINKING_ENERGY) : M.energy(level);   // thinking is never still: the lilac light visibly flows
    energy = mix(energy, wantE, 1 - Math.exp(-dt / 0.18));
    const rate = M.flowRate(energy, f ? f.rate : 0.8);
    flow += dt * rate;
    swirl += dt * rate * 0.55;
    if (mood === 'maya' && !lastSpeaking) rippleAt = t;   // a ripple as she starts to speak
    lastSpeaking = mood === 'maya';
    if (!frozen && t - rippleAt > 3.2 - 1.6 * energy && mood !== 'rest') rippleAt = t;   // louder = a quicker ripple rhythm

    // springs: only the position of the whole orb. The shape is never touched.
    if (!frozen) {
      const press = drag ? M.FOLLOW : M.SPRING;
      M.step(pull.x, drag ? drag.dx : 0, dt, press);
      M.step(pull.y, drag ? drag.dy : 0, dt, press);
      M.step(glide.x, 0, dt, M.GLIDE); M.step(glide.y, 0, dt, M.GLIDE); M.step(glide.s, 1, dt, M.GLIDE);
      const tx = pull.x.x + glide.x.x, ty = pull.y.x + glide.y.x;
      orb.style.transform = tx || ty || glide.s.x !== 1 ? `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${glide.s.x.toFixed(4)})` : '';
    }
    armed = Boolean(drag) && M.shouldMinimize(M.travel(drag.dx, drag.dy), S);

    // ---- draw (unit space: the dome has radius 1 and its centre is the origin) ----
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    g.translate(R0, R0);
    g.scale(R0 - 1, R0 - 1);            // 1 px inside the box so the rim is never cut

    g.save();
    g.clip(SHAPE);
    // dome body: milky white to a warm grey edge
    let gr = g.createRadialGradient(-0.18, -0.28, 0.05, 0, 0, 1.25);
    gr.addColorStop(0, 'rgba(252,247,241,0.97)'); gr.addColorStop(0.5, 'rgba(238,228,217,0.96)'); gr.addColorStop(0.82, 'rgba(220,207,194,0.97)'); gr.addColorStop(1, 'rgba(198,183,168,0.98)');
    g.fillStyle = gr; g.fillRect(-2, -2, 4, 4);

    // ---- the light inside the glass ----
    const lift = f ? f.raise * 0.006 : 0;
    const breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 4.4);       // slow inner breathing of the glow (never the shape)
    const gs = cur.size * (0.94 + 0.06 * breath) * (1 + 0.55 * energy) * (armed ? 1.06 : 1);
    const a = Math.min(1, cur.alpha * (0.86 + 0.14 * breath) + 0.1 * energy + (armed ? 0.05 : 0));
    const blob = (cx, cy, rs, al, sy) => {
      g.save(); g.translate(cx, cy); g.scale(1, sy);
      const b = g.createRadialGradient(0, 0, 0, 0, 0, rs);
      b.addColorStop(0, rgba(cur.core, al)); b.addColorStop(0.42, rgba(cur.mid, al * 0.78)); b.addColorStop(0.78, rgba(cur.mid, al * 0.2)); b.addColorStop(1, rgba(cur.mid, 0));
      g.fillStyle = b; g.fillRect(-rs, -rs, 2 * rs, 2 * rs); g.restore();
    };
    blob(0.04 * Math.sin(flow * 0.7), 0.12 - lift + 0.03 * Math.cos(flow * 0.6), gs, a, 1.1);     // the heart of the glow

    // currents: lobes of light circling the heart at different speeds and distances; louder = wider, brighter and quicker
    if (cur.size > 0.3) {
      for (let i = 0; i < BLOBS; i++) {
        const dir = i % 2 ? -1 : 1, sp = 0.7 + 0.28 * i;
        const ang = flow * sp * dir + i * 1.257;
        const orbitR = (0.2 + 0.12 * i / BLOBS + 0.22 * energy) * (0.9 + 0.1 * Math.sin(flow * 0.5 + i));
        blob(orbitR * Math.cos(ang), 0.05 - lift + orbitR * Math.sin(ang) * 0.9, gs * (0.34 + 0.05 * i + 0.1 * energy), a * (0.4 + 0.3 * energy), 1);
      }
    }

    // swirl: soft trails of light that turn slowly around the heart (clipped, so they never reach the outline)
    if (cur.size > 0.3 && S >= 60) {
      for (let i = 0; i < 3; i++) {
        const a0 = swirl * (i % 2 ? -1 : 1) + i * 2.094, r = (0.3 + 0.1 * i) * (0.85 + 0.35 * energy);
        for (let j = 0; j < 7; j++) {
          const aj = a0 + j * (0.26 + 0.08 * energy) * (i % 2 ? -1 : 1);
          blob(r * Math.cos(aj), 0.06 - lift + r * Math.sin(aj) * 0.92, gs * (0.2 - 0.016 * j), a * (0.34 + 0.2 * energy) * (1 - j * 0.12), 1);
        }
      }
    }

    // frosting over the glow: the edges stay milky
    gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0, 'rgba(250,244,238,0)'); gr.addColorStop(0.66, 'rgba(244,235,226,0)'); gr.addColorStop(0.9, 'rgba(228,216,204,0.4)'); gr.addColorStop(1, 'rgba(206,192,178,0.72)');
    g.fillStyle = gr; g.fillRect(-2, -2, 4, 4);

    // soft light on the glass (fixed: part of the dome, not of the movement)
    gr = g.createRadialGradient(-0.46, -0.52, 0, -0.46, -0.52, 0.62);
    gr.addColorStop(0, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-2, -2, 4, 4);
    gr = g.createRadialGradient(0.52, 0.34, 0, 0.52, 0.34, 0.4);
    gr.addColorStop(0, 'rgba(255,255,255,0.2)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-2, -2, 4, 4);
    gr = g.createRadialGradient(0, 0.78, 0, 0, 0.78, 0.55);
    gr.addColorStop(0, 'rgba(170,150,130,0.14)'); gr.addColorStop(1, 'rgba(170,150,130,0)');
    g.fillStyle = gr; g.fillRect(-2, -2, 4, 4);

    if (S >= 100) {
      // ripples inside the glass: soft rings that widen from the heart and fade before the edge (clipped to the dome)
      for (let j = 0; j < 2; j++) {
        const rp = (t - rippleAt) / 2.4 - j * 0.28;
        if (rp >= 0 && rp < 1) {
          const al = (0.07 + 0.12 * energy) * (1 - rp) * (1 - rp);
          g.strokeStyle = `rgba(255,255,255,${al.toFixed(3)})`; g.lineWidth = 0.09 + 0.05 * rp;   // a wide, faint wash, not a thin ring
          g.beginPath(); g.arc(0, 0.05, 0.3 + 0.6 * rp, 0, 2 * Math.PI); g.stroke();
        }
      }
      // speckles drifting through the light; brighter and quicker while someone speaks
      const sp = 0.55 + 0.45 * Math.min(1, energy * 1.4 + (mood === 'maya' || mood === 'senior' ? 0.35 : 0));
      for (const d of dots) {
        const ang = d.a + flow * 0.3 * d.s, rr = d.r + 0.05 * Math.sin(flow * 0.8 + d.p);
        const tw = 0.5 + 0.5 * Math.sin(t * (1.1 + 0.9 * energy) * (0.7 + 0.3 * d.s) + d.p);
        g.fillStyle = `rgba(255,248,232,${(0.55 * tw * sp * (mood === 'rest' ? 0.25 : 1)).toFixed(3)})`;
        g.beginPath(); g.arc(rr * Math.cos(ang), rr * Math.sin(ang) * 0.95, 0.008 + 0.009 * d.s, 0, 2 * Math.PI); g.fill();
      }
    }
    g.restore();

    // the rim: a thin, soft edge so the dome reads on any background (drawn on the dome's own outline, never outside it)
    g.save(); g.clip(SHAPE);
    g.strokeStyle = 'rgba(120,100,85,0.16)'; g.lineWidth = 0.025; g.stroke(SHAPE);
    g.restore();
    if (S >= 100) { // the lip where the dome meets its base
      g.save(); g.clip(SHAPE);
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.02;
      g.beginPath(); g.ellipse(0, 0.9, 0.5, 0.06, 0, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
      g.restore();
    }
    rect = orb.getBoundingClientRect();
  }

  // The loop runs in app.js (it owns the audio levels). With reduced motion it does not run: draw one still frame instead.
  function still() { if (reduceMotion) paint(performance.now(), 0, null, true); }

  // ---- gliding between big and small: the orb is placed by layout, then slides and scales from where it was ----
  window.addEventListener('maya-callstate', () => {
    placeWidget();                          // the widget has its place before the orb glides to it
    if (reduceMotion) { still(); return; }
    const old = rect;                       // includes any pull offset: the glide starts from where the orb was let go
    orb.style.transform = '';
    pull.x.x = pull.y.x = pull.x.v = pull.y.v = 0;
    glide.x.x = glide.y.x = 0; glide.s.x = 1; glide.x.v = glide.y.v = glide.s.v = 0;
    const now = orb.getBoundingClientRect();
    if (!old || !now.width || !old.width || document.body.dataset.callLayout === 'none') return;
    glide.x.x = old.left + old.width / 2 - (now.left + now.width / 2);
    glide.y.x = old.top + old.height / 2 - (now.top + now.height / 2);
    glide.s.x = old.width / now.width;
    orb.style.transform = `translate(${glide.x.x}px, ${glide.y.x}px) scale(${glide.s.x})`;
  });

  // ---- pull away ----
  const cs = () => window.mayaCallState;
  orb.addEventListener('pointerdown', (e) => {
    const c = cs();
    if (!c || !c.live || c.view !== 'full' || (e.pointerType === 'mouse' && e.button !== 0) || drag) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
    try { orb.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  });
  orb.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x0; drag.dy = e.clientY - drag.y0;
  });
  function release(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (e.type === 'pointerup' && M.shouldMinimize(M.travel(d.dx, d.dy), S)) {
      const c = cs();
      if (c && c.live && c.view === 'full') c.minimize();   // the call stays live; the orb glides to its small place
    }
  }
  orb.addEventListener('pointerup', release);
  orb.addEventListener('pointercancel', release);

  // ---- the minimized widget: a fixed floating piece, dragged by a finger, always inside the screen ----
  const stage = document.getElementById('stage');
  let wpos = null;                          // where a finger left it; null = the default place (bottom-right above the composer)
  let wdrag = null;                         // { id, x0, y0, wx, wy, moved, target }
  let suppressClickUntil = 0;
  const screenBox = () => ({ vw: document.documentElement.clientWidth, vh: Math.min(window.innerHeight, window.visualViewport ? window.visualViewport.height : Infinity) });
  function placeWidget() {
    if (!stage) return;
    const layout = document.body.dataset.callLayout;
    if (layout === 'none') { wpos = null; stage.style.removeProperty('--wx'); stage.style.removeProperty('--wy'); return; }
    if (layout !== 'small') return;
    const { vw, vh } = screenBox(), w = stage.offsetWidth, h = stage.offsetHeight;
    const c = document.getElementById('composer');
    const p = wpos ? M.clampWidget(wpos.x, wpos.y, w, h, vw, vh) : M.defaultWidget(w, h, vw, vh, c ? c.getBoundingClientRect().top : 0);
    if (wpos) wpos = p;
    stage.style.setProperty('--wx', `${p.x}px`); stage.style.setProperty('--wy', `${p.y}px`);
  }
  if (stage) {
    window.addEventListener('resize', placeWidget);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', placeWidget);
    if (window.ResizeObserver) new ResizeObserver(placeWidget).observe(stage);   // words switched on/off change its size
    stage.addEventListener('pointerdown', (e) => {
      const c = cs();
      if (!c || !c.live || c.view !== 'minimized' || (e.pointerType === 'mouse' && e.button !== 0) || wdrag) return;
      const cur = stage.getBoundingClientRect();
      wdrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, wx: cur.left, wy: cur.top, moved: false, target: e.target };
    });
    // move / up are heard on the window, so a quick flick that leaves the widget before its first move is still a drag (a mouse is
    // not captured like a finger is, and capturing on press would send a button's click to the wrong place)
    window.addEventListener('pointermove', (e) => {
      if (!wdrag || e.pointerId !== wdrag.id) return;
      const dx = e.clientX - wdrag.x0, dy = e.clientY - wdrag.y0;
      if (!wdrag.moved) {
        if (M.isTap(M.travel(dx, dy))) return;
        wdrag.moved = true; stage.classList.add('dragging');
      }
      const { vw, vh } = screenBox();
      wpos = M.clampWidget(wdrag.wx + dx, wdrag.wy + dy, stage.offsetWidth, stage.offsetHeight, vw, vh);
      stage.style.setProperty('--wx', `${wpos.x}px`); stage.style.setProperty('--wy', `${wpos.y}px`);
    });
    const wend = (e) => {
      if (!wdrag || e.pointerId !== wdrag.id) return;
      const d = wdrag; wdrag = null; stage.classList.remove('dragging');
      if (d.moved) { suppressClickUntil = performance.now() + 400; return; }      // a drag never expands, mutes or cuts
      const c = cs();
      if (e.type === 'pointerup' && c && c.live && c.view === 'minimized' && !(d.target.closest && d.target.closest('button'))) c.expand();   // a tap on the widget itself
    };
    window.addEventListener('pointerup', wend);
    window.addEventListener('pointercancel', wend);
    // the click that follows the end of a drag is swallowed before any button (or the orb) can see it
    window.addEventListener('click', (e) => { if (performance.now() < suppressClickUntil) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }

  window.mayaOrb = {
    draw: (ts, level, f) => paint(ts, level, f, false),
    // for tests and screenshots
    debug: () => ({ widget: wpos, pull: { x: pull.x.x, y: pull.y.x }, armed, dragging: Boolean(drag), glide: { x: glide.x.x, y: glide.y.x, s: glide.s.x }, energy, flow, mood: M.mood({ state: orb.dataset.state, who: orb.dataset.who || 'none', quietMs: performance.now() - lastActive }), size: S }),
  };
  updateWho();
})();
