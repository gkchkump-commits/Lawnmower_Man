// Avatar dev/visual harness. Every control is scriptable through URL parameters so screenshots
// are reproducible, e.g.
//   /dev/avatar.html?fixedTime=1&compare=1
//   /dev/avatar.html?fixedTime=1&jaw=0.6&yaw=0.2&ui=0
//   /dev/avatar.html?renderer=placeholder&state=thinking
// Exposes window.__avatar and sets window.__ready = true after the first frame.
/* global URLSearchParams, location, history */

import { createAvatar } from '../avatar/index.js';
import { STATES } from '../avatar/director.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const flag = (k, d) => (q.has(k) ? !['0', 'false', 'no', ''].includes(q.get(k)) : d);

const W = num('w', 392);
const H = num('h', 584);
document.documentElement.style.setProperty('--w', `${W}px`);
document.documentElement.style.setProperty('--h', `${H}px`);
const ui = flag('ui', true);
const compare = flag('compare', false);
if (!ui) {
  document.getElementById('panel').hidden = true;
  document.body.classList.add('bare');
}
const transparent = flag('transparent', true);
const bg = q.get('bg') || (transparent ? 'black' : 'black');
const view = document.getElementById('avatarView');
if (bg !== 'black') view.classList.add(bg);

const packUrl = q.get('pack') ? `../assets/avatars/${q.get('pack')}/` : '../assets/avatars/reference/';
if (compare) {
  const refView = document.getElementById('refView');
  refView.hidden = false;
  const which = q.get('ref') || 'neutral';
  /** @type {HTMLImageElement} */ (document.getElementById('ref')).src = `${packUrl}preview/${which}.jpg`;
}

// slider definitions: [param, AnimState key(s), min, max, step]
const SLIDERS = [
  ['jaw', ['jawOpen'], 0, 1, 0.01],
  ['wide', ['mouthWide'], 0, 1, 0.01],
  ['round', ['mouthRound'], 0, 1, 0.01],
  ['smile', ['smile'], 0, 1, 0.01],
  ['browUp', ['browUp'], 0, 1, 0.01],
  ['blink', ['blinkL', 'blinkR'], 0, 1, 0.01],
  ['blinkL', ['blinkL'], 0, 1, 0.01],
  ['blinkR', ['blinkR'], 0, 1, 0.01],
  ['gazeX', ['gazeX'], -1, 1, 0.01],
  ['gazeY', ['gazeY'], -1, 1, 0.01],
  ['yaw', ['headYaw'], -0.35, 0.35, 0.005],
  ['pitch', ['headPitch'], -0.25, 0.25, 0.005],
  ['roll', ['headRoll'], -0.2, 0.2, 0.005],
  ['energy', ['energy'], 0, 1, 0.01],
];

const active = new Map(); // param -> value
for (const [p] of SLIDERS) if (q.has(p)) active.set(p, num(p, 0));

const options = {
  renderer: q.get('renderer') || 'relief',
  packUrl,
  assetsBase: '../assets/',
  quality: q.get('quality') || 'high',
  particles: num('particles', 1),
  bloom: num('bloom', 1),
  seed: num('seed', 1),
  fixedTime: q.has('fixedTime') ? num('fixedTime', 0) : undefined,
  transparent,
  idleMotion: num('idle', 1),
  zoom: num('zoom', 1),
};

function overridesFromActive() {
  const o = {};
  for (const [p, keys] of SLIDERS) if (active.has(p)) for (const k of keys) o[k] = active.get(p);
  return o;
}

let avatar;
try {
  avatar = await createAvatar(document.getElementById('avatar'), options);
} catch (e) {
  console.error('[harness] createAvatar failed', e);
  document.getElementById('avatarLabel').textContent = `error: ${e.message}`;
  window.__error = String(e?.stack || e);
  throw e;
}
window.__avatar = avatar;
document.getElementById('avatarLabel').textContent = ui ? avatar.renderer : '';

if (q.has('fx')) avatar.setEffects(num('fx', 1));
if (q.has('state')) avatar.setState(q.get('state'));
if (q.has('speech')) avatar.setSpeechLevel(num('speech', 0));
if (q.has('mouthJaw') || q.has('mouthWide') || q.has('mouthRound')) {
  avatar.setMouth({ jaw: num('mouthJaw', 0), wide: num('mouthWide', 0), round: num('mouthRound', 0) });
}
if (q.has('lookX') || q.has('lookY')) avatar.lookAt(num('lookX', 0), num('lookY', 0));
avatar.setOverrides(overridesFromActive());

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function updateUrl() {
  const u = new URL(location.href);
  for (const [p] of SLIDERS) {
    if (active.has(p)) u.searchParams.set(p, String(active.get(p)));
    else u.searchParams.delete(p);
  }
  history.replaceState(null, '', u);
}

