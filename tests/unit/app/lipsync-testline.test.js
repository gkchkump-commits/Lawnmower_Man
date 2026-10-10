// The Settings > Voice > Test lip-sync line ("Bob, pop by at five. Maybe my mom made muffins.") on
// REAL speech: a Kokoro clip (tests/fixtures/kokoro/testline_af_heart, the voice server's /tts
// output) through the real LipSync, Director and the reference pack's relief rig at 60 Hz. Guards
// what the v0.4 review measured on real clips: every m / b / p seals and parts at its sound, also
// after a consonant ("pop by", "made muffins"); a short vowel between two closures ("Maybe my")
// parts the lips; a release opens the mouth over a few frames instead of popping it open.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../../src/app/emitter.js';
import { LipSync, XFADE } from '../../../src/audio/lipsync.js';
import { analyseAcoustics } from '../../../src/audio/acoustics.js';
import { bytesToBase64, decodeWav } from '../../../src/audio/wav.js';
import { Director } from '../../../src/avatar/director.js';
import { buildRig, rigUniforms } from '../../../src/avatar/heads/relief/rig.js';

const dir = fileURLToPath(new URL('../../fixtures/kokoro/', import.meta.url));
const meta = JSON.parse(readFileSync(`${dir}testline_af_heart.json`, 'utf8'));
const bytes = readFileSync(`${dir}testline_af_heart.wav`);
const wav = decodeWav(new Uint8Array(bytes));
const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/assets/avatars/reference/pack.json', import.meta.url)), 'utf8'));
const rig = buildRig(pack);
const VOW = new Set(['aa', 'E', 'I', 'O', 'U', 'RR']);

/**
 * Play the clip (as the app's clip: base64 WAV + visemes) and record the mouth: the director's
 * output and the relief rig's opening at the centre (plate px).
 * @param {{ acoustics?: any, each?: (now: number) => void }} [o]
 */
function play(o = {}) {
  const clip = { kind: 'audio', audioB64: bytesToBase64(new Uint8Array(bytes)), visemes: meta.visemes, text: meta.text };
  const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, level: () => 0.05, spectrum: () => false });
  let now = 0;
  const ls = new LipSync({ player, now: () => now, ...(o.acoustics ? { acoustics: o.acoustics } : {}) });
  const dr = new Director({ seed: 1, idleMotion: 0 });
  dr.setState('speaking');
  const rec = [], u = {};
  for (let f = 0; f / 60 < wav.durationSec + 0.5; f++) {
    now = f / 60;
    o.each?.(now);
    player.current = now < wav.durationSec ? { clip, kind: 'audio', time: now } : null;
    const m = ls.update(1 / 60, now);
    dr.setMouth(m);
    dr.setSpeechLevel(m.level);
    const a = dr.update(1 / 60, now);
    rigUniforms(rig, a, u);
    rec.push({ t: now, ap: u.open[0] + u.open[1], press: a.mouthPress, jaw: a.jawOpen, target: { jaw: m.jaw, press: m.press } });
  }
  return { rec, ls, clip };
}

/** Runs of frames with the lips sealed (opening under 1 plate px): [first, last] times. */
function seals(rec) {
  const out = [];
  let r = null;
  for (const q of rec) {
    if (q.ap < 1) { if (r) r[1] = q.t; else r = [q.t, q.t]; } else if (r) { out.push(r); r = null; }
  }
  if (r) out.push(r);
  return out;
}

