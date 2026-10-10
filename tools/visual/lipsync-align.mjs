#!/usr/bin/env node
// Lip-sync timing on REAL voice-server clips, end to end and without a browser: each clip (a WAV
// plus its /tts JSON with `visemes`, e.g. from the Kokoro voice) is played through the real
// LipSync and Director at 60 Hz on a simulated playback clock, and the mouth they produce is
// compared with the audio:
//   closures  time of the fullest lip closure (m b p between vowels) vs the energy dip in the audio
//   seal      the relief head's lips sealed (rendered aperture < 1 px, the pack's real rig) vs the
//             acoustic closure (the dip below half its depth): when the seal starts and ends, and
//             how many closures seal at all
//   onsets    the jaw opening (> 0.08) after a pause vs the acoustic onset (-30 dB re peak)
//   xcorr     lag of the best correlation between jawOpen and the audio level (dB)
// Negative numbers: the mouth is EARLY (leads the sound), as it should be by a few tens of ms.
//
//   node tools/visual/lipsync-align.mjs <dir with name.wav + name.json> [--latency 0.02]
//        [--offset ms] [--json out.json]
//
// --latency: the player's output latency (s): the analyser sees the audio that long before it is
// heard; the playback clock (player.current.time) is compensated for it, as in AudioPlayer.
// --offset: Settings > Voice > Lip-sync timing (voice.lipSyncOffsetMs; + = mouth later).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Emitter } from '../../src/app/emitter.js';
import { LipSync } from '../../src/audio/lipsync.js';
import { decodeWav } from '../../src/audio/wav.js';
import { Director } from '../../src/avatar/director.js';
import { buildRig, rigUniforms } from '../../src/avatar/heads/relief/rig.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
if (!dir) {
  console.error('usage: node tools/visual/lipsync-align.mjs <clips dir> [--latency s] [--json out.json]');
  process.exit(1);
}
const LATENCY = Number(opt('latency', 0.02));
const OFFSET = Number(opt('offset', 0)) / 1000;
const SEAL_PX = 1;
const packDir = new URL('../../public/assets/avatars/reference/', import.meta.url);
const pack = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8'));
const rig = buildRig(pack, JSON.parse(readFileSync(new URL(pack.files.mesh, packDir), 'utf8')));
const FPS = 60;
const HOP = 0.005;
const VOWELS = new Set(['aa', 'E', 'I', 'O', 'U', 'RR']);

/** dB envelope (20 ms RMS windows every 5 ms), 0 dB = the clip's peak. */
function envelope(x, sr) {
  const h = Math.round(sr * HOP), n = Math.round(sr * 0.02);
  const frames = Math.floor(x.length / h);
  const db = new Float64Array(frames);
  let peak = -Infinity;
  for (let i = 0; i < frames; i++) {
    let acc = 0, c = 0;
    for (let j = i * h - (n >> 1); j < i * h + (n >> 1); j++) if (j >= 0 && j < x.length) { acc += x[j] * x[j]; c++; }
    db[i] = 20 * Math.log10(Math.sqrt(acc / Math.max(1, c)) + 1e-9);
    peak = Math.max(peak, db[i]);
  }
  for (let i = 0; i < frames; i++) db[i] -= peak;
  return db;
}

function simulate(clip, samples, sr) {
  const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, analyser: null, spectrum: () => false });
  // AnalyserNode (fftSize 2048 at 48 kHz = 42.7 ms): the newest samples rendered, LATENCY ahead of the ear
  const win = Math.round(0.0427 * sr);
  player.level = () => {
    if (!player.current) return 0;
    const end = Math.round((player.current.time + LATENCY) * sr);
    let acc = 0;
    for (let i = end - win; i < end; i++) if (i >= 0 && i < samples.length) acc += samples[i] * samples[i];
    return Math.sqrt(acc / win);
  };
  let now = 0;
  const ls = new LipSync({ player, now: () => now });
  ls.setOffset?.(OFFSET);
  const dr = new Director({ seed: 1, idleMotion: 0 });
  dr.setState('speaking');
  const dt = 1 / FPS;
  const dur = samples.length / sr;
  const rec = [];
  const pre = 0.4;
  const u = {};
  for (let f = 0; f * dt < dur + pre + 0.5; f++) {
    now = f * dt;
    const t = now - pre;
    if (t >= 0 && t < dur) {
      if (!player.current) { player.current = { clip, kind: 'audio', time: 0 }; player.emit('start', clip); }
      player.current.time = t;
    } else if (player.current) {
      player.current = null;
      player.emit('end', clip, { stopped: false });
    }
    const m = ls.update(dt, now);
    dr.setMouth(m);
    dr.setSpeechLevel(m.level);
    if (m.cues) dr.setProsody(m.cues);
    const a = dr.update(dt, now);
    rigUniforms(rig, a, u);
    // the relief head's lip aperture at the mouth's centre (rigUniforms gives it in plate px)
    rec.push({ t, jaw: a.jawOpen, press: a.mouthPress, tuck: a.mouthTuck, ap: u.open[0] + u.open[1] });
  }
  return rec;
}