if (ui) {
  const states = document.getElementById('states');
  const stateButtons = [];
  for (const s of STATES) {
    const b = el('button', { onclick: () => {
      avatar.setState(s);
      stateButtons.forEach((x) => x.classList.toggle('active', x === b));
      const u = new URL(location.href); u.searchParams.set('state', s); history.replaceState(null, '', u);
    } }, s);
    if ((q.get('state') || 'idle') === s) b.classList.add('active');
    stateButtons.push(b);
    states.append(b);
  }

  const sliders = document.getElementById('sliders');
  for (const [p, , min, max, step] of SLIDERS) {
    const out = el('output', {}, active.has(p) ? String(active.get(p)) : '–');
    const input = el('input', { type: 'range', min, max, step, value: String(active.get(p) ?? 0) });
    const row = el('div', { class: `row${active.has(p) ? ' on' : ''}` }, el('label', {}, p), input, out);
    input.addEventListener('input', () => {
      active.set(p, Number(input.value));
      out.textContent = input.value;
      row.classList.add('on');
      avatar.setOverrides(overridesFromActive());
      updateUrl();
    });
    row.addEventListener('dblclick', () => {
      active.delete(p);
      out.textContent = '–';
      row.classList.remove('on');
      avatar.setOverrides(overridesFromActive());
      updateUrl();
    });
    sliders.append(row);
  }

  const speech = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: String(num('speech', 0)) });
  const speechOut = el('output', {}, String(num('speech', 0)));
  speech.addEventListener('input', () => { avatar.setSpeechLevel(Number(speech.value)); speechOut.textContent = speech.value; });
  sliders.append(el('div', { class: 'row' }, el('label', {}, 'speech'), speech, speechOut));

  document.getElementById('blinkBtn').addEventListener('click', () => avatar.blink());
  document.getElementById('resetBtn').addEventListener('click', () => {
    active.clear();
    avatar.setOverrides(null);
    sliders.querySelectorAll('.row').forEach((r) => r.classList.remove('on'));
    sliders.querySelectorAll('output').forEach((o) => { o.textContent = '–'; });
    updateUrl();
  });

  // crude lip-sync demo: random visemes + loudness envelope while "speaking"
  let talkTimer = 0;
  document.getElementById('talkBtn').addEventListener('click', (ev) => {
    const b = /** @type {HTMLButtonElement} */ (ev.currentTarget);
    if (talkTimer) {
      clearInterval(talkTimer); talkTimer = 0; b.classList.remove('active');
      avatar.setSpeechLevel(0); avatar.setMouth({ jaw: 0 }); avatar.setState('idle');
      return;
    }
    b.classList.add('active');
    avatar.setState('speaking');
    const visemes = [{ jaw: 0.55 }, { jaw: 0.2, wide: 0.7 }, { jaw: 0.35, round: 0.8 }, { jaw: 0.05 }, { jaw: 0.4, wide: 0.3 }, { jaw: 0 }];
    let i = 0;
    talkTimer = setInterval(() => {
      const v = visemes[(i++ * 7 + (i % 3)) % visemes.length];
      avatar.setMouth(v);
      avatar.setSpeechLevel(v.jaw > 0.02 ? 0.4 + v.jaw : 0.05);
    }, 110);
  });

  const render = document.getElementById('render');
  const sel = (label, values, current, onchange) => {
    const s = el('select', { onchange: (e) => onchange(e.target.value) });
    for (const v of values) { const o = el('option', { value: v }, v); if (v === current) o.selected = true; s.append(o); }
    return el('div', { class: 'row' }, el('label', {}, label), s, el('span'));
  };
  render.append(sel('quality', ['low', 'medium', 'high'], options.quality, (v) => avatar.setOptions({ quality: v })));
  const rangeOpt = (label, key, min, max, val) => {
    const input = el('input', { type: 'range', min, max, step: 0.01, value: String(val) });
    const out = el('output', {}, String(val));
    input.addEventListener('input', () => { out.textContent = input.value; avatar.setOptions({ [key]: Number(input.value) }); });
    return el('div', { class: 'row' }, el('label', {}, label), input, out);
  };
  render.append(rangeOpt('particles', 'particles', 0, 2, options.particles));
  render.append(rangeOpt('bloom', 'bloom', 0, 2, options.bloom));
  const fx = el('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: String(num('fx', 1)) });
  fx.addEventListener('input', () => avatar.setEffects(Number(fx.value)));
  render.append(el('div', { class: 'row' }, el('label', {}, 'effects'), fx, el('span')));

  const hit = document.getElementById('hit');
  const canvas = document.getElementById('avatar');
  canvas.addEventListener('mousemove', (e) => {
    hit.textContent = `hitTest: ${avatar.hitTest(e.clientX, e.clientY)}`;
    if (flag('follow', false)) {
      const r = canvas.getBoundingClientRect();
      avatar.lookAt(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    }
  });
  canvas.addEventListener('mouseleave', () => { if (flag('follow', false)) avatar.lookAt(null); });
}

if (flag('stats', false)) {
  const st = document.getElementById('stats');
  setInterval(() => {
    const s = avatar.stats();
    st.textContent = `${s.fps} fps  ${s.cpuFrameMs} ms cpu\n${s.drawCalls} calls  ${s.triangles} tris  ${s.points} pts\n${s.width}x${s.height} ${s.quality}`;
  }, 500);
}

await avatar.nextFrame();
// one more frame so late-arriving textures are definitely on screen
await avatar.nextFrame();
window.__ready = true;