describe('the Test lip-sync line on a real Kokoro clip', () => {
  const { rec, ls, clip } = play();
  const fused = ls._clips.get(clip).st.fused.tl;
  const runs = seals(rec);
  const closures = fused.filter((s) => s.viseme === 'PP');

  it('seals every m / b / p for two frames or more (the b of "Maybe" too)', () => {
    expect(closures.length).toBeGreaterThanOrEqual(9);
    for (const s of closures) {
      const mid = 0.5 * (s.start + s.end);
      const run = runs.find(([a, b]) => b >= mid - 0.09 && a <= mid + 0.02);
      expect(run, `closure at ${s.start.toFixed(3)}`).toBeTruthy();
      expect(run[1] - run[0], `closure at ${s.start.toFixed(3)}`).toBeGreaterThan(1 / 60 - 1e-6);
    }
  });

  it('parts the lips at each release into a vowel, also after a consonant ("pop by", "made muffins"), a little ahead of it', () => {
    let n = 0, afterConsonant = 0;
    fused.forEach((s, i) => {
      if (s.viseme !== 'PP' || !fused[i + 1] || !VOW.has(fused[i + 1].viseme)) return;
      // the release is an acoustic landmark (the 0.8-5 kHz band's steepest rise)
      expect(s.exactEnd, `release at ${s.end.toFixed(3)}`).toBe(true);
      const run = runs.find(([a, b]) => b + 1 / 60 >= s.end - 0.06 && a <= s.end);
      const open = run[1] + 1 / 60;                     // the first frame with the lips apart
      expect(open - s.end, `release at ${s.end.toFixed(3)}`).toBeLessThan(0.005);
      expect(open - s.end, `release at ${s.end.toFixed(3)}`).toBeGreaterThan(-0.035);
      n++;
      if (fused[i - 1] && fused[i - 1].viseme !== 'sil' && !VOW.has(fused[i - 1].viseme)) afterConsonant++;
    });
    expect(n).toBeGreaterThanOrEqual(7);
    expect(afterConsonant).toBeGreaterThanOrEqual(1);
  });

  it('a short vowel between two closures parts the lips: the /i/ of "Maybe my"', () => {
    // (v0.4's lane kept the lips sealed from the b of "Maybe" to the m of "my", 150 ms)
    const b = closures.find((s) => s.start > 1.85 && s.start < 1.95), m = closures.find((s) => s.start > 1.95 && s.start < 2.05);
    expect(b && m).toBeTruthy();
    const between = rec.filter((q) => q.t > b.end - 0.04 && q.t < m.start);
    expect(Math.max(...between.map((q) => q.ap))).toBeGreaterThan(8);
    expect(between.filter((q) => q.ap > 5).length).toBeGreaterThanOrEqual(2);
  });

  it('a release opens the mouth over a few frames: no frame opens it by more than 22 plate px', () => {
    // (the jaw waits behind the sealed lips: v0.4's lane let it drop behind them and the release
    // popped the mouth open by 30 px in one frame; v0.3 by 22)
    let worst = 0;
    for (let i = 1; i < rec.length; i++) worst = Math.max(worst, rec[i].ap - rec[i - 1].ap);
    expect(worst).toBeLessThan(22);
    // and inside a closure the jaw stays fairly high
    for (const s of closures) {
      const inside = rec.filter((q) => q.t > s.start - 0.02 && q.t < s.end - 0.03 && q.ap < 1);
      for (const q of inside) expect(q.jaw, `closure at ${s.start.toFixed(3)}`).toBeLessThan(0.45);
    }
  });

  it('the analysis arriving while the clip plays crossfades the mouth (no jump)', () => {
    // a worker that answers only at 1.0 s (a slow machine: the clip started before its analysis)
    const job = { track: null, final: false, failed: false, promise: Promise.resolve(null) };
    const late = { analyse: () => job, warmUp() {} };
    const at = 1.0;
    const { rec: r2 } = play({ acoustics: late, each: (now) => { if (now >= at && !job.final) { job.track = analyseAcoustics(wav.samples, wav.sampleRate); job.final = true; } } });
    const k = r2.findIndex((q) => q.t >= at);
    const step = (i) => Math.max(Math.abs(r2[i].target.jaw - r2[i - 1].target.jaw), Math.abs(r2[i].target.press - r2[i - 1].target.press));
    // the switch frame changes the targets no more than the frames around it do
    let around = 0;
    for (let i = k - 6; i < k + 8; i++) if (i !== k && i !== k + 1) around = Math.max(around, step(i));
    expect(step(k)).toBeLessThanOrEqual(around + 0.02);
    expect(step(k + 1)).toBeLessThanOrEqual(around + 0.02);
    // ... and after the crossfade it is the analysed mouth
    const j = r2.findIndex((q) => q.t >= at + XFADE + 0.05);
    expect(r2[j].target.jaw).toBeCloseTo(rec[j].target.jaw, 6);
    expect(r2[j].target.press).toBeCloseTo(rec[j].target.press, 6);
  });
});
