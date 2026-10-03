// Procedural-head dev page: the relief and procedural heads side by side with shared controls,
// plus a turntable sweep (yaw +-0.6 rad) that only a real 3D head can do.
// Exposes window.__heads = { relief, procedural } and sets window.__ready after the first frame.
/* global URLSearchParams, location */

import { createAvatar } from '../avatar/index.js';
import { STATES } from '../avatar/director.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
document.documentElement.style.setProperty('--w', `${num('w', 392)}px`);
document.documentElement.style.setProperty('--h', `${num('h', 584)}px`);

const only = q.get('only');
const names = only ? [only] : ['relief', 'procedural'];
for (const n of ['relief', 'procedural']) if (!names.includes(n)) document.getElementById(`v-${n}`).hidden = true;

const heads = {};
for (const n of names) {
  const view = document.getElementById(`v-${n}`);
  try {
    heads[n] = await createAvatar(view.querySelector('canvas'), {
      renderer: n, packUrl: '../assets/avatars/reference/', assetsBase: '../assets/',
      quality: q.get('quality') || 'high', seed: num('seed', 1),
    });
    view.querySelector('.label').textContent = heads[n].renderer;
  } catch (e) {
    view.querySelector('.label').textContent = `${n}: ${e.message}`;
    window.__error = String(e?.stack || e);
  }
}
window.__heads = heads;
const all = () => Object.values(heads);

// states
const states = document.getElementById('states');
for (const s of STATES) {
  const b = document.createElement('button');
  b.textContent = s;
  b.addEventListener('click', () => {
    all().forEach((h) => h.setState(s));
    states.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
  states.append(b);
}

// cursor follow
for (const n of Object.keys(heads)) {
  const c = document.getElementById(`v-${n}`).querySelector('canvas');
  c.addEventListener('mousemove', (e) => {
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = 1 - ((e.clientY - r.top) / r.height) * 2;
    all().forEach((a) => a.lookAt(x, y));
  });
  c.addEventListener('mouseleave', () => all().forEach((a) => a.lookAt(null)));
}

document.getElementById('blink').addEventListener('click', () => all().forEach((h) => h.blink()));

// turntable: override the head yaw on the procedural head only (relief is 2.5D)
let spin = 0;
const turntable = document.getElementById('turntable');
function setSpin(on) {
  cancelAnimationFrame(spin);
  spin = 0;
  turntable.classList.toggle('active', on);
  if (!heads.procedural) return;
  if (!on) { heads.procedural.setOverrides(null); return; }
  const t0 = performance.now();
  const step = (now) => {
    heads.procedural.setOverrides({ headYaw: 0.6 * Math.sin((now - t0) / 1600), headPitch: 0.08 * Math.sin((now - t0) / 2300) });
    spin = requestAnimationFrame(step);
  };
  spin = requestAnimationFrame(step);
}
turntable.addEventListener('click', () => setSpin(!spin));
if (q.get('turntable') === '1') setSpin(true);

// crude lip-sync demo
let talk = 0;
document.getElementById('talk').addEventListener('click', (ev) => {
  const b = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  if (talk) {
    clearInterval(talk); talk = 0; b.classList.remove('active');
    all().forEach((h) => { h.setSpeechLevel(0); h.setMouth({ jaw: 0 }); h.setState('idle'); });
    return;
  }
  b.classList.add('active');
  all().forEach((h) => h.setState('speaking'));
  const visemes = [{ jaw: 0.55 }, { jaw: 0.2, wide: 0.7 }, { jaw: 0.35, round: 0.8 }, { jaw: 0.05 }, { jaw: 0.4, wide: 0.3 }, { jaw: 0 }];
  let i = 0;
  talk = setInterval(() => {
    const v = visemes[(i++ * 7 + (i % 3)) % visemes.length];
    all().forEach((h) => { h.setMouth(v); h.setSpeechLevel(v.jaw > 0.02 ? 0.4 + v.jaw : 0.05); });
  }, 110);
});

// fps / draw calls
setInterval(() => {
  for (const [n, h] of Object.entries(heads)) {
    const s = h.stats();
    document.getElementById(`v-${n}`).querySelector('.stats').textContent =
      `${s.fps} fps  ${s.drawCalls} calls\n${s.triangles} tris  ${s.width}x${s.height}`;
  }
}, 500);

await Promise.all(all().map((h) => h.nextFrame()));
window.__ready = true;