function stats(v) {
  if (!v.length) return 'n=0';
  const s = [...v].sort((a, b) => a - b).map((x) => x * 1000);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `n=${String(s.length).padStart(3)} median ${q(0.5).toFixed(1).padStart(6)} ms  mean ${mean.toFixed(1).padStart(6)}  IQR [${q(0.25).toFixed(0)}, ${q(0.75).toFixed(0)}]`;
}

const pooled = { closure: [], sealOn: [], sealEnd: [], onset: [], xcorr: [] };
let nSealed = 0, nClosures = 0;
const perClip = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const wav = decodeWav(readFileSync(join(dir, f.replace(/\.json$/, '.wav'))));
  const clip = { kind: 'audio', visemes: meta.visemes, text: meta.text, samples: wav.samples, sampleRate: wav.sampleRate };
  const db = envelope(wav.samples, wav.sampleRate);
  const rec = simulate(clip, wav.samples, wav.sampleRate);
  const atDb = (t) => db[Math.min(db.length - 1, Math.max(0, Math.round(t / HOP)))];
  // acoustic dips: local minima at least 8 dB below the highest level on both sides within 120 ms
  const dips = [];
  for (let i = 1; i + 1 < db.length; i++) {
    if (!(db[i] <= db[i - 1] && db[i] < db[i + 1])) continue;
    let l = -Infinity, rr = -Infinity;
    for (let j = Math.max(0, i - 24); j < i; j++) l = Math.max(l, db[j]);
    for (let j = i + 1; j < Math.min(db.length, i + 25); j++) rr = Math.max(rr, db[j]);
    if (Math.min(l, rr) - db[i] >= 8 && db[i] > -45) dips.push(i * HOP);
  }
  const r = { closure: [], sealOn: [], sealEnd: [], onset: [], xcorr: 0 };
  const tl = meta.visemes;
  for (let i = 1; i + 1 < tl.length; i++) {
    const s = tl[i];
    if (s.viseme === 'PP' && VOWELS.has(tl[i - 1].viseme) && VOWELS.has(tl[i + 1].viseme)) {
      // the acoustic dip of this closure: the nearest one to the segment (the timeline may be off)
      const c = 0.5 * (s.start + s.end);
      let ta = NaN;
      for (const d of dips) if (Math.abs(d - c) < 0.1 && !(Math.abs(ta - c) <= Math.abs(d - c))) ta = d;
      if (!Number.isFinite(ta)) continue;
      // the mouth's fullest closure near it: max press, ties broken by the smallest jaw
      let tm = NaN, best = -Infinity;
      for (const q of rec) {
        if (q.t < ta - 0.12 || q.t > ta + 0.12) continue;
        const score = q.press - q.jaw;
        if (score > best) { best = score; tm = q.t; }
      }
      if (Number.isFinite(tm)) r.closure.push(tm - ta);
      // the acoustic closure: the deepest level within 50 ms of the segment, flanked within 150 ms
      // by sound at least 6 dB louder; it lasts while the level is below half the dip's depth (an
      // m whose murmur keeps the level up has none, and is skipped: not a dip of a neighbour)
      const i0 = Math.max(0, Math.round((s.start - 0.05) / HOP)), i1 = Math.min(db.length - 1, Math.round((s.end + 0.05) / HOP));
      let k = i0;
      for (let j = i0; j <= i1; j++) if (db[j] < db[k]) k = j;
      let fl = -Infinity, fr = -Infinity;
      for (let j = Math.max(0, k - 30); j <= k; j++) fl = Math.max(fl, db[j]);
      for (let j = k; j <= Math.min(db.length - 1, k + 30); j++) fr = Math.max(fr, db[j]);
      const flank = Math.min(fl, fr);
      if (flank - db[k] >= 6 && flank >= -30) {
        const half = db[k] + 0.5 * (flank - db[k]);
        let a0 = k, a1 = k;
        while (a0 > 0 && db[a0 - 1] < half) a0--;
        while (a1 + 1 < db.length && db[a1 + 1] < half) a1++;
        const on = a0 * HOP, off = (a1 + 1) * HOP;
        // the sealed run of frames (aperture < SEAL_PX) nearest the dip
        const runs = [];
        for (const q of rec) {
          if (q.t < on - 0.15 || q.t > off + 0.15 || q.ap >= SEAL_PX) continue;
          const last = runs[runs.length - 1];
          if (last && q.t - last[1] < 1.5 / FPS) last[1] = q.t; else runs.push([q.t, q.t]);
        }
        nClosures++;
        if (runs.length) {
          const best = runs.reduce((b, x) => (Math.abs(0.5 * (x[0] + x[1]) - k * HOP) < Math.abs(0.5 * (b[0] + b[1]) - k * HOP) ? x : b));
          nSealed++;
          r.sealOn.push(best[0] - on);
          r.sealEnd.push(best[1] + 1 / FPS - off);
        }
      }
    }
    if (s.viseme !== 'sil' && tl[i - 1].viseme === 'sil' && tl[i - 1].end - tl[i - 1].start >= 0.1) {
      let ta = NaN;
      for (let t = s.start - 0.15; t < s.start + 0.15; t += HOP) if (atDb(t) > -30) { ta = t; break; }
      if (!Number.isFinite(ta)) continue;
      // the jaw's trough in the pause, then the moment it has opened by 0.06 from there
      let trough = Infinity, tt = NaN;
      for (const q of rec) if (q.t >= ta - 0.2 && q.t <= ta + 0.05 && q.jaw < trough) { trough = q.jaw; tt = q.t; }
      let tm = NaN;
      for (const q of rec) if (q.t > tt && q.jaw > trough + 0.06) { tm = q.t; break; }
      if (Number.isFinite(tm)) r.onset.push(tm - ta);
    }
  }
  // xcorr of jaw (frames) with the audio level (dB, floored at -40) over +-150 ms
  const frames = rec.filter((q) => q.t >= 0 && q.t < wav.durationSec);
  const A = frames.map((q) => q.jaw);
  const B = frames.map((q) => Math.max(-40, atDb(q.t)));
  const z = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1; return v.map((x) => (x - m) / sd); };
  const za = z(A), zb = z(B);
  let bestLag = 0, bestR = -Infinity;
  for (let lag = -9; lag <= 9; lag++) {
    let acc = 0, n = 0;
    for (let i = 0; i < za.length; i++) { const j = i + lag; if (j >= 0 && j < zb.length) { acc += za[j] * zb[i]; n++; } }
    if (acc / n > bestR) { bestR = acc / n; bestLag = lag; }
  }
  // + lag: jaw[i + lag] matches audio[i], i.e. the mouth comes AFTER the sound
  r.xcorr = bestLag / FPS;
  for (const k of ['closure', 'sealOn', 'sealEnd', 'onset']) pooled[k].push(...r[k]);
  pooled.xcorr.push(r.xcorr);
  perClip.push({ clip: basename(f, '.json'), ...r, r: bestR });
  console.log(`${basename(f, '.json').padEnd(22)} xcorr ${(r.xcorr * 1000).toFixed(0).padStart(4)} ms (r=${bestR.toFixed(2)})  closures ${stats(r.closure)}`);
}
console.log(`--- pooled, rendered mouth vs audio (- = mouth early), latency ${LATENCY * 1000} ms ---`);
console.log(`closure ${stats(pooled.closure)}`);
console.log(`seal on ${stats(pooled.sealOn)}  (sealed ${nSealed}/${nClosures})`);
console.log(`seal end ${stats(pooled.sealEnd)}`);
console.log(`onset   ${stats(pooled.onset)}`);
console.log(`xcorr   ${stats(pooled.xcorr)}`);
if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ pooled, sealed: [nSealed, nClosures], perClip }, null, 1));
