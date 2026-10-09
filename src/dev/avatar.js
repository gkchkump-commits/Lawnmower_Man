// Avatar dev/visual harness. Every control is scriptable through URL parameters so screenshots
// are reproducible, e.g.
//   /dev/avatar.html?fixedTime=1&compare=1
//   /dev/avatar.html?fixedTime=1&jaw=0.6&yaw=0.2&ui=0
//   /dev/avatar.html?renderer=placeholder&state=thinking
//   /dev/avatar.html?fixedTime=1&vis=PP                       one viseme's mouth shape
//   /dev/avatar.html?say=Hello!%20I'm%20Claude.&t=0.8         the system-voice lip-sync at 0.8 s
//   /dev/avatar.html?clip=a.json,b.json&t=1.2                 real voice-server clips (local voice)
// Exposes window.__avatar and sets window.__ready = true after the first frame. In say / clip
// mode window.__seek(t) advances the simulation to t seconds and renders (film strips, videos).
/* global URLSearchParams, location, history */

import { createAvatar } from '../avatar/index.js';
import { STATES } from '../avatar/director.js';
import { Emitter } from '../app/emitter.js';
import { LipSync, VISEME_SHAPES, normalizeVisemes, planSpeech } from '../audio/lipsync.js';
import { LEAD_IN } from '../audio/articulation.js';
import { base64ToBytes, decodeWav } from '../audio/wav.js';

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
  ['press', ['mouthPress'], 0, 1, 0.01],
  ['tuck', ['mouthTuck'], 0, 1, 0.01],
  ['teeth', ['mouthTeeth'], 0, 1, 0.01],
  ['tongue', ['mouthTongue'], 0, 1, 0.01],
  ['asym', ['mouthAsym'], -1, 1, 0.01],
  ['cheek', ['cheekRaise'], 0, 1, 0.01],
  ['chin', ['chinRaise'], 0, 1, 0.01],
  ['nostril', ['nostrilFlare'], 0, 1, 0.01],
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
// vis=<viseme id>: that viseme's mouth shape as overrides (explicit sliders still win)
const VIS_KEYS = { jaw: 'jaw', wide: 'wide', round: 'round', press: 'press', tuck: 'tuck', teeth: 'teeth', tongue: 'tongue' };
if (q.has('vis') && VISEME_SHAPES[q.get('vis')]) {
  for (const [ch, p] of Object.entries(VIS_KEYS)) active.set(p, VISEME_SHAPES[q.get('vis')][ch]);
}
for (const [p] of SLIDERS) if (q.has(p)) active.set(p, num(p, 0));
const sayText = q.get('say');
// clip=<url>[,<url>...]: real voice-server clips (/tts JSON: text, visemes, audioB64 or wav=<url>)
const clipUrls = (q.get('clip') || '').split(',').map((s) => s.trim()).filter(Boolean);
const scripted = !!sayText || clipUrls.length > 0;

const options = {
  renderer: q.get('renderer') || 'relief',
  packUrl,
  assetsBase: '../assets/',
  quality: q.get('quality') || 'high',
  particles: num('particles', 1),
  bloom: num('bloom', 1),
  seed: num('seed', 1),
  fixedTime: q.has('fixedTime') && !scripted ? num('fixedTime', 0) : undefined,
  transparent,
  idleMotion: num('idle', 1),
  expressiveness: num('expr', 1),
  zoom: num('zoom', 1),
  // say / clip modes drive a scripted clock through avatar.advance(): no render loop of their own
  autoStart: !scripted,
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

if (sayText || clipUrls.length) {
  const sim = sayText ? speechSimulation(sayText) : await clipSimulation(clipUrls);
  window.__seek = (t) => sim.seek(Number(t) || 0);
  window.__plan = sim.plan;
  window.__schedule = sim.schedule;
  sim.seek(num('t', 0));
  // textures decode asynchronously: render the same instant again once they are surely there
  await new Promise((r) => setTimeout(r, 300));
  sim.seek(num('t', 0));
} else {
  await avatar.nextFrame();
  // one more frame so late-arriving textures are definitely on screen
  await avatar.nextFrame();
}
window.__ready = true;

/**
 * The system-voice lip-sync path, deterministic: a scripted "voice" speaks `text` (word boundary
 * events at its own, slightly different tempo with per-word jitter — like a real SAPI voice), a
 * fake player forwards them to the real LipSync, whose output drives the avatar through the same
 * calls the app makes (setMouth, setSpeechLevel, setProsody), on a fixed 60 Hz clock.
 * URL: say=<text>&t=<s>, rate (utterance rate, 1), bounds=0 (a voice without boundary events),
 * voiceTempo (voice duration / plan duration, 1.1), jitter (per-word, 0.15), latency (s, 0.06),
 * caption=1 (show the word being spoken).
 * @param {string} text
 */
function speechSimulation(text) {
  const rate = num('rate', 1);
  const plan = planSpeech(text);
  const tempo = num('voiceTempo', 1.1) / rate;
  const jitter = num('jitter', 0.15);
  const latency = num('latency', 0.06);
  const bounds = flag('bounds', true);
  // the voice's own word onsets (s after it starts speaking)
  const words = plan.words;
  const onsets = [];
  let tv = 0;
  for (let k = 0; k < words.length; k++) {
    onsets.push(tv);
    const span = (k + 1 < words.length ? words[k + 1].t0 : words[k].t1) - words[k].t0;
    const h = Math.sin((k + 1) * 12.9898 + text.length * 78.233) * 43758.5453;
    tv += span * tempo * (1 + jitter * (2 * (h - Math.floor(h)) - 1));
  }
  const speechEnd = latency + tv + 0.05;
  /** @type {Array<{ t: number, fn: () => void }>} */
  const events = [];
  const player = Object.assign(new Emitter(), {
    current: null, sampleRate: 48000, level: () => 0, spectrum: () => false,
  });
  const clip = { kind: 'speech', text, rate };
  events.push({ t: 0, fn: () => { player.current = { clip, kind: 'speech', time: 0 }; player.emit('start', clip); } });
  events.push({ t: latency, fn: () => player.emit('speechstart', clip) });
  if (bounds) {
    onsets.forEach((o, k) => events.push({ t: latency + o, fn: () => player.emit('boundary', { word: words[k].text, charIndex: words[k].start, charLength: words[k].end - words[k].start, clip }) }));
  }
  events.push({ t: speechEnd, fn: () => { player.current = null; player.emit('end', clip, { stopped: false }); } });
  events.push({ t: speechEnd + 0.4, fn: () => avatar.setState('idle') });
  events.sort((a, b) => a.t - b.t);
  let now = -0.6; // pre-roll: the avatar is already in its speaking state when the voice starts
  let ev = 0;
  const lipsync = new LipSync({ player, now: () => now });
  avatar.setState('speaking');
  const caption = flag('caption', false) ? document.getElementById('caption') : null;
  if (caption) caption.hidden = false;
  const dt = 1 / 60;
  const step = () => {
    now += dt;
    while (ev < events.length && events[ev].t <= now) events[ev++].fn();
    if (player.current) player.current.time = now;
    const m = lipsync.update(dt, now);
    avatar.setMouth(m);
    avatar.setSpeechLevel(m.level);
    if (m.cues) avatar.setProsody(m.cues);
    avatar.advance(dt, { render: false });
  };
  return {
    plan,
    /** @param {number} t seconds after the request to speak */
    seek(t) {
      while (now + dt <= t + 1e-9) step();
      avatar.advance(0);
      let k = -1;
      for (let i = 0; i < onsets.length; i++) if (now >= latency + onsets[i]) k = i;
      const said = k >= 0 && now < speechEnd ? words[k].text : '';
      if (caption) caption.textContent = `${now.toFixed(2)} s  ${said}`;
      return { t: now, word: said, p: lipsync.track?.p ?? null, leadIn: LEAD_IN };
    },
  };
}

/**
 * The local-voice lip-sync path on REAL voice-server clips, deterministic: the clips (the /tts
 * response JSON — text, visemes and audioB64, or `wav` = a URL of the WAV file) play back to back
 * through a fake AudioPlayer (the playback clock, the decoded buffer, an analyser level over the
 * real samples) into the real LipSync, whose output drives the avatar through the app's calls on
 * a 60 Hz clock. The avatar thinks until the first clip starts and speaks until the last one has
 * ended (as the controller does). URL: clip=<url>[,<url>...]&t=<s>, gap (s between clips, 0.06),
 * latency (analyser lead, s, 0.02), pre (s of thinking before the first clip, 0.8), caption=1.
 * @param {string[]} urls
 */
async function clipSimulation(urls) {
  const gap = num('gap', 0.06);
  const latency = num('latency', 0.02);
  const pre = num('pre', 0.8);
  /** @type {Array<{ clip: any, buffer: any, samples: Float32Array, sampleRate: number, start: number, end: number }>} */
  const items = [];
  let t0 = 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`clip ${url}: HTTP ${res.status}`);
    const j = await res.json();
    let bytes;
    if (j.audioB64) bytes = base64ToBytes(j.audioB64);
    else if (j.wav) bytes = new Uint8Array(await (await fetch(new URL(j.wav, new URL(url, location.href)))).arrayBuffer());
    else throw new Error(`clip ${url} has no audio`);
    const wav = decodeWav(bytes);
    const clip = { kind: 'audio', audioB64: j.audioB64 || '', visemes: normalizeVisemes(j.visemes), text: j.text || '' };
    // what the app's AudioPlayer hands the lip-sync: the decoded (dry) buffer of the clip
    const buffer = { sampleRate: wav.sampleRate, length: wav.samples.length, duration: wav.durationSec, getChannelData: () => wav.samples };
    items.push({ clip, buffer, samples: wav.samples, sampleRate: wav.sampleRate, start: t0, end: t0 + wav.durationSec });
    t0 += wav.durationSec + gap;
  }
  const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, analyser: null, spectrum: () => false });
  let cur = -1;
  player.level = () => {
    const it = items[cur];
    if (!player.current || !it) return 0;
    // an AnalyserNode (2048 samples at 48 kHz) holds the newest audio, `latency` ahead of the ear
    const win = Math.round(0.0427 * it.sampleRate);
    const end = Math.round((player.current.time + latency) * it.sampleRate);
    let acc = 0;
    for (let i = end - win; i < end; i++) if (i >= 0 && i < it.samples.length) acc += it.samples[i] * it.samples[i];
    return Math.sqrt(acc / win);
  };
  let now = -pre;
  const lipsync = new LipSync({ player, now: () => now });
  avatar.setState('thinking');
  const caption = flag('caption', false) ? document.getElementById('caption') : null;
  if (caption) caption.hidden = false;
  const last = items[items.length - 1];
  const dt = 1 / 60;
  const step = () => {
    now += dt;
    const k = items.findIndex((it) => now >= it.start && now < it.end);
    if (k !== cur) {
      if (cur >= 0) {
        const c = items[cur].clip;
        player.current = null;
        player.emit('end', c, { stopped: false });
      }
      cur = k;
      if (k >= 0) {
        if (k === 0) avatar.setState('speaking');
        player.current = { clip: items[k].clip, kind: 'audio', time: 0, buffer: items[k].buffer };
        player.emit('start', items[k].clip);
      }
    }
    if (player.current) player.current.time = now - items[cur].start;
    if (last && cur < 0 && now >= last.end + 0.3 && avatar.state === 'speaking') avatar.setState('idle');
    const m = lipsync.update(dt, now);
    avatar.setMouth(m);
    avatar.setSpeechLevel(m.level);
    if (m.cues) avatar.setProsody(m.cues);
    avatar.setIntonation(m.intonation);
    avatar.advance(dt, { render: false });
  };
  return {
    plan: null,
    schedule: items.map((it) => ({ start: it.start, end: it.end, text: it.clip.text })),
    /** @param {number} tt seconds after the first clip's start */
    seek(tt) {
      while (now + dt <= tt + 1e-9) step();
      avatar.advance(0);
      const it = items.find((x) => now >= x.start && now < x.end);
      if (caption) caption.textContent = `${now.toFixed(2)} s  ${it ? it.clip.text : ''}`;
      return { t: now, clip: it ? items.indexOf(it) : -1 };
    },
  };
}
